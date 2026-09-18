import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openBuffer } from "../plugins/usage-analytics/scripts/event-buffer.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "event-buffer-"));
const NOW = 1_700_000_000_000;
const event = (name, ts = NOW) => ({ ts, sub: 1, kind: "skill", name });
const names = (batches) => batches.flatMap((b) => b.events.map((e) => e.name));
const open = (dir, options = {}) => openBuffer(dir, { now: () => NOW, ...options });

test("appended events come back from a claim, in order", () => {
  const buffer = open(tmpDir());
  buffer.append(event("a"));
  buffer.append(event("b"));
  assert.deepEqual(names(buffer.claim()), ["a", "b"]);
});

test("a fully settled batch is gone", () => {
  const buffer = open(tmpDir());
  buffer.append(event("a"));
  buffer.claim()[0].settle();
  assert.deepEqual(buffer.claim(), []);
});

test("an unsettled batch is offered again, ahead of newer events", () => {
  const buffer = open(tmpDir());
  buffer.append(event("old"));
  buffer.claim(); // e.g. the push failed: never settled
  buffer.append(event("new"));
  assert.deepEqual(names(buffer.claim()), ["old", "new"]);
});

test("a partly sent batch resumes after the last handled event", () => {
  const buffer = open(tmpDir());
  for (const n of ["a", "b", "c", "d"]) buffer.append(event(n));
  buffer.claim()[0].settle({ handled: 3 });
  assert.deepEqual(names(buffer.claim()), ["d"]);
});

test("rejected events go to dead/ and are not offered again", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("good"));
  buffer.append(event("bad"));
  const [batch] = buffer.claim();
  batch.settle({ rejected: [batch.events[1]] });
  assert.deepEqual(buffer.claim(), []);
  const dead = fs.readdirSync(path.join(dir, "dead"));
  assert.equal(dead.length, 1);
  assert.match(fs.readFileSync(path.join(dir, "dead", dead[0]), "utf8"), /"name":"bad"/);
});

test("pending reports whether unclaimed events exist", () => {
  const buffer = open(tmpDir());
  assert.equal(buffer.pending(), false);
  buffer.append(event("a"));
  assert.equal(buffer.pending(), true);
  buffer.claim();
  assert.equal(buffer.pending(), false);
});

const DAY = 24 * 60 * 60 * 1000;
const batchFiles = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith("batch-")).map((f) => path.join(dir, f));

test("torn and expired lines are skipped and counted in the log, the rest survives", () => {
  const dir = tmpDir();
  const lines = [];
  const buffer = open(dir, { log: (l) => lines.push(l) });
  buffer.append(event("fresh"));
  buffer.append(event("ancient", NOW - 7 * DAY));
  fs.appendFileSync(path.join(dir, "events.jsonl"), '{"ts":17000000\n'); // a torn write
  buffer.append(event("also-fresh"));
  assert.deepEqual(names(buffer.claim()), ["fresh", "also-fresh"]);
  assert.match(lines.join("\n"), /skipped 1 expired and 1 corrupt/);
});

test("an event written into a batch after it was claimed is not lost", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("claimed"));
  const [batch] = buffer.claim();
  // a slow writer that opened the live file before the rename
  fs.appendFileSync(batchFiles(dir)[0], JSON.stringify(event("late")) + "\n");
  batch.settle();
  assert.deepEqual(names(buffer.claim()), ["late"]);
});

test("a full buffer refuses new events instead of growing", () => {
  const buffer = open(tmpDir(), { maxBacklogBytes: 100 });
  assert.equal(buffer.append(event("a".repeat(100))), true);
  assert.equal(buffer.append(event("overflow")), false);
  assert.equal(names(buffer.claim()).length, 1);
});

test("a live file that filled to the cap is still delivered, not thrown away as over-cap", () => {
  const lines = [];
  const buffer = open(tmpDir(), { maxBacklogBytes: 100, log: (l) => lines.push(l) });
  buffer.append(event("big-" + "x".repeat(200)));
  assert.equal(names(buffer.claim()).length, 1);
  assert.deepEqual(lines, []);
});

test("a backlog over its cap loses its oldest batch first, and says so", () => {
  const lines = [];
  const buffer = open(tmpDir(), { maxBacklogBytes: 150, log: (l) => lines.push(l) });
  buffer.append(event("oldest-" + "x".repeat(60)));
  buffer.claim();
  buffer.append(event("newer-" + "x".repeat(60)));
  buffer.claim();
  buffer.append(event("newest-" + "x".repeat(60)));
  const held = names(buffer.claim());
  assert.equal(held.some((n) => n.startsWith("oldest-")), false);
  assert.equal(held.at(-1).startsWith("newest-"), true);
  assert.match(lines.join("\n"), /backlog over 150 bytes: evicted/);
});

test("an unreadable batch is quarantined and does not block the batches behind it", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "batch-0000000000000-1-000000.jsonl")); // a directory: reading it fails
  const buffer = open(dir);
  buffer.append(event("behind"));
  assert.deepEqual(names(buffer.claim()), ["behind"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "dead")), ["batch-0000000000000-1-000000.jsonl"]);
});

test("dead/ is capped too: the oldest files go first and the newest always stays", () => {
  const dir = tmpDir();
  let tick = NOW;
  const buffer = openBuffer(dir, { maxDeadBytes: 120, now: () => tick++ });
  for (const [i, n] of ["one", "two", "three"].entries()) {
    buffer.append(event(n + "-" + "x".repeat(40), tick));
    const [batch] = buffer.claim();
    batch.settle({ rejected: batch.events });
    // age is modification time; don't leave it to the filesystem's timestamp resolution
    for (const f of fs.readdirSync(path.join(dir, "dead"))) {
      const file = path.join(dir, "dead", f);
      if (fs.readFileSync(file, "utf8").includes(n + "-")) fs.utimesSync(file, new Date(NOW + i * 60_000), new Date(NOW + i * 60_000));
    }
  }
  buffer.append(event("four-" + "x".repeat(40), tick));
  const [batch] = buffer.claim();
  batch.settle({ rejected: batch.events });
  const dead = fs.readdirSync(path.join(dir, "dead")).map((f) => fs.readFileSync(path.join(dir, "dead", f), "utf8")).join("");
  assert.equal(dead.includes("one-"), false);
  assert.equal(dead.includes("two-"), false);
  assert.equal(dead.includes("four-"), true);
});

test("unreadable batches count against the dead/ cap too", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "dead"));
  fs.writeFileSync(path.join(dir, "dead", "rejected-0-old.jsonl"), "x".repeat(500));
  const lastWeek = new Date(Date.now() - 7 * DAY);
  fs.utimesSync(path.join(dir, "dead", "rejected-0-old.jsonl"), lastWeek, lastWeek);
  fs.mkdirSync(path.join(dir, "batch-0000000000000-1-000000.jsonl"));
  open(dir, { maxDeadBytes: 100 }).claim();
  assert.deepEqual(fs.readdirSync(path.join(dir, "dead")), ["batch-0000000000000-1-000000.jsonl"]);
});

test("when dead/ is unusable, an unreadable batch is discarded rather than blocking the batches behind it", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "dead"), "not a directory");
  fs.mkdirSync(path.join(dir, "batch-0000000000000-1-000000.jsonl"));
  const lines = [];
  const buffer = open(dir, { log: (l) => lines.push(l) });
  buffer.append(event("behind"));
  assert.deepEqual(names(buffer.claim()), ["behind"]);
  assert.match(lines.join("\n"), /cannot keep batch-0000000000000-1-000000\.jsonl in dead\//);
  assert.deepEqual(batchFiles(dir).length, 1); // only "behind" is still held
});

test("when dead/ is unusable, rejected events are discarded, the batch still settles, and the log does not claim they were kept", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "dead"), "not a directory");
  const lines = [];
  const buffer = open(dir, { log: (l) => lines.push(l) });
  buffer.append(event("bad"));
  const [batch] = buffer.claim();
  batch.settle({ rejected: batch.events });
  assert.deepEqual(buffer.claim(), []);
  assert.match(lines.join("\n"), /cannot keep/);
  assert.doesNotMatch(lines.join("\n"), /kept in dead/);
});

test("a dead/ file that cannot be evicted does not stop batches from settling", { skip: process.getuid?.() === 0 && "root ignores permissions" }, () => {
  const dir = tmpDir();
  const dead = path.join(dir, "dead");
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, "rejected-old.jsonl"), "x".repeat(500));
  const lastWeek = new Date(Date.now() - 7 * DAY);
  fs.utimesSync(path.join(dead, "rejected-old.jsonl"), lastWeek, lastWeek);
  const lines = [];
  const buffer = open(dir, { maxDeadBytes: 100, log: (l) => lines.push(l) });
  buffer.append(event("bad"));
  const [batch] = buffer.claim();
  fs.chmodSync(dead, 0o555); // nothing in dead/ can be added or removed
  try {
    batch.settle({ rejected: batch.events });
  } finally {
    fs.chmodSync(dead, 0o755);
  }
  assert.deepEqual(buffer.claim(), []);
  assert.match(lines.join("\n"), /cannot (keep|evict)/);
});

test("settling a batch whose file has vanished is harmless", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("a"));
  const [batch] = buffer.claim();
  fs.rmSync(batchFiles(dir)[0]);
  batch.settle();
  assert.deepEqual(buffer.claim(), []);
});

test("a partly handled batch keeps both its unhandled events and a late tail", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("a"));
  buffer.append(event("b"));
  const [batch] = buffer.claim();
  fs.appendFileSync(batchFiles(dir)[0], JSON.stringify(event("late")) + "\n");
  batch.settle({ handled: 1 });
  assert.deepEqual(names(buffer.claim()), ["b", "late"]);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("rejections from the same batch accumulate in one dead/ file, without repeats", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  for (const n of ["bad-1", "ok", "bad-2"]) buffer.append(event(n));
  let [batch] = buffer.claim();
  batch.settle({ handled: 1, rejected: [batch.events[0]] });
  [batch] = buffer.claim();
  batch.settle({ rejected: [batch.events[1]] });
  assert.deepEqual(buffer.claim(), []);
  const files = fs.readdirSync(path.join(dir, "dead"));
  assert.equal(files.length, 1);
  const kept = fs.readFileSync(path.join(dir, "dead", files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l).name);
  assert.deepEqual(kept, ["bad-1", "bad-2"]);
});

test("two flushers' batches on one dir keep their age order and never overwrite each other", () => {
  const dir = tmpDir();
  const first = openBuffer(dir, { now: () => 1000 + NOW });
  const second = openBuffer(dir, { now: () => 1000 + NOW }); // same clock, same process
  first.append(event("from-first"));
  first.claim();
  second.append(event("from-second"));
  assert.deepEqual(names(second.claim()), ["from-first", "from-second"]);
});

test("an event written by a slow writer after its batch was settled is still not lost", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("claimed"));
  const [batch] = buffer.claim();
  const slowWriter = fs.openSync(batchFiles(dir)[0], "a"); // opened the live file before the claim…
  batch.settle();
  fs.writeSync(slowWriter, JSON.stringify(event("after-settle")) + "\n"); // …and only now gets to write
  fs.closeSync(slowWriter);
  assert.deepEqual(names(buffer.claim()), ["after-settle"]);
});

test("the same holds when the batch was only partly handled", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("a"));
  buffer.append(event("b"));
  const [batch] = buffer.claim();
  const slowWriter = fs.openSync(batchFiles(dir)[0], "a");
  batch.settle({ handled: 1 });
  fs.writeSync(slowWriter, JSON.stringify(event("after-settle")) + "\n");
  fs.closeSync(slowWriter);
  assert.deepEqual(names(buffer.claim()).sort(), ["after-settle", "b"]);
});

test("settled batches are cleaned up once no slow writer can still be holding them", () => {
  const dir = tmpDir();
  const buffer = open(dir, { settleGraceMs: 0 });
  buffer.append(event("a"));
  buffer.claim()[0].settle();
  buffer.claim();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("settling the same batch repeatedly without progress changes nothing and never fails", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  for (const n of ["a", "b"]) buffer.append(event(n));
  for (let i = 0; i < 3; i++) buffer.claim()[0].settle({ handled: 0 }); // the sink was down three passes in a row
  assert.deepEqual(names(buffer.claim()), ["a", "b"]);
});

test("a batch settled in several equal-sized steps never trips over its own earlier steps", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  for (const n of ["a1", "a2", "a3", "a4"]) buffer.append(event(n));
  for (const expected of [["a1", "a2", "a3", "a4"], ["a2", "a3", "a4"], ["a3", "a4"], ["a4"]]) {
    const [batch] = buffer.claim();
    assert.deepEqual(batch.events.map((e) => e.name), expected);
    batch.settle({ handled: 1 });
  }
  assert.deepEqual(buffer.claim(), []);
});
