// Every CLAUDE_ANALYTICS_* environment variable the plugin reads, in one place.
// Never throws: problems become `warnings` for the caller to log.
import os from "node:os";
import path from "node:path";

function ms(env, name, fallback, warnings) {
  if (env[name] === undefined || env[name] === "") return fallback;
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
    // HOME="" makes os.homedir() return "" rather than throw; joining that
    // would put the buffer inside whatever directory the session runs in.
    const home = homedir();
    if (typeof home === "string" && path.isAbsolute(home)) return path.join(home, ".claude", "analytics");
  } catch {}
  {
    // No usable HOME and no passwd entry for the uid: common in containers.
    warnings.push("no home directory, keeping the event buffer in the temp dir (set CLAUDE_ANALYTICS_DIR)");
    // Per user: on a shared /tmp, one fixed name would let anyone read or plant the buffer.
    return path.join(os.tmpdir(), `claude-analytics-${process.getuid?.() ?? "user"}`);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Where events go, and whether the credentials may go with them. The URL is
// logged, so credentials written into it are dropped; and they are only sent
// over https or to this machine, never in clear text across a network.
function loki(env, warnings) {
  let url = env.CLAUDE_ANALYTICS_LOKI_URL || "http://localhost:3100";
  let token = env.CLAUDE_ANALYTICS_LOKI_TOKEN || "";
  let basicAuth = env.CLAUDE_ANALYTICS_LOKI_BASIC_AUTH || "";
  if (token && basicAuth) warnings.push("both CLAUDE_ANALYTICS_LOKI_TOKEN and _LOKI_BASIC_AUTH are set: using the token");
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {}
  if (parsed && (parsed.username || parsed.password)) {
    warnings.push("CLAUDE_ANALYTICS_LOKI_URL holds credentials: dropped them, set CLAUDE_ANALYTICS_LOKI_BASIC_AUTH instead");
    parsed.username = parsed.password = "";
    url = parsed.href;
  }
  const safe = parsed && (parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)));
  if ((token || basicAuth) && !safe) {
    warnings.push("CLAUDE_ANALYTICS_LOKI_URL is not https or this machine: not sending credentials to it");
    token = basicAuth = "";
  }
  return { url, token, basicAuth, tenant: env.CLAUDE_ANALYTICS_LOKI_TENANT || "" };
}

export function loadConfig(env = process.env, { homedir = os.homedir } = {}) {
  const warnings = [];
  return {
    disabled: disabled(env, warnings),
    dataDir: dataDir(env, homedir, warnings),
    user: env.CLAUDE_ANALYTICS_USER || "",
    project: env.CLAUDE_ANALYTICS_PROJECT || "",
    source: env.CLAUDE_ANALYTICS_SOURCE || "dev",
    loki: loki(env, warnings),
    flushMs: ms(env, "CLAUDE_ANALYTICS_FLUSH_MS", 1000, warnings),
    idleExitMs: ms(env, "CLAUDE_ANALYTICS_IDLE_EXIT_MS", 10 * 60 * 1000, warnings),
    warnings,
  };
}
