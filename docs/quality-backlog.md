# Quality backlog

Working memory for the quality loop. Read this first every iteration; take the top unchecked item of the
current phase. One item = one PR, branched as `quality/<slug>`.

Audit 1: 2026-09-19, against main at 9584787. Main green: 143 pass, 1 skipped (smoke, needs Loki).
After #3 and #4 merged (main at f434c4c): 146 pass, 1 skipped.

**Coordination:** Emil's PR #3 (`fix-held-name-nesting`) merged on 2026-09-19, so the *(after #3)* marks below
are satisfied. Write the naming helper and the "how it works" page against the post-#3 code.

**Loaded run** (required for changes to event-buffer, drain, flush or flusher-lock):
`bash -c 'pids=; for i in 1 2 3 4; do (while :; do :; done) & pids="$pids $!"; done; log=$(mktemp); trap "exec 2>/dev/null; kill $pids; rm -f $log" EXIT; ok=0; for i in $(seq 10); do node --test test/multi-process.test.mjs >"$log" 2>&1 && ok=$((ok+1)) || tail -40 "$log"; done; echo "$ok/10"'`
prints `10/10` and leaves no busy loops behind, even if interrupted (keep the `bash -c`: zsh does not word-split `$pids`).

## Phase 1: code quality

- [x] **Session cache retention belongs to session-context.** `flush.mjs` defines `SESSION_CACHE_MS` and passes it
  to `pruneSessions(dir, maxAgeMs, log)`, so the entry point knows how long the cache of another module lives, and
  `pruneSessions` has no test at all. Change it to `pruneSessions(dir, { maxAgeMs = <default>, log } = {})`, test
  it at the interface (old entries go, fresh ones stay, a missing `sessions/` is silent, other errors are logged).
  _Done when:_ `flush.mjs` calls `pruneSessions(dir, { log })` with no age, the default is still 6 days, and
  `test/session-context.test.mjs` covers pruning.
- [x] **The fallback log location has one owner.** `record-main.mjs` rebuilds `$TMPDIR/claude-analytics.log` to
  point the flusher's stderr at it, duplicating the fallback rule inside `log.mjs`. Have `createLog` expose the
  fallback path (or a `stderrTarget()` that opens the first writable of the two) and use it in `startFlusher`.
  _Done when:_ among `plugins/usage-analytics/scripts/`, the string `claude-analytics.log` appears only in
  `log.mjs`, and `test/log.test.mjs` covers the new interface.
- [x] **One question for "should this hook start a flusher?".** `record-main.mjs` must know to call
  `isHeld(dir)` before `spawnAllowed(dir)` (the other order touches the throttle marker for nothing). Add
  `mayStartFlusher(dir)` to `flusher-lock.mjs` that owns the order; keep `isHeld`/`spawnAllowed` exported for
  their existing tests. _Done when:_ `record-main.mjs` makes one lock call and a test pins that a held lock does
  not touch the throttle marker.
- [x] **Glossary covers the terms the code uses.** `CONTEXT.md` has no entry for *backlog* (used in
  `maxBacklogBytes` and the "backlog over N bytes" log line, and covering both the live file cap and held
  batches), *data dir*, *claim*, *grace period*, or *push*. Add them, glossary-only, no implementation detail.
  _Done when:_ `CONTEXT.md` has entries for backlog, data dir, claim, grace period and push.
- [x] **drain test imports its collaborators like every other test.** `test/drain.test.mjs`'s last-but-one test
  dynamically imports `event-buffer`, `fs`, `os`, `path` inside the test body. Move them to top-level imports.
  _Done when:_ no `await import(` in `test/`, all tests green.
- [x] **Buffer file names are built in one place.** `event-buffer.mjs` spells batch, held, late, settled and tmp
  names with ad-hoc template strings and regexes spread over `claim`, `retire`, `sweepSettled` and `settle`
  (the `origin` regex). Collect them into one small internal naming helper so the age-order invariant in ADR 0002
  is visible in one place. No interface change. _Done when:_ the batch, `-held-`, `-late-`, `.settled-` and batch
  `.tmp` names in the data dir (not `dead/`, not the live file) are produced and parsed by the helper; the
  existing tests in `test/event-buffer.test.mjs` pass without modification; a new table test pins that each
  helper-produced name is byte-identical to the pre-refactor format and that pre-refactor names parse; and the
  loaded run passes.
  *(after #3, which changes held naming)* Done in #10. The helper is module-private, so the format is pinned through
  `openBuffer` rather than by a table test of the helper itself.
- [x] **One vanished session file does not end the whole prune.** In `pruneSessions` a single `statSync` that
  hits ENOENT (a hook's `.tmp` renamed away between `readdirSync` and `statSync`) throws out of the loop, is
  swallowed as "no cache", and skips every remaining file until the next flusher start. Handle each file on its
  own. _Done when:_ a test with a dangling symlink and several old entries in `sessions/` shows every old entry
  pruned and nothing logged (several entries, because `readdirSync` order is filesystem-defined), and the test
  fails before the fix.

## Phase 2: documentation content

- [x] Docs pages "what it is" and "install" (plugin, per-repo settings, Sandcastle). _Done when:_ both MDX pages
  exist under `docs/` with frontmatter and README links to them.
- [x] Docs page "what is recorded" (event shape, kinds, labels, the names-only rule). _Done when:_ the page exists,
  links ADR 0003 and `CONTEXT.md`, repeats no glossary definitions, and `docs/index.mdx` links to it.
- [x] Docs page "how it works" (hooks, buffer, flusher, failures, late writes, modules). _Done when:_ the page
  exists, every module in the README Modules table is covered, and `docs/index.mdx` links to it. *(after #3)*
- [x] Docs page "operating the stack" (ports, auth, retention, dashboard, troubleshooting, native telemetry).
  _Done when:_ the page exists, covers every README section on these topics, and `docs/index.mdx` and
  `docs/install.mdx` link to it instead of the README's "Run the stack" section.
- [x] Shrink `README.md` to an entry point that links into `docs/`; keep `CONTEXT.md` as the glossary.
  _Done when:_ README is at most 60 lines and every section it dropped lives in a docs page.
- [x] ADR (via /architect:adr): the flusher is spawned on demand by hooks and exits when idle, rather than a
  daemon (launchd/systemd) or a flusher per session. _Done when:_ the ADR is in `docs/architecture-decisions/`.
- [x] ADR (via /architect:adr): why events carry `sub` (retry-stable nanosecond timestamps). ADR 0002 already
  relies on Loki deduplicating re-pushes; this one records the timestamp scheme that makes that true and
  references 0002 rather than re-deciding it. _Done when:_ the ADR is in `docs/architecture-decisions/`, links
  ADRs 0002 and 0003, and matches `loki-sink.mjs` (ms timestamp plus `sub` padded to 6 digits; the index fallback
  for events without `sub` is not retry-stable).

## Phase 3: Turborepo

- [ ] pnpm workspaces: root `pnpm-workspace.yaml` with `plugins/*`, plugin `package.json` (zero deps, no build),
  lockfile; `pnpm test` / `pnpm check` work; CI still on npm scripts. ADR for the move.
  _Done when:_ `pnpm install && pnpm test && pnpm check` pass from a clean clone and the ADR is in `docs/architecture-decisions/`.
- [ ] turbo: `turbo.json` with `test`, `check`, `build`; root scripts delegate to turbo.
  _Done when:_ `pnpm turbo run test check build` passes locally with the plugin's tasks included.
- [ ] CI runs through turbo. _Done when:_ every CI step that ran an npm script runs it through turbo, and CI is green on the PR.

## Phase 4: docs app

- [ ] `apps/docs` on Fumadocs reading repo-root `docs/` as content (check Fumadocs + Turborepo docs via Context7
  first). Done when `pnpm --filter docs dev` serves every page and `pnpm --filter docs build` passes in CI.

## Questions for Emil

- **Should an unreadable lock heartbeat count as held?** `heldBy` in `flusher-lock.mjs` treats any `statSync`
  failure as "not held", while `readPid` treats an unreadable lock as "leave it alone". Aligning them would make
  `isHeld` return true and `acquire` return null on a non-ENOENT stat failure: a lock-semantics change, not a
  refactor, and it needs a stat seam that does not exist yet. Moved out of phase 1 for that reason.

- **Should the grace period count from the settle?** `sweepSettled` in `event-buffer.mjs` removes a settled
  batch once its file has gone `settleGraceMs` without a write, measured from the file's mtime. Settling does not
  touch the mtime, so a batch whose last write is 5 s old by the next claim's sweep is removed there: about one
  flush interval after its settle (the rest of the pass plus one sleep of 1 s by default, longer while backing
  off) instead of 5 s after it. A writer that opened the live file just before the claim and stalls briefly can
  then lose its event. ADR 0002 line 55 ("A writer stalled for longer than the grace period can still lose its
  event") reads as if shorter stalls were safe. Touching the file in `retire()` would make the grace period start
  at the settle: a behaviour change to the buffer, so not taken by the quality loop. Found in review of #8.

- **Are late re-pushes deduplicated?** ADR 0005 and ADR 0002 rely on Loki dropping a re-pushed event. Loki's
  docs promise two things: the ingester drops an exact duplicate of an entry in its open chunk, and the querier
  merges what several replicas wrote. Neither covers a duplicate that arrives after the original's chunk was
  flushed. A retry after the
  chunk was flushed (outages, batches held for hours) may be counted twice. Worth checking against the stack: push an
  event, force a flush (`POST /flush`), push it again, and count it with a query. If duplicates survive, options are
  query-side dedup in the dashboard or accepting the overcount. Found in review of #18.

## Parked

_None yet._
