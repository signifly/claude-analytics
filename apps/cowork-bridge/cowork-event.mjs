// Cowork event: maps Cowork's OpenTelemetry log records to the usage events the plugin
// records, so both land in one stream. Names only, never content: see ADR 0003 and 0008.
import { bareName } from "../../plugins/usage-analytics/scripts/usage-event.mjs";

export const SOURCE = "cowork";

const BARE = /^[\w:.-]{1,100}$/;
const EMAIL = /^[^\s@"]{1,100}@[\w.-]{1,100}$/;
const bare = (value) => typeof value === "string" && BARE.test(value);

// The only attributes ever read. Content-bearing ones (prompt, tool_input, response, body, …)
// are never looked at; tool_parameters is parsed for its two MCP names and the subagent type only.
function read(attributes) {
  const values = {};
  if (!Array.isArray(attributes)) return values;
  for (const attribute of attributes) {
    const value = attribute?.value;
    if (typeof attribute?.key !== "string" || !value || typeof value !== "object") continue;
    const scalar = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
    if (scalar !== undefined && scalar !== null && typeof scalar !== "object") values[attribute.key] = String(scalar);
  }
  return values;
}

function parameters(attrs) {
  try {
    const parsed = JSON.parse(attrs.tool_parameters);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function classify(attrs) {
  switch (attrs["event.name"]) {
    case "user_prompt":
      // A typed skill also emits skill_activated (user-slash), which counts it.
      return { kind: "prompt", name: "prompt" };
    case "skill_activated":
      return { kind: attrs.invocation_trigger === "user-slash" ? "command" : "skill", name: attrs["skill.name"] };
    case "tool_result":
      break;
    default:
      return null; // tool_decision would count every call twice; the rest is not usage
  }
  const tool = bareName(attrs.tool_name);
  if (tool === "Skill") return null; // counted by skill_activated
  if (tool === "Agent" || tool === "Task") return { kind: "agent", name: parameters(attrs).subagent_type };
  if (tool.startsWith("mcp__")) return { kind: "mcp", name: tool, mcp_server: tool.split("__")[1] };
  if (tool === "mcp_tool") {
    const { mcp_server_name: server, mcp_tool_name: name } = parameters(attrs);
    if (bare(server) && bare(name)) return { kind: "mcp", name: `mcp__${server}__${name}`, mcp_server: server };
    return { kind: "mcp", name: "mcp_tool" }; // names redacted: still a call
  }
  return { kind: "tool", name: tool };
}

function timestamp(record) {
  const nanos = [record.timeUnixNano, record.observedTimeUnixNano].map((v) => String(v ?? "")).find((v) => /^[1-9]\d{12,18}$/.test(v));
  if (!nanos) return { ts: Date.now(), sub: Math.floor(Math.random() * 1e6) };
  const big = BigInt(nanos);
  return { ts: Number(big / 1_000_000n), sub: Number(big % 1_000_000n) };
}

function toEvent(record, resource) {
  if (!record || typeof record !== "object") return null;
  const attrs = { ...resource, ...read(record.attributes) };
  if (!attrs["event.name"] && typeof record.body?.stringValue === "string") {
    attrs["event.name"] = record.body.stringValue.replace(/^claude_code\./, "");
  }
  const classified = classify(attrs);
  if (!classified) return null;
  const email = String(attrs["user.email"] ?? "").trim().toLowerCase();
  const session = attrs["session.id"];
  // Same field order and rules as the plugin's events; built from scratch, so nothing else can ride along.
  const event = { ...timestamp(record), kind: classified.kind, name: bareName(classified.name) };
  if (classified.mcp_server) event.mcp_server = bareName(classified.mcp_server);
  event.user = EMAIL.test(email) ? email : "unknown";
  event.project = "unknown";
  event.source = SOURCE;
  if (session !== undefined) event.session_id = bare(session) ? session : "unknown";
  return event;
}

// An OTLP ExportLogsServiceRequest in its JSON encoding → usage events. Never throws.
export function toUsageEvents(request) {
  const events = [];
  const list = (value) => (Array.isArray(value) ? value : []);
  for (const resourceLogs of list(request?.resourceLogs)) {
    const resource = read(resourceLogs?.resource?.attributes);
    for (const scopeLogs of list(resourceLogs?.scopeLogs)) {
      for (const record of list(scopeLogs?.logRecords)) {
        const event = toEvent(record, resource);
        if (event) events.push(event);
      }
    }
  }
  return events;
}
