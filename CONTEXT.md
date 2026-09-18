# Context

Domain language for claude-analytics. Use these terms exactly in code, tests, docs and reviews.

## Glossary

**Usage event** — one recorded fact that something was used in a Claude Code session: a name, a kind, and who/where. Never carries content (prompt text, arguments, tool inputs or outputs, paths). _Avoid_: log, metric, telemetry.

**Kind** — what was used. One of `skill`, `command`, `agent`, `mcp`, `tool`, `prompt`, `session`. A skill typed as a slash command is a `command`; the same skill invoked by Claude is a `skill`.

**Name** — the bare identifier of the thing used: first token only, a leading `/` stripped, characters `[\w:.-]`, at most 100; anything else becomes `unknown`.

**Hook payload** — the JSON Claude Code pipes to a hook on stdin. Input to the plugin, never stored.

**Session context** — who and where a session is: `user`, `project`, `source`. Resolved once per session and cached.

**Identity tag** — the `user` value. `CLAUDE_ANALYTICS_USER` if set, else git email, else OS user, else `unknown`.

**Source** — what kind of session produced the event: `dev` (a person) or e.g. `sandcastle` (an autonomous agent).

**Event buffer** — everything under the data dir that holds usage events between capture and delivery: the live file, claimed batches, and the dead folder.

**Live file** — `events.jsonl`, the append-only file hooks write to.

**Batch** — a claimed slice of the buffer (`batch-*.jsonl`): renamed away from the live file so writers and the flusher don't contend. The one overlap — a slow writer appending to a file that was already claimed, or even settled — is caught: see **Late write**.

**Late write** — an event a slow writer puts into a batch file after the claim. Before the settle it is a *late tail* and stays held; after it, the settled file is still being watched and the bytes become a batch of their own.

**Settle** — telling the buffer what happened to a batch: how many events were handled, which were rejected. Unhandled events stay held.

**Held** — events still on disk waiting for a later attempt.

**Dead** — events set aside in `dead/` for inspection: rejected by the sink, or in a batch that could not be read. _Avoid_: dropped. Events only ever leave the buffer undelivered with a log line: expiry, unparseable lines, cap eviction, a full live file, or an unusable `dead/`.

**Expired** — events older than the age limit, skipped (and gone once their batch settles) because Loki would refuse them.

**Flusher** — the single background process per data dir that moves events from the buffer to the sink.

**Flusher lock** — the pid file plus heartbeat that guarantees one flusher per data dir.

**Sink** — where the flusher delivers events. `push(events)` answers `ok` or `rejected`, or throws when a retry makes sense. Loki is the production adapter.

**Stack** — the docker compose deployment: Loki, Grafana, Tempo, Mimir, OTel collector.

## Relationships

- A **hook payload** becomes at most one **usage event**.
- A **usage event** is a **kind**, a **name** and a **session context**.
- Hooks append to the **live file**; the **flusher** claims **batches** from the **event buffer** and pushes them to the **sink**, then **settles** each batch.
- One **flusher lock** per data dir; one **flusher** per lock.
