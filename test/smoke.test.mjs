// End to end: the real hook script, a real flusher, a real Loki.
// Skipped unless SMOKE_LOKI_URL is set (CI starts Loki with docker compose).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LOKI = process.env.SMOKE_LOKI_URL;
const record = fileURLToPath(new URL("../plugins/usage-analytics/scripts/record.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a hook payload piped into record.mjs shows up in Loki", { skip: !LOKI && "SMOKE_LOKI_URL not set", timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  const marker = `smoke-${Date.now()}`;
  const payload = { hook_event_name: "PostToolUse", session_id: marker, cwd: dir, tool_name: "Skill", tool_input: { skill: marker, args: "SECRET-ARGS" } };
  const hook = spawnSync(process.execPath, [record], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_ANALYTICS_DIR: dir, CLAUDE_ANALYTICS_LOKI_URL: LOKI, CLAUDE_ANALYTICS_USER: "ci-smoke", CLAUDE_ANALYTICS_IDLE_EXIT_MS: "3000" },
  });
  assert.equal(hook.status, 0);
  assert.equal(hook.stderr.toString(), "");

  const query = new URLSearchParams({ query: `{service_name="claude-code-usage", user="ci-smoke"} |= "${marker}"`, start: `${Date.now() - 60_000}000000` });
  let lines = [];
  for (let attempt = 0; attempt < 20 && !lines.length; attempt++) {
    await sleep(1000);
    const res = await fetch(`${LOKI}/loki/api/v1/query_range?${query}`);
    lines = (await res.json()).data.result.flatMap((stream) => stream.values.map(([, line]) => line));
  }
  assert.equal(lines.length, 1, `flusher log:\n${fs.readFileSync(path.join(dir, "flusher.log"), "utf8")}`);
  assert.deepEqual(JSON.parse(lines[0]), { kind: "skill", name: marker, user: "ci-smoke", project: path.basename(dir), source: "dev", session_id: marker });
});
