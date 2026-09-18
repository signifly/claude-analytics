// Loki adapter for the flusher's sink seam: push(events) → "ok" | "rejected",
// throws when a retry makes sense.
import { describe } from "./log.mjs";
import { LABELS } from "./usage-event.mjs";

export const SERVICE_NAME = "claude-code-usage";

// Loki will never accept these as sent; everything else may succeed later.
const REJECTED = new Set([400, 413, 422]);
const MISCONFIGURED = new Set([401, 403, 404, 407]);

export function createLokiSink({ url, token, basicAuth, tenant, fetch = globalThis.fetch, log = () => {} }) {
  const endpoint = `${String(url).replace(/\/+$/, "")}/loki/api/v1/push`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (basicAuth) headers.Authorization = `Basic ${Buffer.from(basicAuth).toString("base64")}`;
  if (tenant) headers["X-Scope-OrgID"] = tenant;

  return {
    async push(events) {
      const streams = new Map();
      events.forEach((event, i) => {
        const stream = { service_name: SERVICE_NAME };
        for (const key of LABELS) stream[key] = String(event[key] ?? "unknown");
        const id = JSON.stringify(stream);
        if (!streams.has(id)) streams.set(id, { stream, values: [] });
        // ms timestamp + the event's random `sub` digits: stable across re-pushes, so
        // a retry sends the same (timestamp, line) and Loki treats it as a duplicate.
        // The index fallback covers events written without `sub`; it is not retry-stable.
        const ns = `${event.ts}${String((event.sub ?? i) % 1e6).padStart(6, "0")}`;
        const { ts, sub, ...line } = event;
        streams.get(id).values.push([ns, JSON.stringify(line)]);
      });

      let res;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ streams: [...streams.values()] }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new Error(describe(err)); // "fetch failed" alone says nothing; keep the cause
      }
      if (res.ok) return "ok";

      const detail = `${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`;
      if (REJECTED.has(res.status)) {
        log(`Loki rejected ${events.length} events: ${detail}`);
        return "rejected";
      }
      const hint = MISCONFIGURED.has(res.status) ? " (check CLAUDE_ANALYTICS_LOKI_URL / credentials; holding events)" : "";
      throw new Error(detail + hint);
    },
  };
}
