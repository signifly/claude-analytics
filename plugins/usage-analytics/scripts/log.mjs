// The only diagnostics channel for the hooks and the flusher. Best-effort and
// never throws: analytics must not surface errors into a session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;
const ONCE_MS = 60 * 60 * 1000;

// One line for any error: its message plus the code or cause that explains it.
export function describe(err) {
  const cause = err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.cause?.message;
  return [err?.code && !String(err?.message).includes(err.code) ? err.code : "", err?.message ?? String(err), cause].filter(Boolean).join(": ");
}

export function createLog(dir) {
  const file = path.join(dir, "flusher.log");

  function log(msg) {
    const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {}
      fs.appendFileSync(file, line);
    } catch {
      try {
        fs.appendFileSync(path.join(os.tmpdir(), "claude-analytics.log"), line); // data dir unwritable
      } catch {}
    }
  }

  // At most once per hour per key, for conditions that would otherwise repeat on every hook event.
  function logOnce(key, msg) {
    const marker = path.join(dir, `.logged-${key}`);
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs < ONCE_MS) return;
    } catch {}
    log(msg);
    try {
      fs.writeFileSync(marker, "");
    } catch {}
  }

  return { file, log, logOnce };
}
