// Session context: who and where a session is (user, project, source).
// Resolved once per session and cached on disk, so later events skip the git subprocesses.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe } from "./log.mjs";

// An answer resolved while git itself was failing is only trusted this long.
const PROVISIONAL_MS = 2 * 60 * 1000;
// How long a session's cached context is kept after it was last resolved (cache hits don't refresh it).
const SESSION_CACHE_MS = 6 * 24 * 60 * 60 * 1000;

export function sessionContext({ dir, sessionId, cwd, config, logOnce = () => {}, exec = execFileSync, now = Date.now }) {
  const sessionsDir = path.join(dir, "sessions");
  const file = sessionId && path.join(sessionsDir, `${String(sessionId).replace(/[^\w-]/g, "_").slice(0, 100)}.json`);
  if (file) {
    try {
      const { provisionalAt, ...cached } = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!provisionalAt || now() - provisionalAt < PROVISIONAL_MS) return cached;
    } catch (err) {
      if (err instanceof SyntaxError) logOnce("session-corrupt", "session cache unparseable, resolving again");
      else if (err?.code !== "ENOENT") logOnce("session-read", `session cache unreadable: ${describe(err)}`);
    }
  }

  let gitTrouble = false;
  const git = (...args) => {
    try {
      return String(exec("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 })).trim();
    } catch (err) {
      // A non-zero exit (not a repo, no remote, no email) is an answer. Git
      // missing, timing out or a vanished cwd is not: the result is only
      // cached provisionally, so it is retried later but not on every event.
      if (typeof err?.status !== "number") {
        gitTrouble = true;
        logOnce(`git-${args[0]}`, `git ${args[0]} failed: ${describe(err)}`);
      }
      return "";
    }
  };
  const osUser = () => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER || process.env.USERNAME || ""; // uid without a passwd entry (containers)
    }
  };
  // Last path segment of the origin URL (any credentials sit before it and are never kept),
  // else the repo folder, else the working folder.
  const project = () => {
    const fromRemote = git("remote", "get-url", "origin").match(/([^/:]+?)(?:\.git)?\/?$/)?.[1];
    return fromRemote || path.basename(git("rev-parse", "--show-toplevel") || cwd || "") || "unknown";
  };

  const context = {
    user: config.user || git("config", "user.email") || osUser() || "unknown",
    project: config.project || project(),
    source: config.source,
  };
  if (file) {
    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`; // tmp + rename: concurrent hooks never read a torn file
      fs.writeFileSync(tmp, JSON.stringify(gitTrouble ? { ...context, provisionalAt: now() } : context));
      fs.renameSync(tmp, file);
    } catch (err) {
      logOnce("session-write", `session cache not writable: ${describe(err)}`);
    }
  }
  return context;
}

// Removes cached session contexts untouched for longer than maxAgeMs.
export function pruneSessions(dir, { maxAgeMs = SESSION_CACHE_MS, log = () => {} } = {}) {
  const sessionsDir = path.join(dir, "sessions");
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(sessionsDir)) {
      const file = path.join(sessionsDir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    if (err?.code !== "ENOENT") log(`cannot prune session cache: ${describe(err)}`);
  }
}
