// Flusher lock: guarantees one flusher per data dir. A pid file with a
// heartbeat; the single place that knows what "a flusher is alive" means.
import fs from "node:fs";
import path from "node:path";

// The holder touches the lock on every stillMine(); a lock older than this is
// dead whatever its pid says (covers pid reuse after a crash or reboot).
const DEFAULT_STALE_MS = 3 * 60 * 1000;

const pidFile = (dir) => path.join(dir, "flusher.pid");

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0; // never hand 0 or NaN to process.kill
  } catch {
    return 0;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // exists but not signalable (sandbox)
  }
}

function heldBy(file, staleMs) {
  const pid = readPid(file);
  if (!pid) return 0;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > staleMs) return 0;
  } catch {
    return 0;
  }
  return processExists(pid) ? pid : 0;
}

export function isHeld(dir, { staleMs = DEFAULT_STALE_MS } = {}) {
  return heldBy(pidFile(dir), staleMs) !== 0;
}

// Returns a lock handle, or null if a live flusher already holds the dir.
export function acquire(dir, { staleMs = DEFAULT_STALE_MS, log = () => {} } = {}) {
  const file = pidFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      // tmp + hard link: the lock appears complete or not at all, never empty.
      fs.writeFileSync(tmp, String(process.pid));
      try {
        fs.linkSync(tmp, file);
        return handle(file);
      } catch (err) {
        if (err?.code !== "EEXIST") {
          log(`cannot create lock: ${err?.code || err?.message}`);
          return null;
        }
      }
      if (heldBy(file, staleMs)) return null;
      // Only remove the lock we just judged stale, not one a racing flusher created since.
      const stale = readPid(file);
      if (!heldBy(file, staleMs) && readPid(file) === stale) {
        log(`taking over stale lock (pid ${stale || "invalid"})`);
        fs.rmSync(file, { force: true });
      }
    }
    log("could not acquire lock after 3 attempts");
    return null;
  } catch (err) {
    log(`lock error: ${err?.code || err?.message}`);
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function handle(file) {
  const mine = () => readPid(file) === process.pid;
  return {
    // True while this process still owns the lock; also beats the heartbeat,
    // so a holder that keeps checking can't forget to.
    stillMine() {
      if (!mine()) return false;
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch {}
      return true;
    },
    release() {
      try {
        if (mine()) fs.rmSync(file);
      } catch {}
    },
  };
}
