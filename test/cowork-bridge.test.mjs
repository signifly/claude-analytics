import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createBridge } from "../apps/cowork-bridge/bridge.mjs";

const TOKEN = "t".repeat(40);
const logs = {
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: "1700000000000000000",
              attributes: [
                { key: "event.name", value: { stringValue: "tool_result" } },
                { key: "tool_name", value: { stringValue: "Read" } },
                { key: "user.email", value: { stringValue: "dev@signifly.com" } },
                { key: "tool_input", value: { stringValue: "SECRET" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function withBridge({ sink = { push: async () => "ok" }, maxBytes } = {}, run) {
  const lines = [];
  const server = http.createServer(createBridge({ token: TOKEN, sink, log: (line) => lines.push(line), maxBytes }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, { body = JSON.stringify(logs), headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body,
  });

test("OTLP/JSON logs become usage events pushed to the sink", async () => {
  const pushed = [];
  await withBridge({ sink: { push: async (events) => (pushed.push(...events), "ok") } }, async (base) => {
    const res = await post(base, "/v1/logs");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].name, "Read");
  assert.equal(pushed[0].source, "cowork");
  assert.ok(!JSON.stringify(pushed).includes("SECRET"));
});

test("a request without the right bearer token is refused and nothing is pushed", async () => {
  let pushes = 0;
  await withBridge({ sink: { push: async () => (pushes++, "ok") } }, async (base) => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`]) {
      const headers = authorization === undefined ? { authorization: "" } : { authorization };
      assert.equal((await post(base, "/v1/logs", { headers })).status, 401);
    }
  });
  assert.equal(pushes, 0);
});

test("gzip-encoded requests are accepted", async () => {
  await withBridge({}, async (base) => {
    const res = await post(base, "/v1/logs", { body: gzipSync(JSON.stringify(logs)), headers: { "content-encoding": "gzip" } });
    assert.equal(res.status, 200);
  });
});

test("protobuf is refused with a hint, so a misconfigured exporter is visible", async () => {
  await withBridge({}, async (base) => {
    const res = await post(base, "/v1/logs", { body: "x", headers: { "content-type": "application/x-protobuf" } });
    assert.equal(res.status, 415);
    assert.match(await res.text(), /http\/json/);
  });
});

test("a body that is not JSON is a 400", async () => {
  await withBridge({}, async (base) => {
    assert.equal((await post(base, "/v1/logs", { body: "{nope" })).status, 400);
  });
});

test("a body over the size limit is refused, before or after decompression", async () => {
  await withBridge({ maxBytes: 1000 }, async (base) => {
    const big = JSON.stringify({ resourceLogs: [], pad: "x".repeat(5000) });
    assert.equal((await post(base, "/v1/logs", { body: big })).status, 413);
    assert.equal((await post(base, "/v1/logs", { body: gzipSync(big), headers: { "content-encoding": "gzip" } })).status, 413);
  });
});

test("metrics and traces are accepted and discarded, so the exporter does not keep retrying them", async () => {
  let pushes = 0;
  await withBridge({ sink: { push: async () => (pushes++, "ok") } }, async (base) => {
    assert.equal((await post(base, "/v1/metrics", { body: "{}" })).status, 200);
    assert.equal((await post(base, "/v1/traces", { body: "{}" })).status, 200);
  });
  assert.equal(pushes, 0);
});

test("when Loki is unreachable the exporter is told to retry", async () => {
  await withBridge({ sink: { push: async () => { throw new Error("503 Loki down"); } } }, async (base, lines) => {
    assert.equal((await post(base, "/v1/logs")).status, 503);
    assert.ok(lines.some((line) => line.includes("Loki down")));
  });
});

test("events Loki rejects are not retried", async () => {
  await withBridge({ sink: { push: async () => "rejected" } }, async (base) => {
    assert.equal((await post(base, "/v1/logs")).status, 200);
  });
});

test("logs never contain request content", async () => {
  await withBridge({ sink: { push: async () => { throw new Error("boom"); } } }, async (base, lines) => {
    await post(base, "/v1/logs");
    await post(base, "/v1/logs", { body: "{SECRET" });
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes("SECRET"));
  });
});

test("the health check needs no token; other paths and methods are 404", async () => {
  await withBridge({}, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await post(base, "/v1/other")).status, 404);
    assert.equal((await fetch(`${base}/v1/logs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
  });
});

test("a bridge without a long token refuses to start", () => {
  assert.throws(() => createBridge({ token: "short", sink: { push: async () => "ok" } }), /token/);
});
