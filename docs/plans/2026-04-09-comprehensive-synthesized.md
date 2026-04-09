# Synthesized Implementation Plan — 2026-04-09

## Goal

Comprehensive codebase improvement for claude-orchestrator (TypeScript MCP server) across 8 areas:

1. Clean up dead code and stale TODOs
2. Add model-routing fallback strategy
3. Harden agent-mail MCP transport detection
4. Add error recovery to scan.ts
5. Expand bead-splitting edge case coverage
6. Add Vitest test suite for core modules
7. Deep-plan fault tolerance — handle missing planner output
8. SwarmTender nudge rate-limiting

## Synthesis Notes

### Key decisions when merging perspectives

1. **Dead code (Item 1) is mostly a no-op.** All three plans agree: the referenced `console.log` in `review.ts:~309` is inside a Gate 3 instruction string, not actual dead code. The `bead-templates.ts` "TODO stubs" reference is acceptance-criteria text. **Action:** Verify via rebuild + targeted grep. Ergonomics plan adds rephrasing embedded TODO strings to avoid grep false-positives — included as a minor polish task.

2. **Model-routing fallback (Item 2) — validation over runtime detection.** Robustness plan proposed `validateModelAvailability()` using `model-detection.ts`, but this adds a runtime dependency and complexity. Correctness plan proposed a simpler tier validation + `bead.priority` null guard. Ergonomics plan proposed `validateModelTier()` with medium-tier fallback. **Decision:** Adopt correctness + ergonomics approach: validate tiers at `routeModel()` call time, fall back to `DEFAULT_TIERS` on missing keys, add `bead.priority` null guard. Defer runtime model availability checking (can be layered on later).

3. **Agent-mail transport (Item 3) — health check, not auto-detection.** All three plans agree auto-detection is fragile. **Decision:** Add a `checkAgentMailHealth()` function, call it lazily on first agent-mail need, log clearly if unreachable. No env var override (`.mcp.json` is the config surface). Document the SSE/http history in AGENTS.md.

4. **Scan.ts (Item 4) — already robust, minimal changes.** Correctness plan identified the main gap: `signal` not propagated to `ensureCccReady()` exec calls. Ergonomics plan adds a `summary` field to fallback paths. Robustness plan adds progress logging. **Decision:** Propagate signal (correctness fix) + set `summary` on fallback paths (ergonomics fix). Skip progress logging (low value, adds noise).

5. **Bead-splitting (Item 5) — shell escaping is the priority.** All three plans agree `formatSplitCommands()` has a shell injection risk (only `"` is escaped, not `$`, backticks, `\`). Correctness plan adds NaN betweenness filtering. Ergonomics plan adds `reason` field on edge-case overrides. **Decision:** All three fixes included.

6. **Tests (Item 6) — tests after code changes, grouped by priority.** Correctness plan dependencies are right: tests should cover the improved code (post-T2, T5). Robustness plan wanted tests first (T6 as dependency for T2/T5), but this creates a circular dependency since we want to test the improved code. **Decision:** Code changes first (T2, T5), then tests (T7). Tests for `plan-quality.ts` and `goal-refinement.ts` have no code-change dependency and can run in parallel.

7. **Deep-plan (Item 7) — `Promise.allSettled` + synthesis hint.** Correctness plan correctly identified that the inner try/catch means `Promise.all` doesn't actually reject on agent failure. However, `writeFileSync` before the try block CAN throw unhandled. **Decision:** Wrap `writeFileSync` + `mkdirSync` in try/catch. Add sentinel prefix to failed/empty plan strings (ergonomics). Keep `Promise.all` since the inner catch already handles agent failures — `Promise.allSettled` is unnecessary given the existing error handling.

8. **SwarmTender (Item 8) — global budget + agent name fix + error logging.** All three plans agree on: (a) per-poll global nudge budget, (b) the agent name resolution bug at line 225 (worktree path used as Agent Mail agent name), (c) silent error swallowing. Robustness plan added `nudgeCooldownMs` distinct from `nudgeDelayMs` — but `nudgeDelayMs` already serves this purpose (time since last nudge). **Decision:** Add `maxNudgesPerPoll` (default 3), fix agent name resolution, replace `.catch(() => {})` with error logging. Skip separate `nudgeCooldownMs` (redundant with existing `nudgeDelayMs`).

### Conflicts resolved

- **T6 dependency direction:** Robustness said T2/T5 depend on T6 (write tests first). Correctness said T6 depends on T2/T5 (test improved code). **Resolution:** T2/T5 first, then T7 (tests). This is safer because testing buggy code and then updating tests wastes effort.
- **Transport auto-detection vs health check:** Robustness proposed env var + graceful degradation. Others proposed simpler health check. **Resolution:** Health check only — env vars add config surface area without clear benefit since `.mcp.json` is already the config point.
- **Promise.all vs Promise.allSettled in deep-plan:** Correctness wanted `allSettled`. Code inspection shows inner try/catch already normalizes all failures into `DeepPlanResult` objects, so `Promise.all` never rejects. **Resolution:** Keep `Promise.all`, but wrap the `writeFileSync` that sits outside the try/catch.

---

## Implementation Tasks

### T1: Verify build and audit dead code
**depends_on:** []
**files:** `mcp-server/`, `mcp-server/src/bead-templates.ts`
**what:**
1. Run `cd mcp-server && npm run build` to ensure dist matches src.
2. Grep `mcp-server/src/` for `TODO`, `FIXME`, `HACK` — classify each as: (a) active, (b) resolved/stale, (c) dynamic content string.
3. Remove category (b) items. Leave (a) with context. Leave (c) as-is.
4. In `bead-templates.ts`, rephrase embedded `TODO stubs` in acceptance-criteria strings to `stub methods` to reduce grep false-positives.
**acceptance:**
- `npm run build` succeeds.
- No stale TODO/FIXME in source (string literals referencing the concept are acceptable).
- `grep -rn 'TODO\|FIXME' mcp-server/src/` produces only intentional/active items.

---

### T2: Add model-routing tier validation and priority null guard
**depends_on:** []
**files:** `mcp-server/src/model-routing.ts`
**what:**
1. Add `validateModelTier(tier: ModelTier, label: string): boolean` — checks `tier.implementation` and `tier.review` are non-empty strings. Returns false and logs warning via `process.stderr` on failure.
2. In `routeModel()`: validate `tierMap[complexity]` before use. If invalid, fall back to `DEFAULT_TIERS[complexity]`. If DEFAULT_TIERS itself has an issue (shouldn't happen), fall back to `DEFAULT_TIERS.medium`.
3. Guard `bead.priority`: in `classifyBeadComplexity()`, change the priority check from `bead.priority <= 1` to `typeof bead.priority === "number" && !Number.isNaN(bead.priority) && bead.priority <= 1`. This prevents `undefined <= 1` evaluating to `false` silently.
4. Add optional `fallbacks?: string[]` field to `ModelTier` interface for future use (no logic change, just the type).
**acceptance:**
- `routeModel()` never throws, even with `tiers` missing a complexity key or containing empty strings.
- `bead.priority` being `undefined` or `NaN` does not affect classification incorrectly.
- Fallback usage is logged to stderr.

---

### T3: Add agent-mail connectivity health check
**depends_on:** []
**files:** `mcp-server/src/agent-mail.ts`, `AGENTS.md`
**what:**
1. Add `checkAgentMailHealth(url?: string): Promise<{ reachable: boolean; transport?: string; error?: string }>` that sends a GET/HEAD to the agent-mail endpoint (default `http://127.0.0.1:8765/mcp`) with a 3s timeout.
2. Export it for use by coordination code. Call it lazily on first agent-mail tool invocation; cache result for the session.
3. If unreachable, return a clear error: `"Agent Mail unreachable at ${url}. Is the server running? Check: npx agent-mail-server"`.
4. Document in `AGENTS.md`: the SSE vs http transport history (commits 0a7a8c2, c12c6be, 7c08923), current recommended type (`http`), and how to diagnose connection issues.
**acceptance:**
- First agent-mail tool call validates connectivity.
- Unreachable server produces an actionable error message.
- Health check does not block operations that don't need agent-mail.

---

### T4: Propagate AbortSignal in scan.ts + set fallback summary
**depends_on:** []
**files:** `mcp-server/src/scan.ts`
**what:**
1. In `ensureCccReady()`: pass `signal` to the `exec("ccc", ["--help"])` call (line 163), `exec("ccc", ["status"])` call (line 171), `exec("ccc", ["init", "-f"])` call (line 178), and `exec("ccc", ["index"])` call (line 189). The exec signature already supports this via options.
2. In the double-fault branch of `scanRepo()` (line 96-109): after building `result`, set `result.codebaseAnalysis.summary = "Scan failed: both ccc and builtin providers failed. Results may be incomplete."`.
3. In `createFallbackScanResult()`: set `codebaseAnalysis.summary = "Partial scan: fell back from ${source} to builtin provider."` on the returned result.
4. In `createEmptyCodebaseAnalysis()`: change `summary: undefined` to `summary: ""` so downstream code never gets `undefined`.
**acceptance:**
- AbortSignal cancellation propagates to all ccc subprocess calls in `ensureCccReady`.
- `result.codebaseAnalysis.summary` is always a non-empty string in fallback paths.
- Existing fallback behavior unchanged.

---

### T5: Harden bead-splitting: shell escaping, NaN filtering, reason fields
**depends_on:** []
**files:** `mcp-server/src/bead-splitting.ts`
**what:**
1. **Shell escaping in `formatSplitCommands()`:** Replace the single `replace(/"/g, '\\"')` with a comprehensive shell escape that also handles `$`, backticks, `\`, and `!`. Use a helper: `function shellEscape(s: string): string { return s.replace(/[\\"$`!]/g, '\\$&'); }`.
2. **NaN betweenness filtering in `identifyBottlenecks()`:** Change `.filter((b) => b.Value >= threshold)` to `.filter((b) => typeof b.Value === "number" && !Number.isNaN(b.Value) && b.Value >= threshold)`.
3. **Reason field on edge-case overrides in `parseSplitProposal()`:** When `splittable === true` but `children.length < 2`, override `reason` to: `"LLM proposed split but returned ${children.length} child(ren) — need at least 2 for meaningful parallelism"` (preserve original reason as prefix if present).
4. **File overlap warning:** After building `children` array in `parseSplitProposal()`, check for overlapping files across children. If found, append a warning to `reason`: `"Warning: overlapping files across children: ${overlapping.join(', ')}"`.
**acceptance:**
- `formatSplitCommands()` output is safe against shell injection for descriptions containing `$(rm -rf /)`, backticks, `$VAR`, etc.
- NaN betweenness values are filtered out, not propagated.
- Single-child proposals set `splittable: false` with an explanatory reason.
- Overlapping file sets produce a warning in the reason field.

---

### T6: Deep-plan fault tolerance
**depends_on:** []
**files:** `mcp-server/src/deep-plan.ts`
**what:**
1. **Wrap `writeFileSync` and `mkdirSync`:** Move `mkdirSync(outputDir, { recursive: true })` into a try/catch. If it fails, fall back to using `tmpdir()` directly (no subdirectory). Wrap the `writeFileSync(taskFile, ...)` at line 39 inside the per-agent try/catch (currently it's outside).
2. **Synthesis sentinel for failed/empty plans:** In the catch block, set `plan` to `"(AGENT FAILED — exclude from synthesis: ${err.message})"` instead of `""`. In the success block, if `result.stdout.trim()` is empty, set `plan` to `"(AGENT RETURNED EMPTY — exclude from synthesis)"`.
3. **Add filtering helper:** Export `filterViableResults(results: DeepPlanResult[]): DeepPlanResult[]` that returns only results where `exitCode === 0` and `!plan.startsWith("(AGENT")`.
4. Keep `Promise.all` (the inner try/catch already normalizes errors into `DeepPlanResult`).
**acceptance:**
- `writeFileSync` failure doesn't crash the batch.
- Failed/empty agent results have explicit sentinel strings, not empty strings.
- `filterViableResults()` correctly identifies usable vs failed results.
- All existing callers continue to work (sentinel strings are distinguishable from valid plans).

---

### T7: Add Vitest tests for core modules
**depends_on:** [T2, T5]
**files:**
- `mcp-server/src/__tests__/model-routing.test.ts` (new)
- `mcp-server/src/__tests__/bead-splitting.test.ts` (new)
- `mcp-server/src/__tests__/plan-quality.test.ts` (new)
- `mcp-server/src/__tests__/goal-refinement.test.ts` (new)
**what:**

**model-routing.test.ts:**
- `classifyBeadComplexity`: simple bead (docs/typo), medium bead (3 files, endpoint), complex bead (auth + 8 files + security). Boundary scores (score=1 -> simple, score=2 -> medium, score=4 -> complex). Undefined description, undefined priority (after T2 fix).
- `routeModel`: default tiers, custom tiers, tiers with missing key (falls back after T2 fix), tiers with empty string (falls back after T2 fix).
- `routeBeads`: empty array, single bead, mixed complexities. Verify summary counts.
- `formatRoutingSummary`: empty routes returns `""`, normal routes.

**bead-splitting.test.ts:**
- `identifyBottlenecks`: empty Bottlenecks (null, undefined, []), below threshold, at threshold (0.3), above threshold, bead ID not in beads array, sorted by betweenness desc, NaN betweenness filtered (after T5 fix), empty beads array.
- `parseSplitProposal`: valid splittable JSON, no JSON in output, splittable+0 children, splittable+1 child (reason set after T5 fix), malformed JSON, child with empty title filtered, overlapping files warning (after T5 fix).
- `formatSplitProposal`: not splittable, splittable with children.
- `formatSplitCommands`: not splittable returns `""`, normal output, shell metacharacters in description escaped (after T5 fix).

**plan-quality.test.ts:**
- `parsePlanQualityScore`: valid JSON, JSON in markdown fences, JSON with surrounding text, non-JSON output, empty string. Score boundaries: block (<60), warn (60-79), proceed (>=80).
- `clampScore`: negative, >100, NaN, string input, undefined.
- `formatPlanQualityScore`: bar rendering.

**goal-refinement.test.ts:**
- `synthesizeGoal`: empty answers, bucket classification (scope/constraint/non-goal), value-based non-goal detection.
- `extractConstraints`: mixed answers, empty array.
- `parseQuestionsJSON`: valid array, markdown fences, invalid JSON (fallback), empty array, filters invalid questions, `allowOther` default.

**acceptance:**
- All 4 test files pass via `cd mcp-server && npx vitest run`.
- Line coverage >60% for `model-routing.ts`, `bead-splitting.ts`, `plan-quality.ts`, `goal-refinement.ts`.
- Edge cases from the analysis are covered (especially post-T2 and post-T5 fixes).

---

### T8: SwarmTender global nudge budget + agent name fix + error logging
**depends_on:** []
**files:** `mcp-server/src/tender.ts`
**what:**
1. **Add `maxNudgesPerPoll`:** Add `maxNudgesPerPoll: number` to `TenderConfig` with default `3`. In `poll()`, declare `let nudgesThisCycle = 0` at the top. Before calling `nudgeStuckAgent()`, check `nudgesThisCycle < this.config.maxNudgesPerPoll`. If at budget, skip (do NOT increment `nudgesSent` or `lastNudgedAt`). After sending, increment `nudgesThisCycle`.
2. **Fix agent name resolution:** At line 225, `this.nudgeStuckAgent(agent.worktreePath, agent.worktreePath)` uses worktree path as agent name. Replace with a lookup: extract the agent name from the worktree path (e.g., the basename or a registered mapping). If the `whoisAgent` function can resolve it, use that; otherwise use `path.basename(agent.worktreePath)` as a reasonable heuristic.
3. **Replace silent error swallowing:** Change `.catch(() => {})` at line 225 to `.catch(err => this.log.error("Nudge delivery failed", { stepIndex: agent.stepIndex, error: err instanceof Error ? err.message : String(err) }))`. Do NOT increment `nudgesSent` on delivery failure (move the increment inside a `.then()`).
4. **Config validation:** In the constructor, warn if `nudgeDelayMs > killWaitMs` (config inconsistency that would prevent kills from ever triggering).
**acceptance:**
- With 10 stuck agents and `maxNudgesPerPoll: 3`, at most 3 nudges sent per poll cycle.
- Nudge messages target a reasonable agent identity (not a raw filesystem path).
- Nudge delivery failures are logged, not silently swallowed.
- Config inconsistency `nudgeDelayMs > killWaitMs` produces a warning at construction time.

---

## Dependency Graph

```
T1: Verify build and audit dead code                 depends_on: []
T2: Model-routing tier validation + priority guard   depends_on: []
T3: Agent-mail connectivity health check             depends_on: []
T4: Propagate AbortSignal in scan.ts + fallback summary  depends_on: []
T5: Harden bead-splitting                            depends_on: []
T6: Deep-plan fault tolerance                        depends_on: []
T7: Vitest tests for core modules                    depends_on: [T2, T5]
T8: SwarmTender nudge budget + agent name fix        depends_on: []

Wave 1 (parallel): T1, T2, T3, T4, T5, T6, T8
Wave 2 (after T2 + T5): T7
```

```
T1 ─────────────────────────┐
T2 ────────────────────┬─── T7
T3 ─────────────────── │
T4 ─────────────────── │
T5 ────────────────────┘
T6 ─────────────────────────┘
T8 ─────────────────────────┘
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| T2 tier validation breaks custom tier configs | Medium | Medium | Validation warns + falls back, never throws. Existing configs with valid strings are unaffected. |
| T5 shell escaping breaks legitimate descriptions with `$` or backslashes | Low | Medium | Only escape in `formatSplitCommands()` output (shell command strings), not in data structures. Test with descriptions containing special chars. |
| T6 `writeFileSync` wrapping changes error semantics | Low | Low | The per-agent try/catch already existed; we're just moving the writeFileSync inside it. |
| T7 tests are brittle against prompt text changes | Medium | Low | Test behavior (scores, classifications, parsed structures), not exact strings. |
| T8 global nudge budget starves agents in large swarms | Low | High | Budget is per-poll (resets each cycle), not global. Agents accumulate nudges across polls. Priority: ensure first nudge always gets through. |
| T3 health check adds latency to first tool call | Low | Low | 3s timeout, async, cached. Only runs on first agent-mail need. |
| T4 changing `createEmptyCodebaseAnalysis().summary` from `undefined` to `""` | Low | Low | Downstream code checking `if (summary)` will now need to check `summary.length > 0` for the empty case. Mitigated by setting meaningful strings in all fallback paths. |

---

## Test Strategy

### model-routing.test.ts (T7)

| Test Case | Input | Expected |
|-----------|-------|----------|
| Simple bead classification | `{title: "Update README", description: "Fix typo"}` | `complexity: "simple"` |
| Complex bead classification | `{title: "Migrate auth", description: "Security architecture refactor across 8 files"}` | `complexity: "complex"` |
| Medium bead classification | `{title: "Add endpoint", description: "New API route, 3 files"}` | `complexity: "medium"` |
| Undefined description | `{description: undefined}` | No throw |
| Undefined priority (post-T2) | `{priority: undefined}` | Priority signal skipped, no score change |
| NaN priority (post-T2) | `{priority: NaN}` | Priority signal skipped |
| routeModel with default tiers | Simple bead | Returns haiku-class implementation model |
| routeModel with missing tier key | `tiers: { simple: {...}, medium: {...} }` (no complex) | Falls back to DEFAULT_TIERS |
| routeModel with empty model string | `tiers: { simple: { implementation: "" } }` | Falls back to DEFAULT_TIERS.medium |
| routeBeads empty array | `[]` | Empty map, all zeros |
| routeBeads mixed | 3 beads of different complexity | Correct summary counts |
| formatRoutingSummary empty | Empty map | `""` |
| Score boundary: 1 -> simple | Bead scoring 1 | `"simple"` |
| Score boundary: 2 -> medium | Bead scoring 2 | `"medium"` |
| Score boundary: 4 -> complex | Bead scoring 4 | `"complex"` |

### bead-splitting.test.ts (T7)

| Test Case | Input | Expected |
|-----------|-------|----------|
| identifyBottlenecks: null Bottlenecks | `{Bottlenecks: null}` | `[]` |
| identifyBottlenecks: undefined Bottlenecks | `{}` | `[]` |
| identifyBottlenecks: empty array | `{Bottlenecks: []}` | `[]` |
| identifyBottlenecks: below threshold | Value 0.1, threshold 0.3 | `[]` |
| identifyBottlenecks: at threshold | Value 0.3 | `[{bead, betweenness: 0.3}]` |
| identifyBottlenecks: NaN filtered (post-T5) | Value NaN | Filtered out |
| identifyBottlenecks: sorted desc | Multiple values | Highest first |
| identifyBottlenecks: bead ID not found | ID "br-99" not in beads | Filtered out |
| parseSplitProposal: valid JSON | `{"splittable": true, "children": [...2+]}` | Correct SplitProposal |
| parseSplitProposal: no JSON | `"I can't split this"` | `{splittable: false}` |
| parseSplitProposal: 0 children | `{"splittable": true, "children": []}` | `{splittable: false}` with reason |
| parseSplitProposal: 1 child (post-T5) | `{"splittable": true, "children": [{}]}` | `{splittable: false}` with reason about needing >=2 |
| parseSplitProposal: malformed JSON | Truncated JSON | `{splittable: false}` |
| parseSplitProposal: overlapping files (post-T5) | Children sharing files | Warning in reason |
| formatSplitCommands: shell metacharacters (post-T5) | Description with `$(rm -rf /)` | Escaped in output |
| formatSplitCommands: not splittable | `{splittable: false}` | `""` |

### plan-quality.test.ts (T7)

| Test Case | Input | Expected |
|-----------|-------|----------|
| Parse valid JSON | `{"workflows": 80, "edgeCases": 70, ...}` | Correct PlanQualityScore |
| Parse JSON in markdown fences | `` ```json\n{...}\n``` `` | Same |
| Parse JSON with surrounding text | `Here's my score: {...}` | Extracts correctly |
| Non-JSON output | `"The plan looks good"` | `null` |
| Empty string | `""` | `null` |
| clampScore: negative | `-10` | `0` |
| clampScore: >100 | `150` | `100` |
| clampScore: NaN | `NaN` | `50` |
| Recommendation: block | overall < 60 | `"block"` |
| Recommendation: warn | overall 60-79 | `"warn"` |
| Recommendation: proceed | overall >= 80 | `"proceed"` |

### goal-refinement.test.ts (T7)

| Test Case | Input | Expected |
|-----------|-------|----------|
| synthesizeGoal: empty answers | `("goal", [])` | Only goal section |
| synthesizeGoal: bucket classification | Answers with scope/constraint IDs | Correct sections |
| extractConstraints: mixed | Mixed answers | Only constraint/non-goal/avoid/exclude |
| extractConstraints: empty | `[]` | `[]` |
| parseQuestionsJSON: valid array | Valid JSON array | Parsed questions |
| parseQuestionsJSON: markdown fences | Fenced JSON | Strips fences, parses |
| parseQuestionsJSON: invalid JSON | `"not json"` | Fallback question |
| parseQuestionsJSON: empty array | `"[]"` | Empty array |
| parseQuestionsJSON: allowOther default | Missing field | Defaults to `true` |
