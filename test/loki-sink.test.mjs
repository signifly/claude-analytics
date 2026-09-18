import assert from "node:assert/strict";
import { test } from "node:test";
import { createLokiSink } from "../plugins/usage-analytics/scripts/loki-sink.mjs";

const event = (over = {}) => ({
  ts: 1_700_000_000_000, sub: 42, kind: "skill", name: "tdd",
  user: "dev@example.com", project: "webshop", source: "dev", session_id: "s-1", ...over,
});

function fakeLoki(status = 204, body = "") {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { requests, fetch };
}

test("events are pushed to Loki's push endpoint as one stream per label set", async () => {
  const loki = fakeLoki();
  const sink = createLokiSink({ url: "http://loki:3100/", fetch: loki.fetch });
  const outcome = await sink.push([event(), event({ sub: 43, name: "grilling" }), event({ kind: "tool", name: "Bash" })]);
  assert.equal(outcome, "ok");
  assert.equal(loki.requests[0].url, "http://loki:3100/loki/api/v1/push");
  const { streams } = loki.requests[0].body;
  assert.equal(streams.length, 2);
  assert.deepEqual(streams[0].stream, {
    service_name: "claude-code-usage", user: "dev@example.com", project: "webshop", source: "dev", kind: "skill",
  });
  assert.equal(streams[0].values.length, 2);
  assert.equal(streams[1].stream.kind, "tool");
  assert.deepEqual(streams[1].values.map(([, line]) => JSON.parse(line).name), ["Bash"]);
});

test("events written by an older plugin, without sub-millisecond digits, still get distinct valid timestamps", async () => {
  const loki = fakeLoki();
  const old = ({ sub, ...rest }) => rest;
  await createLokiSink({ url: "http://loki:3100", fetch: loki.fetch }).push([old(event()), old(event({ name: "b" }))]);
  const stamps = loki.requests[0].body.streams[0].values.map(([ns]) => ns);
  for (const ns of stamps) assert.match(ns, /^\d{19}$/);
  assert.equal(new Set(stamps).size, 2);
});

test("a missing label value becomes unknown rather than failing the push", async () => {
  const loki = fakeLoki();
  const { user, ...anonymous } = event();
  assert.equal(await createLokiSink({ url: "http://loki:3100", fetch: loki.fetch }).push([anonymous]), "ok");
  assert.equal(loki.requests[0].body.streams[0].stream.user, "unknown");
});

test("each entry gets a nanosecond timestamp from the event, stable across re-pushes", async () => {
  const loki = fakeLoki();
  const sink = createLokiSink({ url: "http://loki:3100", fetch: loki.fetch });
  await sink.push([event()]);
  await sink.push([event()]);
  const [first, second] = loki.requests.map((r) => r.body.streams[0].values[0]);
  assert.equal(first[0], "1700000000000000042");
  assert.deepEqual(first, second); // identical entry, so Loki dedupes a retry
});

test("the log line carries the event without the timestamp fields", async () => {
  const loki = fakeLoki();
  await createLokiSink({ url: "http://loki:3100", fetch: loki.fetch }).push([event()]);
  assert.deepEqual(JSON.parse(loki.requests[0].body.streams[0].values[0][1]), {
    kind: "skill", name: "tdd", user: "dev@example.com", project: "webshop", source: "dev", session_id: "s-1",
  });
});

for (const status of [400, 413, 422]) {
  test(`a ${status} means Loki will never take these events: rejected, and logged`, async () => {
    const lines = [];
    const sink = createLokiSink({ url: "http://loki:3100", fetch: fakeLoki(status, "entry too far behind").fetch, log: (l) => lines.push(l) });
    assert.equal(await sink.push([event()]), "rejected");
    assert.match(lines.join("\n"), new RegExp(`rejected 1 events: ${status} entry too far behind`));
  });
}

for (const status of [429, 500, 503]) {
  test(`a ${status} is worth retrying`, async () => {
    const sink = createLokiSink({ url: "http://loki:3100", fetch: fakeLoki(status, "busy").fetch });
    await assert.rejects(sink.push([event()]), new RegExp(`^Error: ${status} busy$`));
  });
}

for (const status of [401, 403, 404]) {
  test(`a ${status} is a fixable misconfiguration: events are held, and the error says what to check`, async () => {
    const sink = createLokiSink({ url: "http://loki:3100", fetch: fakeLoki(status, "nope").fetch });
    await assert.rejects(sink.push([event()]), /check CLAUDE_ANALYTICS_LOKI_URL \/ credentials; holding events/);
  });
}

test("a network failure is retryable and names its cause", async () => {
  const fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
  await assert.rejects(createLokiSink({ url: "http://loki:3100", fetch }).push([event()]), /fetch failed: ECONNREFUSED/);
});

test("credentials and tenant are sent as headers; a token wins over basic auth", async () => {
  const loki = fakeLoki();
  await createLokiSink({ url: "http://l", token: "t0k", basicAuth: "u:p", tenant: "signifly", fetch: loki.fetch }).push([event()]);
  assert.equal(loki.requests[0].headers.Authorization, "Bearer t0k");
  assert.equal(loki.requests[0].headers["X-Scope-OrgID"], "signifly");
  const basic = fakeLoki();
  await createLokiSink({ url: "http://l", basicAuth: "u:p", fetch: basic.fetch }).push([event()]);
  assert.equal(basic.requests[0].headers.Authorization, "Basic dTpw");
});

test("a request that times out is retryable", async () => {
  const fetch = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
  await assert.rejects(createLokiSink({ url: "http://loki:3100", fetch }).push([event()]), /aborted due to timeout/);
});
