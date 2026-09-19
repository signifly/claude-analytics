// The hook's whole contract with Claude Code: whatever happens, exit 0 and print nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const record = fileURLToPath(new URL("../plugins/usage-analytics/scripts/record.mjs", import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "record-"));
const payload = (over = {}) => JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s-1", cwd: os.tmpdir(), tool_name: "Read", tool_input: {}, ...over });

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [record], {
    input,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_ANALYTICS_LOKI_URL: "http://127.0.0.1:9", // nothing listens: the flusher fails fast and exits
      CLAUDE_ANALYTICS_IDLE_EXIT_MS: "300",
      CLAUDE_ANALYTICS_FLUSH_MS: "100",
      CLAUDE_ANALYTICS_USER: "test",
      ...env,
    },
  });
}
const silent = (result) => {
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "");
  assert.equal(result.stderr.toString(), "");
};

test("a tool-use payload is appended to the live file, silently", () => {
  const dir = tmpDir();
  silent(runHook(payload(), { CLAUDE_ANALYTICS_DIR: dir }));
  const files = fs.readdirSync(dir).filter((f) => f === "events.jsonl" || f.startsWith("batch-"));
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(path.join(dir, files[0]), "utf8"), /"kind":"tool","name":"Read","user":"test"/);
});

test("a hook event starts a flusher when none is running", async () => {
  const dir = tmpDir();
  silent(runHook(payload(), { CLAUDE_ANALYTICS_DIR: dir }));
  const log = path.join(dir, "flusher.log");
  let started = false;
  for (let waited = 0; waited < 5000 && !started; waited += 50) {
    started = fs.existsSync(log) && /flusher started/.test(fs.readFileSync(log, "utf8"));
    if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(started, "no flusher started");
});

const blockedParent = () => {
  const file = path.join(tmpDir(), "a-file");
  fs.writeFileSync(file, "");
  return path.join(file, "analytics");
};
for (const [what, input, env] of [
  ["stdin that is not JSON", "not json", {}],
  ["empty stdin", "", {}],
  ["a null payload", "null", {}],
  ["a payload of the wrong shape", '{"hook_event_name":"PostToolUse","tool_name":{"a":1},"tool_input":"x","session_id":{}}', {}],
  ["a working directory that no longer exists", payload({ cwd: "/no/such/dir" }), { CLAUDE_ANALYTICS_USER: "" }],
  ["a data dir that cannot be created", payload(), { CLAUDE_ANALYTICS_DIR: blockedParent() }],
  ["no HOME at all", payload(), { HOME: "", CLAUDE_ANALYTICS_DIR: "" }],
]) {
  test(`${what} still exits 0 and prints nothing`, () => {
    silent(runHook(input, { CLAUDE_ANALYTICS_DIR: tmpDir(), ...env }));
  });
}

test("when recording is switched off, nothing is created and nothing is started", () => {
  const dir = path.join(tmpDir(), "analytics");
  silent(runHook(payload(), { CLAUDE_ANALYTICS_DIR: dir, CLAUDE_ANALYTICS_DISABLED: "1" }));
  assert.equal(fs.existsSync(dir), false);
});
