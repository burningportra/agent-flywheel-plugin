# Ergonomics Plan — 2026-04-09

## Goal

Improve developer experience across 8 areas of the claude-orchestrator codebase: dead code removal, model-routing fallback, agent-mail transport resilience, scan error recovery, bead-splitting edge cases, Vitest coverage expansion, deep-plan fault tolerance, and SwarmTender nudge rate-limiting.

---

## Ergonomics Analysis

### Item 1 — Dead code and stale TODOs

**Current state:** `tools/review.ts:~309` has no actual `console.log` — the reference in the task description points to the inline string `"Check for: TODO/FIXME left over, console.log not cleaned up"` inside a gate-check string literal (line 347). This is not dead code; it is intentional gate text. However, `bead-templates.ts:184` has the string `"Implement the endpoint behavior in the named module without leaving TODO stubs."` which is acceptance-criteria text, not a real TODO. The item is lower severity than described but worth clarifying.

**DX impact:** Future contributors doing a `grep TODO` will be confused by false positives embedded in template strings. The fix is ergonomic: grep-safe comments vs. user-visible strings should be visually distinct or scoped.

**Simplest API:** No API change needed. Rename embedded TODO references to non-grep-colliding wording like `"leave no stub methods"`.

**Composes with existing patterns:** All in `bead-templates.ts` acceptance-criteria arrays — low risk.

---

### Item 2 — Model-routing fallback strategy

**Current state:** `model-routing.ts` routes via `DEFAULT_TIERS` which reads from `MODEL_ROUTING_TIERS` in `prompts.ts`. There is no guard against `MODEL_ROUTING_TIERS.*` returning an empty string. If an operator configures a custom tier map and omits a tier level, `routeModel` returns an empty `implementation` or `review` string silently.

**DX impact:** Routing failures are invisible — the agent gets an empty model name, which only surfaces as a provider error at spawn time, far from the root cause. The fix should make the failure loud and early.

**Simplest API:** Add a `validateModelTier(tier: ModelTier, complexity: BeadComplexity): void` that throws a descriptive error during startup or first use. Alternatively, add a `fallbackTier` field to `ModelTier` that is used when a model is unavailable. Since we cannot know at routing-time whether a model is available, the simpler approach is validation at `routeModel` call time with a clear error message.

**Sensible default:** If validation fails, log a warning and fall back to the `medium` tier.

**Composes with existing patterns:** `routeModel` already returns a `ModelRoute` struct — the validation is a pre-check that can be added without changing the return type.

---

### Item 3 — Agent-mail MCP transport detection

**Current state:** `.mcp.json` currently uses `type: "http"` pointing to `http://127.0.0.1:8765/mcp`. The commit history shows an SSE↔URL flip-flop (commits 0a7a8c2, c12c6be). The root issue: there is no auto-detection; the operator must know which type the running agent-mail server supports.

**DX impact:** When starting fresh, the wrong transport type causes a silent MCP connection failure. Operators learn this only after the session fails to connect, with no helpful error message.

**Simplest API:** Add a startup health-check note in AGENTS.md (or a `mcp-check` script) that pings `http://127.0.0.1:8765/mcp` and prints the supported transport type. The `.mcp.json` config cannot auto-detect — but a pre-flight script can warn and suggest the right value.

**No breaking change:** The `.mcp.json` format is Claude Code's format, not ours to change.

---

### Item 4 — Error recovery in scan.ts

**Current state:** `scan.ts` already has a robust two-level fallback: ccc provider → builtin profiler → empty profile. This is well-implemented. The original concern about `throws on failure` (item description) appears to have already been addressed — `createEmptyRepoProfile(cwd)` is used on double-fault.

**DX impact:** The double-fault path returns a result with warnings but no `codebaseAnalysis.summary` explicitly documenting the failure chain. A downstream consumer reading `result.codebaseAnalysis.summary` gets `undefined`, which could cause confusing rendering.

**Simplest API:** Set `codebaseAnalysis.summary` on the fallback path to `"Scan failed: both ccc and builtin providers failed. Results may be incomplete."` so callers always get a printable string.

**Composes with existing patterns:** `createFallbackScanResult` already sets `sourceMetadata.warnings` — the `summary` field just needs to be populated.

---

### Item 5 — Bead-splitting edge case coverage

**Current state:** `bead-splitting.ts` has three main paths that need edge-case hardening:

1. `identifyBottlenecks`: if `insights.Bottlenecks` is `null`/`undefined`, the `?? []` guard handles it. Good.
2. `parseSplitProposal`: if the LLM returns a JSON object with `"splittable": true` but `"children": []` (empty array), the function sets `splittable: false` correctly because `children.length >= 2` is false. But `reason` will be `undefined` rather than explaining why splittable was overridden — confusing for debugging.
3. `formatSplitCommands`: if `children` has exactly 1 element, it silently returns `""` — callers get no output and no explanation.
4. Single-bead plans: if `beads.find()` in `identifyBottlenecks` returns `undefined`, the `.filter()` handles it, but this is silent.

**DX impact:** An LLM hallucinating `"children": [{ "title": "Only child" }]` causes silent failure with no warning message.

**Simplest API:** Add a `reason` field to the `splittable: false` overrides — e.g., `"LLM proposed split but only 1 child returned; need at least 2 for meaningful parallelism"`.

---

### Item 6 — Vitest test suite for core modules

**Current state:** Tests exist for `beads.ts`, `state.ts`, `checkpoint.ts`, `tools/`, `logger.ts`, `tender.ts`. Missing coverage: `plan-quality.ts`, `goal-refinement.ts`, `model-routing.ts`, `bead-splitting.ts`.

**DX impact:** No tests means regressions surface in production usage rather than in CI. For a module like `model-routing.ts` that runs on every bead, the blast radius is high.

**Simplest API:** Vitest unit tests co-located in `mcp-server/src/__tests__/`. Each test file imports only the pure functions (no `exec` dependency), keeping them fast and isolated.

**Target:** >60% line coverage across the 4 modules. Priority: `model-routing.ts` (pure functions, fully testable), `bead-splitting.ts` (pure parsers), `plan-quality.ts`, `goal-refinement.ts`.

---

### Item 7 — Deep-plan fault tolerance

**Current state:** `deep-plan.ts:runDeepPlanAgents` uses `Promise.all` — if one of the 3 agents throws, the entire `Promise.all` rejects. Looking at the implementation: the inner `try/catch` returns a `DeepPlanResult` with `exitCode: 1` and `error` field rather than re-throwing, so `Promise.all` actually does not reject on agent failure. However, the caller (`tools/plan.ts`) instructs the orchestrating agent to synthesize all 3 plans manually — if the agent receives a result with `plan: ""` and `error: "..."`, it may silently skip it or confuse it for valid content.

**DX impact:** The operator spawning deep-plan agents sees 3 tasks and may not notice one returned empty. The synthesis instruction should explicitly check for empty plans and note which agents failed.

**Simplest API:** In `runDeepPlanAgents`, add a `synthesisHint` to each result: `"(FAILED — exclude from synthesis)"` when `plan === ""`. Callers receive a clear signal rather than an empty string.

**Composes with existing patterns:** `DeepPlanResult` already has `error?: string` — the synthesis prompt template can check for it.

---

### Item 8 — SwarmTender nudge rate-limiting

**Current state:** `tender.ts` tracks `nudgesSent` and `lastNudgedAt` per agent, and gates nudges behind `maxNudges` (default 2) and `nudgeDelayMs` (default 0). The `nudgeDelayMs: 0` default means once an agent is stuck, it gets nudged on every poll cycle until `maxNudges` is reached. With default `pollInterval: 60_000`, this means 2 nudges in 60 seconds. This is fine for 1 agent but with 10 simultaneous stuck agents, the coordinator floods 20 nudges in one poll cycle.

**DX impact:** Agent-mail rate limits or coordinator confusion when many agents get stuck simultaneously (e.g., rate-limit cascade).

**Simplest API:** Add a `maxNudgesPerPollCycle: number` field (default 3) to `TenderConfig`. In the `poll()` method, track a `nudgesThisCycle` counter, skip nudges beyond the budget, and reset per cycle. Per-agent budget (`maxNudges`) stays unchanged.

**Sensible default:** 3 nudges per poll cycle is enough for normal swarms; large swarms with many simultaneous stalls won't flood the coordinator.

---

## Implementation Tasks

### T1: Fix dead code / false-positive TODO strings
**Files:** `mcp-server/src/bead-templates.ts`
**Steps:**
1. Replace `"Implement the endpoint behavior in the named module without leaving TODO stubs."` with `"Implement the endpoint behavior without leaving stub methods."` to avoid grep false-positives.
2. Audit all string literals in `bead-templates.ts` for embedded `TODO`/`FIXME` text and rephrase.
**Acceptance criteria:** `grep -n "TODO\|FIXME" mcp-server/src/bead-templates.ts` returns no matches (except inside comments meant for developers).
**Depends on:** []

---

### T2: Model-routing validation and fallback warning
**Files:** `mcp-server/src/model-routing.ts`
**Steps:**
1. Add `validateModelTier(tier: ModelTier, complexity: BeadComplexity): void` that checks `tier.implementation` and `tier.review` are non-empty strings.
2. Call `validateModelTier` at the top of `routeModel`. On failure, log a `stderr` warning and fall back to the `medium` tier from `DEFAULT_TIERS`.
3. Export `validateModelTier` so callers can pre-validate custom tier maps.
**Acceptance criteria:** Passing an empty `implementation` string to `routeModel` logs a warning and returns the `medium` tier instead of returning garbage.
**Depends on:** []

---

### T3: agent-mail transport detection helper
**Files:** `mcp-server/src/agent-mail.ts` (or a new `mcp-check.ts` script), `AGENTS.md`
**Steps:**
1. Add a `checkAgentMailTransport(url: string): Promise<"http" | "sse" | "unreachable">` utility that pings the agent-mail endpoint and returns the transport type based on the Content-Type header.
2. Document in `AGENTS.md` under the Agent Mail section: run `node mcp-server/dist/mcp-check.js` to verify transport before starting a session.
3. Add a comment in `.mcp.json` (as a README note since JSON has no comments) documenting the SSE vs http history and how to diagnose.
**Acceptance criteria:** Running the check against a live `http://127.0.0.1:8765/mcp` prints `transport: http` or `transport: sse`.
**Depends on:** []

---

### T4: scan.ts fallback summary field
**Files:** `mcp-server/src/scan.ts`
**Steps:**
1. In the double-fault branch inside `scanRepo`, after building `result`, set `result.codebaseAnalysis.summary` to `"Scan failed: ccc and builtin both unavailable. Results are empty stubs."`.
2. In `createFallbackScanResult`, set `codebaseAnalysis.summary` to `"Partial scan: fell back from ${source} to builtin provider."`.
**Acceptance criteria:** `result.codebaseAnalysis.summary` is always a non-empty string in all code paths.
**Depends on:** []

---

### T5: bead-splitting edge case hardening
**Files:** `mcp-server/src/bead-splitting.ts`
**Steps:**
1. In `parseSplitProposal`: when `splittable && children.length < 2`, set `reason` to `"LLM proposed split but returned fewer than 2 children — need at least 2 for meaningful parallelism"` before overriding `splittable: false`.
2. In `formatSplitCommands`: when `children.length === 1`, return a comment string explaining why no commands were emitted, rather than `""`.
3. In `identifyBottlenecks`: add a guard for `beads` being an empty array — return `[]` immediately with no `.filter()` overhead.
**Acceptance criteria:** Passing `children: [{ title: "only" }]` to `parseSplitProposal` sets `splittable: false` with a non-undefined `reason`. Passing `beads: []` to `identifyBottlenecks` returns `[]`.
**Depends on:** []

---

### T6: Vitest test suite — model-routing + bead-splitting
**Files:** `mcp-server/src/__tests__/model-routing.test.ts` (new), `mcp-server/src/__tests__/bead-splitting.test.ts` (new)
**Steps:**
1. Create `model-routing.test.ts` covering: `classifyBeadComplexity` (simple/medium/complex signals), `routeModel` (valid tiers, empty tier fallback after T2), `routeBeads` (empty array, single bead, mixed).
2. Create `bead-splitting.test.ts` covering: `parseSplitProposal` (valid JSON, empty children, 1-child edge case, malformed JSON), `identifyBottlenecks` (empty beads, null Bottlenecks, threshold filtering), `formatSplitProposal` (splittable/not-splittable), `formatSplitCommands` (1-child, 0-child, normal).
**Acceptance criteria:** `cd mcp-server && npm test` passes with coverage ≥60% for both modules.
**Depends on:** [T2, T5]

---

### T7: Vitest test suite — plan-quality + goal-refinement
**Files:** `mcp-server/src/__tests__/plan-quality.test.ts` (new), `mcp-server/src/__tests__/goal-refinement.test.ts` (new)
**Steps:**
1. Read `plan-quality.ts` and `goal-refinement.ts` to understand exported pure functions.
2. Write tests for the scoring/quality signal logic in `plan-quality.ts`.
3. Write tests for the refinement prompt generation and parsing in `goal-refinement.ts`.
**Acceptance criteria:** Both modules reach ≥60% coverage in Vitest run.
**Depends on:** []

---

### T8: deep-plan synthesis hint on agent failure
**Files:** `mcp-server/src/deep-plan.ts`
**Steps:**
1. In the `catch` branch of `runDeepPlanAgents`, set `plan` to `"(AGENT FAILED — exclude from synthesis: ${err})"` instead of `""`.
2. In the success branch, add a guard: if `result.stdout.trim()` is empty (e.g., agent ran but produced nothing), set `plan` to `"(AGENT RETURNED EMPTY — exclude from synthesis)"`.
3. Update `DeepPlanResult` JSDoc to document that `plan` may start with `"(AGENT"` as a sentinel for synthesis exclusion.
**Acceptance criteria:** When one of 3 plan agents fails, the returned `DeepPlanResult.plan` string contains an explicit exclusion marker rather than an empty string.
**Depends on:** []

---

### T9: SwarmTender per-cycle nudge budget
**Files:** `mcp-server/src/tender.ts`
**Steps:**
1. Add `maxNudgesPerPollCycle: number` to `TenderConfig` with default `3`.
2. In `poll()`, declare `let nudgesThisCycle = 0` at the top of the loop.
3. Before calling `nudgeStuckAgent`, check `nudgesThisCycle < this.config.maxNudgesPerPollCycle`. If at budget, skip the nudge (do not increment `nudgesSent` or `lastNudgedAt`).
4. After sending a nudge, increment `nudgesThisCycle`.
5. Update `TenderConfig` JSDoc.
**Acceptance criteria:** With 10 simultaneously stuck agents and `maxNudgesPerPollCycle: 3`, at most 3 nudges are sent per poll cycle.
**Depends on:** []

---

## Dependency Graph

```
T1: Fix dead code / false-positive TODO strings            depends_on: []
T2: Model-routing validation and fallback warning          depends_on: []
T3: agent-mail transport detection helper                  depends_on: []
T4: scan.ts fallback summary field                         depends_on: []
T5: bead-splitting edge case hardening                     depends_on: []
T6: Vitest tests — model-routing + bead-splitting          depends_on: [T2, T5]
T7: Vitest tests — plan-quality + goal-refinement          depends_on: []
T8: deep-plan synthesis hint on agent failure              depends_on: []
T9: SwarmTender per-cycle nudge budget                     depends_on: []
```

**Parallelizable groups:**
- Group A (no deps): T1, T2, T3, T4, T5, T7, T8, T9
- Group B (after Group A): T6

---

## Discoverability & Debugging Notes

### Model routing
- `routeModel` validation warnings go to `process.stderr` so they appear in the structured logger output — same channel as all other warnings. Operators see them immediately during bead dispatch.
- The `formatRoutingSummary` output is already shown at bead dispatch time, giving operators a clear view of which model tier each bead uses.

### scan.ts
- All fallback paths already write to `process.stderr` via the structured logger. The new `summary` field ensures downstream UI code never renders `undefined` as the scan summary.

### bead-splitting
- `parseSplitProposal` is a pure function. The new `reason` fields on edge-case overrides let callers surface helpful messages without reading source code.

### deep-plan
- The sentinel prefix `"(AGENT"` in `plan` is machine-readable: synthesis agents can check `plan.startsWith("(AGENT")` to skip failed planners.

### SwarmTender nudge budget
- `getSummary()` already reports active/idle/stuck counts. Adding a `nudgesThisCycle` to the log output (via `this.log.warn`) gives operators visibility into rate-limiting decisions without a new API.

### MCP transport
- The `.mcp.json` comment in `AGENTS.md` preserves institutional memory of the SSE↔http flip-flop so future operators don't repeat the experiment.

---

## Migration Notes

### Breaking changes: None
All changes are additive or internal. No tool signatures, MCP protocol shapes, or state schemas are modified.

### Operator friction
- **T2 (model-routing):** Operators with custom `tiers` in config may see new validation warnings if they accidentally pass empty model strings. The fallback to `medium` tier prevents hard failures.
- **T9 (nudge rate-limiting):** Default `maxNudgesPerPollCycle: 3` matches current behavior for swarms with ≤3 stuck agents. Large swarms now get protected automatically.
- **T8 (deep-plan):** The sentinel string in `plan` is a new convention. Existing callers that check `plan === ""` to detect failure will still work; new callers should check `plan.startsWith("(AGENT")`.

### Incremental adoption
All tasks are independent and can be merged in any order. T6 (tests) depends on T2 and T5 being done first to avoid testing buggy behavior. All other tasks can ship independently.
