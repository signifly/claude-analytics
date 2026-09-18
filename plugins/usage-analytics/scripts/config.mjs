// Every environment variable the plugin reads, in one place.
import os from "node:os";
import path from "node:path";

function ms(env, name, fallback, warnings) {
  if (env[name] === undefined) return fallback;
  const value = Number(env[name]);
  if (Number.isFinite(value) && value >= 100) return value;
  warnings.push(`ignoring invalid ${name}=${env[name]}, using ${fallback}`);
  return fallback;
}

export function loadConfig(env = process.env) {
  const warnings = [];
  return {
    disabled: env.CLAUDE_ANALYTICS_DISABLED === "1",
    dataDir: env.CLAUDE_ANALYTICS_DIR || path.join(os.homedir(), ".claude", "analytics"),
    user: env.CLAUDE_ANALYTICS_USER || "",
    project: env.CLAUDE_ANALYTICS_PROJECT || "",
    source: env.CLAUDE_ANALYTICS_SOURCE || "dev",
    loki: {
      url: env.CLAUDE_ANALYTICS_LOKI_URL || "http://localhost:3100",
      token: env.CLAUDE_ANALYTICS_LOKI_TOKEN || "",
      basicAuth: env.CLAUDE_ANALYTICS_LOKI_BASIC_AUTH || "",
      tenant: env.CLAUDE_ANALYTICS_LOKI_TENANT || "",
    },
    flushMs: ms(env, "CLAUDE_ANALYTICS_FLUSH_MS", 1000, warnings),
    idleExitMs: ms(env, "CLAUDE_ANALYTICS_IDLE_EXIT_MS", 10 * 60 * 1000, warnings),
    warnings,
  };
}
