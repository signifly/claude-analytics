// Cowork bridge: an OTLP/HTTP endpoint for Cowork's log export. It keeps the names of what
// was used and hands them to the same Loki sink the plugin uses; everything else is dropped
// here, before it reaches any storage. See ADR 0008.
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { toUsageEvents } from "./cowork-event.mjs";

const MIN_TOKEN = 32;

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // An oversized body is read to the end and discarded, so the client still gets its 413.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => (size > maxBytes ? reject(new Refusal(413, "request too large")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function decode(raw, encoding, maxBytes) {
  if (!encoding || encoding === "identity") return raw;
  if (encoding !== "gzip") throw new Refusal(415, `unsupported content-encoding ${encoding.slice(0, 20)}`);
  try {
    return gunzipSync(raw, { maxOutputLength: maxBytes });
  } catch (err) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE") throw new Refusal(413, "request too large");
    throw new Refusal(400, "body is not valid gzip");
  }
}

export function createBridge({ token, sink, log = () => {}, maxBytes = 4 * 1024 * 1024 }) {
  if (typeof token !== "string" || token.length < MIN_TOKEN) throw new Error(`the bridge needs a token of at least ${MIN_TOKEN} characters`);
  // Hashing first gives equal lengths, so the comparison takes the same time whatever was sent.
  const digest = (value) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  const authorized = (req) => timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected);

  const reply = (res, status, body = "{}") => {
    res.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain" });
    res.end(body);
  };

  return async function handle(req, res) {
    const path = String(req.url).split("?", 1)[0];
    if (req.method === "GET" && path === "/healthz") return reply(res, 200, "ok");
    const signal = { "/v1/logs": "logs", "/v1/metrics": "metrics", "/v1/traces": "traces" }[path];
    if (req.method !== "POST" || !signal) return reply(res, 404, "not found");
    if (!authorized(req)) return reply(res, 401, "unauthorized");

    try {
      const type = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim();
      if (type !== "application/json") throw new Refusal(415, "only OTLP http/json is accepted: set the exporter protocol to http/json");
      const raw = await readBody(req, maxBytes);
      // Only log records carry usage; metrics and traces are acknowledged and dropped.
      if (signal !== "logs") return reply(res, 200);
      let request;
      try {
        request = JSON.parse(decode(raw, req.headers["content-encoding"], maxBytes).toString("utf8"));
      } catch (err) {
        if (err instanceof Refusal) throw err;
        throw new Refusal(400, "body is not JSON");
      }
      const events = toUsageEvents(request);
      if (events.length === 0) return reply(res, 200);
      let outcome;
      try {
        outcome = await sink.push(events);
      } catch (err) {
        // 503 is retryable for OTLP exporters; the events' timestamps make the retry a duplicate in Loki.
        log(`push of ${events.length} events failed, exporter will retry: ${err?.message ?? err}`);
        return reply(res, 503, "upstream unavailable");
      }
      if (outcome === "rejected") log(`Loki rejected ${events.length} events`);
      return reply(res, 200);
    } catch (err) {
      if (!(err instanceof Refusal)) {
        log(`unexpected error: ${err?.name ?? "Error"}`); // the message could quote the body
        return reply(res, 500, "internal error");
      }
      log(`refused ${signal}: ${err.status} ${err.message}`);
      if (!res.headersSent) reply(res, err.status, err.message);
    }
  };
}
