import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../plugins/usage-analytics/scripts/config.mjs";

test("without any settings, events go to ~/.claude/analytics and a local Loki", () => {
  const config = loadConfig({}, { homedir: () => "/home/dev" });
  assert.equal(config.dataDir, "/home/dev/.claude/analytics");
  assert.equal(config.loki.url, "http://localhost:3100");
  assert.equal(config.disabled, false);
  assert.deepEqual(config.warnings, []);
});

test("a machine with no home directory falls back to the temp dir instead of failing", () => {
  const config = loadConfig({}, { homedir: () => { throw new Error("uv_os_homedir returned ENOENT"); } });
  assert.equal(config.dataDir, path.join(os.tmpdir(), "claude-analytics"));
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
