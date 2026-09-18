// Usage event: maps a Claude Code hook payload to the one thing we record.
// See docs/architecture-decisions/0003-record-names-never-content.mdx.

// Loki stream labels. Meant to stay low-cardinality: `kind` is a fixed set;
// user/project/source are one value per person/repo/deployment but are not validated here.
export const LABELS = ["user", "project", "source", "kind"];

// The only fields an event may carry, and which of them hold identifiers.
// (`ts` + `sub` together are the timestamp: milliseconds plus random sub-millisecond digits.)
const FIELDS = ["ts", "sub", "kind", "name", "mcp_server", "user", "project", "source", "session_id", "subagent"];
const IDENTIFIERS = new Set(["kind", "name", "mcp_server", "subagent"]);
// The only fields the session context may supply; anything else in it is ignored.
const CONTEXT_FIELDS = ["user", "project", "source"];

const BARE = /^[\w:.-]{1,100}$/;

// First token only, leading "/" stripped, [\w:.-], at most 100 characters —
// so free text can never ride along in a name. Anything else is "unknown".
export function bareName(value) {
  const token = String(value ?? "").trim().split(/\s/, 1)[0].replace(/^\//, "");
  return BARE.test(token) ? token : "unknown";
}

function classify(payload) {
  if (payload.hook_event_name === "UserPromptSubmit") {
    // A command is a leading "/token"; a path has further slashes and is just a prompt.
    const token = String(payload.prompt || "").trimStart().split(/\s/, 1)[0];
    return /^\/[\w:.-]+$/.test(token) ? { kind: "command", name: token } : { kind: "prompt", name: "prompt" };
  }
  if (payload.hook_event_name === "SessionStart") return { kind: "session", name: payload.source || "startup" };
  if (payload.hook_event_name !== "PostToolUse") return null;

  const tool = bareName(payload.tool_name);
  const input = payload.tool_input || {};
  if (tool === "Skill") return { kind: "skill", name: input.skill || input.command };
  if (tool === "Agent" || tool === "Task") return { kind: "agent", name: input.subagent_type || "general-purpose" };
  if (tool.startsWith("mcp__")) return { kind: "mcp", name: tool, mcp_server: tool.split("__")[1] };
  return { kind: "tool", name: tool };
}

// `context` is the session context, or a function returning it: the lookup can
// cost git subprocesses, so it only happens for payloads that produce an event.
export function toEvent(payload, context, { now = Date.now(), sub = Math.floor(Math.random() * 1e6) } = {}) {
  const classified = classify(payload);
  if (!classified) return null;
  const resolved = (typeof context === "function" ? context() : context) || {};
  const draft = { ts: now, sub, ...classified, session_id: payload.session_id ?? undefined, subagent: payload.agent_type || undefined };
  for (const field of CONTEXT_FIELDS) {
    const value = resolved[field];
    draft[field] = typeof value === "string" || typeof value === "number" ? String(value).slice(0, 200) : "unknown";
  }
  // The allow-list is the last step: a branch above cannot leak a field it was never allowed to emit.
  const event = {};
  for (const field of FIELDS) {
    if (draft[field] === undefined && field !== "name") continue; // every event has a name
    if (IDENTIFIERS.has(field)) event[field] = bareName(draft[field]);
    // A session id is an id or nothing: no first-token leniency for free text.
    else if (field === "session_id") event[field] = typeof draft[field] === "string" && BARE.test(draft[field]) ? draft[field] : "unknown";
    else event[field] = draft[field];
  }
  return event;
}
