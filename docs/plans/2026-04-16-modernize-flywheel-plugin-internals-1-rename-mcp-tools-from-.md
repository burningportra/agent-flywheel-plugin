# Modernize Flywheel Plugin Internals

**Date:** 2026-04-16
**Mode:** standard plan
**Scope:** 4 threads — MCP tool aliasing, SwarmTender config/telemetry, deep-plan latency, AST-aware TODO scanner.

## Context

- Source-of-truth tool names in `mcp-server/src/server.ts` are already `flywheel_*` (line 48 onward). However, older clients / cached plugin installs still surface `orch_*`. We saw this live in this very session: every MCP call reached us as `mcp__orch-tools__orch_*`. Goal: make the rename bidirectional — new `flywheel_*` names stay primary, but legacy `orch_*` names resolve to the same runners so existing client sessions don't break.
- `SwarmTender` (`mcp-server/src/tender.ts:26-73`) accepts a `TenderConfig` interface but the defaults are hardcoded. `maxNudgesPerPoll` is declared but not in defaults. There is no structured telemetry emitted from nudge/kill decisions — logs are free-form strings.
- Deep-plan (`mcp-server/src/deep-plan.ts`) spawns 3 planner processes with a 180s per-planner timeout. Each planner scans the repo fresh; there is no shared profile artifact. Synthesis happens in a separate agent that re-reads all 3 plan files plus repo context. No caching, no shard boundaries.
- Profiler (`mcp-server/src/profiler.ts:229`) scans TODOs via `grep -rE "(TODO|FIXME|HACK|XXX):"`. This misses language-specific forms (`// @todo`, JSDoc `@todo`, Python docstring TODOs without colons, `# XXX` at column 1) and yields false positives inside string literals / generated files.

## Objectives (per thread)

### Thread A — MCP tool name aliasing (Idea #1)
Primary name stays `flywheel_*`. Register `orch_*` aliases so both names dispatch to the same runner. Emit a one-time deprecation warning per alias call (throttled) recommending the new name.

**Acceptance criteria:**
- Calling `orch_profile` and `flywheel_profile` both succeed against the same cwd and return equivalent payloads.
- `ListTools` response includes both names (aliases marked with `"deprecated": true` in description text, since MCP protocol has no formal deprecation flag).
- Unit test in `mcp-server/src/__tests__/server.test.ts` covers both dispatch paths for at least 2 tools.
- README / AGENTS.md note the alias window and state it will be removed in v4.0.

### Thread B — SwarmTender config + telemetry (Idea #3)
1. Lift all threshold defaults in `tender.ts:63-73` into a single `DEFAULT_TENDER_CONFIG` constant that can be overridden via (a) a `tender.config.json` in `.pi-flywheel/`, and (b) env vars `FLYWHEEL_TENDER_<FIELD>` (opt-in, env wins).
2. Add `maxNudgesPerPoll` to the defaults (currently optional → undefined; must have a concrete default, e.g. 3).
3. Introduce a `TenderTelemetryEvent` type and emit NDJSON events to `.pi-flywheel/tender-events.log`:
   - `nudge_sent` (agent, reason, nudgeCount, elapsedSinceActivity)
   - `agent_killed` (agent, reason, totalNudges, waitedMs)
   - `conflict_detected` (file, worktrees[])
   - `poll_summary` (activeAgents, stuckAgents, nudgesThisCycle)
4. Document config knobs in `docs/tender-config.md`.

**Acceptance criteria:**
- `tender.test.ts` gains cases for: config override via JSON, env override, telemetry event emission assertions.
- Running a swarm produces a non-empty `.pi-flywheel/tender-events.log` with valid NDJSON.
- `maxNudgesPerPoll` is no longer optional in the shipped default.

### Thread C — Deep-plan synthesis latency (Idea #6)
1. Before spawning planners, compute a shared `ProfileSnapshot` once (reuse `loadCachedProfile`) and pass its file path into each planner task prompt so planners don't each rerun `scan.ts`.
2. Reduce the synthesizer's working set: instead of reading all 3 plan files whole, split each plan by top-level `##` sections, group by section title, and synthesize section-by-section in sequence. This keeps each synthesis step under a small context window and enables early termination if a section has trivial differences.
3. Add a `--fast-synthesis` mode (default on for repos with >500 files) that skips the section-wise merge for sections where all 3 planners produced identical byte-content.

**Acceptance criteria:**
- On a fixture repo with ≥500 files, end-to-end deep-plan wall time improves by ≥25% vs baseline (measure via `time` around `runDeepPlanAgents` in a manual bench script checked into `mcp-server/scripts/bench-deep-plan.ts`).
- Planner task prompts include `profileFile: <path>` and planners read from it instead of rescanning.
- `deep-plan.test.ts` (new) covers the section-split + identical-section shortcut logic.

### Thread D — AST-aware TODO scanner (Idea #7)
1. Extract the current grep implementation (`profiler.ts:229`) into a `TodoScanner` interface with a `grepScanner` default.
2. Add `tsAstScanner` using `typescript` package (already a transitive dep via MCP SDK? verify — if not, add) to walk JSDoc comments and inline comments for TS/JS files.
3. Add `pythonTodoScanner` using regex tuned for `#` line comments and `"""` docstrings (full AST via tree-sitter is over-scoped; pattern-level improvements are enough).
4. Preserve old behavior behind `FLYWHEEL_PROFILE_SCANNER=grep` env var for rollback.
5. Merge results from all scanners with dedup on `(file, line)`.

**Acceptance criteria:**
- Scanner picks up at least these new forms: `// @todo Refactor`, `/** @todo description */`, Python `# XXX not colon-suffixed`, triple-quoted docstring TODOs.
- Does not flag `TODO` appearing inside string literals (verified by 3 negative-test fixtures).
- `profiler.test.ts` gains fixtures covering TS, JS, and Python positive + negative cases.
- Fallback env var works.

## Implementation order (dependency-aware)

1. **Thread A (aliasing)** — independent, low-risk, unblocks client tooling. Ship first.
2. **Thread D (TODO scanner)** — independent of A/B/C. Can be done in parallel with A.
3. **Thread B (tender config+telemetry)** — independent. Parallel.
4. **Thread C (deep-plan latency)** — depends on profile snapshot being a stable artifact; do after A/D land so profile code is in a calmer state.

## Beads to create

- **bead-A**: Add `orch_*` aliases for all flywheel MCP tools with deprecation note + ListTools entries + dispatch test.
- **bead-B1**: Introduce `DEFAULT_TENDER_CONFIG`, JSON+env overrides, docs.
- **bead-B2**: Add TenderTelemetryEvent type + NDJSON writer + emit at nudge/kill/conflict/poll sites + tests.
- **bead-C1**: Pass shared profile snapshot into planner tasks; update prompt templates in `deep-plan.ts` + callers.
- **bead-C2**: Section-wise synthesis with identical-section shortcut + bench script + test.
- **bead-D1**: Refactor TODO scanner to `TodoScanner` interface with grep as default; wire `FLYWHEEL_PROFILE_SCANNER` env var.
- **bead-D2**: Implement `tsAstScanner` and `pythonTodoScanner`; merge with dedup; fixtures.

**Dependencies:**
- B2 depends on B1 (config must exist before telemetry opts-in).
- D2 depends on D1 (interface must exist).
- C2 depends on C1 (snapshot plumbed before synthesizer change).

## Risks

- Alias collision: if a future `flywheel_*` tool shadows a different `orch_*` tool, dispatch ordering matters. Keep aliases in a single map and fail loudly on duplicate registration.
- Tender telemetry volume: NDJSON file unbounded on long sessions. Add size cap (e.g. rotate at 10MB) in a follow-up if it becomes an issue — not in scope for this plan.
- Deep-plan section-split assumes plans use `##` sections. If planners deviate, synthesizer must fall back to whole-file synthesis. Add fallback path and log warning.
- TypeScript AST scanner loads `typescript` at runtime; confirm it's not a huge cold-start cost. If it is, lazy-load on first TS file only.

## Out of scope

- Replacing tree-sitter with a full multi-language AST framework.
- Rotating tender event logs (separate follow-up).
- Renaming state directory (already done in commit `44de3a1`).
- Full checkpoint schema versioning (Idea #4 — deferred).
