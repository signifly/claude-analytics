// Every CLAUDE_ANALYTICS_* environment variable the plugin reads, in one place.
// Never throws: problems become `warnings` for the caller to log.
import os from "node:os";
import path from "node:path";

function ms(env, name, fallback, warnings) {
  if (env[name] === undefined) return fallback;
  const value = Number(env[name]);
  if (Number.isFinite(value) && value >= 100) return value;
  warnings.push(`ignoring invalid ${name}=${env[name]}, using ${fallback}`);
  return fallback;
}

function disabled(env, warnings) {
  const value = String(env.CLAUDE_ANALYTICS_DISABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(value)) return true;
  if (value) warnings.push(`CLAUDE_ANALYTICS_DISABLED=${env.CLAUDE_ANALYTICS_DISABLED} is not 1/true/yes: still recording`);
  return false;
}

function dataDir(env, homedir, warnings) {
  if (env.CLAUDE_ANALYTICS_DIR) return env.CLAUDE_ANALYTICS_DIR;
  try {
    return path.join(homedir(), ".claude", "analytics");
  } catch {
    // No HOME and no passwd entry for the uid: common in containers.
    warnings.push("no home directory, keeping the event buffer in the temp dir (set CLAUDE_ANALYTICS_DIR)");
    return path.join(os.tmpdir(), "claude-analytics");
  }
}

export function loadConfig(env = process.env, { homedir = os.homedir } = {}) {
  const warnings = [];
  const token = env.CLAUDE_ANALYTICS_LOKI_TOKEN || "";
  const basicAuth = env.CLAUDE_ANALYTICS_LOKI_BASIC_AUTH || "";
  if (token && basicAuth) warnings.push("both CLAUDE_ANALYTICS_LOKI_TOKEN and _LOKI_BASIC_AUTH are set: using the token");
  return {
    disabled: disabled(env, warnings),
    dataDir: dataDir(env, homedir, warnings),
    user: env.CLAUDE_ANALYTICS_USER || "",
    project: env.CLAUDE_ANALYTICS_PROJECT || "",
    source: env.CLAUDE_ANALYTICS_SOURCE || "dev",
    loki: { url: env.CLAUDE_ANALYTICS_LOKI_URL || "http://localhost:3100", token, basicAuth, tenant: env.CLAUDE_ANALYTICS_LOKI_TENANT || "" },
    flushMs: ms(env, "CLAUDE_ANALYTICS_FLUSH_MS", 1000, warnings),
    idleExitMs: ms(env, "CLAUDE_ANALYTICS_IDLE_EXIT_MS", 10 * 60 * 1000, warnings),
    warnings,
  };
}
