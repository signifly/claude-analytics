// Event buffer: owns the files that hold usage events — the live file, claimed
// batches and dead/. (The lock, log and sessions/ belong to other modules.)
// See docs/architecture-decisions/0002-append-only-file-buffer.mdx.
import fs from "node:fs";
import path from "node:path";
import { describe } from "./log.mjs";

const DEFAULTS = {
  maxBacklogBytes: 50 * 1024 * 1024,
  maxDeadBytes: 20 * 1024 * 1024,
  // Loki (stack/loki.yaml) rejects samples older than 168h; stay a day inside that.
  maxAgeMs: 6 * 24 * 60 * 60 * 1000,
  // How long a settled batch is kept and watched for late writes before it is removed.
  settleGraceMs: 5000,
  now: Date.now,
  log: () => {},
};

const BATCH = /^batch-.*\.jsonl$/;
const SETTLED = /^(batch-.*\.jsonl)\.settled-(\d+)-(.+)$/;

export function openBuffer(dir, options = {}) {
  const { maxBacklogBytes, maxDeadBytes, maxAgeMs, settleGraceMs, now, log } = { ...DEFAULTS, ...options };
  const liveFile = path.join(dir, "events.jsonl");
  const deadDir = path.join(dir, "dead");
  let claims = 0;
  let retired = 0;

  // A missing file is an ordinary answer; any other failure is reported (once
  // per kind per process), because "0" or "nothing" would otherwise pass for an empty buffer.
  const reported = new Set();
  const unexpected = (what, err) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return;
    const key = `${what}:${err?.code}`;
    if (!reported.has(key)) log(`cannot ${what}: ${describe(err)}`);
    reported.add(key);
  };
  const stat = (file) => {
    try {
      return fs.statSync(file);
    } catch (err) {
      unexpected(`stat ${path.basename(file)}`, err);
      return null;
    }
  };
  const size = (file) => stat(file)?.size ?? 0;
  const mtime = (file) => stat(file)?.mtimeMs ?? 0;
  const list = (folder, pattern) => {
    try {
      return fs.readdirSync(folder).filter((f) => pattern.test(f)).sort().map((f) => path.join(folder, f));
    } catch (err) {
      unexpected(`list ${path.basename(folder)}/`, err);
      return [];
    }
  };
  const remove = (file) => {
    try {
      fs.rmSync(file, { force: true, recursive: true });
      return true;
    } catch (err) {
      log(`cannot remove ${path.basename(file)}: ${describe(err)}`);
      return false;
    }
  };
  const toLines = (events) => events.map((e) => JSON.stringify(e) + "\n").join("");

  // Everything that enters dead/ comes through here: written whole, then capped.
  // Pass `file` to move an existing file in, or `lines` to add to a file of
  // that name (repeats are ignored, so re-settling a batch doesn't pile up copies).
  // Never throws, and returns whether the events were kept: dead/ is a courtesy,
  // and failing to fill it must not block the batches behind.
  function toDead(name, { file, lines }) {
    const target = path.join(deadDir, name);
    const tmp = `${target}.tmp`;
    let kept = true;
    try {
      fs.mkdirSync(deadDir, { recursive: true });
      if (file) fs.renameSync(file, target);
      else {
        let existing = "";
        try {
          existing = fs.readFileSync(target, "utf8");
        } catch {}
        const known = new Set(existing.split("\n"));
        fs.writeFileSync(tmp, existing + lines.filter((line) => !known.has(line)).map((line) => line + "\n").join(""));
        fs.renameSync(tmp, target);
      }
    } catch (err) {
      kept = false;
      log(`cannot keep ${name} in dead/ (${describe(err)}), discarding it`);
      if (file) remove(file);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
    evictOldest(deadDir, /^(?!.*\.tmp$)/, maxDeadBytes, "dead/", { byMtime: true });
    return kept;
  }

  // Batch names carry their claim time, so name order is age order. dead/ mixes
  // name shapes, so there age means modification time.
  function evictOldest(folder, pattern, maxBytes, what, { byMtime = false } = {}) {
    const files = list(folder, pattern).map((file) => ({ file, bytes: size(file), mtime: mtime(file) }));
    if (byMtime) files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    // Never the newest: a live file that filled up to the cap is claimed as one
    // batch slightly over it, and must not be thrown away whole.
    for (const { file, bytes } of files.slice(0, -1)) {
      if (total <= maxBytes) break;
      if (!remove(file)) continue; // logged; try the next one rather than stalling delivery
      total -= bytes;
      log(`${what} over ${maxBytes} bytes: evicted ${path.basename(file)} (${bytes} bytes)`);
    }
  }

  // A slow writer can still hold the claimed file open and write to it at any
  // moment, even after it was settled. So a settled file is never deleted or
  // replaced directly: it lives on under a ".settled-<bytes seen>-<id>" name,
  // where sweepSettled() watches it for late writes until the grace period is over.
  //
  // `held` (may be empty) first becomes a batch of its own, under a name that
  // keeps the parent's place in the age order. Only then is the parent retired,
  // so no failure in between can lose the held events: the worst case is both
  // files existing, and re-pushed events are deduplicated by the sink.
  function retire(file, bytesSeen, held) {
    const base = file.replace(/\.jsonl$/, "");
    const id = `${process.pid}-${retired++}`;
    if (held.length) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, held);
      fs.renameSync(tmp, `${base}-held-${id}.jsonl`);
    }
    fs.renameSync(file, `${file}.settled-${bytesSeen}-${id}`);
  }

  const lateBytes = (file) => size(file) - Number(path.basename(file).match(SETTLED)[2]);

  function sweepSettled() {
    for (const file of list(dir, SETTLED)) {
      const [, batchName, seen, id] = path.basename(file).match(SETTLED);
      const info = stat(file);
      if (!info) continue;
      try {
        if (info.size > Number(seen)) {
          // A late write: those bytes become a batch of their own ("-late" sorts
          // after the parent's "-held" rest and before any newer batch), and we keep watching.
          const late = fs.readFileSync(file).subarray(Number(seen));
          fs.writeFileSync(path.join(dir, `${batchName.replace(/\.jsonl$/, "")}-late-${id}-${seen}.jsonl`), late);
          fs.renameSync(file, path.join(dir, `${batchName}.settled-${Number(seen) + late.length}-${id}`));
          // Deliberately the wall clock, not the injected now(): it is compared with a real file mtime.
        } else if (Date.now() - info.mtimeMs >= settleGraceMs) fs.rmSync(file, { force: true });
      } catch (err) {
        unexpected(`sweep ${path.basename(file)}`, err);
      }
    }
    // An interrupted settle can leave its temp file behind; nothing else would ever look at it.
    for (const tmp of list(dir, /^batch-.*\.jsonl\.tmp$/)) if (Date.now() - mtime(tmp) >= settleGraceMs) remove(tmp);
  }

  function readBatch(file) {
    const name = path.basename(file);
    let raw;
    try {
      raw = fs.readFileSync(file);
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      // An unreadable batch must not block the ones behind it.
      if (toDead(name, { file })) log(`moved ${name} to dead/: unreadable (${describe(err)})`);
      return null;
    }

    const cutoff = now() - maxAgeMs;
    const events = [];
    let expired = 0;
    let corrupt = 0;
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (!Number.isFinite(event?.ts)) corrupt++;
        else if (event.ts < cutoff) expired++;
        else events.push(event);
      } catch {
        corrupt++; // unparseable, e.g. a torn write
      }
    }
    if (expired || corrupt) log(`${name}: skipped ${expired} expired and ${corrupt} corrupt lines`);

    return {
      name,
      events,
      // The first `handled` events are done with (delivered, or listed in
      // `rejected`); the rest stay held for a later claim.
      settle({ handled = events.length, rejected = [] } = {}) {
        // One dead/ file per original batch, however many held/late pieces it was settled in.
        const origin = name.replace(/-(held|late)-.*$/, "").replace(/\.jsonl$/, "");
        if (rejected.length && toDead(`rejected-${origin}.jsonl`, { lines: rejected.map((e) => JSON.stringify(e)) }))
          log(`${name}: ${rejected.length} rejected events kept in dead/`);
        // A writer that opened the live file before the claim may have
        // appended after we read it: that tail is held too.
        let tail = Buffer.alloc(0);
        try {
          tail = fs.readFileSync(file).subarray(raw.length);
        } catch (err) {
          // Gone is fine (evicted, cleaned up by hand). Anything else: leave the
          // file alone — pushing it again is safe, deleting an unseen tail is not.
          if (err?.code === "ENOENT") return;
          throw err;
        }
        if (handled === 0 && !tail.length && events.length) return; // nothing changed: leave the batch exactly as it is
        retire(file, raw.length + tail.length, Buffer.concat([Buffer.from(toLines(events.slice(handled))), tail]));
      },
    };
  }

  return {
    // False when the live file is already over maxBacklogBytes: the event was not stored.
    append(event) {
      fs.mkdirSync(dir, { recursive: true });
      if (size(liveFile) > maxBacklogBytes) return false;
      // One small write in append mode: safe with several concurrent writers
      // on a local filesystem (a torn line is skipped and counted on read).
      fs.appendFileSync(liveFile, JSON.stringify(event) + "\n");
      return true;
    },

    // Unclaimed events: in the live file, or written late into a settled batch.
    pending: () => size(liveFile) > 0 || list(dir, SETTLED).some((file) => lateBytes(file) > 0),

    // Claims the live file by renaming it (writers reopen the path per event,
    // so new events land in a fresh file) and returns every held batch, oldest first.
    claim() {
      if (size(liveFile) > 0) {
        try {
          // Name = claim time, then pid and a counter to keep it unique. Never
          // reuse an existing name: rename would silently replace a held batch.
          let target;
          do target = path.join(dir, `batch-${now()}-${process.pid}-${String(claims++).padStart(6, "0")}.jsonl`);
          while (fs.existsSync(target));
          fs.renameSync(liveFile, target);
        } catch (err) {
          if (err?.code !== "ENOENT") log(`cannot claim buffer: ${describe(err)}`);
        }
      }
      sweepSettled();
      evictOldest(dir, BATCH, maxBacklogBytes, "backlog");
      return list(dir, BATCH).map(readBatch).filter(Boolean);
    },
  };
}
