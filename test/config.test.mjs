import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../plugins/usage-analytics/scripts/config.mjs";

// The no-home fallback is per user: a shared /tmp must not hold one buffer for everyone.
const tempDataDir = path.join(os.tmpdir(), `claude-analytics-${process.getuid?.() ?? "user"}`);

test("without any settings, events go to ~/.claude/analytics and a local Loki", () => {
  const config = loadConfig({}, { homedir: () => "/home/dev" });
  assert.equal(config.dataDir, "/home/dev/.claude/analytics");
  assert.equal(config.loki.url, "http://localhost:3100");
  assert.equal(config.disabled, false);
  assert.deepEqual(config.warnings, []);
});

test("a machine with no home directory falls back to the temp dir instead of failing", () => {
  const config = loadConfig({}, { homedir: () => { throw new Error("uv_os_homedir returned ENOENT"); } });
  assert.equal(config.dataDir, tempDataDir);
  assert.match(config.warnings.join("\n"), /no home directory/);
});

test("recording is switched off by 1, true or yes, and anything else says so", () => {
  for (const value of ["1", "true", "TRUE", "yes"]) assert.equal(loadConfig({ CLAUDE_ANALYTICS_DISABLED: value }).disabled, true);
  const odd = loadConfig({ CLAUDE_ANALYTICS_DISABLED: "off" });
  assert.equal(odd.disabled, false);
  assert.match(odd.warnings.join("\n"), /CLAUDE_ANALYTICS_DISABLED=off/);
});

test("unusable intervals fall back to the defaults with a warning", () => {
  for (const value of ["abc", "5", "-1"]) {
    const config = loadConfig({ CLAUDE_ANALYTICS_FLUSH_MS: value });
    assert.equal(config.flushMs, 1000);
    assert.match(config.warnings.join("\n"), /CLAUDE_ANALYTICS_FLUSH_MS/);
  }
  assert.equal(loadConfig({ CLAUDE_ANALYTICS_FLUSH_MS: "250" }).flushMs, 250);
});

test("an empty or relative home directory is treated as no home, never as a path inside the working directory", () => {
  for (const home of ["", "relative/home", undefined]) {
    const config = loadConfig({}, { homedir: () => home });
    assert.equal(config.dataDir, tempDataDir, `homedir=${home}`);
    assert.match(config.warnings.join("\n"), /no home directory/);
  }
});

test("credentials written into the Loki URL are dropped from it, and the warning does not repeat them", () => {
  const config = loadConfig({ CLAUDE_ANALYTICS_LOKI_URL: "https://123:s3cr3t@logs.example.net/" });
  assert.equal(config.loki.url, "https://logs.example.net/");
  assert.match(config.warnings.join("\n"), /CLAUDE_ANALYTICS_LOKI_BASIC_AUTH/);
  assert.ok(!JSON.stringify(config).includes("s3cr3t"));
});

test("credentials are only sent over https, or over http to this machine", () => {
  for (const url of ["https://logs.example.net", "http://localhost:3100", "http://127.0.0.1:3100", "http://[::1]:3100"]) {
    const config = loadConfig({ CLAUDE_ANALYTICS_LOKI_URL: url, CLAUDE_ANALYTICS_LOKI_BASIC_AUTH: "u:p", CLAUDE_ANALYTICS_LOKI_TOKEN: "t0k" });
    assert.equal(config.loki.basicAuth, "u:p", url);
    assert.equal(config.loki.token, "t0k", url);
  }
  for (const url of ["http://logs.example.net:3100", "http://host.docker.internal:3100", "not a url"]) {
    const config = loadConfig({ CLAUDE_ANALYTICS_LOKI_URL: url, CLAUDE_ANALYTICS_LOKI_BASIC_AUTH: "u:p", CLAUDE_ANALYTICS_LOKI_TOKEN: "t0k" });
    assert.equal(config.loki.basicAuth, "", url);
    assert.equal(config.loki.token, "", url);
    assert.match(config.warnings.join("\n"), /not sending credentials/, url);
  }
});

test("an empty value means unset, so managed settings can pin a variable without a warning", () => {
  const config = loadConfig({ CLAUDE_ANALYTICS_FLUSH_MS: "", CLAUDE_ANALYTICS_IDLE_EXIT_MS: "", CLAUDE_ANALYTICS_DIR: "", CLAUDE_ANALYTICS_LOKI_TOKEN: "" }, { homedir: () => "/home/dev" });
  assert.equal(config.flushMs, 1000);
  assert.equal(config.dataDir, "/home/dev/.claude/analytics");
  assert.deepEqual(config.warnings, []);
});
