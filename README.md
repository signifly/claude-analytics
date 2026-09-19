# claude-analytics

Usage analytics for Claude Code: which skills, slash commands, tools and subagents get run, by whom, across
developer sessions and autonomous (Sandcastle) agents. This repo hosts both halves:

- **`plugins/usage-analytics/`** – a Claude Code plugin holding the hook configuration and scripts.
- **`docker-compose.yml` + `stack/`** – the LGTM stack (Loki, Grafana, Tempo, Mimir) plus an OTel collector,
  with a provisioned "Claude Code usage" dashboard.

Documentation lives in [`docs/`](docs/): start with [what it is](docs/index.mdx), [install](docs/install.mdx)
and [what is recorded](docs/what-is-recorded.mdx).

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
claude plugin marketplace add signifly/claude-analytics
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
| `CLAUDE_ANALYTICS_DIR` | `~/.claude/analytics` (temp dir if there is no home) | Buffer location |
| `CLAUDE_ANALYTICS_FLUSH_MS` / `_IDLE_EXIT_MS` | `1000` / `600000` | Flush interval, idle time before the flusher exits (values under 100 or non-numeric are ignored, with a log line) |
| `CLAUDE_ANALYTICS_DISABLED` | – | `1`, `true` or `yes` turns recording off (anything else is logged and ignored) |

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

Per event: timestamp (plus random sub-millisecond digits), identity tag (git email by default), project name, source, session id, and the **name** of the
skill / slash command / tool / MCP tool / subagent. Never recorded: prompt text, command arguments, tool inputs or
outputs, file contents, or file paths. The working directory is only used to look up the project name (repo name,
else folder name). Names are reduced to a bare identifier
(`[\w:.-]`, first token only, at most 100 characters) before they are stored; a session id that isn't one becomes
`unknown`.

## How it works

- **Hooks** (`hooks/hooks.json`): `SessionStart`, `UserPromptSubmit` and `PostToolUse`, all `"async": true`, so a
  session never waits on analytics. `scripts/record.mjs` appends one JSON line per event and does no network I/O.
  It refuses new events while the live file is over 50 MB.
- **Identity** is resolved once per session (`CLAUDE_ANALYTICS_USER` → git email → OS user → `unknown`) and cached
  in `<dir>/sessions/` so later events skip the git lookups. Set `CLAUDE_ANALYTICS_*` through settings `env` or the
  real environment.
- **Flusher** (`scripts/flush.mjs`): spawned on demand by the hook (at most once every 5 s), one per buffer
  directory. The lock is a pid file with a heartbeat: a crashed flusher is replaced by the next hook event, and a
  lock whose pid is alive but whose heartbeat is older than 3 minutes (recycled pid, hung process) is taken over too.
  It inherits the Loki settings of the session that spawned it. Every flush interval it renames the live file to a
  `batch-*.jsonl` file and pushes it to `/loki/api/v1/push` in chunks of ~1 MiB. It exits after 10 minutes in which
  no new events arrived and no events left the buffer; held batches during an outage do not keep it alive, the next
  hook event starts a new flusher that retries them.
- **Failures**: network errors, timeouts, 5xx, 429 and any other unexpected status keep the unhandled events on disk
  and retry with backoff (twice the flush interval, doubling to 60 s), resuming after the last handled chunk;
  401/403/404/407 add a "check URL / credentials" hint to the log. 400/413/422, which Loki will never accept, move
  the events to `<dir>/dead/`, as do batches that cannot be read (`dead/` is capped at 20 MB, oldest-modified
  first). Held batches are capped at 50 MB, oldest evicted first (the newest is never evicted). Events older than
  6 days are skipped, since Loki rejects samples older than 7. Every one of these leaves a line in the log.
- **Late writes**: a settled batch is kept as `.settled-*` for 5 s and watched, because a slow hook process can
  still be writing to it; late bytes become a batch of their own
  ([ADR 0002](docs/architecture-decisions/0002-append-only-file-buffer.mdx)).
- **Labels** are low-cardinality: `service_name`, `user`, `project`, `source`, `kind`. The JSON log line repeats
  all but `service_name` and adds `name`, `session_id`, and where present `subagent` and `mcp_server`.

### Modules

All under `plugins/usage-analytics/scripts/`. Terms are defined in [CONTEXT.md](CONTEXT.md); decisions in
[docs/architecture-decisions/](docs/architecture-decisions/).

| Module | Owns |
|---|---|
| `usage-event.mjs` | `toEvent(payload, context)` (`context` may be a function, looked up lazily): kinds, names, the allow-list that keeps content out, and the `LABELS` list |
| `event-buffer.mjs` | `openBuffer(dir)` → `append` / `pending` / `claim` / `batch.settle`: the live file, batches, dead/, caps, expiry, late writes |
| `flusher-lock.mjs` | `mayStartFlusher` (for the hook), `acquire` → `stillMine` / `release` (for the flusher): one flusher per data dir, pid file with heartbeat |
| `flush-once.mjs` | `flushOnce(buffer, sink)`: one pass — chunking, resume, rejection handling |
| `drain.mjs` | the flusher loop: interval, backoff, idle exit, heartbeat before every push |
| `loki-sink.mjs` | the Loki adapter for the sink: stream grouping, timestamps, auth, which status codes retry |
| `session-context.mjs`, `config.mjs`, `log.mjs` | identity and project lookup, environment variables, diagnostics |
| `record.mjs` → `record-main.mjs`, `flush.mjs` | entry points: the hook (a guard that always exits 0 silently, around the real work), and the flusher process |

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

- `~/.claude/analytics/flusher.log` (rotated to `.log.1` at 1 MB; falls back to `$TMPDIR/claude-analytics.log`, same
  cap) records: flusher start/exit and lost or taken-over locks, config warnings, failed and recovered pushes with the
  underlying cause, batches delivered but not settled, rejected events, evictions, skipped expired/unparseable lines,
  a full live file, `dead/` or session-cache problems, and the flusher's stderr if it crashes. Hook-side messages are
  limited to one per kind per hour.
- Leftover `batch-*.jsonl` files mean Loki was unreachable or misconfigured; they are retried by the next flusher.
- Nothing arriving and no log at all usually means `node` is not on the `PATH` that Claude Code hooks run with.
- After changing the plugin, run `claude plugin marketplace update claude-analytics` and restart Claude Code.
