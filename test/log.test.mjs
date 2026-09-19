import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLog, describe } from "../plugins/usage-analytics/scripts/log.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);

test("a repeating condition is logged once per hour, not on every hook event", () => {
  const dir = tmpDir();
  const { file, logOnce } = createLog(dir);
  logOnce("git", "git failed");
  logOnce("git", "git failed");
  assert.equal(lines(file).length, 1);
  const anHourAgo = new Date(Date.now() - 61 * 60 * 1000);
  fs.utimesSync(path.join(dir, ".logged-git"), anHourAgo, anHourAgo);
  logOnce("git", "git failed");
  assert.equal(lines(file).length, 2);
});

test("with an unwritable data dir the log moves to the fallback dir, still throttled and still capped", () => {
  const blocked = path.join(tmpDir(), "a-file");
  fs.writeFileSync(blocked, "");
  const fallbackDir = tmpDir();
  const { log, logOnce } = createLog(path.join(blocked, "analytics"), { fallbackDir, maxBytes: 300 });
  for (let i = 0; i < 5; i++) logOnce("record-EACCES", "record failed: EACCES");
  const fallback = path.join(fallbackDir, "claude-analytics.log");
  assert.equal(lines(fallback).length, 1);
  for (let i = 0; i < 50; i++) log("x".repeat(40));
  assert.ok(fs.statSync(fallback).size < 600, `fallback log grew to ${fs.statSync(fallback).size} bytes`);
});

test("any thrown value becomes one readable line", () => {
  assert.equal(describe(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })), "fetch failed: ECONNREFUSED");
  assert.equal(describe("plain string"), "plain string");
  assert.match(describe({ status: 503 }), /503/);
  assert.equal(typeof describe(Object.create(null)), "string");
  assert.equal(typeof describe(undefined), "string");
});

test("a child process's stderr goes to the log, or to the fallback log when the data dir is unwritable", () => {
  const dir = tmpDir();
  const unusedFallback = tmpDir();
  const { file, log, stderrTarget } = createLog(dir, { fallbackDir: unusedFallback });
  log("flusher started");
  const fd = stderrTarget();
  fs.writeSync(fd, "child crashed\n");
  fs.closeSync(fd);
  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /flusher started/); // appended, not truncated
  assert.match(written, /child crashed/);
  assert.deepEqual(fs.readdirSync(unusedFallback), []);

  const blocked = path.join(tmpDir(), "a-file");
  fs.writeFileSync(blocked, "");
  const fallbackDir = tmpDir();
  const fallbackFd = createLog(path.join(blocked, "analytics"), { fallbackDir }).stderrTarget();
  fs.writeSync(fallbackFd, "child crashed early\n");
  fs.closeSync(fallbackFd);
  assert.match(fs.readFileSync(path.join(fallbackDir, "claude-analytics.log"), "utf8"), /child crashed early/);
});

test("with no writable log anywhere, a child process's stderr is ignored rather than failing", () => {
  const blocked = path.join(tmpDir(), "a-file");
  fs.writeFileSync(blocked, "");
  const { stderrTarget } = createLog(path.join(blocked, "analytics"), { fallbackDir: path.join(blocked, "tmp") });
  assert.equal(stderrTarget(), "ignore");
});

test("a log that cannot be rotated stops growing and later lines go to the capped fallback", { skip: process.getuid?.() === 0 && "root ignores permissions" }, () => {
  const dir = tmpDir();
  const fallbackDir = tmpDir();
  const { file, log } = createLog(dir, { fallbackDir, maxBytes: 300 });
  log("x".repeat(400)); // over the cap: the next write wants to rotate
  const size = fs.statSync(file).size;
  fs.chmodSync(dir, 0o555); // the file stays writable, but it can no longer be renamed to .1
  try {
    for (let i = 0; i < 50; i++) log(`line ${i}`);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.equal(fs.statSync(file).size, size, "the over-cap log kept growing");
  const fallback = path.join(fallbackDir, "claude-analytics.log");
  assert.match(fs.readFileSync(fallback, "utf8"), /line 49/);
  assert.ok(fs.statSync(fallback).size < 600, `fallback grew to ${fs.statSync(fallback).size} bytes`);
});
