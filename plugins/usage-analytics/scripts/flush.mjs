#!/usr/bin/env node
// One flusher per buffer directory (lock in DATA_DIR): drains the shared buffer
// and pushes batched events to Loki. Spawned on demand by record.mjs, exits
// when idle. It inherits the Loki settings of the session that spawned it.
import fs from "node:fs";
import path from "node:path";
import {
  BUFFER_FILE, DATA_DIR, DEAD_DIR, LOCK_STALE_MS, LOKI_URL, MAX_BACKLOG_BYTES, PID_FILE, SERVICE_NAME, SESSIONS_DIR,
  ensureDirs, log, readLockPid,
} from "./lib.mjs";

const env = process.env;

function envMs(name, fallback) {
  if (env[name] === undefined) return fallback;
  const value = Number(env[name]);
  if (Number.isFinite(value) && value >= 100) return value;
  log(`ignoring invalid ${name}=${env[name]}, using ${fallback}`);
  return fallback;
}

const INTERVAL_MS = envMs("CLAUDE_ANALYTICS_FLUSH_MS", 1000);
const IDLE_EXIT_MS = envMs("CLAUDE_ANALYTICS_IDLE_EXIT_MS", 10 * 60 * 1000);
// ~1 MiB per request (Promtail's default batch size); an estimate, not a hard limit.
const MAX_BATCH_BYTES = 1024 * 1024;
// Drop events older than 6d: stack/loki.yaml rejects samples older than 168h,
// minus a day of margin. Also reused as the session-cache TTL.
const MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;
const MAX_DEAD_BYTES = 20 * 1024 * 1024;
const LABELS = ["user", "project", "source", "kind"];
// Loki will never accept these as sent; everything else may succeed later.
const REJECTED = new Set([400, 413, 422]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- lock -------------------------------------------------------------------

// The pid file is created complete (tmp + hard link), so it can never be
// observed empty. A stale lock is only removed if it still names the pid that
// was validated as dead; ownsLock() in the main loop covers the remaining race.
function acquireLock() {
  const tmp = `${PID_FILE}.${process.pid}.tmp`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      fs.writeFileSync(tmp, String(process.pid));
      try {
        fs.linkSync(tmp, PID_FILE);
        return true;
      } catch (err) {
        if (err?.code !== "EEXIST") {
          log(`cannot create lock: ${err?.code || err?.message}`);
          return false;
        }
      }
      const holder = readLockPid();
      if (holder && lockFresh() && processExists(holder)) return false; // live flusher
      if (readLockPid() === holder) {
        log(`taking over stale lock (pid ${holder || "invalid"})`);
        fs.rmSync(PID_FILE, { force: true });
      }
    }
    log("could not acquire lock after 3 attempts");
    return false;
  } catch (err) {
    log(`lock error: ${err?.code || err?.message}`);
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function lockFresh() {
  try {
    return Date.now() - fs.statSync(PID_FILE).mtimeMs <= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

const ownsLock = () => readLockPid() === process.pid;

function heartbeat() {
  try {
    const now = new Date();
    fs.utimesSync(PID_FILE, now, now);
  } catch {}
}

function releaseLock() {
  try {
    if (ownsLock()) fs.rmSync(PID_FILE);
  } catch {}
}

// --- pushing ----------------------------------------------------------------

function headers() {
  const h = { "Content-Type": "application/json" };
  if (env.CLAUDE_ANALYTICS_LOKI_TOKEN) h.Authorization = `Bearer ${env.CLAUDE_ANALYTICS_LOKI_TOKEN}`;
  else if (env.CLAUDE_ANALYTICS_LOKI_BASIC_AUTH)
    h.Authorization = `Basic ${Buffer.from(env.CLAUDE_ANALYTICS_LOKI_BASIC_AUTH).toString("base64")}`;
  if (env.CLAUDE_ANALYTICS_LOKI_TENANT) h["X-Scope-OrgID"] = env.CLAUDE_ANALYTICS_LOKI_TENANT;
  return h;
}

// Returns "ok" or "rejected"; throws on anything worth retrying.
async function push(events) {
  const streams = new Map();
  events.forEach((event, i) => {
    const stream = { service_name: SERVICE_NAME };
    for (const key of LABELS) stream[key] = String(event[key] ?? "unknown");
    const id = JSON.stringify(stream);
    if (!streams.has(id)) streams.set(id, { stream, values: [] });
    // ms timestamp + the event's own sub-ms digits: unique, and identical on a
    // re-push so Loki dedupes. (`i` only covers events from older plugin versions.)
    const ns = `${event.ts}${String((event.sub ?? i) % 1e6).padStart(6, "0")}`;
    const { ts, sub, ...body } = event;
    streams.get(id).values.push([ns, JSON.stringify(body)]);
  });
  const res = await fetch(`${LOKI_URL}/loki/api/v1/push`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ streams: [...streams.values()] }),
    signal: AbortSignal.timeout(10_000),
  });
  heartbeat();
  if (res.ok) return "ok";
  const detail = `${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`;
  if (REJECTED.has(res.status)) {
    log(`Loki rejected ${events.length} events: ${detail}`);
    return "rejected";
  }
  const hint = [401, 403, 404, 407].includes(res.status) ? " (check CLAUDE_ANALYTICS_LOKI_URL / credentials; holding events)" : "";
  throw new Error(detail + hint);
}

function moveToDead(file, reason) {
  try {
    fs.mkdirSync(DEAD_DIR, { recursive: true });
    fs.renameSync(file, path.join(DEAD_DIR, path.basename(file)));
    log(`quarantined ${path.basename(file)} in dead/: ${reason}`);
  } catch (err) {
    log(`cannot quarantine ${path.basename(file)} (${err?.code}); deleting it: ${reason}`);
    fs.rmSync(file, { force: true });
  }
}

function writeLines(file, events) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + "\n").join(""));
  fs.renameSync(tmp, file);
}

async function sendFile(file) {
  const name = path.basename(file);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    if (err?.code !== "ENOENT") moveToDead(file, `unreadable: ${err?.code || err?.message}`);
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;
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

  const chunks = [[]];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 64;
    if (chunks.at(-1).length && bytes + size > MAX_BATCH_BYTES) {
      chunks.push([]);
      bytes = 0;
    }
    chunks.at(-1).push(event);
    bytes += size;
  }

  const rejected = [];
  const keepRejected = () => {
    if (!rejected.length) return;
    fs.mkdirSync(DEAD_DIR, { recursive: true });
    writeLines(path.join(DEAD_DIR, `rejected-${Date.now()}-${name}`), rejected);
    log(`${name}: ${rejected.length} rejected events kept in dead/`);
  };
  let sent = 0;
  for (const chunk of chunks) {
    if (!chunk.length) continue;
    try {
      if ((await push(chunk)) === "rejected") rejected.push(...chunk);
    } catch (err) {
      // Keep only what is still unsent, so the retry resumes instead of restarting.
      if (sent) writeLines(file, events.slice(sent));
      keepRejected();
      throw err;
    }
    sent += chunk.length;
  }
  keepRejected();

  // A writer that opened the buffer before the rename may have appended after
  // we read it: keep that tail for the next loop instead of deleting it.
  const tail = fs.readFileSync(file).subarray(raw.length);
  if (tail.length) fs.writeFileSync(file, tail);
  else fs.rmSync(file, { force: true });
}

// --- buffer management --------------------------------------------------------

const listFiles = (dir, pattern) =>
  fs.readdirSync(dir).filter((f) => pattern.test(f)).sort().map((f) => path.join(dir, f));

// Claim the live buffer by renaming it; writers reopen the path per event, so
// new events land in a fresh file. Returns whether new events were claimed.
function claimBuffer() {
  try {
    if (fs.statSync(BUFFER_FILE).size === 0) return false;
    fs.renameSync(BUFFER_FILE, path.join(DATA_DIR, `batch-${Date.now()}-${process.pid}.jsonl`));
    return true;
  } catch (err) {
    if (err?.code !== "ENOENT") log(`cannot claim buffer: ${err?.code || err?.message}`);
    return false;
  }
}

// Oldest-first eviction keeps a directory under a byte budget.
function enforceCap(dir, pattern, maxBytes, what) {
  try {
    const files = listFiles(dir, pattern).map((f) => ({ f, size: fs.statSync(f).size }));
    let total = files.reduce((sum, x) => sum + x.size, 0);
    for (const { f, size } of files) {
      if (total <= maxBytes) break;
      fs.rmSync(f, { force: true });
      total -= size;
      log(`${what} over ${maxBytes} bytes: evicted ${path.basename(f)} (${size} bytes)`);
    }
  } catch (err) {
    if (err?.code !== "ENOENT") log(`cannot enforce ${what} cap: ${err?.code || err?.message}`);
  }
}

function pruneSessions() {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const file of listFiles(SESSIONS_DIR, /./)) {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    log(`cannot prune session cache: ${err?.code || err?.message}`);
  }
}

function describe(err) {
  const cause = err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.cause?.message;
  return [err?.message, cause].filter(Boolean).join(": ");
}

// --- main loop ----------------------------------------------------------------

async function drain() {
  let lastActivity = Date.now();
  let backoff = 0;
  while (Date.now() - lastActivity < IDLE_EXIT_MS) {
    await sleep(backoff || INTERVAL_MS);
    if (!ownsLock()) return log("lock lost to another flusher, exiting"), false;
    heartbeat();

    // Only new events or a successful push count as activity, so an
    // unreachable Loki doesn't keep this process alive forever.
    if (claimBuffer()) lastActivity = Date.now();
    enforceCap(DATA_DIR, /^batch-.*\.jsonl$/, MAX_BACKLOG_BYTES, "backlog");
    const batches = listFiles(DATA_DIR, /^batch-.*\.jsonl$/);
    if (!batches.length) continue;

    await sleep(100); // let in-flight appends to the renamed file finish
    try {
      for (const file of batches) await sendFile(file);
      if (backoff) log("push recovered");
      backoff = 0;
      lastActivity = Date.now();
      enforceCap(DEAD_DIR, /./, MAX_DEAD_BYTES, "dead/");
    } catch (err) {
      backoff = Math.min(MAX_BACKOFF_MS, (backoff || INTERVAL_MS) * 2);
      log(`push failed, retry in ${backoff}ms: ${describe(err)}`);
    }
  }
  return true;
}

async function main() {
  ensureDirs();
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      log(`received ${sig}, exiting`);
      releaseLock();
      process.exit(0);
    });

  while (acquireLock()) {
    log(`flusher started -> ${LOKI_URL}`);
    pruneSessions();
    const idle = await drain();
    releaseLock();
    if (!idle) return;
    // An event appended between the last claim and the release saw a live
    // flusher and spawned nothing: pick it up instead of stranding it.
    let pending = false;
    try {
      pending = fs.statSync(BUFFER_FILE).size > 0;
    } catch {}
    if (!pending) return log("flusher idle, exiting");
  }
}

function fatal(err) {
  log(`fatal: ${err?.stack || err}`);
  releaseLock();
  process.exit(1);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

main().catch(fatal);
