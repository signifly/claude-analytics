// The properties ADR 0002 rests on only exist across processes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openBuffer } from "../plugins/usage-analytics/scripts/event-buffer.mjs";
import { flushOnce } from "../plugins/usage-analytics/scripts/flush-once.mjs";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "multi-"));
const run = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${file} exited ${code}`))));
  });

test("events appended by several processes while the flusher is claiming are each delivered exactly once", { timeout: 60_000 }, async () => {
  const dir = tmpDir();
  const WRITERS = 6;
  const EACH = 300;
  const buffer = openBuffer(dir, { settleGraceMs: 100 });
  const delivered = [];
  let pushes = 0;
  const flakySink = {
    async push(events) {
      if (++pushes % 5 === 0) throw new Error("503 every fifth push");
      delivered.push(...events.map((e) => e.name));
      return "ok";
    },
  };

  let writing = true;
  const writers = Promise.all(Array.from({ length: WRITERS }, (_, w) => run(fixture("append-many.mjs"), [dir, w, EACH]))).finally(() => (writing = false));
  const breathe = () => new Promise((resolve) => setTimeout(resolve, 2)); // let child exits be seen
  while (writing) {
    await flushOnce(buffer, flakySink, { maxPushBytes: 4000 });
    await breathe();
  }
  await writers;
  // keep flushing until every settled batch has outlived its grace period
  for (let i = 0; i < 200 && fs.readdirSync(dir).some((f) => f !== "dead"); i++) {
    await flushOnce(buffer, flakySink, { maxPushBytes: 4000 });
    await breathe();
  }

  const expected = Array.from({ length: WRITERS }, (_, w) => Array.from({ length: EACH }, (_, i) => `w${w}-${i}`)).flat();
  assert.equal(delivered.length, expected.length, "lost or duplicated events");
  assert.deepEqual([...delivered].sort(), expected.sort());
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== "dead"), []);
});

for (const [situation, prepare, exactlyOne] of [
  ["a free data dir", () => {}, true],
  ["a stale lock", (dir) => fs.writeFileSync(path.join(dir, "flusher.pid"), "999999"), false],
]) {
  test(`when several flushers race for ${situation}, at most one still owns the lock afterwards`, { timeout: 60_000 }, async () => {
    for (let round = 0; round < 5; round++) {
      const dir = tmpDir();
      prepare(dir);
      const startAt = Date.now() + 400;
      const results = await Promise.all(Array.from({ length: 8 }, () => run(fixture("acquire-race.mjs"), [dir, startAt])));
      const owners = results.filter((r) => r === "owner").length;
      // Racing a stale lock can leave nobody holding it (the next hook event
      // starts a fresh flusher); it must never leave two.
      assert.ok(exactlyOne ? owners === 1 : owners <= 1, `round ${round}: ${owners} owners`);
    }
  });
}
