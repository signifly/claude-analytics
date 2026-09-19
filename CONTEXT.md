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

**Data dir** — the folder that holds one event buffer together with its flusher lock, cached session contexts and log. Each machine or container has its own; never shared between them.

**Event buffer** — everything under the data dir that holds usage events between capture and delivery: the live file, claimed batches, and the dead folder.

**Live file** — `events.jsonl`, the append-only file hooks write to.

**Claim** — the flusher taking everything in the live file as a new batch in one step, so writers carry on into a fresh live file. Each claim then offers every held batch, oldest first.

**Batch** — a claimed slice of the buffer (`batch-*.jsonl`): renamed away from the live file so writers and the flusher don't contend. The one overlap — a slow writer appending to a file that was already claimed, or even settled — is caught: see **Late write**.

**Grace period** — how long a settled batch must go without any write before it is removed; every late write restarts it. It counts from the batch's last write, not from its settle, so a batch that was quiet before it was settled can be removed at once, and a slow writer that only now gets to write can lose its event.

**Late write** — an event a slow writer puts into a batch file after the claim. Before the settle it is a *late tail* and stays held; after it, the settled file is still being watched and the bytes become a batch of their own.

**Settle** — telling the buffer what happened to a batch: how many events were handled, which were rejected. Unhandled events stay held.

**Held** — events still on disk waiting for a later attempt.

**Backlog** — the events waiting for delivery: the live file and the held batches. The two parts are capped separately, at the same size: over its cap the live file refuses new events (logged), and the oldest held batches are evicted, each with a log line.

**Dead** — events set aside in `dead/` for inspection: rejected by the sink, or in a batch that could not be read. _Avoid_: dropped. Events only ever leave the buffer undelivered with a log line: expiry, unparseable lines, cap eviction, a full live file, or an unusable `dead/`.

**Expired** — events older than the age limit, skipped (and gone once their batch settles) because Loki would refuse them.

**Flusher** — the single background process per data dir that moves events from the buffer to the sink.

**Flusher lock** — the pid file plus heartbeat that guarantees one flusher per data dir.

**Sink** — where the flusher delivers events. `push(events)` answers `ok` or `rejected`, or throws when a retry makes sense. Loki is the production adapter.

**Push** — one delivery attempt: a chunk of a batch handed to the sink. It is either handled (`ok` or `rejected`) or fails as a whole and is retried later, with every event from it, and everything behind it, still held.

**Stack** — the docker compose deployment: Loki, Grafana, Tempo, Mimir, OTel collector.

## Relationships

- A **hook payload** becomes at most one **usage event**.
- A **usage event** is a **kind**, a **name** and a **session context**.
- Hooks append to the **live file**; the **flusher** claims **batches** from the **event buffer** and pushes them to the **sink**, then **settles** each batch.
- One **flusher lock** per data dir; one **flusher** per lock.
