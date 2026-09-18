#!/usr/bin/env node
// Claude Code hook entry point. Its contract with the session: exit 0 and print
// nothing, whatever happens — including a half-updated plugin whose modules fail to load.
try {
  await import("./record-main.mjs");
} catch {}
