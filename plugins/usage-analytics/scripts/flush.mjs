#!/usr/bin/env node
// Flusher entry point: one per data dir. Takes the flusher lock and drains the
// event buffer into Loki until idle; after releasing the lock it re-checks the
// live file, so an event appended during shutdown is not stranded.
// Spawned on demand by record.mjs; inherits the Loki settings of that session.
import fs from "node:fs";
import { loadConfig } from "./config.mjs";
import { openBuffer } from "./event-buffer.mjs";
import { drain } from "./drain.mjs";
import { acquire } from "./flusher-lock.mjs";
import { createLog } from "./log.mjs";
import { createLokiSink } from "./loki-sink.mjs";
import { pruneSessions } from "./session-context.mjs";

process.umask(0o077); // the buffer and log are the user's alone

const config = loadConfig();
const { log } = createLog(config.dataDir);

let lock = null;

async function main() {
  const dir = config.dataDir;
  // Versions before 0.4.3 created the default data dir world-readable. A configured
  // dir is left alone: it may be shared on purpose.
  if (!process.env.CLAUDE_ANALYTICS_DIR) fs.chmod(dir, 0o700, () => {});
  const buffer = openBuffer(dir, { log });
  const sink = createLokiSink({ ...config.loki, log });

  while ((lock = acquire(dir, { log }))) {
    log(`flusher started -> ${config.loki.url}`);
    for (const warning of config.warnings.splice(0)) log(warning);
    pruneSessions(dir, { log });
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
