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
  now: Date.now,
  log: () => {},
};

const BATCH = /^batch-.*\.jsonl$/;

export function openBuffer(dir, options = {}) {
  const { maxBacklogBytes, maxDeadBytes, maxAgeMs, now, log } = { ...DEFAULTS, ...options };
  const liveFile = path.join(dir, "events.jsonl");
  const deadDir = path.join(dir, "dead");
  let claims = 0;

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
        if (rejected.length && toDead(`rejected-${name}`, { lines: rejected.map((e) => JSON.stringify(e)) }))
          log(`${name}: ${rejected.length} rejected events kept in dead/`);
        // A writer that opened the live file before the claim may have
        // appended after we read it: that tail is held too.
        let tail = Buffer.alloc(0);
        try {
          tail = fs.readFileSync(file).subarray(raw.length);
        } catch (err) {
          // Gone is fine (evicted, cleaned up by hand). Anything else: leave the
          // file alone — pushing it again is safe, deleting an unseen tail is not.
          if (err?.code !== "ENOENT") throw err;
        }
        const held = toLines(events.slice(handled));
        if (!held && !tail.length) return fs.rmSync(file, { force: true });
        const tmp = `${file}.tmp`;
        try {
          fs.writeFileSync(tmp, Buffer.concat([Buffer.from(held), tail]));
          fs.renameSync(tmp, file);
        } finally {
          try {
            fs.rmSync(tmp, { force: true }); // only still there if the rename didn't happen
          } catch {}
        }
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

    pending: () => size(liveFile) > 0,

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
      evictOldest(dir, BATCH, maxBacklogBytes, "backlog");
      return list(dir, BATCH).map(readBatch).filter(Boolean);
    },
  };
}
