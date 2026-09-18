import assert from "node:assert/strict";
import { test } from "node:test";
import { toEvent } from "../plugins/usage-analytics/scripts/usage-event.mjs";

const context = { user: "dev@example.com", project: "webshop", source: "dev" };
const at = { now: 1_700_000_000_000, sub: 42 };
const base = { session_id: "s-1", cwd: "/Users/someone/clients/acme/webshop" };

test("a skill run by Claude is recorded by skill name", () => {
  const event = toEvent(
    { ...base, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "tdd", args: "add retry to payments" } },
    context,
    at,
  );
  assert.deepEqual(event, {
    ts: 1_700_000_000_000,
    sub: 42,
    kind: "skill",
    name: "tdd",
    user: "dev@example.com",
    project: "webshop",
    source: "dev",
    session_id: "s-1",
  });
});

test("a typed slash command is recorded by command name, without its arguments", () => {
  const event = toEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "/commit fix auth bug for Acme" }, context, at);
  assert.equal(event.kind, "command");
  assert.equal(event.name, "commit");
  assert.ok(!JSON.stringify(event).includes("Acme"));
});

test("an ordinary prompt is counted without its text", () => {
  const event = toEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "Why is Danish VAT wrong at checkout?" }, context, at);
  assert.equal(event.kind, "prompt");
  assert.equal(event.name, "prompt");
  assert.ok(!JSON.stringify(event).includes("VAT"));
});

test("a prompt that starts with a file path is a prompt, not a command", () => {
  const event = toEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "/Users/someone/notes.md summarise" }, context, at);
  assert.equal(event.kind, "prompt");
  assert.ok(!JSON.stringify(event).includes("notes.md"));
});

const tool = (tool_name, tool_input = {}, extra = {}) => ({ ...base, hook_event_name: "PostToolUse", tool_name, tool_input, ...extra });

test("other tool calls are recorded by tool name only", () => {
  const event = toEvent(tool("Bash", { command: "psql $DATABASE_URL -c 'select * from users'" }), context, at);
  assert.equal(event.kind, "tool");
  assert.equal(event.name, "Bash");
  assert.ok(!JSON.stringify(event).includes("psql"));
});

test("an MCP tool call keeps the full tool name and names its server", () => {
  const event = toEvent(tool("mcp__claude_ai_Notion__notion-search", { query: "Q4 pricing" }), context, at);
  assert.equal(event.kind, "mcp");
  assert.equal(event.name, "mcp__claude_ai_Notion__notion-search");
  assert.equal(event.mcp_server, "claude_ai_Notion");
});

test("a spawned subagent is recorded by its type, not its brief", () => {
  const event = toEvent(tool("Agent", { subagent_type: "Explore", prompt: "find invoice PDF code" }), context, at);
  assert.equal(event.kind, "agent");
  assert.equal(event.name, "Explore");
  assert.ok(!JSON.stringify(event).includes("invoice"));
});

test("a subagent spawned without a type counts as general-purpose", () => {
  assert.equal(toEvent(tool("Task", { prompt: "x" }), context, at).name, "general-purpose");
});

test("events fired inside a subagent carry the subagent type", () => {
  assert.equal(toEvent(tool("Read", {}, { agent_type: "Explore" }), context, at).subagent, "Explore");
});

test("a session start is recorded with how it started", () => {
  const event = toEvent({ ...base, hook_event_name: "SessionStart", source: "resume" }, context, at);
  assert.equal(event.kind, "session");
  assert.equal(event.name, "resume");
  assert.equal(event.source, "dev"); // the payload's `source` must not overwrite the session context's
});

test("hook events we don't track produce nothing", () => {
  assert.equal(toEvent({ ...base, hook_event_name: "Stop" }, context, at), null);
});

test("a skill invoked through a command line keeps only the skill name", () => {
  const event = toEvent(tool("Skill", { command: "/commit fix the auth bug for Acme" }), context, at);
  assert.equal(event.name, "commit");
  assert.ok(!JSON.stringify(event).includes("Acme"));
});

test("a name that is not a bare identifier becomes unknown", () => {
  assert.equal(toEvent(tool("Skill", { skill: "../../etc/passwd" }), context, at).name, "unknown");
  assert.equal(toEvent(tool("Skill", {}), context, at).name, "unknown");
});

test("no payload content ever reaches the event, whatever the hook sends", () => {
  const secrets = { cwd: "/Users/someone/clients/acme", transcript_path: "/tmp/transcript.jsonl", tool_response: "SECRET-OUTPUT", prompt: "SECRET-PROMPT" };
  const event = toEvent({ ...tool("Edit", { file_path: "/secret/path.ts", new_string: "SECRET-CODE" }), ...secrets }, context, at);
  const line = JSON.stringify(event);
  for (const leaked of ["acme", "transcript", "SECRET", "/secret"]) assert.ok(!line.includes(leaked), `leaked ${leaked}`);
  assert.deepEqual(Object.keys(event).sort(), ["kind", "name", "project", "session_id", "source", "sub", "ts", "user"]);
});

test("an empty subagent type is left out rather than recorded as unknown", () => {
  assert.equal("subagent" in toEvent(tool("Read", {}, { agent_type: "" }), context, at), false);
});

test("session context is only looked up for payloads that produce an event", () => {
  let lookups = 0;
  const lookup = () => (lookups++, context);
  assert.equal(toEvent({ ...base, hook_event_name: "Stop" }, lookup, at), null);
  assert.equal(lookups, 0);
  assert.equal(toEvent(tool("Read"), lookup, at).user, "dev@example.com");
  assert.equal(lookups, 1);
});
