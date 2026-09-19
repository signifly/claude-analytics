// Flusher lock: guarantees one flusher per data dir. A pid file with a
// heartbeat; the single place that knows what "a flusher is alive" means.
import fs from "node:fs";
import path from "node:path";
import { describe } from "./log.mjs";

// The holder touches the lock on every stillMine(); a lock older than this is
// dead whatever its pid says (covers pid reuse after a crash or reboot).
const DEFAULT_STALE_MS = 3 * 60 * 1000;

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

const pidFile = (dir) => path.join(dir, "flusher.pid");

// Thrown by readPid when the lock exists but cannot be read (EIO, EMFILE,
// EISDIR…). That is not evidence of a stale lock, so nobody acts on it.
class Unreadable extends Error {}

function readPid(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw new Unreadable(describe(err));
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : 0; // pid 0 would signal our whole process group
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
  try {
    return heldBy(pidFile(dir), staleMs) !== 0;
  } catch {
    return true; // unreadable: assume held rather than start a flusher that could not take it anyway
  }
}

// Returns a lock handle, or null if a live flusher already holds the dir or
// the lock could not be created (logged). The holder must call stillMine()
// more often than staleMs; drain does so at least every 60 s.
export function acquire(dir, { staleMs = DEFAULT_STALE_MS, log = () => {}, link = fs.linkSync } = {}) {
  const file = pidFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      // tmp + hard link: a lock created here is never seen half-written.
      fs.writeFileSync(tmp, String(process.pid));
      try {
        link(tmp, file);
        return handle(file, log);
      } catch (err) {
        if (NO_HARD_LINKS.has(err?.code)) {
          // Exclusive create is just as exclusive; the file is only briefly empty,
          // which readers treat as "no valid holder yet".
          try {
            fs.writeFileSync(file, String(process.pid), { flag: "wx" });
            return handle(file, log);
          } catch (wxErr) {
            if (wxErr?.code !== "EEXIST") return log(`cannot create lock: ${describe(wxErr)}`), null;
          }
        } else if (err?.code !== "EEXIST") {
          return log(`cannot create lock: ${describe(err)}`), null;
        }
      }
      if (heldBy(file, staleMs)) return null;
      // Narrows the race with another flusher taking over at the same moment; the
      // window that remains is covered by stillMine() before every push.
      const stale = readPid(file);
      if (!heldBy(file, staleMs) && readPid(file) === stale) {
        log(`taking over stale lock (pid ${stale || "invalid"})`);
        fs.rmSync(file, { force: true });
      }
    }
    log("could not acquire lock after 3 attempts");
    return null;
  } catch (err) {
    log(err instanceof Unreadable ? `cannot read lock, leaving it alone: ${err.message}` : `lock error: ${describe(err)}`);
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

function handle(file, log) {
  // A read hiccup is not a takeover: keep the lock until another pid is actually seen in it.
  const mine = () => {
    try {
      return readPid(file) === process.pid;
    } catch {
      return true;
    }
  };
  let heartbeatFailed = false;
  return {
    // True while this process still owns the lock; also beats the heartbeat,
    // so a holder that keeps checking can't forget to.
    stillMine() {
      if (!mine()) return false;
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch (err) {
        if (!heartbeatFailed) log(`cannot refresh lock heartbeat (${describe(err)}); another flusher may take over`);
        heartbeatFailed = true;
      }
      return true;
    },
    release() {
      try {
        if (readPid(file) === process.pid) fs.rmSync(file); // only a lock we can positively read as ours
      } catch (err) {
        log(`cannot release lock: ${describe(err)}`);
      }
    },
  };
}

// The hook's one question: start a flusher now? Checks the lock first, so a
// running flusher doesn't use up the spawn throttle.
export function mayStartFlusher(dir) {
  return !isHeld(dir) && spawnAllowed(dir);
}

// Throttle for whoever starts flushers: true at most once per interval. A
// flusher that dies at startup (bad install, broken lock) would otherwise be
// respawned on every hook event. Errs towards allowing.
export function spawnAllowed(dir, { minIntervalMs = 5000 } = {}) {
  const marker = path.join(dir, ".flusher-spawned");
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < minIntervalMs) return false;
  } catch {}
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, "");
  } catch {}
  return true;
}
