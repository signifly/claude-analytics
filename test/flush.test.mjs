import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openBuffer } from "../plugins/usage-analytics/scripts/event-buffer.mjs";
import { flushOnce } from "../plugins/usage-analytics/scripts/flush-once.mjs";

const NOW = 1_700_000_000_000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "flush-"));
const event = (name) => ({ ts: NOW, sub: 1, kind: "skill", name });

// In-memory sink: answers each push from a script, then "ok" forever.
function scriptedSink(...script) {
  const pushes = [];
  return {
    pushes,
    delivered: () => pushes.filter((p) => p.outcome === "ok").flatMap((p) => p.names),
    async push(events) {
      const outcome = script.shift() ?? "ok";
      pushes.push({ names: events.map((e) => e.name), outcome });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function bufferWith(...names) {
  const dir = tmpDir();
  const buffer = openBuffer(dir, { now: () => NOW });
  for (const n of names) buffer.append(event(n));
  return { dir, buffer };
}

test("buffered events are delivered and leave the buffer", async () => {
  const { buffer } = bufferWith("a", "b");
  const sink = scriptedSink();
  const result = await flushOnce(buffer, sink);
  assert.deepEqual(sink.delivered(), ["a", "b"]);
  assert.deepEqual(result, { delivered: 2, rejected: 0, error: null });
  assert.deepEqual(buffer.claim(), []);
});

const outage = () => Object.assign(new Error("503 unavailable"), { status: 503 });
// each test event is ~120 bytes with overhead, so this forces one event per push
const ONE_PER_PUSH = { maxPushBytes: 130 };

test("an outage loses nothing: events are delivered once the sink recovers", async () => {
  const { buffer } = bufferWith("a", "b");
  const sink = scriptedSink(outage());
  const failed = await flushOnce(buffer, sink);
  assert.equal(failed.delivered, 0);
  assert.match(failed.error.message, /503/);
  const recovered = await flushOnce(buffer, sink);
  assert.deepEqual(recovered, { delivered: 2, rejected: 0, error: null });
  assert.deepEqual(sink.delivered(), ["a", "b"]);
});

test("a failure part-way through resumes after the last delivered push, without duplicates", async () => {
  const { buffer } = bufferWith("a", "b", "c");
  const sink = scriptedSink("ok", outage());
  await flushOnce(buffer, sink, ONE_PER_PUSH);
  await flushOnce(buffer, sink, ONE_PER_PUSH);
  assert.deepEqual(sink.delivered(), ["a", "b", "c"]);
});

test("events the sink rejects are set aside in dead/ and the queue moves on", async () => {
  const { dir, buffer } = bufferWith("a", "poison", "c");
  const sink = scriptedSink("ok", "rejected", "ok");
  const result = await flushOnce(buffer, sink, ONE_PER_PUSH);
  assert.deepEqual(result, { delivered: 2, rejected: 1, error: null });
  assert.deepEqual(sink.delivered(), ["a", "c"]);
  assert.deepEqual(buffer.claim(), []);
  const [dead] = fs.readdirSync(path.join(dir, "dead"));
  assert.match(fs.readFileSync(path.join(dir, "dead", dead), "utf8"), /poison/);
});

test("rejections seen before an outage are not retried after it", async () => {
  const { buffer } = bufferWith("poison", "b");
  const sink = scriptedSink("rejected", outage());
  await flushOnce(buffer, sink, ONE_PER_PUSH);
  await flushOnce(buffer, sink, ONE_PER_PUSH);
  assert.deepEqual(sink.pushes.map((p) => p.names[0]), ["poison", "b", "b"]);
});

test("newer batches wait behind a held one, so order is kept", async () => {
  const { buffer } = bufferWith("old");
  const sink = scriptedSink(outage(), outage());
  await flushOnce(buffer, sink);
  buffer.append(event("new"));
  await flushOnce(buffer, sink);
  assert.deepEqual(sink.pushes.map((p) => p.names), [["old"], ["old"]]);
  await flushOnce(buffer, sink);
  assert.deepEqual(sink.delivered(), ["old", "new"]);
});

test("pushes stay under the size limit", async () => {
  const { buffer } = bufferWith("a", "b", "c", "d", "e");
  const sink = scriptedSink();
  await flushOnce(buffer, sink, { maxPushBytes: 260 });
  assert.deepEqual(sink.pushes.map((p) => p.names.length), [2, 2, 1]);
});

test("a buffer failure is reported like any other failed attempt, not thrown", async () => {
  const broken = { claim() { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } };
  const result = await flushOnce(broken, scriptedSink());
  assert.match(result.error.message, /EACCES/);
});
