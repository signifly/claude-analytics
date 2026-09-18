import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquire, isHeld } from "../plugins/usage-analytics/scripts/flusher-lock.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "flusher-lock-"));
const pidFile = (dir) => path.join(dir, "flusher.pid");
const DEAD_PID = 999_999; // beyond macOS's pid range and far above anything a test machine hands out
const LIVE_FOREIGN_PID = process.ppid;
const longAgo = new Date(Date.now() - 60 * 60 * 1000);

test("a free data dir can be locked, and is free again after release", () => {
  const dir = tmpDir();
  assert.equal(isHeld(dir), false);
  const lock = acquire(dir);
  assert.ok(lock);
  assert.equal(isHeld(dir), true);
  lock.release();
  assert.equal(isHeld(dir), false);
});

test("a held dir cannot be locked a second time", () => {
  const dir = tmpDir();
  const lock = acquire(dir);
  assert.equal(acquire(dir), null);
  lock.release();
});

test("a live flusher's lock is respected", () => {
  const dir = tmpDir();
  fs.writeFileSync(pidFile(dir), String(LIVE_FOREIGN_PID));
  assert.equal(isHeld(dir), true);
  assert.equal(acquire(dir), null);
  assert.equal(fs.readFileSync(pidFile(dir), "utf8"), String(LIVE_FOREIGN_PID));
});

for (const [what, content] of [["empty", ""], ["garbage", "not-a-pid"], ["zero", "0"], ["negative", "-1"]]) {
  test(`an ${what} lock file does not block a new flusher`, () => {
    const dir = tmpDir();
    fs.writeFileSync(pidFile(dir), content);
    assert.equal(isHeld(dir), false);
    const lock = acquire(dir);
    assert.ok(lock);
    assert.equal(isHeld(dir), true);
    lock.release();
  });
}

test("a lock left by a dead process is taken over", () => {
  const dir = tmpDir();
  fs.writeFileSync(pidFile(dir), String(DEAD_PID));
  assert.equal(isHeld(dir), false);
  assert.ok(acquire(dir));
});

test("a lock whose heartbeat stopped is taken over even if its pid is alive (pid reuse)", () => {
  const dir = tmpDir();
  fs.writeFileSync(pidFile(dir), String(LIVE_FOREIGN_PID));
  fs.utimesSync(pidFile(dir), longAgo, longAgo);
  assert.equal(isHeld(dir), false);
  assert.ok(acquire(dir));
});

test("checking the lock keeps its heartbeat fresh", () => {
  const dir = tmpDir();
  const lock = acquire(dir);
  fs.utimesSync(pidFile(dir), longAgo, longAgo);
  assert.equal(lock.stillMine(), true);
  assert.equal(isHeld(dir), true);
  lock.release();
});

test("a flusher that lost its lock notices, and does not release the new owner's lock", () => {
  const dir = tmpDir();
  const lock = acquire(dir);
  fs.writeFileSync(pidFile(dir), String(LIVE_FOREIGN_PID)); // another flusher took over
  assert.equal(lock.stillMine(), false);
  lock.release();
  assert.equal(isHeld(dir), true);
});

test("takeovers are reported to the log", () => {
  const dir = tmpDir();
  fs.writeFileSync(pidFile(dir), String(DEAD_PID));
  const lines = [];
  acquire(dir, { log: (line) => lines.push(line) }).release();
  assert.match(lines.join("\n"), /stale lock \(pid 999999\)/);
});
