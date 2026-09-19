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

// Every hook gets its own TMPDIR: the temp dir is where the log, its throttle
// markers and (with no home) the whole buffer fall back to, and the machine's
// real one may hold a live buffer. The result says which dir was used.
function runHook(input, env = {}) {
  const tmp = env.TMPDIR ?? tmpDir();
  const result = spawnSync(process.execPath, [record], {
    input,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: tmp,
      CLAUDE_ANALYTICS_LOKI_URL: "http://127.0.0.1:9", // nothing listens: the flusher fails fast and exits
      CLAUDE_ANALYTICS_IDLE_EXIT_MS: "300",
      CLAUDE_ANALYTICS_FLUSH_MS: "100",
      CLAUDE_ANALYTICS_USER: "test",
      ...env,
    },
  });
  return { ...result, tmp };
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

test("an unreadable data dir leaves one line per kind of problem, not one per hook event", { skip: process.getuid?.() === 0 && "root ignores permissions" }, () => {
  const dir = path.join(tmpDir(), "analytics");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o000);
  const fallback = tmpDir(); // the log falls back to $TMPDIR when the data dir is unusable
  try {
    for (let i = 0; i < 5; i++) silent(runHook(payload(), { CLAUDE_ANALYTICS_DIR: dir, TMPDIR: fallback }));
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  const log = fs.readFileSync(path.join(fallback, "claude-analytics.log"), "utf8");
  assert.equal(log.split("\n").filter((l) => l.includes("cannot stat")).length, 1, log);
  assert.match(log, /record failed/);
});

test("with no home, the buffer and the log land in the temp dir the hook was given, never the machine's own", () => {
  const result = runHook(payload(), { HOME: "", CLAUDE_ANALYTICS_DIR: "" });
  silent(result);
  assert.ok(result.tmp, "runHook must give every hook its own TMPDIR");
  const fallbackDir = path.join(result.tmp, "claude-analytics");
  const held = fs.readdirSync(fallbackDir).filter((f) => f === "events.jsonl" || f.startsWith("batch-"));
  assert.equal(held.length, 1);
  assert.match(fs.readFileSync(path.join(fallbackDir, held[0]), "utf8"), /"user":"test"/);
});

test("with a data dir that cannot be created, the fallback log lands in the temp dir the hook was given", () => {
  const result = runHook(payload(), { CLAUDE_ANALYTICS_DIR: blockedParent() });
  silent(result);
  assert.ok(result.tmp, "runHook must give every hook its own TMPDIR");
  assert.match(fs.readFileSync(path.join(result.tmp, "claude-analytics.log"), "utf8"), /record failed/);
});

test("with a read-only data dir, hook events start at most one doomed flusher per interval", { skip: process.getuid?.() === 0 && "root ignores permissions" }, async () => {
  const dir = path.join(tmpDir(), "analytics");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "events.jsonl"), ""); // appends still work; nothing else can be created
  fs.chmodSync(dir, 0o555);
  const tmp = tmpDir();
  const lockErrors = () => {
    const file = path.join(tmp, "claude-analytics.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("lock error")).length : 0;
  };
  try {
    for (let i = 0; i < 6; i++) silent(runHook(payload(), { CLAUDE_ANALYTICS_DIR: dir, TMPDIR: tmp }));
    for (let waited = 0; waited < 5000 && lockErrors() === 0; waited += 50) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1000)); // let any further flushers reach the lock
    assert.equal(lockErrors(), 1, fs.readFileSync(path.join(tmp, "claude-analytics.log"), "utf8"));
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});
