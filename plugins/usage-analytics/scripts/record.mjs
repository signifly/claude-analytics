#!/usr/bin/env node
// Claude Code hook: turns one hook payload (JSON on stdin) into at most one
// JSON line appended to the shared buffer, and starts the flusher if none is
// running. Never talks to the network; the flusher does.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUFFER_FILE, DISABLED, LOG_FILE, MAX_BACKLOG_BYTES,
  bareName, ensureDirs, flusherAlive, log, logOnce, sessionContext,
} from "./lib.mjs";

function classify(p) {
  switch (p.hook_event_name) {
    case "SessionStart":
      return { kind: "session", name: bareName(p.source || "startup") };
    case "UserPromptSubmit": {
      // Only a leading "/token" is recorded (as the command name); the rest of
      // the prompt is discarded.
      const token = String(p.prompt || "").trimStart().split(/\s/, 1)[0];
      if (/^\/[\w:.-]+$/.test(token)) return { kind: "command", name: bareName(token) };
      return { kind: "prompt", name: "prompt" };
    }
    case "PostToolUse": {
      const tool = bareName(p.tool_name);
      const input = p.tool_input || {};
      if (tool === "Skill") return { kind: "skill", name: bareName(input.skill || input.command) };
      if (tool === "Agent" || tool === "Task") return { kind: "agent", name: bareName(input.subagent_type || "general-purpose") };
      if (tool.startsWith("mcp__")) return { kind: "mcp", name: tool, mcp_server: tool.split("__")[1] };
      return { kind: "tool", name: tool };
    }
    default:
      return null;
  }
}

function startFlusher() {
  const flusher = path.join(path.dirname(fileURLToPath(import.meta.url)), "flush.mjs");
  let stderr = "ignore";
  try {
    stderr = fs.openSync(LOG_FILE, "a"); // catches crashes before the flusher can log
  } catch {}
  const child = spawn(process.execPath, [flusher], { detached: true, stdio: ["ignore", "ignore", stderr] });
  // Spawn failures are asynchronous: without this they'd crash the hook.
  child.on("error", (err) => log(`flusher spawn failed: ${err?.code || err?.message}`));
  child.unref();
}

function main() {
  if (DISABLED) return;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (err) {
    ensureDirs();
    return logOnce("stdin", `unreadable hook payload: ${err?.message}`);
  }
  const classified = classify(payload);
  if (!classified) return;

  ensureDirs();
  let backlog = 0;
  try {
    backlog = fs.statSync(BUFFER_FILE).size;
  } catch {}
  if (backlog > MAX_BACKLOG_BYTES) {
    logOnce("buffer-full", `buffer over ${MAX_BACKLOG_BYTES} bytes, dropping events until it drains`);
  } else {
    const event = {
      ts: Date.now(),
      // Random sub-millisecond digits: a stable, unique Loki timestamp for this
      // event, so a re-pushed batch dedupes instead of double counting.
      sub: Math.floor(Math.random() * 1e6),
      ...classified,
      ...sessionContext(payload.session_id, payload.cwd),
      session_id: payload.session_id,
      subagent: payload.agent_type ? bareName(payload.agent_type) : undefined,
    };
    // One small write in append mode: safe with several concurrent writers on a
    // local filesystem (the flusher skips any torn line).
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(event) + "\n");
  }

  if (!flusherAlive()) startFlusher();
}

try {
  main();
} catch (err) {
  // Analytics must never surface errors into a session; leave a trace instead.
  log(`record failed: ${err?.code || err?.message}`);
}
