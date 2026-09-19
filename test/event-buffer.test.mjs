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

test("a late write before the batch is settled (a late tail) stays held", () => {
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

test("a late write after the batch was settled becomes a batch of its own", () => {
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
  const buffer = open(dir, { settleGraceMs: 5000 });
  buffer.append(event("a"));
  buffer.claim()[0].settle();
  buffer.claim();
  assert.equal(fs.readdirSync(dir).length, 1); // still watched during the grace period
  const tenSecondsAgo = new Date(Date.now() - 10_000);
  for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), tenSecondsAgo, tenSecondsAgo);
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

test("a late write sitting in a settled batch counts as pending, so a flusher about to exit picks it up", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("claimed"));
  const [batch] = buffer.claim();
  const slowWriter = fs.openSync(batchFiles(dir)[0], "a");
  batch.settle();
  assert.equal(buffer.pending(), false);
  fs.writeSync(slowWriter, JSON.stringify(event("late")) + "\n");
  fs.closeSync(slowWriter);
  assert.equal(buffer.pending(), true);
  assert.deepEqual(names(buffer.claim()), ["late"]);
  assert.equal(buffer.pending(), false);
});

test("the held rest of a partly handled batch, and late writes to it, stay ahead of newer batches", () => {
  const dir = tmpDir();
  let tick = NOW;
  const buffer = openBuffer(dir, { now: () => tick++ });
  for (const n of ["old-1", "old-2"]) buffer.append(event(n));
  const [batch] = buffer.claim();
  const slowWriter = fs.openSync(batchFiles(dir)[0], "a");
  batch.settle({ handled: 1 });
  fs.writeSync(slowWriter, JSON.stringify(event("old-late")) + "\n");
  fs.closeSync(slowWriter);
  buffer.append(event("new"));
  assert.deepEqual(names(buffer.claim()), ["old-2", "old-late", "new"]);
});

test("leftover temp files from an interrupted settle are cleaned up", () => {
  const dir = tmpDir();
  const stale = path.join(dir, "batch-0000000000000-1-000000.jsonl.tmp");
  fs.writeFileSync(stale, "half written");
  const tenSecondsAgo = new Date(Date.now() - 10_000);
  fs.utimesSync(stale, tenSecondsAgo, tenSecondsAgo);
  open(dir).claim();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a batch can be partly settled any number of times: its file name stays bounded and nothing is lost", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  const all = Array.from({ length: 40 }, (_, i) => `e${i}`);
  for (const n of all) buffer.append(event(n));
  const seen = [];
  for (let pass = 0; pass < 40; pass++) {
    const [batch] = buffer.claim();
    seen.push(batch.events[0].name);
    assert.ok(batch.name.length < 100, `pass ${pass}: ${batch.name.length}-character batch name`);
    batch.settle({ handled: 1 }); // a flapping sink: one push gets through per pass
  }
  assert.deepEqual(seen, all);
  assert.deepEqual(buffer.claim(), []);
});

test("several late writes to one settled batch are offered in the order they were written", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  buffer.append(event("claimed-" + "x".repeat(20))); // keeps the byte offset under 100 for the first late write…
  const [batch] = buffer.claim();
  const slowWriter = fs.openSync(batchFiles(dir)[0], "a");
  batch.settle();
  fs.writeSync(slowWriter, JSON.stringify(event("late-1")) + "\n");
  assert.deepEqual(names(buffer.claim()), ["late-1"]); // left unsettled
  fs.writeSync(slowWriter, JSON.stringify(event("late-2")) + "\n"); // …and over 100 for the second
  fs.closeSync(slowWriter);
  assert.deepEqual(names(buffer.claim()), ["late-1", "late-2"]);
});

test("a late write that cannot be recovered does not count as pending forever", { skip: process.getuid?.() === 0 && "root ignores permissions" }, () => {
  const dir = tmpDir();
  const lines = [];
  const buffer = open(dir, { log: (l) => lines.push(l) });
  buffer.append(event("claimed"));
  const [batch] = buffer.claim();
  const slowWriter = fs.openSync(batchFiles(dir)[0], "a");
  batch.settle();
  fs.writeSync(slowWriter, JSON.stringify(event("late")) + "\n");
  fs.closeSync(slowWriter);
  const settled = path.join(dir, fs.readdirSync(dir).find((f) => f.includes(".settled-")));
  fs.chmodSync(dir, 0o555); // the data dir went read-only: the late bytes cannot be turned into a batch
  try {
    assert.equal(buffer.pending(), true);
    assert.deepEqual(buffer.claim(), []);
    const aMinuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(settled, aMinuteAgo, aMinuteAgo);
    assert.equal(buffer.pending(), false); // given up on for now: the flusher may go idle
    assert.match(lines.join("\n"), /cannot sweep/);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.deepEqual(names(buffer.claim()), ["late"]); // …but still delivered once the dir is writable again
});

// The file names are a stored format: a newer plugin must pick up what an older one left behind.
test("buffer files keep their on-disk names: claimed, held, settled and late", () => {
  const dir = tmpDir();
  const buffer = open(dir);
  const pid = process.pid;
  const listing = () => fs.readdirSync(dir).sort();
  for (const n of ["a", "b", "c"]) buffer.append(event(n));
  const claimedBytes = fs.statSync(path.join(dir, "events.jsonl")).size;
  let [batch] = buffer.claim();
  assert.deepEqual(listing(), [`batch-${NOW}-${pid}-000000.jsonl`]);

  const slowWriter = fs.openSync(path.join(dir, `batch-${NOW}-${pid}-000000.jsonl`), "a");
  batch.settle({ handled: 1 });
  assert.deepEqual(listing(), [
    `batch-${NOW}-${pid}-000000-held-${pid}-0.jsonl`,
    `batch-${NOW}-${pid}-000000.jsonl.settled-${claimedBytes}-${pid}-0`,
  ]);

  fs.writeSync(slowWriter, JSON.stringify(event("late")) + "\n");
  fs.closeSync(slowWriter);
  const lateBytes = Buffer.byteLength(JSON.stringify(event("late")) + "\n");
  [batch] = buffer.claim();
  assert.deepEqual(listing(), [
    `batch-${NOW}-${pid}-000000-held-${pid}-0.jsonl`,
    `batch-${NOW}-${pid}-000000-late-${pid}-0-${String(claimedBytes).padStart(12, "0")}.jsonl`,
    `batch-${NOW}-${pid}-000000.jsonl.settled-${claimedBytes + lateBytes}-${pid}-0`,
  ]);

  batch.settle({ handled: 1 }); // the held rest, partly settled again: still one "-held-" segment
  const heldBytes = claimedBytes - Buffer.byteLength(JSON.stringify(event("a")) + "\n");
  const heldSettled = `batch-${NOW}-${pid}-000000-held-${pid}-0.jsonl.settled-${heldBytes}-${pid}-1`;
  assert.deepEqual(listing(), [
    heldSettled,
    `batch-${NOW}-${pid}-000000-held-${pid}-1.jsonl`,
    `batch-${NOW}-${pid}-000000-late-${pid}-0-${String(claimedBytes).padStart(12, "0")}.jsonl`,
    `batch-${NOW}-${pid}-000000.jsonl.settled-${claimedBytes + lateBytes}-${pid}-0`,
  ]);
});

test("files left by an earlier run are read under their names: settled with late bytes, held, and their dead/ origin", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "batch-1690000000000-11-000003.jsonl.settled-0-11-7"), JSON.stringify(event("late-from-before")) + "\n");
  fs.writeFileSync(path.join(dir, "batch-1690000000000-11-000003-held-11-4.jsonl"), JSON.stringify(event("held-from-before")) + "\n");
  const buffer = open(dir);
  const batches = buffer.claim();
  assert.deepEqual(names(batches), ["held-from-before", "late-from-before"]);
  assert.ok(fs.readdirSync(dir).includes("batch-1690000000000-11-000003-late-11-7-000000000000.jsonl"));
  for (const batch of batches) batch.settle({ rejected: batch.events });
  assert.deepEqual(fs.readdirSync(path.join(dir, "dead")), ["rejected-batch-1690000000000-11-000003.jsonl"]);
});

const asRoot = process.getuid?.() === 0 && "root ignores permissions";

test("a live file that cannot be claimed stops counting as pending until it changes, and is reported once", { skip: asRoot }, () => {
  const dir = tmpDir();
  const lines = [];
  const buffer = open(dir, { log: (l) => lines.push(l) });
  buffer.append(event("stuck"));
  fs.chmodSync(dir, 0o555); // the live file can no longer be renamed away
  try {
    for (let i = 0; i < 3; i++) buffer.claim();
    assert.equal(buffer.pending(), false);
    assert.equal(lines.filter((l) => l.includes("cannot claim")).length, 1, lines.join("\n"));
    buffer.append(event("new")); // the file itself is still writable
    assert.equal(buffer.pending(), true);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.deepEqual(names(buffer.claim()), ["stuck", "new"]); // nothing was lost
});
