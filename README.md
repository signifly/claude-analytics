# claude-analytics

Usage analytics for Claude Code: which skills, slash commands, tools and subagents get run, by whom, across
developer sessions and autonomous (Sandcastle) agents. This repo hosts both halves:

- **`plugins/usage-analytics/`** – a Claude Code plugin holding the hook configuration and scripts.
- **`docker-compose.yml` + `stack/`** – the LGTM stack (Loki, Grafana, Tempo, Mimir) plus an OTel collector,
  with a provisioned "Claude Code usage" dashboard.

```
Claude Code hooks ──append──▶ ~/.claude/analytics/events.jsonl ──flusher (1s batches)──▶ Loki ──▶ Grafana
(async, no network)            shared, append-only buffer         one process per buffer dir
```

## Run the stack

```sh
docker compose up -d
open http://localhost:3030        # Grafana, opens on the usage dashboard (anonymous viewer; admin/admin to log in)
```

| Service | Port | Override |
|---|---|---|
| Grafana | 3030 | `GRAFANA_PORT`, `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_ANONYMOUS=false` |
| Loki push/query | 3100 | `LOKI_PORT` (then also change `CLAUDE_ANALYTICS_LOKI_URL`) |
| OTLP gRPC / HTTP | 4317 / 4318 | `OTLP_GRPC_PORT`, `OTLP_HTTP_PORT` |

All ports are published on **127.0.0.1 only**. To serve a team, set `BIND_ADDRESS=0.0.0.0` and, before you do,
set a real admin password, `GRAFANA_ANONYMOUS=false`, and put Loki behind auth (it has none of its own; the flusher
supports bearer/basic auth, see below). Retention: Loki 90 days, Tempo 7 days, Mimir unlimited. The dashboard is
provisioned from `stack/grafana/dashboards/`; edit the JSON there, UI edits are not persisted.

## Install the hooks

The repo is a plugin marketplace. Per developer:

```sh
claude plugin marketplace add <git-url-or-path-of-this-repo>
claude plugin install usage-analytics@claude-analytics
```

Per team repo (auto-enabled once the folder is trusted): copy `examples/project-settings.json` into the repo's
`.claude/settings.json`. To make it mandatory org-wide, put the same keys in managed settings.

To try it without installing: `claude --plugin-dir plugins/usage-analytics`.

Requires `node` ≥ 18 on the machine/container running Claude Code. No dependencies.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_ANALYTICS_LOKI_URL` | `http://localhost:3100` | Loki base URL |
| `CLAUDE_ANALYTICS_USER` | `git config user.email`, then OS user | Identity tag (`user` label) |
| `CLAUDE_ANALYTICS_SOURCE` | `dev` | `dev` or e.g. `sandcastle` (`source` label) |
| `CLAUDE_ANALYTICS_PROJECT` | repo name of the `origin` remote, then git root folder, then cwd folder | `project` label |
| `CLAUDE_ANALYTICS_LOKI_TOKEN` / `_LOKI_BASIC_AUTH` / `_LOKI_TENANT` | – | Bearer token (wins over basic), `user:pass`, `X-Scope-OrgID` |
| `CLAUDE_ANALYTICS_DIR` | `~/.claude/analytics` | Buffer location |
| `CLAUDE_ANALYTICS_FLUSH_MS` / `_IDLE_EXIT_MS` | `1000` / `600000` | Flush interval, idle time before the flusher exits |
| `CLAUDE_ANALYTICS_DISABLED` | – | exactly `1` turns recording off |

Set shared values through the `env` key of a settings file (see the example).

### Sandcastle agents

Pass identity through the `env` option so it exists before Claude Code starts:

```ts
await sandcastle.run({
  // ...
  env: {
    CLAUDE_ANALYTICS_USER: "agent:pr-reviewer",
    CLAUDE_ANALYTICS_SOURCE: "sandcastle",
    CLAUDE_ANALYTICS_LOKI_URL: "http://host.docker.internal:3100",
  },
});
```

Each container runs its own buffer and flusher. Don't mount the host's `~/.claude/analytics` into a container: the
flusher lock is pid-based and pids don't carry across containers. Set `CLAUDE_ANALYTICS_USER` explicitly; containers
often have no git identity or passwd entry to fall back on. With the default loopback binding a container may not
reach the host's Loki; point it at a shared Loki or start the stack with `BIND_ADDRESS=0.0.0.0`.

## What is recorded

Per event: timestamp, identity tag (git email by default), project name, source, session id, and the **name** of the
skill / slash command / tool / MCP tool / subagent. Never recorded: prompt text, command arguments, tool inputs or
outputs, file contents, file paths or the working directory. Names are reduced to a bare identifier
(`[\w:.-]`, first token only) before they are stored.

## How it works

- **Hooks** (`hooks/hooks.json`): `SessionStart`, `UserPromptSubmit` and `PostToolUse`, all `"async": true`, so a
  session never waits on analytics. `scripts/record.mjs` appends one JSON line per event and does no network I/O.
  It stops appending while the buffer is over 50 MB.
- **Identity** is resolved once per session (`CLAUDE_ANALYTICS_USER` → git email → OS user → `unknown`) and cached
  in `<dir>/sessions/` so later events skip the git lookups. Set `CLAUDE_ANALYTICS_*` through settings `env` or the
  real environment.
- **Flusher** (`scripts/flush.mjs`): spawned on demand by the hook, one per buffer directory. The lock is a pid file
  with a heartbeat, so a crashed flusher or a recycled pid is taken over after 3 minutes. It inherits the Loki
  settings of the session that spawned it. Every second it renames the buffer to a `batch-*.jsonl` file, pushes it
  to `/loki/api/v1/push` in chunks of ~1 MiB and deletes it once everything was handled. It exits after 10 minutes
  without new events or a successful push.
- **Failures**: network errors, 5xx, 429 and config-type errors (401/403/404/407/408) keep the batch on disk and
  retry with backoff (2 s doubling to 60 s), resuming after the last delivered chunk. Only 400/413/422, which Loki
  will never accept, take events out of the queue, and those are kept in `<dir>/dead/` (capped at 20 MB). The
  backlog is capped at 50 MB, oldest evicted first. Events older than 6 days are skipped, since Loki rejects
  samples older than 7. All of this is logged.
- **Labels** are low-cardinality: `service_name`, `user`, `project`, `source`, `kind`. The JSON log line repeats
  those and adds `name`, `session_id`, and where present `subagent` and `mcp_server`.

### Modules

All under `plugins/usage-analytics/scripts/`. Terms are defined in [CONTEXT.md](CONTEXT.md); decisions in
[docs/architecture-decisions/](docs/architecture-decisions/).

| Module | Owns |
|---|---|
| `usage-event.mjs` | `toEvent(payload, context)`: kinds, names, and the allow-list that keeps content out |
| `event-buffer.mjs` | `append` / `claim` / `batch.settle`: the live file, batches, dead/, caps, expiry, late tails |
| `flusher-lock.mjs` | `isHeld` / `acquire`: one flusher per data dir, pid file with heartbeat |
| `flush-once.mjs` | `flushOnce(buffer, sink)`: chunking, resume, rejection handling |
| `loki-sink.mjs` | the Loki adapter for the sink: streams, timestamps, auth, which status codes retry |
| `session-context.mjs`, `config.mjs`, `log.mjs` | identity and project lookup, environment variables, diagnostics |
| `record.mjs`, `flush.mjs` | entry points: the hook, and the flusher loop (interval, backoff, idle exit) |

### Event kinds

| `kind` | From | `name` |
|---|---|---|
| `skill` | `PostToolUse` on the `Skill` tool | skill name |
| `command` | `UserPromptSubmit` starting with `/word` | command name (arguments are not recorded) |
| `agent` | `PostToolUse` on `Agent`/`Task` | subagent type |
| `mcp` | `PostToolUse` on `mcp__*` | full tool name |
| `tool` | any other `PostToolUse` | tool name |
| `prompt` | any other `UserPromptSubmit` | constant `prompt` (prompt text is never recorded) |
| `session` | `SessionStart` | startup / resume / clear / compact |

Example LogQL: `sum by (name, user) (count_over_time({service_name="claude-code-usage", kind="skill"} | json name="name" [7d]))`

## Native Claude Code telemetry (optional)

The collector also accepts Claude Code's built-in OpenTelemetry export (token/cost metrics, tool events) into the
same Loki/Mimir/Tempo (delta metrics are converted to cumulative for Mimir):

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 claude
```

## Development

```sh
npm test                                                  # unit tests, no network, no dependencies
SMOKE_LOKI_URL=http://localhost:3100 node --test test/smoke.test.mjs   # real hook → real Loki
```

Tests live at the module interfaces above; the buffer and lock run against temp dirs, the flusher against an
in-memory sink, the Loki adapter against an injected `fetch`. To ship a change, bump `version` in
`plugins/usage-analytics/.claude-plugin/plugin.json`.

## Troubleshooting

- `~/.claude/analytics/flusher.log` (rotated to `.log.1` at 1 MB; falls back to `$TMPDIR/claude-analytics.log`) records
  flusher start/exit, lock takeovers, failed and recovered pushes with the underlying cause, rejected or evicted
  batches, skipped expired/corrupt lines, and hook-side failures.
- Leftover `batch-*.jsonl` files mean Loki was unreachable or misconfigured; they are retried by the next flusher.
- Nothing arriving and no log at all usually means `node` is not on the `PATH` that Claude Code hooks run with.
- After changing the plugin, run `claude plugin marketplace update claude-analytics` and restart Claude Code.
