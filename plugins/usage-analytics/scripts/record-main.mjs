// The hook's work: hook payload on stdin → at most one usage event appended to
// the buffer. Starts the flusher if none is running. Never talks to the network.
// Loaded by record.mjs, which guarantees the exit-0-and-silent contract.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { openBuffer } from "./event-buffer.mjs";
import { mayStartFlusher } from "./flusher-lock.mjs";
import { createLog, describe } from "./log.mjs";
import { sessionContext } from "./session-context.mjs";
import { toEvent } from "./usage-event.mjs";

function startFlusher(stderr, log) {
  const flusher = path.join(path.dirname(fileURLToPath(import.meta.url)), "flush.mjs");
  const child = spawn(process.execPath, [flusher], { detached: true, stdio: ["ignore", "ignore", stderr] });
  // Spawn failures are asynchronous: without this they'd crash the hook.
  child.on("error", (err) => log(`flusher spawn failed: ${describe(err)}`));
  child.unref();
}

function main() {
  const config = loadConfig();
  if (config.disabled) return;
  const dir = config.dataDir;
  const { log, logOnce, stderrTarget } = createLog(dir);
  try {
    for (const warning of config.warnings) logOnce(`config-${warning.slice(0, 40)}`, warning);

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch (err) {
      return logOnce("stdin", `unreadable hook payload: ${describe(err)}`);
    }
    if (!payload || typeof payload !== "object") return logOnce("stdin", "hook payload is not an object");

    const context = () => sessionContext({ dir, sessionId: payload.session_id, cwd: payload.cwd, config, logOnce });
    const event = toEvent(payload, context);
    if (!event) return;

    // Each hook event is a new process, so the buffer's own once-per-process
    // suppression does not help here: throttle its messages per kind instead.
    const bufferLog = (msg) => logOnce(`buffer-${String(msg).split(":")[0].slice(0, 60)}`, msg);
    if (!openBuffer(dir, { log: bufferLog }).append(event)) logOnce("buffer-full", "live file is over its size cap, refusing new events until the flusher claims it");
    if (mayStartFlusher(dir)) startFlusher(stderrTarget(), log);
  } catch (err) {
    // Analytics must never surface errors into a session; leave a trace instead
    // (throttled: a broken data dir would otherwise log on every hook event).
    logOnce(`record-${err?.code || "error"}`, `record failed: ${describe(err)}`);
  }
}

main(); // record.mjs catches anything that escapes, including a failure to load this module
