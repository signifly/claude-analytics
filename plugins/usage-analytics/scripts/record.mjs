#!/usr/bin/env node
// Claude Code hook entry point: hook payload on stdin → at most one usage
// event appended to the buffer. Starts the flusher if none is running.
// Never talks to the network.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { openBuffer } from "./event-buffer.mjs";
import { isHeld } from "./flusher-lock.mjs";
import { createLog, describe } from "./log.mjs";
import { sessionContext } from "./session-context.mjs";
import { toEvent } from "./usage-event.mjs";

const config = loadConfig();
const { file: logFile, log, logOnce } = createLog(config.dataDir);

function startFlusher() {
  const flusher = path.join(path.dirname(fileURLToPath(import.meta.url)), "flush.mjs");
  let stderr = "ignore";
  try {
    stderr = fs.openSync(logFile, "a"); // catches crashes before the flusher can log
  } catch {}
  const child = spawn(process.execPath, [flusher], { detached: true, stdio: ["ignore", "ignore", stderr] });
  // Spawn failures are asynchronous: without this they'd crash the hook.
  child.on("error", (err) => log(`flusher spawn failed: ${describe(err)}`));
  child.unref();
}

function main() {
  if (config.disabled) return;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (err) {
    return logOnce("stdin", `unreadable hook payload: ${err?.message}`);
  }

  const dir = config.dataDir;
  const context = () => sessionContext({ dir, sessionId: payload.session_id, cwd: payload.cwd, config, logOnce });
  const event = toEvent(payload, context);
  if (!event) return;

  if (!openBuffer(dir, { log }).append(event)) logOnce("buffer-full", "live file is over its size cap, refusing new events until the flusher claims it");
  if (!isHeld(dir)) startFlusher();
}

try {
  main();
} catch (err) {
  // Analytics must never surface errors into a session; leave a trace instead.
  log(`record failed: ${describe(err)}`);
}
