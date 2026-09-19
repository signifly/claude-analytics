import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { drain } from "../plugins/usage-analytics/scripts/drain.mjs";
import { openBuffer } from "../plugins/usage-analytics/scripts/event-buffer.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// A fake clock: sleeping is what moves time forward.
function harness({ passes = [], lockLostAfter = Infinity } = {}) {
  let time = 0;
  const sleeps = [];
  const lines = [];
  let checks = 0;
  const h = {
    pushed: 0,
    sleeps,
    lines,
    beats: () => checks,
    options: {
      flushMs: SECOND,
      idleExitMs: 10 * MINUTE,
      now: () => time,
      sleep: async (ms) => { sleeps.push(ms); time += ms; },
      log: (line) => lines.push(line),
      lock: { stillMine: () => ++checks <= lockLostAfter },
      buffer: { pending: () => false },
      // each pass answers from the script, then "nothing to do" forever
      flush: async (buffer, sink) => {
        const pass = passes.shift() ?? {};
        let error = null;
        try {
          for (let i = 0; i < (pass.pushes ?? 0); i++) await sink.push([]);
        } catch (err) {
          error = err; // like flushOnce: a failed push ends the pass, it doesn't throw
        }
        return { delivered: 0, rejected: 0, error, ...pass };
      },
      sink: { push: async () => (h.pushed++, "ok") },
    },
  };
  return h;
}

test("with nothing to do, the flusher gives up after the idle time", async () => {
  const h = harness();
  assert.equal(await drain(h.options), true);
  assert.equal(h.sleeps.length, 600); // 10 minutes of 1 s passes
});

test("failed passes back off from 2 s, doubling to a 60 s ceiling, then recover", async () => {
  const failing = Array.from({ length: 7 }, () => ({ error: new Error("503 busy") }));
  const h = harness({ passes: [...failing, { delivered: 1 }] });
  await drain(h.options);
  assert.deepEqual(h.sleeps.slice(0, 9), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 1000]);
  assert.match(h.lines[0], /push failed, retry in 2000ms: 503 busy/);
  assert.ok(h.lines.includes("push recovered"));
});

test("deliveries and rejections both count as activity; failures do not", async () => {
  const at9min = Array.from({ length: 539 }, () => ({}));
  const h = harness({ passes: [...at9min, { rejected: 3 }] });
  await drain(h.options);
  assert.equal(h.sleeps.length, 540 + 600); // the rejection at 9 min restarted the idle clock

  const down = harness({ passes: Array.from({ length: 50 }, () => ({ error: new Error("down") })) });
  await drain(down.options);
  assert.ok(down.sleeps.reduce((a, b) => a + b) < 12 * MINUTE); // an outage doesn't keep it alive
});

test("a flusher that loses its lock stops, and says so", async () => {
  const h = harness({ lockLostAfter: 3 });
  assert.equal(await drain(h.options), false);
  assert.match(h.lines.at(-1), /lock lost/);
});

test("losing the lock mid-pass stops at once and is never reported as a push failure", async () => {
  const h = harness({ passes: [{ pushes: 5 }], lockLostAfter: 3 });
  assert.equal(await drain(h.options), false);
  assert.ok(h.pushed < 5);
  assert.deepEqual(h.sleeps, [1000]); // no backoff sleep before exiting
  assert.deepEqual(h.lines, ["lock lost to another flusher, exiting"]);
});

test("a pass that could not settle is logged for what it is and does not count as activity", async () => {
  const settleError = Object.assign(new Error("ENOSPC: no space left"), { batch: "batch-1.jsonl" });
  const h = harness({ passes: Array.from({ length: 2000 }, () => ({ delivered: 3, settleError })) });
  assert.equal(await drain(h.options), true);
  assert.match(h.lines[0], /delivered 3 .*batch-1\.jsonl.*could not settle.*ENOSPC/);
  assert.ok(h.sleeps.reduce((a, b) => a + b) < 12 * MINUTE); // a full disk doesn't keep it alive
});

test("the lock is checked, and its heartbeat refreshed, before every push of a long pass", async () => {
  const h = harness({ passes: [{ pushes: 200, delivered: 200 }] });
  await drain(h.options);
  assert.ok(h.beats() >= 200);
});

test("with the real flush pass: an outage, then recovery, delivers everything once and then goes idle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-"));
  const buffer = openBuffer(dir);
  for (const name of ["a", "b", "c"]) buffer.append({ ts: Date.now(), sub: 1, kind: "tool", name });

  const h = harness();
  const delivered = [];
  let outage = 3;
  const sink = { async push(events) { if (outage-- > 0) throw new Error("503 busy"); delivered.push(...events.map((e) => e.name)); return "ok"; } };
  const { flush, ...options } = h.options; // use drain's default: the real flushOnce
  assert.equal(await drain({ ...options, buffer, sink }), true);
  assert.deepEqual(delivered, ["a", "b", "c"]);
  assert.equal(h.lines.filter((l) => l.startsWith("push failed")).length, 3);
  assert.ok(h.lines.includes("push recovered"));
  assert.deepEqual(buffer.claim(), []); // nothing held
});

test("new events arriving count as activity even while the sink is down", async () => {
  let pendingFor = 20;
  const h = harness({ passes: Array.from({ length: 40 }, () => ({ error: new Error("down") })) });
  h.options.buffer = { pending: () => pendingFor-- > 0 };
  await drain(h.options);
  assert.ok(h.sleeps.reduce((a, b) => a + b) > 20 * MINUTE); // the idle clock restarted while events kept arriving
});
