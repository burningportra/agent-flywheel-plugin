# Correctness Plan — 2026-04-09

## Goal

Analyze and plan implementation for 8 improvement items with a focus on **correctness**: type safety, edge cases, error handling, data integrity, test coverage, and regression prevention. Each item is evaluated for what can go wrong, what invariants must hold, and what edge cases must be covered.

---

## Correctness Analysis

### Item 1: Clean up dead code and stale TODOs

**Current state:** The task brief references `console.log` in `tools/review.ts:~309` and stale TODOs in `prompts.ts` and `bead-templates.ts`. After reading the source:
- `review.ts:347` — The `console.log` mention is inside a Gate 3 string literal (`"Check for: TODO/FIXME left over, console.log not cleaned up, dead code."`). This is **not** dead code — it's an instruction string. The `dist/review.js:309` line is the compiled version of the same string. **No cleanup needed here.**
- `prompts.ts` — Grep found references to "TODOs" only in strings that describe analysis instructions (lines 35, 63, 208, 232, 1827). These are **intentional references** to the concept of TODOs, not stale TODO comments. The FIXME at line 1591 mentioned in the brief does not exist; line 1591 is the start of `freshPlanRefinementPrompt()` — clean code with no FIXME.
- `bead-templates.ts:164` — Line 164 is `TODO stubs` per the brief. Reading the source, line 155 begins `BUILTIN_TEMPLATES` and there are no TODO stubs; the file is 659 lines of clean template definitions and expansion logic.

**Correctness verdict:** The dead code claims appear to be based on stale `dist/` output from a previous build. The source files are clean. The only action is to **verify by rebuilding** (`npm run build`) and re-checking dist output. If dist is out of sync with src, the fix is simply rebuilding.

**Invariant:** `dist/` must always reflect current `src/` after a build. Any dead code in dist that doesn't exist in src is a build artifact issue, not a source code issue.

**Edge case:** If there are genuine stale TODOs that were already cleaned up in a recent commit but dist wasn't rebuilt, this item collapses to a `npm run build` step.

### Item 2: Add model-routing fallback strategy

**Current state:** `model-routing.ts` (234 lines) classifies beads into simple/medium/complex and routes to model tiers. The `DEFAULT_TIERS` map references `MODEL_ROUTING_TIERS` from `prompts.ts`. `routeModel()` indexes into `tierMap[complexity]` which always succeeds because `BeadComplexity` is a union of exactly the 3 keys in the map.

**What can go wrong:**
1. **Model unavailable at runtime:** The routing picks a model string (e.g., `"claude-opus-4-6"`) but there's no check that the model is actually available. If the model is rate-limited, down, or the user lacks access, the downstream call fails with no fallback.
2. **Tier configuration missing keys:** If `tiers` parameter is provided but missing a complexity key, `tierMap[complexity]` returns `undefined` and `tier.implementation` throws a TypeError.
3. **Empty bead fields:** `bead.description` and `bead.title` can be `undefined` per the code (`bead.description ?? ""`), but `bead.priority` has no null guard — if `priority` is undefined, `bead.priority <= 1` evaluates to `false` (safe but semantically wrong — an undefined priority should probably default to medium, not be silently ignored).

**Invariants:**
- `routeModel()` must always return a valid `ModelRoute` — never throw.
- If a preferred model is unavailable, there must be a fallback chain (e.g., opus -> sonnet -> haiku).
- The `tiers` parameter must be validated to contain all 3 complexity keys.

**Edge cases:**
- `bead.priority` is undefined or NaN
- `tiers` parameter has only 1 or 2 of the 3 keys
- Model string is empty string `""`
- `bead.description` is undefined (already handled) but `bead.title` being exactly `undefined` (already handled)

### Item 3: Harden agent-mail MCP transport detection

**Current state:** `.mcp.json` has flipped between `"type": "url"`, `"type": "sse"`, and `"type": "http"` across 4 commits:
- Initial: `url`
- c12c6be: changed to `sse` 
- 0a7a8c2: reverted to `url` (SSE broke connection)
- 7c08923: changed to `http`

Currently it's `"type": "http"` with `"url": "http://127.0.0.1:8765/mcp"`.

**What can go wrong:**
1. **Transport type not supported by Claude Code version:** Different CC versions support different transport types. `"http"` may not work on older versions; `"sse"` broke the connection.
2. **Server not running:** If the agent-mail server isn't running at port 8765, the MCP connection fails silently or with an opaque error.
3. **Port conflict:** Another process on 8765 causes connection to wrong server.

**Invariants:**
- The transport type must match what the running Claude Code version supports.
- Connection failure must produce a clear error message, not silent failure.

**Correctness approach:** Rather than auto-detection (complex, fragile), add a startup health check. The orchestrator MCP server (stdio) can validate agent-mail connectivity on first tool call and report clearly if it fails. This is simpler and more debuggable than transport auto-detection.

**Edge cases:**
- Agent-mail server starts after orchestrator
- Agent-mail on non-default port
- Network interface bound to localhost vs 0.0.0.0

### Item 4: Add error recovery to scan.ts

**Current state:** `scan.ts` already has excellent error recovery:
- `scanRepo()` (line 80) tries `cccScanProvider`, catches errors, falls back to `builtinScanProvider`, and on double-fault returns an emergency minimal result with `createEmptyRepoProfile()`.
- `collectCccCodebaseAnalysis()` uses `Promise.allSettled()` for individual queries, logs failures, and only throws if ALL queries fail.
- Error info is preserved in `ScanErrorInfo` with `recoverable` flag.

**Correctness verdict:** The brief's claim that `scan.ts:45` "throws on failure" appears outdated. The current code has a 3-tier fallback (ccc -> builtin -> empty). **No additional error recovery is needed in scan.ts itself.**

**Remaining correctness concern:** The `ensureCccReady()` function (line 158) calls `exec("ccc", ["init", "-f"])` with a force flag. If ccc init fails intermittently, the entire ccc path fails and falls back — this is correct behavior. However, `ensureCccReady` does not pass the `signal` parameter to any of its exec calls, meaning AbortSignal cancellation won't propagate to ccc subprocess spawning. This is a minor correctness gap.

**Edge cases already handled:**
- ccc not installed -> falls back to builtin
- ccc index timeout -> falls back to builtin  
- All ccc queries fail -> falls back to builtin
- Both providers fail -> returns empty profile with warnings

**Edge case NOT handled:**
- `signal` parameter unused in `ensureCccReady` subprocess calls
- `parseCccSearchResults` returns empty array for malformed output (safe but loses data silently)

### Item 5: Expand bead-splitting edge case coverage

**Current state:** `bead-splitting.ts` (228 lines) has:
- `identifyBottlenecks()` — filters by threshold, handles null `insights.Bottlenecks`
- `parseSplitProposal()` — robust JSON parsing with fallback to "not splittable"
- `formatSplitProposal()` / `formatSplitCommands()` — display formatting

**What can go wrong:**
1. **Off-by-one in `identifyBottlenecks`:** `threshold` default is 0.3. Uses `>=` which is correct (inclusive). No off-by-one.
2. **Empty plans:** If `beads` array is empty, `identifyBottlenecks` returns `[]` (correct). If `insights.Bottlenecks` is null/undefined, the `?? []` guard handles it (correct).
3. **Single-bead edge case:** A plan with 1 bead can still be a bottleneck (betweenness can be non-zero in a graph with dependencies). `parseSplitProposal` requires `children.length >= 2` for `splittable: true` (line 153), which is correct — splitting into 1 child is meaningless.
4. **JSON injection in `formatSplitCommands`:** Line 213 escapes double quotes in description but NOT shell metacharacters like `$()`, backticks, or semicolons. The generated `br create` commands could be subject to shell injection if description contains malicious content.

**Invariants:**
- `parseSplitProposal` must never throw (always returns a valid `SplitProposal`)
- `identifyBottlenecks` must handle missing/null Bottlenecks array
- Split children must have disjoint file sets (not enforced — only instructed in the prompt)
- `splittable` must be false if children < 2

**Edge cases to test:**
- `insights.Bottlenecks` is `undefined`, `null`, or empty `[]`
- `beads` is empty
- Bottleneck bead ID not found in beads array
- LLM output contains no JSON, malformed JSON, or JSON without `splittable` key
- LLM returns `children: []` but `splittable: true` (should be corrected to false)
- LLM returns children with overlapping files (should warn)
- Description with shell metacharacters in `formatSplitCommands`
- Betweenness value is exactly at threshold boundary (0.3)
- Betweenness value is 0, 1, or NaN

### Item 6: Add Vitest test suite for core modules

**Current state:** Vitest is configured (`mcp-server/vitest.config.ts`). Existing tests:
- `__tests__/beads.test.ts` — covers beads.ts
- `__tests__/tender.test.ts` — covers tender.ts (auto-escalation, removeAgent, getSummary)
- `__tests__/checkpoint.test.ts`, `state.test.ts`, `logger.test.ts` — infrastructure
- `__tests__/tools/*.test.ts` — tool-level tests

**Missing test coverage for:**
- `plan-quality.ts` — `parsePlanQualityScore()`, `clampScore()`, `formatPlanQualityScore()` — pure functions, highly testable
- `goal-refinement.ts` — `synthesizeGoal()`, `extractConstraints()`, `parseQuestionsJSON()` — pure functions, highly testable  
- `model-routing.ts` — `classifyBeadComplexity()`, `routeModel()`, `routeBeads()`, `formatRoutingSummary()` — pure functions, highly testable
- `bead-splitting.ts` — `identifyBottlenecks()`, `parseSplitProposal()`, `formatSplitProposal()`, `formatSplitCommands()` — pure functions, highly testable
- `deep-plan.ts` — requires exec mock, medium complexity
- `scan.ts` — requires exec mock, already has fallback logic worth testing

**Correctness priority for tests (by risk):**
1. `parsePlanQualityScore` — parses LLM output, many failure modes
2. `parseSplitProposal` — parses LLM output, many failure modes
3. `parseQuestionsJSON` — parses LLM output, many failure modes
4. `classifyBeadComplexity` — score thresholds, boundary conditions
5. `synthesizeGoal` — bucket classification, empty inputs
6. `extractConstraints` — filter logic
7. `clampScore` — boundary values

### Item 7: Deep-plan fault tolerance

**Current state:** `deep-plan.ts` (83 lines):
- `runDeepPlanAgents()` uses `Promise.all()` — if any agent's exec call throws (not caught by the inner try/catch), the entire batch rejects.
- The inner try/catch (lines 41-77) handles exec errors and returns a `DeepPlanResult` with `exitCode: 1` and error message.
- However, if `writeFileSync(taskFile, ...)` throws (disk full, permission denied), the error propagates unhandled.
- `Promise.all` means all agents run, but the caller blocks until ALL complete. There's no timeout at the batch level, only per-agent (180s).

**What can go wrong:**
1. **One agent hangs beyond timeout:** The 180s timeout should handle this, but if exec doesn't respect the timeout (implementation-dependent), the batch blocks forever.
2. **writeFileSync throws:** Disk full or permission error on temp directory crashes the entire batch.
3. **Synthesis agent can't find plan files:** If 1 of 3 agents fails, its output file is empty or missing. The synthesis step (driven by the skill prompt, not this code) must handle partial inputs.
4. **All agents return empty plans:** The code returns `DeepPlanResult[]` with empty `plan` strings. The caller must check for this.

**Invariants:**
- `runDeepPlanAgents` must always return a `DeepPlanResult[]` (never throw)
- Each result must clearly indicate success/failure via `exitCode` and `error`
- Partial results (some agents fail) must be usable

**Correctness improvements:**
- Use `Promise.allSettled` instead of `Promise.all` to guarantee all results are captured
- Wrap `writeFileSync` in try/catch
- Add batch-level timeout
- Filter successful results for the synthesis step

### Item 8: SwarmTender nudge rate-limiting

**Current state:** `tender.ts` already has nudge rate-limiting:
- `maxNudges` (default 2) — maximum nudges before kill
- `nudgeDelayMs` (default 0) — delay before first nudge after stuck detection  
- `killWaitMs` (default 120s) — wait after last nudge before kill
- Per-agent tracking: `nudgesSent`, `lastNudgedAt`

**What can go wrong:**
1. **Multiple stalled agents flood coordinator:** Each stuck agent is nudged independently. With 10 stuck agents and `maxNudges=2`, that's 20 nudge messages, potentially overwhelming the coordinator or rate-limiting the Agent Mail server.
2. **No global nudge budget:** There's per-agent limiting but no per-poll or per-tender limit on total nudges sent.
3. **Nudge timing with fast poll interval:** If `pollInterval` is small (e.g., 10s) and `nudgeDelayMs` is 0, a stuck agent gets nudged on every poll until `maxNudges` is reached. With `maxNudges=2` and `pollInterval=60s`, this means 2 nudges in 2 minutes, which is reasonable. But with `pollInterval=10s`, it's 2 nudges in 20 seconds.
4. **`nudgeStuckAgent` uses worktreePath as both agent name and thread ID:** Line 225 passes `agent.worktreePath` as both `stuckAgentName` and `threadId`. This means the nudge is sent to an agent named after the worktree path, not the actual Agent Mail agent name. This is a **correctness bug** — the agent name should be resolved from the Agent Mail registry, not from the worktree path.

**Invariants:**
- Total nudges per poll cycle should be bounded (global budget)
- Nudge messages should target the correct Agent Mail agent identity
- Kill decisions should not race with activity detection

**Edge cases:**
- All agents stuck simultaneously
- Agent becomes active between nudge and next poll (nudge was unnecessary)
- Agent is killed but worktree cleanup hasn't happened yet
- `nudgeDelayMs` > `killWaitMs` (config inconsistency)
- Agent name vs worktree path mismatch

---

## Implementation Tasks

### T1: Verify and rebuild dist (dead code audit)
**Files:** `mcp-server/`
**Steps:**
1. Run `cd mcp-server && npm run build`
2. Grep `dist/` for `console.log` — confirm the only hit is the Gate 3 instruction string
3. Grep `src/` for `TODO`, `FIXME`, `HACK` — document any genuine stale items
4. If any genuine dead code found in src, remove it

**Acceptance criteria:**
- dist/ matches src/ after rebuild
- No stale console.log calls in source (string literals referencing console.log are acceptable)
- Document findings (may be "no action needed")

### T2: Add model-routing fallback chain
**Files:** `mcp-server/src/model-routing.ts`
**Steps:**
1. Add fallback model chain to `ModelTier`: `fallbacks?: string[]`
2. Validate `tiers` parameter in `routeModel()` — if a complexity key is missing, fall back to `DEFAULT_TIERS`
3. Add null guard for `bead.priority` (default to 3 = medium if undefined)
4. Export a `resolveModelWithFallback(preferred: string, available: string[]): string` utility for downstream use

**Acceptance criteria:**
- `routeModel()` never throws, even with malformed `tiers` input
- `bead.priority` being undefined/NaN doesn't affect classification incorrectly
- Fallback chain is documented in types

### T3: Add agent-mail connectivity health check
**Files:** `mcp-server/src/agent-mail.ts` (or new `agent-mail-health.ts`), `.mcp.json`
**Steps:**
1. Add a `checkAgentMailHealth()` function that pings the agent-mail endpoint
2. Call it on first orchestrator tool invocation, cache the result
3. Return clear error message if agent-mail is unreachable
4. Leave `.mcp.json` transport type as `http` (current working config)

**Acceptance criteria:**
- First tool call that needs agent-mail validates connectivity
- Error message includes the URL and suggests troubleshooting steps
- Health check doesn't block if agent-mail is not needed for the current operation

### T4: Propagate AbortSignal in scan.ts
**Files:** `mcp-server/src/scan.ts`
**Steps:**
1. Pass `signal` to all `exec()` calls in `ensureCccReady()` (lines 163, 171, 189)
2. Verify `runCccQuery()` doesn't need signal (it has its own timeout — acceptable)
3. No other changes needed — the existing fallback chain is already robust

**Acceptance criteria:**
- AbortSignal cancellation propagates to ccc subprocess calls
- Existing fallback behavior unchanged
- No new error paths introduced

### T5: Harden bead-splitting and add shell escaping
**Files:** `mcp-server/src/bead-splitting.ts`
**Steps:**
1. Add shell escaping in `formatSplitCommands()` for description text (escape `$`, backticks, `\`, `!`, in addition to existing `"` escaping)
2. Add file overlap validation in `parseSplitProposal()` — warn (don't reject) if children have overlapping file sets
3. Handle `NaN` betweenness values in `identifyBottlenecks()` — filter them out

**Acceptance criteria:**
- Generated shell commands are safe against injection
- Overlapping file sets produce a warning in the `reason` field
- NaN betweenness values are filtered out, not propagated

### T6: Add Vitest tests for core pure-function modules
**Files:** 
- `mcp-server/src/__tests__/plan-quality.test.ts` (new)
- `mcp-server/src/__tests__/goal-refinement.test.ts` (new)
- `mcp-server/src/__tests__/model-routing.test.ts` (new)
- `mcp-server/src/__tests__/bead-splitting.test.ts` (new)

**Steps:**
1. Create test files for each module
2. Write tests per the Test Strategy section below
3. Run `npx vitest` and verify all pass
4. Check coverage: `npx vitest --coverage`

**Acceptance criteria:**
- All 4 new test files pass
- >60% line coverage for `plan-quality.ts`, `goal-refinement.ts`, `model-routing.ts`, `bead-splitting.ts`
- Edge cases from the Correctness Analysis are covered

### T7: Add fault tolerance to deep-plan.ts
**Files:** `mcp-server/src/deep-plan.ts`
**Steps:**
1. Change `Promise.all` to `Promise.allSettled` at line 81
2. Wrap `writeFileSync(taskFile, ...)` in try/catch with fallback to inline stdin
3. Add `successCount` and `failedAgents` to the return type or a wrapper result
4. Add batch-level timeout (configurable, default 10 minutes)
5. Filter and return only fulfilled results, with failed agents logged

**Acceptance criteria:**
- If 1 of 3 agents fails, the other 2 results are still returned
- writeFileSync failure doesn't crash the batch
- Batch timeout prevents infinite blocking
- Return type clearly indicates which agents succeeded/failed

### T8: Add global nudge budget to SwarmTender
**Files:** `mcp-server/src/tender.ts`
**Steps:**
1. Add `maxNudgesPerPoll` config option (default 3) to `TenderConfig`
2. Track nudge count within each `poll()` cycle, stop nudging after budget exhausted
3. Fix the agent name resolution in `nudgeStuckAgent` call (line 225) — the worktree path is used as agent name, but it should resolve to the actual Agent Mail agent name
4. Add config validation: warn if `nudgeDelayMs > killWaitMs`

**Acceptance criteria:**
- No more than `maxNudgesPerPoll` nudge messages sent per poll cycle
- Nudge messages target correct Agent Mail agent identities
- Config inconsistencies (nudgeDelayMs > killWaitMs) produce a warning at construction time

---

## Dependency Graph

```
T1: Verify and rebuild dist (dead code audit)          depends_on: []
T2: Add model-routing fallback chain                   depends_on: []
T3: Add agent-mail connectivity health check           depends_on: []
T4: Propagate AbortSignal in scan.ts                   depends_on: []
T5: Harden bead-splitting and add shell escaping       depends_on: []
T6: Add Vitest tests for core modules                  depends_on: [T2, T5]
T7: Add fault tolerance to deep-plan.ts                depends_on: []
T8: Add global nudge budget to SwarmTender             depends_on: []
```

**Parallelizable groups:**
- Wave 1: T1, T2, T3, T4, T5, T7, T8 (all independent)
- Wave 2: T6 (depends on T2 and T5 because tests should cover the improved code)

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| T2 fallback chain introduces model name coupling | Medium | Medium | Use constants from prompts.ts, not hardcoded strings |
| T5 shell escaping breaks legitimate bead descriptions | Low | Medium | Test with descriptions containing special chars; only escape in shell command output, not in data structures |
| T6 tests are brittle against prompt text changes | Medium | Low | Test behavior (scores, classifications), not exact strings |
| T7 Promise.allSettled changes return type shape | Medium | High | Ensure all callers of `runDeepPlanAgents` handle the new shape; add adapter if needed |
| T8 global nudge budget causes stuck agents to never be nudged | Low | High | Budget is per-poll, not global — agents accumulate nudges across polls. Ensure budget doesn't prevent the first nudge to any agent |
| T3 health check adds latency to first tool call | Low | Low | Make health check async with timeout; cache result |
| T1 finds genuine dead code that other tasks depend on | Low | Medium | Audit before removing; check import graph |

---

## Test Strategy

### plan-quality.test.ts

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Parse valid LLM JSON output | `{"workflows": 80, "edgeCases": 70, ...}` | PlanQualityScore with correct values |
| Parse JSON wrapped in markdown fences | `` ```json\n{...}\n``` `` | Same as above |
| Parse JSON with extra text before/after | `Here's my score: {...} Hope that helps!` | Extracts JSON correctly |
| Handle non-JSON output | `I think the plan is good` | Returns `null` |
| Handle empty string | `""` | Returns `null` |
| clampScore with negative number | `-10` | `0` |
| clampScore with >100 | `150` | `100` |
| clampScore with NaN | `NaN` | `50` |
| clampScore with string | `"high"` | `50` |
| clampScore with undefined | `undefined` | `50` |
| Overall score calculation | Known dimension values | Verify weighted average formula |
| Recommendation: block when <60 | overall=55 | `"block"` |
| Recommendation: warn when 60-79 | overall=75 | `"warn"` |
| Recommendation: proceed when >=80 | overall=85 | `"proceed"` |
| formatPlanQualityScore bar rendering | score=50 | 5 filled blocks, 5 empty |
| weakSections truncated to 10 | 15 weak sections | Only 10 in output |

### goal-refinement.test.ts

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| synthesizeGoal with empty answers | `("goal", [])` | Only `## Goal\ngoal` section |
| synthesizeGoal bucket classification | Answers with scope/constraint/non-goal IDs | Correct sections populated |
| synthesizeGoal value-based non-goal detection | Answer with value `"no-tests"` | Goes to Non-Goals bucket |
| extractConstraints filters correctly | Mixed answers | Only constraint/non-goal/avoid/exclude answers |
| extractConstraints with empty array | `[]` | `[]` |
| parseQuestionsJSON valid array | Valid JSON array of questions | Parsed questions with all fields |
| parseQuestionsJSON with markdown fences | Fenced JSON | Strips fences, parses correctly |
| parseQuestionsJSON invalid JSON | `"not json"` | Fallback single generic question |
| parseQuestionsJSON empty array | `"[]"` | Empty array (no questions) |
| parseQuestionsJSON filters invalid questions | Array with missing fields | Only valid questions returned |
| parseQuestionsJSON allowOther default | Question without allowOther field | Defaults to `true` |

### model-routing.test.ts

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| classifyBeadComplexity: simple bead | `{title: "Update README", description: "Fix typo in docs"}` | `{complexity: "simple"}` |
| classifyBeadComplexity: complex bead | `{title: "Migrate auth", description: "Security architecture refactor across 8 files"}` | `{complexity: "complex"}` |
| classifyBeadComplexity: medium bead | `{title: "Add endpoint", description: "New API route with validation, 3 files"}` | `{complexity: "medium"}` |
| classifyBeadComplexity: undefined description | `{description: undefined}` | Does not throw |
| classifyBeadComplexity: undefined priority | `{priority: undefined}` | Does not throw, priority signal skipped |
| extractFileCount: no files section | Description without `### Files:` | `0` |
| extractFileCount: 3 files listed | Description with 3 file paths | `3` |
| routeModel: returns correct tier | Simple bead | Implementation and review models from simple tier |
| routeModel: custom tiers | Custom tier map | Uses custom models |
| routeModel: review differs from implementation | Any bead | `route.review !== route.implementation` |
| routeBeads: empty array | `[]` | Empty map, all zeros |
| routeBeads: mixed complexities | 3 beads of different complexity | Correct summary counts |
| formatRoutingSummary: empty routes | Empty map | `""` |
| Score boundary: score=1 -> simple | Bead with score 1 | `"simple"` |
| Score boundary: score=2 -> medium | Bead with score 2 | `"medium"` |
| Score boundary: score=4 -> complex | Bead with score 4 | `"complex"` |

### bead-splitting.test.ts

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| identifyBottlenecks: empty Bottlenecks | `{Bottlenecks: []}` | `[]` |
| identifyBottlenecks: null Bottlenecks | `{Bottlenecks: null}` | `[]` |
| identifyBottlenecks: undefined Bottlenecks | `{}` (no Bottlenecks key) | `[]` |
| identifyBottlenecks: below threshold | Bottleneck with value 0.1 | `[]` |
| identifyBottlenecks: at threshold | Bottleneck with value 0.3 | `[{bead, betweenness: 0.3}]` |
| identifyBottlenecks: bead ID not in beads array | Bottleneck ID "br-99" not in beads | Filtered out |
| identifyBottlenecks: sorted by betweenness desc | Multiple bottlenecks | Highest first |
| parseSplitProposal: valid splittable JSON | `{"splittable": true, "children": [...]}` | Correct SplitProposal |
| parseSplitProposal: no JSON in output | `"I can't split this"` | `{splittable: false}` |
| parseSplitProposal: splittable true but 0 children | `{"splittable": true, "children": []}` | `{splittable: false}` (corrected) |
| parseSplitProposal: splittable true but 1 child | `{"splittable": true, "children": [{}]}` | `{splittable: false}` (need >=2) |
| parseSplitProposal: malformed JSON | `{"splittable": true, children` | `{splittable: false}` |
| parseSplitProposal: child with empty title filtered | `{"splittable": true, "children": [{"title": ""}]}` | Child filtered out |
| formatSplitProposal: not splittable | `{splittable: false}` | Contains "Cannot split" |
| formatSplitProposal: splittable with children | 2 children | Contains child titles and files |
| formatSplitCommands: not splittable | `{splittable: false}` | `""` |
| formatSplitCommands: shell metacharacters | Description with `$(rm -rf /)` | Escaped in output |
| NaN betweenness filtered | Bottleneck with value NaN | Filtered out (after T5 fix) |

---

## Notes on Scope Adjustments

Based on the source code analysis:

1. **Item 1 (dead code)** is likely a no-op — the referenced issues don't exist in current source. Reduced to a verification task.
2. **Item 4 (scan.ts error recovery)** already has excellent fallback logic. Reduced to signal propagation fix.
3. **Item 8 (nudge rate-limiting)** already has per-agent limiting. The real correctness bug is the agent name resolution on line 225, plus adding a global per-poll budget.
4. **Item 3 (transport detection)** is reframed as a health check rather than auto-detection, which is simpler and more reliable.
