// Session context: who and where a session is (user, project, source).
// Resolved once per session and cached on disk, so later events skip the git subprocesses.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function sessionContext({ dir, sessionId, cwd, config, logOnce = () => {} }) {
  const sessionsDir = path.join(dir, "sessions");
  const file = sessionId && path.join(sessionsDir, `${String(sessionId).replace(/[^\w-]/g, "_")}.json`);
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT" && !(err instanceof SyntaxError)) logOnce("session-read", `session cache unreadable: ${err?.code}`);
    }
  }

  let gitTrouble = false;
  const git = (...args) => {
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
  };
  const osUser = () => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER || process.env.USERNAME || ""; // uid without a passwd entry (containers)
    }
  };
  const project = () => {
    const fromRemote = git("remote", "get-url", "origin").match(/([^/:]+?)(?:\.git)?\/?$/)?.[1];
    return fromRemote || path.basename(git("rev-parse", "--show-toplevel") || cwd || "") || "unknown";
  };

  const context = {
    user: config.user || git("config", "user.email") || osUser() || "unknown",
    project: config.project || project(),
    source: config.source,
  };
  if (file && !gitTrouble) {
    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`; // tmp + rename: concurrent hooks never read a torn file
      fs.writeFileSync(tmp, JSON.stringify(context));
      fs.renameSync(tmp, file);
    } catch (err) {
      logOnce("session-write", `session cache not writable: ${err?.code}`);
    }
  }
  return context;
}

export function pruneSessions(dir, maxAgeMs, log = () => {}) {
  const sessionsDir = path.join(dir, "sessions");
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(sessionsDir)) {
      const file = path.join(sessionsDir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    if (err?.code !== "ENOENT") log(`cannot prune session cache: ${err?.code || err?.message}`);
  }
}
