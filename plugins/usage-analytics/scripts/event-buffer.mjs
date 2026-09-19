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

// Every file name the buffer uses in the data dir, produced and read back in
// one place. The names are a stored format (a newer plugin picks up what an
// older one left) and they carry ADR 0002's ordering: a batch is named for its
// claim time, and its -held- and -late- pieces sort right after it, so name
// order is age order.
const stem = (batchName) => batchName.replace(/\.jsonl$/, "");
// Written by a settle, cleaned up by the sweep: one suffix, so the two cannot drift apart.
const TMP_SUFFIX = ".tmp";
const names = {
  live: "events.jsonl",
  batch: /^batch-.*\.jsonl$/,
  settled: /^(batch-.*\.jsonl)\.settled-(\d+)-(.+)$/,
  tmp: new RegExp(`^batch-.*\\.jsonl${TMP_SUFFIX.replace(".", "\\.")}$`),
  // Claim time, then pid and a counter to keep it unique.
  claimed: (time, pid, seq) => `batch-${time}-${pid}-${String(seq).padStart(6, "0")}.jsonl`,
  // One "-held-" segment per lineage, however often it is partly settled:
  // names that grew with every pass would end in ENAMETOOLONG and a wedged buffer.
  held: (batchName, id) => `${stem(batchName).replace(/-held-\d+-\d+$/, "")}-held-${id}.jsonl`,
  // "-late" sorts after the parent's "-held" rest and before any newer batch;
  // the offset is padded so that name order is write order.
  late: (batchName, id, seen) => `${stem(batchName)}-late-${id}-${String(seen).padStart(12, "0")}.jsonl`,
  settledAs: (batchName, bytesSeen, id) => `${batchName}.settled-${bytesSeen}-${id}`,
  // `seen` stays the string it was written as.
  parseSettled(name) {
    const match = name.match(names.settled);
    return match && { batchName: match[1], seen: match[2], id: match[3] };
  },
  // The batch a held or late piece came from, without extension.
  origin: (batchName) => stem(batchName.replace(/-(held|late)-.*$/, "")),
  tmpOf: (batchName) => `${batchName}${TMP_SUFFIX}`,
};

export function openBuffer(dir, options = {}) {
  const { maxBacklogBytes, maxDeadBytes, maxAgeMs, settleGraceMs, now, log } = { ...DEFAULTS, ...options };
  const liveFile = path.join(dir, names.live);
  const deadDir = path.join(dir, "dead");
  let claims = 0;
  let retired = 0;
  // The live file as it was when a claim of it last failed (read-only data dir,
  // permissions): not pending again until it changes, or the flusher never idles.
  let unclaimable = null;
  const liveSignature = () => {
    const info = stat(liveFile);
    return info ? `${info.size}:${info.mtimeMs}` : null;
  };

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
    const batchName = path.basename(file);
    let id, heldFile;
    do {
      id = `${process.pid}-${retired++}`;
      heldFile = path.join(dir, names.held(batchName, id));
    } while (fs.existsSync(heldFile)); // never the parent itself, nor anything else already there
    if (held.length) {
      const tmp = path.join(dir, names.tmpOf(batchName));
      fs.writeFileSync(tmp, held);
      fs.renameSync(tmp, heldFile);
    }
    fs.renameSync(file, path.join(dir, names.settledAs(batchName, bytesSeen, id)));
  }

  const lateBytes = (file) => size(file) - Number(names.parseSettled(path.basename(file)).seen);

  function sweepSettled() {
    for (const file of list(dir, names.settled)) {
      const { batchName, seen, id } = names.parseSettled(path.basename(file));
      const info = stat(file);
      if (!info) continue;
      try {
        if (info.size > Number(seen)) {
          // A late write: those bytes become a batch of their own, and we keep watching.
          const late = fs.readFileSync(file).subarray(Number(seen));
          fs.writeFileSync(path.join(dir, names.late(batchName, id, seen)), late);
          fs.renameSync(file, path.join(dir, names.settledAs(batchName, Number(seen) + late.length, id)));
          // Deliberately the wall clock, not the injected now(): it is compared with a real file mtime.
        } else if (Date.now() - info.mtimeMs >= settleGraceMs) fs.rmSync(file, { force: true });
      } catch (err) {
        unexpected(`sweep ${path.basename(file)}`, err);
      }
    }
    // An interrupted settle can leave its temp file behind; nothing else would ever look at it.
    for (const tmp of list(dir, names.tmp)) if (Date.now() - mtime(tmp) >= settleGraceMs) remove(tmp);
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
        if (rejected.length && toDead(`rejected-${names.origin(name)}.jsonl`, { lines: rejected.map((e) => JSON.stringify(e)) }))
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
    // A late write is swept by the next claim; one that is still there well past
    // the grace period is a sweep that keeps failing (logged), and must not keep
    // the flusher alive. claim() goes on trying it regardless.
    pending: () =>
      (size(liveFile) > 0 && liveSignature() !== unclaimable) ||
      list(dir, names.settled).some((file) => lateBytes(file) > 0 && Date.now() - mtime(file) < 3 * settleGraceMs),

    // Claims the live file by renaming it (writers reopen the path per event,
    // so new events land in a fresh file) and returns every held batch, oldest first.
    claim() {
      if (size(liveFile) > 0) {
        try {
          // Never reuse an existing name: rename would silently replace a held batch.
          let target;
          do target = path.join(dir, names.claimed(now(), process.pid, claims++));
          while (fs.existsSync(target));
          fs.renameSync(liveFile, target);
          unclaimable = null;
        } catch (err) {
          if (err?.code !== "ENOENT") {
            unclaimable = liveSignature();
            unexpected("claim buffer", err); // once per kind, not on every pass
          }
        }
      }
      sweepSettled();
      evictOldest(dir, names.batch, maxBacklogBytes, "backlog");
      return list(dir, names.batch).map(readBatch).filter(Boolean);
    },
  };
}
