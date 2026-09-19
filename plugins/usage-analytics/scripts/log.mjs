// The only diagnostics channel for the hooks and the flusher. Best-effort and
// never throws: analytics must not surface errors into a session.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const MAX_LOG_BYTES = 1024 * 1024;
const ONCE_MS = 60 * 60 * 1000;

// One line for any thrown value: its message plus the code or cause that explains it.
export function describe(err) {
  try {
    if (typeof err === "string") return err;
    if (!(err instanceof Error)) return util.inspect(err, { depth: 1, breakLength: Infinity });
    const cause = err.cause?.code || err.cause?.errors?.[0]?.code || err.cause?.message;
    const code = err.code && !String(err.message).includes(err.code) ? err.code : "";
    return [code, err.message, cause].filter(Boolean).join(": ");
  } catch {
    return "undescribable error";
  }
}

export function createLog(dir, { fallbackDir = os.tmpdir(), maxBytes = MAX_LOG_BYTES } = {}) {
  const file = path.join(dir, "flusher.log");
  const fallbackFile = path.join(fallbackDir, "claude-analytics.log");

  // Appends with a size cap: the previous generation is kept as <file>.1.
  function write(target, line) {
    try {
      if (fs.statSync(target).size > maxBytes) fs.renameSync(target, `${target}.1`);
    } catch {}
    fs.appendFileSync(target, line);
  }

  function log(msg) {
    const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      write(file, line);
    } catch {
      try {
        write(fallbackFile, line); // data dir unwritable
      } catch {}
    }
  }

  // At most once per hour per key, for conditions that would otherwise repeat
  // on every hook event. The marker falls back too, or an unwritable data dir
  // would turn the throttle off exactly when it is needed.
  function logOnce(key, msg) {
    const name = `.logged-${String(key).replace(/[^\w.-]/g, "_")}`;
    const markers = [
      path.join(dir, name),
      path.join(fallbackDir, `claude-analytics${name}-${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 8)}`),
    ];
    for (const marker of markers) {
      try {
        if (Date.now() - fs.statSync(marker).mtimeMs < ONCE_MS) return;
      } catch {}
    }
    log(msg);
    for (const marker of markers) {
      try {
        fs.writeFileSync(marker, "");
        return;
      } catch {}
    }
  }

  // A file descriptor for a child process's stderr, so a crash before it can
  // log for itself still leaves a trace. "ignore" when neither log is writable.
  function stderrTarget() {
    for (const target of [file, fallbackFile]) {
      try {
        return fs.openSync(target, "a");
      } catch {}
    }
    return "ignore";
  }

  return { file, log, logOnce, stderrTarget };
}
