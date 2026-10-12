# claude-analytics

Usage analytics for Claude Code: which skills, slash commands, tools and subagents get run, by whom, across
developer sessions and autonomous (Sandcastle) agents. It records names, never content.

- **`plugins/usage-analytics/`** is a Claude Code plugin whose async hooks append one line per event to a local
  buffer; a background flusher ships the buffer to Loki.
- **`docker-compose.yml` and `stack/`** run Loki, Grafana, Tempo, Mimir and an OpenTelemetry collector, with a
  provisioned "Claude Code usage" dashboard.
- **`apps/docs/`** is the documentation site, built with Fumadocs from `docs/` (Node 20.9+ for `pnpm build`).

```
Claude Code hooks ──append──▶ ~/.claude/analytics/events.jsonl ──flusher (1s batches)──▶ Loki ──▶ Grafana
```

## Quick start

```sh
git clone https://github.com/signifly/claude-analytics && cd claude-analytics
docker compose up -d                                        # the stack; Grafana on http://localhost:3030
claude plugin marketplace add signifly/claude-analytics
claude plugin install usage-analytics@claude-analytics      # needs node >= 18 on the PATH hooks run with
```

## Documentation

| Page | Answers |
|---|---|
| [What it is](docs/index.mdx) | What claude-analytics does and how the parts fit |
| [Install](docs/install.mdx) | Installing for yourself, a team repo, an organisation or an agent; every configuration variable |
| [What is recorded](docs/what-is-recorded.mdx) | The fields of a usage event, its kinds, and how it looks in Loki |
| [How it works](docs/how-it-works.mdx) | Hooks, the event buffer, the flusher, failures, the modules, troubleshooting |
| [Operating the stack](docs/operating-the-stack.mdx) | Ports, serving a team safely, retention, the dashboard, native telemetry |
| [Architecture decisions](docs/architecture-decisions/) | Why it was built this way |

Terms are defined in [CONTEXT.md](CONTEXT.md), the glossary.

## Development

```sh
pnpm install                                              # turbo; the plugin itself has no dependencies
pnpm test                                                 # unit tests, no network (turbo run test test:root)
pnpm check                                                # syntax-check the plugin scripts (turbo run check)
pnpm --filter docs dev                                    # the docs site on http://localhost:3000, from docs/ (Node 20.9+)
SMOKE_LOKI_URL=http://localhost:3100 node --test test/smoke.test.mjs   # real hook → real Loki
```

The plugin has no dependencies and no build step. To ship a change, bump `version` in
`plugins/usage-analytics/.claude-plugin/plugin.json`.
