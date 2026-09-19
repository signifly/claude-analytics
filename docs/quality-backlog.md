# Quality backlog

Working memory for the quality loop. Read this first every iteration; take the top unchecked item of the
current phase. One item = one PR, branched as `quality/<slug>`.

Audit 1: 2026-09-19, against main at 9584787. Main green: 143 pass, 1 skipped (smoke, needs Loki).

**Coordination:** Emil's PR #3 (`fix-held-name-nesting`) touches `event-buffer.mjs` and the flusher's idle logic.
Items marked *(after #3)* wait until it has merged; skip past them to the next item until then.

## Phase 1: code quality

- [ ] **Session cache retention belongs to session-context.** `flush.mjs` defines `SESSION_CACHE_MS` and passes it
  to `pruneSessions(dir, maxAgeMs, log)`, so the entry point knows how long the cache of another module lives, and
  `pruneSessions` has no test at all. Give `pruneSessions` its own default (keep the parameter for tests), test
  it at the interface (old entries go, fresh ones stay, a missing `sessions/` is silent, other errors are logged).
  _Done when:_ `flush.mjs` calls `pruneSessions(dir, { log })` with no age, and `test/session-context.test.mjs`
  covers pruning.
- [ ] **The fallback log location has one owner.** `record-main.mjs` rebuilds `$TMPDIR/claude-analytics.log` to
  point the flusher's stderr at it, duplicating the fallback rule inside `log.mjs`. Have `createLog` expose the
  fallback path (or a `stderrTarget()` that opens the first writable of the two) and use it in `startFlusher`.
  _Done when:_ the string `claude-analytics.log` appears only in `log.mjs`, with a test in `test/log.test.mjs`.
- [ ] **One question for "should this hook start a flusher?".** `record-main.mjs` must know to call
  `isHeld(dir)` before `spawnAllowed(dir)` (the other order touches the throttle marker for nothing). Add
  `mayStartFlusher(dir)` to `flusher-lock.mjs` that owns the order; keep `isHeld`/`spawnAllowed` exported for
  their existing tests. _Done when:_ `record-main.mjs` makes one lock call and a test pins that a held lock does
  not touch the throttle marker.
- [ ] **A lock whose heartbeat cannot be read is not a free lock.** `heldBy` in `flusher-lock.mjs` treats any
  `statSync` failure as "not held", while `readPid` deliberately treats unreadable as "leave it alone". Make a
  non-ENOENT stat failure throw `Unreadable` like `readPid`. _Done when:_ a test with an injected stat failure
  (or equivalent seam) shows `acquire` returns null and logs "cannot read lock", and existing lock tests pass.
- [ ] **Glossary covers the terms the code uses.** `CONTEXT.md` has no entry for *backlog* (used in
  `maxBacklogBytes` and the "backlog over N bytes" log line, and covering both the live file cap and held
  batches), *data dir*, *claim*, *grace period*, or *push* / *chunk*. Add them, glossary-only, no
  implementation detail. _Done when:_ every domain term in log lines and option names is either in `CONTEXT.md`
  or is plainly not domain language.
- [ ] **drain test imports its collaborators like every other test.** `test/drain.test.mjs`'s last-but-one test
  dynamically imports `event-buffer`, `fs`, `os`, `path` inside the test body. Move them to top-level imports.
  _Done when:_ no `await import(` in `test/`, all tests green. *(after #3, it touches drain tests)*
- [ ] **Buffer file names are built in one place.** `event-buffer.mjs` spells batch, held, late, settled and tmp
  names with ad-hoc template strings and regexes spread over `claim`, `retire`, `sweepSettled` and `settle`
  (the `origin` regex). Collect them into one small internal naming helper so the age-order invariant in ADR 0002
  is visible in one place. No interface change. _Done when:_ every buffer file name is produced and parsed by the
  helper and `test/event-buffer.test.mjs` plus ten loaded runs of `test/multi-process.test.mjs` pass unchanged.
  *(after #3, which changes held naming)*

## Phase 2: documentation content

- [ ] Restructure `docs/` as MDX pages: what it is, install, what is recorded, how it works, operating the stack,
  decisions. Split into several PRs (one or two pages each) when a PR would get large.
- [ ] Shrink `README.md` to an entry point that links into `docs/`; keep `CONTEXT.md` as the glossary.
- [ ] ADR (via /architect:adr): the flusher is spawned on demand by hooks and exits when idle, rather than a
  daemon (launchd/systemd) or a flusher per session.
- [ ] ADR (via /architect:adr): retries rely on Loki deduplicating identical (timestamp, line) pairs, which is
  why events carry `sub` and why "pushed twice" is acceptable everywhere.

## Phase 3: Turborepo

- [ ] pnpm workspaces: root `pnpm-workspace.yaml` with `plugins/*`, plugin `package.json` (zero deps, no build),
  lockfile; `pnpm test` / `pnpm check` work; CI still on npm scripts. ADR for the move.
- [ ] turbo: `turbo.json` with `test`, `check`, `build`; root scripts delegate to turbo.
- [ ] CI runs through turbo.

## Phase 4: docs app

- [ ] `apps/docs` on Fumadocs reading repo-root `docs/` as content (check Fumadocs + Turborepo docs via Context7
  first). Done when `pnpm --filter docs dev` serves every page and `pnpm --filter docs build` passes in CI.

## Questions for Emil

_None yet._

## Parked

_None yet._
