# Robustness Plan --- 2026-04-09

## Goal

Harden the claude-orchestrator MCP server across 8 improvement areas: dead code cleanup, model-routing fallback, agent-mail transport resilience, scan error recovery, bead-splitting edge cases, Vitest coverage for core modules, deep-plan fault tolerance, and SwarmTender nudge rate-limiting. Every change is evaluated through the lens of: "What happens when this fails? How does the system degrade gracefully? What's the blast radius?"

---

## Robustness Analysis

### Item 1: Clean up dead code and stale TODOs

**Current state:** Grep found no actual `console.log` calls in `tools/review.ts` (the reference on line 347 is inside a gate instruction string, which is correct). The `bead-templates.ts:184` reference to "TODO stubs" is prescriptive acceptance criteria text, not a stale TODO. `prompts.ts` references to TODOs are part of the scan/profile display system, not dead code.

**Failure modes:** Dead code causes confusion during maintenance. Stale TODOs mislead developers into thinking work is pending when it may already be done elsewhere.

**Blast radius:** Low -- cleanup is purely cosmetic/hygiene.

**Graceful degradation:** N/A -- this is a cleanup task.

**Robustness strategy:** Audit all TODO/FIXME markers across `mcp-server/src/`. For each, classify as: (a) still relevant and needs tracking, (b) resolved but not cleaned up, or (c) part of dynamic content (display strings). Remove category (b), leave (a) with issue references, leave (c) as-is.

### Item 2: Model-routing fallback strategy

**Current state:** `model-routing.ts` uses `DEFAULT_TIERS` from `prompts.ts` (`MODEL_ROUTING_TIERS`). The `routeModel()` function accepts optional `tiers` but falls back to `DEFAULT_TIERS`. There is NO validation that the returned model string is actually available/reachable. If a preferred model is unavailable (rate-limited, deprecated, API key missing), the caller gets an opaque failure downstream when the model is invoked.

**Failure modes:**
- Model string refers to a deprecated/removed model -> spawn fails
- API key for a model provider is missing -> auth error at agent spawn time
- Rate limit hit on preferred model -> intermittent failures
- Custom tiers map has missing complexity key -> undefined access

**Blast radius:** HIGH -- a bad model route propagates through bead implementation AND review, potentially blocking the entire workflow.

**Graceful degradation strategy:**
1. Add a `validateModelAvailability()` function that checks if a model string is reachable (leveraging `model-detection.ts`'s `detectAvailableModels()`).
2. Add tier-level fallback: if the preferred model for a tier is unavailable, fall back to the next-lower tier's model (complex -> medium -> simple).
3. Add a `ModelRouteWithFallback` type that records both the primary and fallback model.
4. Log a warning via `createLogger("model-routing")` when fallback is used.

### Item 3: Agent-mail MCP transport detection

**Current state:** `.mcp.json` currently uses `"type": "http"` with `"url": "http://127.0.0.1:8765/mcp"`. Recent commits show a flip-flop between `url` and `sse` types (commits `0a7a8c2`, `c12c6be`, `7c08923`), indicating the correct transport type is environment-dependent.

**Failure modes:**
- Wrong transport type -> MCP connection fails at startup -> all Agent Mail tools unavailable
- Server not running on expected port -> connection refused
- SSE endpoint works in some environments but not others (proxy, firewall)

**Blast radius:** CRITICAL -- Agent Mail is used for all multi-agent coordination. If it fails, swarm mode, deep-plan, and review agents all break.

**Graceful degradation strategy:**
1. Add a startup health-check that probes the agent-mail endpoint and logs connection status.
2. Document the transport selection criteria (when to use `http` vs `sse` vs `url`).
3. In the orchestrator's coordination detection (`coordination.ts`), add graceful handling when Agent Mail is unreachable -- fall back to non-Agent-Mail coordination (e.g., file-based).
4. Add a `--agent-mail-transport` CLI flag or env var (`AGENT_MAIL_TRANSPORT`) to make this configurable without editing `.mcp.json`.

### Item 4: Error recovery in scan.ts

**Current state:** `scanRepo()` already has robust error recovery. It:
- Tries `cccScanProvider`, catches errors, falls back to `builtinScanProvider` (line 87-110)
- Handles double-fault (both providers fail) by returning `createEmptyRepoProfile()` with warnings (line 96-110)
- `collectCccCodebaseAnalysis()` uses `Promise.allSettled()` for individual queries (line 228), logging failures and continuing with partial results
- Only throws if ALL queries fail (line 245-249)

**Failure modes already handled:** ccc not installed, ccc init failure, ccc index timeout, individual search query failure, JSON parse errors.

**Remaining gaps:**
- `ensureCccReady()` has a 120s timeout for `ccc index` (line 189) but no progress reporting -- caller has no idea if it's working or hung
- `parseCccSearchResults()` silently produces empty results on malformed output (acceptable but could log a warning)
- `profileRepo()` (called in fallback path) could itself throw with no partial result

**Robustness strategy:**
1. Add progress logging in `ensureCccReady()` before each step.
2. Add a warning log in `parseCccSearchResults()` when output doesn't match expected format.
3. Ensure `toScanErrorInfo()` captures stack traces for debugging (currently only captures message).

### Item 5: Bead-splitting edge case coverage

**Current state:** `bead-splitting.ts` has four main functions: `identifyBottlenecks()`, `beadSplitProposalPrompt()`, `parseSplitProposal()`, `formatSplitProposal()`, `formatSplitCommands()`.

**Edge cases not covered:**
- `identifyBottlenecks()`: Empty `insights.Bottlenecks` (uses `??[]` -- OK). Empty `beads` array (returns `[]` -- OK). Bead ID in bottleneck not found in beads array (filtered by null check -- OK).
- `parseSplitProposal()`: Empty string input (returns not-splittable -- OK). JSON with `splittable: true` but 0 or 1 children (line 153: `splittable && children.length >= 2` -- correctly returns false).
- `formatSplitProposal()`: Proposal with 0 children (handled -- returns "Cannot split" message). 
- `formatSplitCommands()`: Child with empty title (empty br create command). Child with description containing shell metacharacters (line 213: only escapes `"` but not `$`, backticks, `\`).

**Failure modes:**
- Shell injection via `formatSplitCommands()` if bead descriptions contain shell metacharacters
- Off-by-one: `parseSplitProposal()` requires `children.length >= 2` which is correct for splits but means single-child "splits" are silently rejected

**Robustness strategy:**
1. Sanitize shell metacharacters in `formatSplitCommands()` descriptions.
2. Add Vitest tests for edge cases: empty input, single child, shell metacharacters in descriptions, malformed JSON, nested JSON objects.
3. Consider allowing single-child splits as "refinements" with a different label.

### Item 6: Vitest test suite for core modules

**Current state:** Existing tests cover: `types`, `checkpoint`, `beads`, `state`, `tools/shared`, `tools/profile`, `tools/discover`, `tools/select`, `tools/memory-tool`, `tools/plan`, `tools/review`, `logger`, `tender`, `tools/approve`. No tests exist for: `plan-quality.ts`, `goal-refinement.ts`, `model-routing.ts`, `bead-splitting.ts`, `scan.ts`, `deep-plan.ts`.

**Failure modes without tests:** Regressions go undetected. Refactors break silent contracts. Edge cases only discovered in production (during orchestration runs).

**Robustness strategy:**
1. `model-routing.ts`: Test `classifyBeadComplexity()` with beads at each complexity level, boundary scores, empty descriptions. Test `routeModel()` with custom tiers. Test `routeBeads()` with mixed complexities.
2. `plan-quality.ts`: Test `parsePlanQualityScore()` with valid JSON, malformed JSON, edge scores (0, 100, boundary at gate thresholds).
3. `goal-refinement.ts`: Test `synthesizeGoal()`, `extractConstraints()`, `parseQuestionsJSON()` with various inputs.
4. `bead-splitting.ts`: Test edge cases from Item 5 analysis.
5. `scan.ts`: Test `createBuiltinScanResult()`, `createFallbackScanResult()`, `createEmptyCodebaseAnalysis()`, `toScanErrorInfo()`. Mock `exec` for `scanRepo()` integration tests.
6. Target >60% line coverage across these modules.

### Item 7: Deep-plan fault tolerance

**Current state:** `deep-plan.ts:runDeepPlanAgents()` runs all agents via `Promise.all()` (line 81). Individual agent failures are caught and returned as `DeepPlanResult` with `exitCode: 1` and `error` field (lines 68-77). However, the synthesis step (triggered by the caller in `tools/plan.ts:219`) expects ALL plan files to exist. If one agent fails to write its plan file, the synthesis agent will block waiting for it.

**Failure modes:**
- Agent timeout (3 min per planner, line 54) -> returns empty plan string
- Agent crash -> caught, returns error result
- Synthesis agent reads plan files that are empty (agent timed out but file was created)
- All agents fail -> synthesis has nothing to work with
- 2 of 3 agents succeed -> synthesis could work with 2 plans but currently expects 3

**Blast radius:** HIGH -- deep-plan is used for complex goals. Blocking the synthesis step blocks the entire planning phase.

**Robustness strategy:**
1. Add result filtering in the synthesis orchestration: skip agents with `exitCode !== 0` or empty `plan` content.
2. Add a minimum viable threshold: synthesis should proceed if at least 2 of N agents succeed (configurable, default N-1).
3. Add timeout escalation: if an agent hasn't produced output by 2.5 min (of the 3 min timeout), log a warning.
4. Add a synthesis fallback: if fewer than 2 agents succeed, fall back to single-plan mode using the one successful result.
5. Add `elapsed` field logging so operators can see which agents are slow.

### Item 8: SwarmTender nudge rate-limiting

**Current state:** `tender.ts` has basic nudge limiting: `maxNudges` (default 2) and `nudgeDelayMs` (default 0, meaning immediate). The `canNudge` check (line 218-219) ensures nudges don't exceed `maxNudges` and respects `nudgeDelayMs`. However:

**Failure modes:**
- `nudgeDelayMs: 0` means ALL stuck agents get nudged on EVERY poll cycle until `maxNudges` is reached. With 60s poll interval and 2 max nudges, a stuck agent gets both nudges within 60s -- too fast.
- Multiple stuck agents all get nudged simultaneously, flooding the coordinator mailbox.
- `nudgeStuckAgent()` uses `worktreePath` as both the agent name AND thread ID (line 225) -- worktree paths are not valid Agent Mail agent names.
- The `.catch(() => {})` on nudge (line 225) silently swallows all errors including connection failures.

**Blast radius:** MEDIUM -- nudge flooding degrades Agent Mail performance and creates noise. Silent failures mean stuck agents are never actually notified.

**Robustness strategy:**
1. Add a per-agent `nudgeCooldownMs` (default 120_000 = 2 min) distinct from `nudgeDelayMs`. After each nudge, enforce cooldown before next nudge to same agent.
2. Add a global nudge budget: max N nudges per poll cycle across ALL agents (default 3). This prevents flood when many agents go stuck simultaneously.
3. Fix the agent name resolution: look up actual Agent Mail agent names from worktree metadata instead of using worktree paths.
4. Replace `.catch(() => {})` with proper error logging via `this.log.error()`.
5. Add nudge delivery confirmation: check if the nudge message was actually delivered before counting it.

---

## Implementation Tasks

### T1: Audit and clean dead code / stale TODOs
- **Files:** All `mcp-server/src/**/*.ts` files
- **Steps:**
  1. Run `grep -rn 'TODO\|FIXME\|HACK\|XXX' mcp-server/src/` and classify each hit
  2. Remove resolved TODOs, add issue references to active ones
  3. Delete any truly dead code (unused imports, unreachable branches)
- **Acceptance criteria:** No stale TODOs remain. All active TODOs reference an issue or have clear context.
- **Dependencies:** None

### T2: Add model-routing fallback strategy
- **Files:** `mcp-server/src/model-routing.ts`, `mcp-server/src/model-detection.ts`
- **Steps:**
  1. Add `validateModelAvailability(modelId: string): boolean` that checks against detected models
  2. Add fallback chain logic to `routeModel()`: try preferred, then next-lower tier, then hardcoded safe default
  3. Add `ModelRouteWithFallback` interface with `primary`, `fallback`, `usedFallback` fields
  4. Add structured logging when fallback is activated
  5. Update `routeBeads()` to use the new fallback-aware routing
- **Acceptance criteria:** `routeModel()` never returns an unavailable model string. Fallback is logged. Tests cover all fallback paths.
- **Dependencies:** T6 (needs tests)

### T3: Harden agent-mail transport detection
- **Files:** `.mcp.json`, `mcp-server/src/coordination.ts`, `mcp-server/src/agent-mail.ts`
- **Steps:**
  1. Add a `checkAgentMailHealth()` function that probes the configured endpoint
  2. In coordination detection, wrap Agent Mail initialization with health check; log and degrade gracefully if unavailable
  3. Add `AGENT_MAIL_TRANSPORT` env var support for runtime override
  4. Document transport selection in `.mcp.json` comments or AGENTS.md
- **Acceptance criteria:** Orchestrator starts cleanly even when agent-mail is down. Warning is logged. Non-swarm features work without agent-mail.
- **Dependencies:** None

### T4: Improve scan.ts error reporting
- **Files:** `mcp-server/src/scan.ts`
- **Steps:**
  1. Add progress logging to `ensureCccReady()` before each exec call
  2. Add warning log in `parseCccSearchResults()` when no blocks are parsed from non-empty output
  3. Add stack trace capture in `toScanErrorInfo()` for Error instances
  4. Add optional `onProgress` callback to `scanRepo()` for caller-visible status
- **Acceptance criteria:** Scan failures produce actionable log output. Stack traces are preserved. Progress is visible for long-running scans.
- **Dependencies:** None

### T5: Harden bead-splitting edge cases
- **Files:** `mcp-server/src/bead-splitting.ts`
- **Steps:**
  1. Sanitize shell metacharacters (`$`, backtick, `\`) in `formatSplitCommands()` descriptions
  2. Add input validation in `identifyBottlenecks()` for empty/malformed insights
  3. Document the `children.length >= 2` requirement in `parseSplitProposal()`
- **Acceptance criteria:** Shell injection is impossible via `formatSplitCommands()`. Edge cases are documented and tested.
- **Dependencies:** T6 (needs tests)

### T6: Add Vitest test suite for core modules
- **Files:** `mcp-server/src/__tests__/model-routing.test.ts`, `mcp-server/src/__tests__/plan-quality.test.ts`, `mcp-server/src/__tests__/goal-refinement.test.ts`, `mcp-server/src/__tests__/bead-splitting.test.ts`, `mcp-server/src/__tests__/scan.test.ts`
- **Steps:**
  1. Create `model-routing.test.ts`: test classifyBeadComplexity (all tiers), routeModel (with/without custom tiers), routeBeads (mixed), formatRoutingSummary
  2. Create `plan-quality.test.ts`: test parsePlanQualityScore (valid, malformed, boundary scores), planQualityScoringPrompt (output structure)
  3. Create `goal-refinement.test.ts`: test synthesizeGoal, extractConstraints, parseQuestionsJSON
  4. Create `bead-splitting.test.ts`: test identifyBottlenecks (empty, threshold boundary), parseSplitProposal (empty, malformed, single child, shell chars), formatSplitProposal, formatSplitCommands
  5. Create `scan.test.ts`: test createBuiltinScanResult, createFallbackScanResult, createEmptyCodebaseAnalysis, toScanErrorInfo, parseCccSearchResults
  6. Run coverage report, verify >60% line coverage for each module
- **Acceptance criteria:** All tests pass. Coverage report shows >60% for targeted modules. No mocking of external services -- only unit tests of pure functions and mock exec for integration tests.
- **Dependencies:** None (but T2 and T5 will add code that needs test updates)

### T7: Deep-plan fault tolerance
- **Files:** `mcp-server/src/deep-plan.ts`, `mcp-server/src/tools/plan.ts`, `mcp-server/src/prompts.ts`
- **Steps:**
  1. Add `filterSuccessfulResults(results: DeepPlanResult[]): DeepPlanResult[]` that excludes failed/empty results
  2. Add a `minViablePlanners` config (default 2) -- synthesis proceeds only if at least this many agents succeed
  3. If fewer than `minViablePlanners` succeed, return the single best result as the plan (skip synthesis)
  4. Add elapsed-time logging per agent in `runDeepPlanAgents()` results
  5. Update synthesis prompt (`synthesisInstructions`) to note which perspectives are missing when some agents failed
  6. Add timeout warning at 80% of deadline (e.g., log at 144s of 180s timeout)
- **Acceptance criteria:** Synthesis proceeds with 2 of 3 agents. Single-agent fallback works. Failed agents are logged with elapsed time and error. Synthesis prompt acknowledges missing perspectives.
- **Dependencies:** None

### T8: SwarmTender nudge rate-limiting
- **Files:** `mcp-server/src/tender.ts`
- **Steps:**
  1. Add `nudgeCooldownMs` to `TenderConfig` (default 120_000)
  2. Add `globalNudgeBudgetPerPoll` to `TenderConfig` (default 3)
  3. Track global nudge count per poll cycle; skip nudges once budget exhausted
  4. Enforce cooldown: only nudge if `(now - agent.lastNudgedAt) >= nudgeCooldownMs`
  5. Replace `.catch(() => {})` with `.catch(err => this.log.error("Nudge failed", { stepIndex, err }))`
  6. Fix `nudgeStuckAgent()` call to resolve actual Agent Mail agent name from worktree mapping
  7. Add observability: log nudge budget usage at end of each poll cycle
- **Acceptance criteria:** No more than `globalNudgeBudgetPerPoll` nudges per poll. Nudge errors are logged. Agent name resolution is correct.
- **Dependencies:** None

---

## Dependency Graph

```
T1: Clean dead code/TODOs                depends_on: []
T2: Model-routing fallback               depends_on: [T6]
T3: Agent-mail transport hardening        depends_on: []
T4: Scan error reporting                  depends_on: []
T5: Bead-splitting edge cases             depends_on: [T6]
T6: Vitest test suite for core modules    depends_on: []
T7: Deep-plan fault tolerance             depends_on: []
T8: SwarmTender nudge rate-limiting       depends_on: []
```

**Parallelization:** T1, T3, T4, T6, T7, T8 can all start immediately. T2 and T5 should wait for T6 (test infrastructure) so their changes are immediately tested.

**Critical path:** T6 -> T2 + T5 (in parallel)

---

## Failure Mode Catalog

### model-routing.ts
| Failure | How it manifests | Detection | Recovery |
|---------|-----------------|-----------|----------|
| Model string invalid | Agent spawn fails with API error | Spawn error log | Fallback to next-lower tier model |
| All models unavailable | No valid model in any tier | Health check at startup | Block workflow with actionable error |
| Custom tiers missing key | `undefined` access in `routeModel()` | TypeScript type check (compile time) | Fall back to DEFAULT_TIERS |

### scan.ts
| Failure | How it manifests | Detection | Recovery |
|---------|-----------------|-----------|----------|
| ccc not installed | `ensureCccReady()` throws | Stderr log `[scan] ccc provider failed` | Fallback to builtin profiler |
| ccc index hangs | 120s timeout | Timeout error in stderr | Fallback to builtin profiler |
| Both providers fail | Empty profile returned | Stderr log for double fault | `createEmptyRepoProfile()` with warnings |
| Malformed ccc output | Empty search results | No direct detection currently | **NEW:** Add warning log when parser returns 0 results from non-empty output |

### deep-plan.ts
| Failure | How it manifests | Detection | Recovery |
|---------|-----------------|-----------|----------|
| Agent timeout (3 min) | Empty plan string, exitCode from exec timeout | `elapsed` field, `error` field | **NEW:** Filter from synthesis input |
| Agent crash | exitCode 1, error message | `error` field in result | **NEW:** Skip in synthesis, log warning |
| All agents fail | No plans for synthesis | **NEW:** Check result count | **NEW:** Fall back to single-plan mode or abort with message |
| Synthesis receives empty plans | Poor synthesized output | Plan quality score (plan-quality.ts) | Re-run failed agents or use best single plan |

### tender.ts
| Failure | How it manifests | Detection | Recovery |
|---------|-----------------|-----------|----------|
| Nudge floods coordinator | Agent Mail inbox noise, slow responses | **NEW:** Nudge budget tracking | **NEW:** Global per-poll budget cap |
| Nudge delivery failure | Agent never receives notification | **NEW:** Error logging (replace silent catch) | **NEW:** Log error, don't count as delivered |
| Wrong agent name in nudge | Message sent to non-existent agent | Agent Mail delivery error | **NEW:** Resolve name from worktree metadata |
| Many agents stuck simultaneously | All nudge budget consumed on first poll | **NEW:** Budget tracking log | Rate-limit spreads nudges across polls |

### bead-splitting.ts
| Failure | How it manifests | Detection | Recovery |
|---------|-----------------|-----------|----------|
| Shell injection in formatSplitCommands | Arbitrary command execution | **NEW:** Sanitization check | **NEW:** Escape shell metacharacters |
| Malformed LLM JSON output | Parse failure | Already handled (returns not-splittable) | N/A -- graceful already |
| Single child from LLM | Treated as not-splittable | `children.length >= 2` check | Document this behavior, consider "refine" label |

---

## Observability Requirements

### Logging (structured stderr via createLogger)

| Module | Logger name | Key events to log |
|--------|------------|-------------------|
| model-routing.ts | `model-routing` | Fallback activated (warn), model unavailable (warn), routing summary per batch (info) |
| scan.ts | `scan` | Progress through ensureCccReady steps (info), parser empty result warning (warn), double-fault (error) |
| deep-plan.ts | `deep-plan` | Per-agent elapsed time (info), agent failure (warn), synthesis input count (info), timeout warning at 80% (warn) |
| tender.ts | `tender` | Nudge sent (info), nudge budget exhausted (warn), nudge delivery failure (error), kill decision (warn), global poll summary (debug) |
| bead-splitting.ts | `bead-splitting` | Split proposal generated (info), shell sanitization applied (debug) |

### Metrics (future -- not in scope for this plan, but noted for observability)

- `model_routing_fallback_count` -- how often fallback is used per session
- `scan_provider_used` -- which provider succeeded (ccc vs builtin)
- `deep_plan_agent_success_rate` -- fraction of planners that succeed
- `tender_nudge_total` -- total nudges sent per swarm session
- `tender_nudge_budget_exhausted` -- poll cycles where budget was hit

### Health checks

- Agent Mail connectivity: probe at startup, log status
- Model availability: check at routing time, log unavailable models
- ccc readiness: already checked in scan pipeline, add timing
