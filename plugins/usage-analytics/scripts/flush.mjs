#!/usr/bin/env node
// Flusher entry point: one per data dir. Moves events from the buffer to Loki
// about once a second, backs off while Loki is failing, exits when idle.
// Spawned on demand by record.mjs; inherits the Loki settings of that session.
import { loadConfig } from "./config.mjs";
import { openBuffer } from "./event-buffer.mjs";
import { flushOnce } from "./flush-once.mjs";
import { acquire } from "./flusher-lock.mjs";
import { createLog } from "./log.mjs";
import { createLokiSink } from "./loki-sink.mjs";
import { pruneSessions } from "./session-context.mjs";

const MAX_BACKOFF_MS = 60 * 1000;
const SESSION_CACHE_MS = 6 * 24 * 60 * 60 * 1000;

const config = loadConfig();
const { log } = createLog(config.dataDir);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lock = null;

// Runs until idle (true) or until the lock is lost to another flusher (false).
async function drain(buffer, sink) {
  let lastActivity = Date.now();
  let backoff = 0;
  while (Date.now() - lastActivity < config.idleExitMs) {
    await sleep(backoff || config.flushMs);
    if (!lock.stillMine()) return log("lock lost to another flusher, exiting"), false;

    // Only new events or a delivery count as activity, so an unreachable Loki
    // doesn't keep this process alive forever.
    if (buffer.pending()) lastActivity = Date.now();
    const { delivered, error } = await flushOnce(buffer, sink);
    if (delivered) lastActivity = Date.now();

    if (error) {
      backoff = Math.min(MAX_BACKOFF_MS, (backoff || config.flushMs) * 2);
      log(`push failed, retry in ${backoff}ms: ${error.message}`);
    } else {
      if (backoff) log("push recovered");
      backoff = 0;
    }
  }
  return true;
}

async function main() {
  for (const warning of config.warnings) log(warning);
  const dir = config.dataDir;
  const buffer = openBuffer(dir, { log });
  const sink = createLokiSink({ ...config.loki, log });

  while ((lock = acquire(dir, { log }))) {
    log(`flusher started -> ${config.loki.url}`);
    pruneSessions(dir, SESSION_CACHE_MS, log);
    const idle = await drain(buffer, sink);
    lock.release();
    if (!idle) return;
    // An event appended between the last flush and the release saw a live
    // flusher and spawned nothing: pick it up instead of stranding it.
    if (!buffer.pending()) return log("flusher idle, exiting");
  }
}

function exit(reason, code) {
  log(reason);
  lock?.release();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => exit(`received ${signal}, exiting`, 0));
process.on("uncaughtException", (err) => exit(`fatal: ${err?.stack || err}`, 1));
process.on("unhandledRejection", (err) => exit(`fatal: ${err?.stack || err}`, 1));

main().catch((err) => exit(`fatal: ${err?.stack || err}`, 1));
