// Event buffer: owns every byte under the data dir that holds usage events
// between capture and delivery — the live file, claimed batches and dead/.
// See docs/architecture-decisions/0002-append-only-file-buffer.mdx.
import fs from "node:fs";
import path from "node:path";

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

  const size = (file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  const list = (folder, pattern) => {
    try {
      return fs.readdirSync(folder).filter((f) => pattern.test(f)).sort().map((f) => path.join(folder, f));
    } catch {
      return [];
    }
  };
  const toLines = (events) => events.map((e) => JSON.stringify(e) + "\n").join("");

  function writeDead(name, content) {
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(path.join(deadDir, name), content);
    evictOldest(deadDir, /./, maxDeadBytes, "dead/");
  }

  function evictOldest(folder, pattern, maxBytes, what) {
    const files = list(folder, pattern).map((file) => ({ file, bytes: size(file) }));
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    // Never the newest: a live file that filled up to the cap is claimed as one
    // batch slightly over it, and must not be thrown away whole.
    for (const { file, bytes } of files.slice(0, -1)) {
      if (total <= maxBytes) break;
      fs.rmSync(file, { force: true, recursive: true });
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
      log(`quarantined ${name} in dead/: unreadable (${err?.code || err?.message})`);
      fs.mkdirSync(deadDir, { recursive: true });
      fs.renameSync(file, path.join(deadDir, name));
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
        corrupt++; // torn line
      }
    }
    if (expired || corrupt) log(`${name}: skipped ${expired} expired and ${corrupt} corrupt lines`);

    return {
      name,
      events,
      // `sent` leading events were handled (delivered, or listed in `rejected`);
      // the rest stay held for a later claim.
      settle({ sent = events.length, rejected = [] } = {}) {
        if (rejected.length) {
          writeDead(`rejected-${now()}-${name}`, toLines(rejected));
          log(`${name}: ${rejected.length} rejected events kept in dead/`);
        }
        // A writer that opened the live file before the claim may have
        // appended after we read it: that tail is still unsent.
        let tail = Buffer.alloc(0);
        try {
          tail = fs.readFileSync(file).subarray(raw.length);
        } catch {}
        const held = toLines(events.slice(sent));
        if (!held && !tail.length) return fs.rmSync(file, { force: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, Buffer.concat([Buffer.from(held), tail]));
        fs.renameSync(tmp, file);
      },
    };
  }

  return {
    // False when the buffer is full and the event was not stored.
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
          fs.renameSync(liveFile, path.join(dir, `batch-${now()}-${process.pid}-${String(claims++).padStart(6, "0")}.jsonl`));
        } catch (err) {
          if (err?.code !== "ENOENT") log(`cannot claim buffer: ${err?.code || err?.message}`);
        }
      }
      evictOldest(dir, BATCH, maxBacklogBytes, "backlog");
      return list(dir, BATCH).map(readBatch).filter(Boolean);
    },
  };
}
