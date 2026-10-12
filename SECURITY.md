# Security

Report a vulnerability privately through
[GitHub's private vulnerability reporting](https://github.com/signifly/claude-analytics/security/advisories/new),
not in a public issue or pull request. We aim to reply within five working days.

The plugin runs on every machine that installs it, inside Claude Code sessions, so these matter most:

- anything that sends prompt text, tool input or output, file contents or paths to Loki or the log,
  contrary to [ADR 0003](docs/architecture-decisions/0003-record-names-never-content.mdx);
- anything that sends the Loki credentials somewhere other than the configured Loki, or writes them to disk;
- a repository a developer opens being able to make the plugin run code or change where events go.
