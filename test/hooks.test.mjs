// The hook commands as Claude Code runs them: through a shell, with whatever PATH
// it was started with. Opened from the Dock, the desktop app's PATH has no
// /usr/local/bin or /opt/homebrew/bin, where the Node installers put node.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../plugins/usage-analytics", import.meta.url));
const { hooks } = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8"));
const commands = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => [event, h.command])));
const installed = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].some((n) => fs.existsSync(n));

for (const [event, command] of commands) {
  test(`the ${event} hook finds node with only the system PATH a GUI app gets`, { skip: !installed && "node is not in /usr/local/bin or /opt/homebrew/bin here" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
    const result = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s-1", cwd: os.tmpdir(), tool_name: "Read", tool_input: {} }),
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: os.homedir(),
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_ANALYTICS_DIR: dir,
        CLAUDE_ANALYTICS_USER: "test",
        CLAUDE_ANALYTICS_LOKI_URL: "http://127.0.0.1:9",
        CLAUDE_ANALYTICS_IDLE_EXIT_MS: "300",
      },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.match(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"), /"name":"Read"/);
  });
}
