import assert from "node:assert/strict";
import { test } from "node:test";
import { toUsageEvents } from "../apps/cowork-bridge/cowork-event.mjs";

// OTLP/JSON attribute values, as Cowork's http/json exporter sends them.
const attrs = (object) => Object.entries(object).map(([key, value]) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } }));

const SECRET = "ACME-CONFIDENTIAL";
const standard = { "user.email": "Dev@Signifly.com", "session.id": "cowork-session-1", "organization.id": "org-1", "user.account_uuid": "uuid-1" };

function request(...records) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attrs({ "service.name": "cowork", "host.name": `${SECRET}-laptop` }) },
        scopeLogs: [
          {
            logRecords: records.map(({ name, time = "1700000000000123456", ...rest }) => ({
              timeUnixNano: time,
              body: { stringValue: `claude_code.${name}` },
              attributes: attrs({ ...standard, "event.name": name, ...rest }),
            })),
          },
        ],
      },
    ],
  };
}

test("a skill Claude activates in Cowork is a skill event for the person's work email", () => {
  const [event] = toUsageEvents(request({ name: "skill_activated", "skill.name": "brand-voice", invocation_trigger: "claude-proactive" }));
  assert.deepEqual(event, {
    ts: 1_700_000_000_000,
    sub: 123456,
    kind: "skill",
    name: "brand-voice",
    user: "dev@signifly.com",
    project: "unknown",
    source: "cowork",
    session_id: "cowork-session-1",
  });
});

test("a skill the person typed as a slash command is a command, as in Claude Code", () => {
  const [event] = toUsageEvents(request({ name: "skill_activated", "skill.name": "brand-voice", invocation_trigger: "user-slash" }));
  assert.equal(event.kind, "command");
  assert.equal(event.name, "brand-voice");
});

test("a prompt is counted without its text, and a slash command in it is left to skill_activated", () => {
  const events = toUsageEvents(request({ name: "user_prompt", prompt: `Summarise the ${SECRET} pitch`, prompt_length: 30, command_name: "brand-voice" }));
  assert.deepEqual(events.map(({ kind, name }) => ({ kind, name })), [{ kind: "prompt", name: "prompt" }]);
});

test("a built-in tool is recorded by name, never with its input", () => {
  const [event] = toUsageEvents(
    request({ name: "tool_result", tool_name: "Bash", tool_input: `{"command":"cat ${SECRET}.txt"}`, tool_parameters: `{"bash_command":"cat ${SECRET}.txt"}` }),
  );
  assert.equal(event.kind, "tool");
  assert.equal(event.name, "Bash");
});

test("an MCP tool is named from the server and tool names in tool_parameters, and nothing else in it is kept", () => {
  const [event] = toUsageEvents(
    request({
      name: "tool_result",
      tool_name: "mcp_tool",
      tool_parameters: JSON.stringify({ mcp_server_name: "claude_ai_Notion", mcp_tool_name: "notion-search", query: SECRET }),
      tool_input: JSON.stringify({ query: SECRET }),
    }),
  );
  assert.equal(event.kind, "mcp");
  assert.equal(event.name, "mcp__claude_ai_Notion__notion-search");
  assert.equal(event.mcp_server, "claude_ai_Notion");
});

test("an MCP tool whose names were redacted is still counted, as an unnamed MCP call", () => {
  const [event] = toUsageEvents(request({ name: "tool_result", tool_name: "mcp_tool" }));
  assert.equal(event.kind, "mcp");
  assert.equal(event.name, "mcp_tool");
  assert.equal(event.mcp_server, undefined);
});

test("an MCP tool name in Claude Code's own form keeps its server", () => {
  const [event] = toUsageEvents(request({ name: "tool_result", tool_name: "mcp__claude_ai_Slack__slack_send_message" }));
  assert.equal(event.kind, "mcp");
  assert.equal(event.mcp_server, "claude_ai_Slack");
});

test("an MCP name that is not a bare identifier becomes unknown rather than carrying free text", () => {
  const [event] = toUsageEvents(
    request({ name: "tool_result", tool_name: "mcp_tool", tool_parameters: JSON.stringify({ mcp_server_name: `${SECRET} notes`, mcp_tool_name: "read" }) }),
  );
  assert.equal(event.name, "mcp_tool");
  assert.ok(!JSON.stringify(event).includes(SECRET));
});

test("a subagent is an agent event named by its type", () => {
  const [event] = toUsageEvents(request({ name: "tool_result", tool_name: "Agent", tool_parameters: JSON.stringify({ subagent_type: "Explore", prompt: SECRET }) }));
  assert.equal(event.kind, "agent");
  assert.equal(event.name, "Explore");
});

test("the Skill tool and tool decisions are not counted twice", () => {
  const events = toUsageEvents(
    request(
      { name: "skill_activated", "skill.name": "brand-voice", invocation_trigger: "claude-proactive" },
      { name: "tool_decision", tool_name: "Skill", decision: "accept" },
      { name: "tool_result", tool_name: "Skill" },
    ),
  );
  assert.deepEqual(events.map((e) => e.kind), ["skill"]);
});

test("responses, API calls and every other event are dropped", () => {
  const events = toUsageEvents(
    request(
      { name: "assistant_response", response: SECRET },
      { name: "api_request", model: "claude-opus-5-5", cost_usd: "0.1" },
      { name: "api_request_body", body: SECRET },
      { name: "plugin_loaded", "plugin.name": "x" },
    ),
  );
  assert.deepEqual(events, []);
});

test("no content from a request full of it reaches an event", () => {
  const everything = request(
    { name: "user_prompt", prompt: SECRET, prompt_text: SECRET },
    { name: "tool_result", tool_name: "Read", tool_input: SECRET, tool_parameters: SECRET, error: SECRET },
    { name: "tool_result", tool_name: "mcp_tool", tool_parameters: `{"mcp_server_name":"x","mcp_tool_name":"y","q":"${SECRET}"}` },
    { name: "skill_activated", "skill.name": "brand-voice", "skill.source": SECRET },
  );
  const events = toUsageEvents(everything);
  assert.equal(events.length, 4);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("an identity that is not an email address is unknown, and a session id that is not bare is unknown", () => {
  const [event] = toUsageEvents(request({ name: "tool_result", tool_name: "Read", "user.email": "not an email", "session.id": "a b" }));
  assert.equal(event.user, "unknown");
  assert.equal(event.session_id, "unknown");
});

test("the timestamp comes from the record, so an exporter's retry produces the same event", () => {
  const record = { name: "tool_result", tool_name: "Read", time: "1700000000999000001" };
  const [first] = toUsageEvents(request(record));
  const [again] = toUsageEvents(request(record));
  assert.deepEqual(first, again);
  assert.equal(first.ts, 1_700_000_000_999);
  assert.equal(first.sub, 1);
});

test("a record without a timestamp falls back to its observed time", () => {
  const body = request({ name: "tool_result", tool_name: "Read" });
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  delete record.timeUnixNano;
  record.observedTimeUnixNano = "1700000005000000000";
  assert.equal(toUsageEvents(body)[0].ts, 1_700_000_005_000);
});

test("the event name is read from the body when the attribute is missing", () => {
  const body = request({ name: "tool_result", tool_name: "Read" });
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  record.attributes = record.attributes.filter((a) => a.key !== "event.name");
  assert.equal(toUsageEvents(body)[0].name, "Read");
});

test("malformed requests yield no events instead of throwing", () => {
  for (const body of [null, "x", {}, { resourceLogs: "x" }, { resourceLogs: [{ scopeLogs: [{ logRecords: [null, 1, { attributes: "x" }] }] }] }]) {
    assert.deepEqual(toUsageEvents(body), []);
  }
});
