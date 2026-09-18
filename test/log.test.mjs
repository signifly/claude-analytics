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
