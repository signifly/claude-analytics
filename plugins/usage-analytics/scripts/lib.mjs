import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;

export const DISABLED = env.CLAUDE_ANALYTICS_DISABLED === "1";
export const DATA_DIR = env.CLAUDE_ANALYTICS_DIR || path.join(os.homedir(), ".claude", "analytics");
export const BUFFER_FILE = path.join(DATA_DIR, "events.jsonl");
export const PID_FILE = path.join(DATA_DIR, "flusher.pid");
export const LOG_FILE = path.join(DATA_DIR, "flusher.log");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const DEAD_DIR = path.join(DATA_DIR, "dead");

export const LOKI_URL = (env.CLAUDE_ANALYTICS_LOKI_URL || "http://localhost:3100").replace(/\/+$/, "");
export const SERVICE_NAME = "claude-code-usage";

// Writers stop appending and the flusher evicts oldest batches beyond this, so
// an unreachable Loki can never fill the disk.
export const MAX_BACKLOG_BYTES = 50 * 1024 * 1024;
// The flusher touches its pid file every loop; a lock older than this is dead
// regardless of what the pid says (covers pid reuse after a crash or reboot).
export const LOCK_STALE_MS = 3 * 60 * 1000;

const MAX_LOG_BYTES = 1024 * 1024;

export function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Best-effort, never throws: the only diagnostics channel for both the hooks
// and the flusher. Falls back to the OS temp dir if DATA_DIR is unwritable.
export function log(msg) {
  const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
  try {
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    try {
      fs.appendFileSync(path.join(os.tmpdir(), "claude-analytics.log"), line);
    } catch {}
  }
}

// Same as log(), but at most once per hour per key, for conditions that would
// otherwise repeat on every hook event.
export function logOnce(key, msg) {
  const marker = path.join(DATA_DIR, `.logged-${key}`);
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < 60 * 60 * 1000) return;
  } catch {}
  log(msg);
  try {
    fs.writeFileSync(marker, "");
  } catch {}
}

// Names end up as Loki query dimensions: keep them to a bare identifier so no
// free-form text (arguments, paths) can ever be recorded through them.
export function bareName(value) {
  const token = String(value ?? "").trim().split(/\s/, 1)[0].replace(/^\//, "");
  return /^[\w:.-]{1,100}$/.test(token) ? token : "unknown";
}

let gitTrouble = false;

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch (err) {
    // A non-zero exit (not a repo, no remote, no email) is expected; git
    // missing or timing out is not, and must not be cached as the answer.
    if (typeof err?.status !== "number") {
      gitTrouble = true;
      logOnce("git", `git ${args[0]} failed: ${err?.code || err?.message}`);
    }
    return "";
  }
}

function osUser() {
  try {
    return os.userInfo().username;
  } catch {
    return env.USER || env.USERNAME || ""; // uid without a passwd entry (containers)
  }
}

function resolveUser(cwd) {
  if (env.CLAUDE_ANALYTICS_USER) return env.CLAUDE_ANALYTICS_USER;
  return git(cwd, ["config", "user.email"]) || osUser() || "unknown";
}

function resolveProject(cwd) {
  if (env.CLAUDE_ANALYTICS_PROJECT) return env.CLAUDE_ANALYTICS_PROJECT;
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  const fromRemote = remote.match(/([^/:]+?)(?:\.git)?\/?$/)?.[1];
  if (fromRemote) return fromRemote;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return path.basename(root || cwd || "") || "unknown";
}

// Identity and project are resolved once per session and cached on disk, so
// later events skip the git subprocesses.
export function sessionContext(sessionId, cwd) {
  const file = sessionId && path.join(SESSIONS_DIR, `${String(sessionId).replace(/[^\w-]/g, "_")}.json`);
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT" && !(err instanceof SyntaxError)) logOnce("session-read", `session cache unreadable: ${err?.code}`);
    }
  }
  gitTrouble = false;
  const ctx = {
    user: resolveUser(cwd),
    project: resolveProject(cwd),
    source: env.CLAUDE_ANALYTICS_SOURCE || "dev",
  };
  if (file && !gitTrouble) {
    try {
      // tmp + rename: concurrent hooks of one session never read a torn file
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(ctx));
      fs.renameSync(tmp, file);
    } catch (err) {
      logOnce("session-write", `session cache not writable: ${err?.code}`);
    }
  }
  return ctx;
}

export function readLockPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

// A flusher is alive only if the lock names a valid pid, that process exists,
// and the lock's heartbeat is fresh.
export function flusherAlive() {
  const pid = readLockPid();
  if (!pid) return false;
  try {
    if (Date.now() - fs.statSync(PID_FILE).mtimeMs > LOCK_STALE_MS) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // exists but not signalable (sandbox); heartbeat is fresh
  }
}
