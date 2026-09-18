// The flusher as a process: what record.mjs spawns.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isHeld } from "../plugins/usage-analytics/scripts/flusher-lock.mjs";

const flusher = fileURLToPath(new URL("../plugins/usage-analytics/scripts/flush.mjs", import.meta.url));
const until = async (condition, ms = 5000) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

test("a flusher holds the lock while it runs and releases it when told to stop", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flush-process-"));
  const child = spawn(process.execPath, [flusher], {
    stdio: "ignore",
    env: { PATH: process.env.PATH, CLAUDE_ANALYTICS_DIR: dir, CLAUDE_ANALYTICS_LOKI_URL: "http://127.0.0.1:9" },
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  assert.ok(await until(() => isHeld(dir)), "flusher never took the lock");
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(isHeld(dir), false);
  assert.match(fs.readFileSync(path.join(dir, "flusher.log"), "utf8"), /received SIGTERM, exiting/);
});

test("a second flusher on the same data dir exits at once and leaves the first one's lock alone", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flush-process-"));
  const env = { PATH: process.env.PATH, CLAUDE_ANALYTICS_DIR: dir, CLAUDE_ANALYTICS_LOKI_URL: "http://127.0.0.1:9" };
  const first = spawn(process.execPath, [flusher], { stdio: "ignore", env });
  assert.ok(await until(() => isHeld(dir)));
  const second = spawn(process.execPath, [flusher], { stdio: "ignore", env });
  assert.equal(await new Promise((resolve) => second.on("exit", resolve)), 0);
  assert.equal(fs.readFileSync(path.join(dir, "flusher.pid"), "utf8"), String(first.pid));
  first.kill("SIGTERM");
  await new Promise((resolve) => first.on("exit", resolve));
});
