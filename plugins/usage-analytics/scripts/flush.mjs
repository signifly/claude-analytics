#!/usr/bin/env node
// Flusher entry point: one per data dir. Takes the flusher lock, drains the
// event buffer into Loki until idle, and makes sure nothing is stranded on exit.
// Spawned on demand by record.mjs; inherits the Loki settings of that session.
import { loadConfig } from "./config.mjs";
import { openBuffer } from "./event-buffer.mjs";
import { drain } from "./drain.mjs";
import { acquire } from "./flusher-lock.mjs";
import { createLog } from "./log.mjs";
import { createLokiSink } from "./loki-sink.mjs";
import { pruneSessions } from "./session-context.mjs";

const SESSION_CACHE_MS = 6 * 24 * 60 * 60 * 1000;

const config = loadConfig();
const { log } = createLog(config.dataDir);

let lock = null;

async function main() {
  const dir = config.dataDir;
  const buffer = openBuffer(dir, { log });
  const sink = createLokiSink({ ...config.loki, log });

  while ((lock = acquire(dir, { log }))) {
    log(`flusher started -> ${config.loki.url}`);
    for (const warning of config.warnings.splice(0)) log(warning);
    pruneSessions(dir, SESSION_CACHE_MS, log);
    const idle = await drain({ buffer, sink, lock, flushMs: config.flushMs, idleExitMs: config.idleExitMs, log });
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
