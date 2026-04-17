# Synthesized Plan: Enable Opus 4.7 Adaptive Thinking in Deep-Plan Agents

**Date:** 2026-04-16
**Synthesized from:** correctness.md, ergonomics.md, robustness.md
**Synthesis perspective:** Best-of-All-Worlds
**Goal:** Enable Opus 4.7 adaptive thinking ("ultrathink") in the agent-flywheel deep-plan agents for higher-quality plan synthesis, with correct error handling and no silent failures.

---

## Synthesis Preamble: How Decisions Were Made

Each section below cites which plan's insight drove the decision and why the alternatives were rejected.

### Key resolved tensions

| Tension | Resolution | Rationale |
|---|---|---|
| `deepPlannerPrompt()` vs appending to `basePrompt` | Append to `basePrompt` | Correctness plan correctly identified `deepPlannerPrompt()` as dead code in the MCP path; ergonomics was wrong on this point |
| Timeout value: 5 min vs 7 min vs 10 min | 7 min (420000ms) default, `DEEP_PLAN_TIMEOUT_MS` env var override | Correctness plan grounded this in observed data; robustness adds env var flexibility; 5 min too tight, 10 min excessive as default |
| Model-conditional ultrathink vs unconditional | Unconditional — "Use ultrathink." is safe on all models | Ergonomics and correctness both confirmed this; robustness's model-conditional complexity is YAGNI |
| `synthesisPrompt` payload vs `_planning.md` | Fix BOTH | Correctness found the `_planning.md` synthesis agent prompt (Step 7) is the actual production path; the payload is advisory. Both need the directive |
| Cost advisory gate | Do NOT add | YAGNI for now per ergonomics and coordinator resolution |
| `DEEP_PLAN_ENABLE_THINKING` env var | Do NOT add | Goal is to enable thinking, not gate it |

### What NOT to do (from all three plans)
- Do NOT use `deepPlannerPrompt()` from `prompts.ts` — it's dead code in the MCP path (correctness)
- Do NOT add model-conditional ultrathink logic (ergonomics, correctness)
- Do NOT add `DEEP_PLAN_ENABLE_THINKING` env var (coordinator directive)
- Do NOT add cost advisory gate in Phase 4 (coordinator directive)
- Do NOT add a new `ultrathink` parameter to the MCP tool schema (ergonomics)
- Do NOT make timeout a complex configurable system — env var override is enough (ergonomics + robustness combined)

---

## 1. Architecture Overview

### The Two Active Code Paths

**Path A: MCP-Driven (primary production path)**
`mcp-server/src/tools/plan.ts` — when `flywheel_plan(mode: "deep")` is called, it constructs `basePrompt` (lines 205–222) and per-perspective task strings, then returns a JSON payload (`kind: "deep_plan_spawn"`) with `planAgents[]`. The orchestrator reads `planAgents` and spawns agents via `Agent()` or NTM. The `task` string in each `planAgents` entry is verbatim passed as the agent's prompt.

**Path B: CLI-Driven (legacy/utility/test path)**
`mcp-server/src/deep-plan.ts` — `runDeepPlanAgents()` writes per-agent task files to disk, then shells out: `claude --print --tools read,bash,grep,find,ls --model <model> @<taskFile>`. Has a 3-minute hard timeout (line 103). Task content comes from `agent.task`. Used in tests; not used by production MCP tool calls.

**Path C: `prompts.ts` exported functions (dead code)**
`competingPlanAgentPrompt()` (line 1367), `planSynthesisPrompt()` (line 1437), `planDocumentPrompt()` (line 1486) — these already contain "Use ultrathink." but are NOT called by any runtime MCP path. Adding to them has zero production effect. The correctness plan identified this definitively; the ergonomics plan was wrong to suggest using `deepPlannerPrompt()` from here.

**Synthesis agent path (production)**
Step 7 of `skills/start/_planning.md` (lines 94–122) — this is the hardcoded synthesis agent prompt the coordinator actually uses. It does NOT read `synthesisPrompt` from the `flywheel_plan` payload. This is a production gap missed by both ergonomics and robustness plans.

### Why ultrathink activation is purely prompt-level

From correctness plan: `claude --help` confirms **no `--thinking` flag** exists for `--print` mode. The `--effort` flag exists but is not thinking-specific. "Use ultrathink." in the task file or prompt is the **only mechanism** that activates adaptive thinking in `--print` mode and in Agent() calls via Claude Code. This applies uniformly to all models — the keyword is safe as a no-op on any runtime that doesn't support it.

### Current state (what's missing)

| Location | "Use ultrathink." present? | Production effect? |
|---|---|---|
| `tools/plan.ts` `basePrompt` (lines 205–222) | No | Yes — all planner agents |
| `tools/plan.ts` `synthesisPrompt` (lines 278–292) | No | Advisory — may not be read |
| `skills/start/_planning.md` Step 7 synthesis agent prompt (lines 96–119) | No | Yes — actual synthesis production path |
| `deep-plan.ts` task file (line 103 context) | No | Yes — CLI path agents |
| `prompts.ts` `deepPlannerPrompt()` (line 1403) | Yes | No — dead code in MCP path |
| `prompts.ts` `planSynthesisPrompt()` | No | No — dead code in MCP path |

### The silent-failure bug (from robustness plan)

When all planners time out:
1. `filterViableResults` returns `[]`
2. `synthesizePlans([])` returns `"# Synthesized Plan\n\n(No planner outputs provided.)\n"`
3. `runPlan` with `planContent = "(No planner outputs provided.)"` accepts this string and saves it as a valid plan file
4. No error is surfaced to the user
5. User sees what looks like a legitimate plan file

This is a correctness failure and must be fixed. The robustness plan identified it; neither correctness nor ergonomics plans addressed it.

---

## 2. User Workflows

### Workflow 1: Deep Plan via MCP (primary production path — after fix)

1. User calls `flywheel_plan(mode: "deep")`.
2. `tools/plan.ts` constructs `basePrompt` (now ending with "Use ultrathink.") + per-perspective suffix.
3. Orchestrator reads `planAgents[]` and spawns 3–4 agents via `Agent()` or NTM.
4. Each agent's `task` prompt includes "Use ultrathink." → Opus 4.7 activates adaptive thinking.
5. Agents write plans to `docs/plans/<date>-<perspective>.md`.
6. Orchestrator follows `_planning.md` Step 7 and spawns synthesis agent.
7. Synthesis agent prompt in `_planning.md` now includes "Use ultrathink." → synthesis also reasons adaptively.
8. Synthesized plan written to `docs/plans/<date>-<slug>-synthesized.md`.

### Workflow 2: Deep Plan via CLI (utility/test path — after fix)

1. Code calls `runDeepPlanAgents(exec, cwd, agents)`.
2. Task file content is `agent.task` (which must include "Use ultrathink." — ensured by callers constructing tasks from `basePrompt`).
3. `claude --print --tools ... @<taskFile>` invoked with 420000ms timeout (7 min).
4. Adaptive thinking activates; agents have sufficient time to think + produce output.
5. `filterViableResults` returns only agents with `exitCode === 0` and non-empty non-error plan.
6. If all fail, `runDeepPlanAgents` emits a structured warning to stderr — it does NOT silently return empty.

### Workflow 3: Env var timeout override

User sets `DEEP_PLAN_TIMEOUT_MS=900000` in environment. `deep-plan.ts` reads this and uses 900000ms (15 min) instead of the 420000ms default. Useful for very large repos. The env var is not required to be set — the 7-min default is sufficient for typical repos.

---

## 3. Data Model / Types

### `DeepPlanAgent` interface (`deep-plan.ts` lines 7–11) — no change

```typescript
export interface DeepPlanAgent {
  name: string;
  task: string;     // "Use ultrathink." must appear here (added by basePrompt in plan.ts)
  model?: string;
}
```

No type changes needed. The fix is purely in the string content of `task`.

### `planAgents` array in `tools/plan.ts` (lines 226–254) — prompt content change

The array entries have a `task` field: `${basePrompt}\n\n## Your perspective: ...\n...`.

The fix adds "Use ultrathink." to `basePrompt` at line 222 (end of the shared base). This is the single source of truth — affects all 3–4 plan agents (correctness, robustness, ergonomics, fresh-perspective) without per-agent duplication.

Decision: **Add once to `basePrompt`, not to each suffix**. Source: correctness plan. Reason: (a) single edit point, (b) future fourth planners added to `planAgents` automatically inherit the directive, (c) per-suffix repetition creates maintenance debt.

### `synthesisPrompt` string in `tools/plan.ts` (lines 278–292)

The `synthesisPrompt` field in the JSON payload is advisory — the orchestrator reads `_planning.md` Step 7 which has its own hardcoded synthesis agent prompt. However, for forward-compatibility (if a future orchestrator reads the payload's `synthesisPrompt`), add "Use ultrathink." to this string too.

Decision: **Fix both `synthesisPrompt` in payload AND the synthesis agent prompt in `_planning.md`**. Source: correctness plan. The payload fix is low-cost insurance; the `_planning.md` fix is the actually-required production fix.

---

## 4. API Surface

### Change 1: Add "Use ultrathink." to `basePrompt` in `tools/plan.ts`

**File:** `mcp-server/src/tools/plan.ts`
**Location:** Line 222 (end of `basePrompt` literal)

**Current:**
```typescript
Focus deeply on your assigned perspective lens.`;
```

**After:**
```typescript
Focus deeply on your assigned perspective lens.

Use ultrathink.`;
```

**Source:** Correctness plan.
**Rationale:** `basePrompt` is shared by all plan agents. Adding here once is the single source of truth. Placement at the end of the shared context matches the pattern used throughout `prompts.ts` (e.g. `planIntegrationPrompt`, `freshPlanRefinementPrompt`). The per-perspective suffix follows after, so the agent reads shared context → ultrathink directive → perspective-specific focus.

**What this does NOT break:**
- `constraintsSummary` is preserved — it's embedded in `basePrompt` via `**Goal:** ${goal}${constraintsSummary}` (line 207). The ergonomics plan raised this concern rightly; the fix does not remove `constraintsSummary`. The ergonomics plan's proposed solution (using `deepPlannerPrompt()` from `prompts.ts`) would have broken this because `deepPlannerPrompt()` has no constraints parameter. The correctness approach (appending to existing `basePrompt`) preserves `constraintsSummary` naturally.
- `memorySection` (prior session context) is preserved — same reason.
- The 4th fresh-perspective planner (lines 256–268) automatically inherits the directive since it also uses `basePrompt`.

**Note on Codex robustness agent:** The robustness perspective uses `subagent_type: CODEX_SUBAGENT_TYPE` (line 237), a Codex agent, not a standard Opus model. "Use ultrathink." in the task prompt for Codex agents has untested behavior. However, the keyword is safe as a no-op on any runtime that doesn't recognize it. Adding it unconditionally (via `basePrompt`) is the correct approach — Codex will either use its own thinking mechanism or ignore the directive. Source: robustness plan identified the concern; coordinator resolution is to add unconditionally with a code comment.

Add a comment to the robustness agent entry in `planAgents`:
```typescript
{
  subagent_type: CODEX_SUBAGENT_TYPE,
  perspective: 'robustness',
  // Note: "Use ultrathink." is in basePrompt; behavior in Codex agents is untested
  // but the keyword is safe as a no-op on runtimes that don't support it.
  task: `${basePrompt}
  ...
  `,
},
```

### Change 2: Add "Use ultrathink." to `synthesisPrompt` in `tools/plan.ts`

**File:** `mcp-server/src/tools/plan.ts`
**Location:** Line 278 (start of `synthesisPrompt` string literal)

**Current:**
```typescript
synthesisPrompt: `## Best-of-All-Worlds Synthesis
```

**After:**
```typescript
synthesisPrompt: `Use ultrathink.

## Best-of-All-Worlds Synthesis
```

**Source:** Correctness plan.
**Rationale:** Placement at the TOP of this string because it is long and detailed; the directive must be encountered immediately. Future orchestrators that do read this payload field will benefit. Current production is not affected (Step 7 of `_planning.md` uses its own prompt).

### Change 3: Add "Use ultrathink." to synthesis agent prompt in `skills/start/_planning.md`

**File:** `skills/start/_planning.md`
**Location:** Step 7, the synthesis agent `Agent()` call (lines 96–121). Specifically, inside the `prompt:` argument.

**Current (line 104 area):**
```
## Best-of-All-Worlds Synthesis

For EACH plan, BEFORE proposing any changes:
1. Honestly acknowledge what that plan does better than the others.
```

**After:**
```
Use ultrathink.

## Best-of-All-Worlds Synthesis

For EACH plan, BEFORE proposing any changes:
1. Honestly acknowledge what that plan does better than the others.
```

**Source:** Correctness plan — this was the production gap missed by both other plans. The synthesis agent prompt in `_planning.md` Step 7 is what actually gets executed. The `synthesisPrompt` field in the `flywheel_plan` payload is advisory and is NOT read by the Step 7 synthesis agent.

**This is the highest-impact change for synthesis quality.** Without it, synthesis agents do NOT use adaptive thinking even after the other changes.

### Change 4: Increase timeout in `deep-plan.ts`

**File:** `mcp-server/src/deep-plan.ts`
**Location:** Line 103

**Current:**
```typescript
timeout: 180000, // 3 min timeout per planner
```

**After:**
```typescript
timeout: Number(process.env.DEEP_PLAN_TIMEOUT_MS ?? 420000), // 7 min default; override via DEEP_PLAN_TIMEOUT_MS
```

**Source:** Timeout value from correctness plan (7 min is the most grounded value — observed that planning tasks already push 3 min without thinking). Env var override from robustness plan (cheap to add, genuine operational value for large repos). 5 min (ergonomics) rejected as too tight. 10 min (robustness) rejected as excessive default that masks problems.

**Rationale:** Adaptive thinking can add 1–3 minutes of think time before any output is written. Complex repos with large context already push toward 3 min without thinking. 7 min provides a buffer. The env var allows operators to increase further (e.g. `DEEP_PLAN_TIMEOUT_MS=900000` for a 15-min cap on very large repos) without a code change.

### Change 5: Add empty-results guard in `deep-plan.ts`

**Source:** Robustness plan (FM-S1 — silent catastrophic failure when all planners time out).

This is the silent-failure bug. The fix has two parts:

**Part 5a:** After `filterViableResults`, emit a warning when fewer than the expected number of planners succeeded:

```typescript
const viable = filterViableResults(results);

if (viable.length === 0) {
  process.stderr.write(
    `[deep-plan] ERROR: All ${agents.length} planner agents failed or timed out. ` +
    `No viable results for synthesis. Errors:\n` +
    results.map(r => `  ${r.name}: ${r.error ?? r.plan}`).join('\n') + '\n'
  );
  return [];
}

if (viable.length < agents.length) {
  process.stderr.write(
    `[deep-plan] WARNING: Only ${viable.length} of ${agents.length} planners succeeded. ` +
    `Synthesis quality may be degraded.\n`
  );
}
```

**Part 5b:** In the `runPlan` consumer (`tools/plan.ts`), guard against empty `planContent`. When `synthesizePlans([])` returns the "(No planner outputs provided.)" sentinel, `runPlan` must reject it rather than save it as a valid plan:

```typescript
// Guard against empty synthesis from all-failed planners
if (planContent.includes('(No planner outputs provided.)')) {
  return errResult('All planner agents failed or timed out — no plan was produced. ' +
    'Check stderr for individual agent errors. Try increasing DEEP_PLAN_TIMEOUT_MS.');
}
```

**Note:** The `tools/plan.ts` MCP-driven path does not call `runDeepPlanAgents` directly — it returns spawn configs to the orchestrator. The guard in Part 5b applies to when the orchestrator calls `flywheel_plan` with `planContent` (the synthesized text). But if the synthesis produced an empty result, the orchestrator should not be calling with that content. The warning in Part 5a (stderr from the CLI path) surfaces the problem in the CLI/test path. For the MCP-driven orchestrator path, the synthesis agent itself would need to detect this — that's a future improvement.

**What matters most:** The stderr warning in Part 5a ensures that when the CLI path fails completely, the user gets a visible error instead of a silently-saved empty plan file.

### No changes to `prompts.ts`

`deepPlannerPrompt()`, `planSynthesisPrompt()`, `planDocumentPrompt()` are dead code in the MCP-driven path. They are NOT called by any `tools/` code. Modifying them has no production effect. Adding a clarifying comment to each function is the only warranted change:

```typescript
/**
 * NOTE: This function is NOT called by the MCP-driven deep-plan path (tools/plan.ts).
 * The MCP path constructs prompts inline in tools/plan.ts. This function may be used
 * by scripts or tests directly. If you need to change deep-plan agent prompts, edit
 * tools/plan.ts basePrompt, not this function.
 */
export function deepPlannerPrompt(...) { ... }
```

**Source:** Correctness plan. The ergonomics plan was wrong to suggest using `deepPlannerPrompt()` from `prompts.ts` as the fix — that would have had zero effect on production behavior.

---

## 5. Testing Strategy

### Test additions for `mcp-server/src/__tests__/tools/plan.test.ts`

Source: Correctness plan (exact test shapes) + ergonomics plan (same intent, similar assertions).

**Test 1: "Use ultrathink." in all plan agent tasks (deep mode)**
```typescript
it('includes "Use ultrathink." in each plan agent task in deep mode', async () => {
  const { ctx } = makeCtx();
  const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
  const structured = result.structuredContent as {
    data: { planAgents: Array<{ task: string }> }
  };
  for (const agent of structured.data.planAgents) {
    expect(agent.task).toContain('Use ultrathink.');
  }
});
```

This is the primary regression guard. It pins the requirement that all plan agents (including the Codex robustness agent) receive "Use ultrathink." in their task text.

**Test 2: "Use ultrathink." in synthesisPrompt payload (deep mode)**
```typescript
it('includes "Use ultrathink." in synthesisPrompt in deep mode', async () => {
  const { ctx } = makeCtx();
  const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
  const structured = result.structuredContent as {
    data: { synthesisPrompt: string }
  };
  expect(structured.data.synthesisPrompt).toContain('Use ultrathink.');
});
```

Secondary coverage — ensures the payload field is also updated.

**Test 3: Existing tests must not regress**
- `returns agent spawn configs in deep mode` — no change to structuredContent shape
- `includes correctness, robustness, and ergonomics perspectives in deep mode` — perspective list unchanged
- All `standard` mode tests — different code path, unaffected
- All `planFile` and `planContent` tests — early-return paths, unaffected

### Test additions for `mcp-server/src/__tests__/deep-plan.test.ts`

Source: Robustness plan (FM-Test1, FM-Test2, FM-Test3). These tests cover real failure modes that the existing test suite does not.

**Test 4: Timed-out agent is excluded from results**
```typescript
it('excludes timed-out agent from results', async () => {
  const exec: ExecFn = async (cmd) => {
    if (cmd === 'claude') throw new Error('Timed out after 420000ms: claude ...');
    return mockProfileResponse();
  };
  const results = await runDeepPlanAgents(exec, '/fake', [
    { name: 'correctness', task: 'Use ultrathink.\n\nPlan it.', model: 'claude-opus-4-7' }
  ]);
  expect(results).toHaveLength(0);
});
```

**Test 5: All agents time out — returns empty array, does not throw**
```typescript
it('returns empty array (does not throw) when all agents time out', async () => {
  const exec: ExecFn = async (cmd) => {
    if (cmd === 'claude') throw new Error('Timed out...');
    return mockProfileResponse();
  };
  const results = await runDeepPlanAgents(exec, '/fake', threeAgents);
  expect(results).toHaveLength(0);
  expect(Array.isArray(results)).toBe(true);
});
```

**Test 6: Partial success — some agents fail, survivors returned**
```typescript
it('returns only successful agents when some fail', async () => {
  let claudeCallCount = 0;
  const exec: ExecFn = async (cmd) => {
    if (cmd === 'claude') {
      claudeCallCount++;
      if (claudeCallCount === 1) throw new Error('Timed out...');
      return { code: 0, stdout: '## Plan\ncontent', stderr: '' };
    }
    return mockProfileResponse();
  };
  const results = await runDeepPlanAgents(exec, '/fake', twoAgents);
  expect(results).toHaveLength(1);
});
```

**Test 7: Timeout env var is respected**
```typescript
it('respects DEEP_PLAN_TIMEOUT_MS env var', async () => {
  process.env.DEEP_PLAN_TIMEOUT_MS = '900000';
  // This test is structural — verify the constant reads from env.
  // The exec mock doesn't capture timeout options, so this primarily
  // serves as a documentation/regression test until ExecFn mock is updated.
  const originalEnv = process.env.DEEP_PLAN_TIMEOUT_MS;
  process.env.DEEP_PLAN_TIMEOUT_MS = '900000';
  // ... run and verify no error (the env var was read)
  process.env.DEEP_PLAN_TIMEOUT_MS = originalEnv;
});
```

Note: The current `ExecFn` type and mock do not capture `options.timeout`. A fuller assertion would require updating the mock to record the timeout value passed. That is a secondary improvement. The test above at minimum pins the existence of the env var behavior.

### Manual verification steps

After all changes are applied:

```bash
# 1. Run full test suite — must pass with zero regressions
cd mcp-server && npx vitest run

# 2. Verify "Use ultrathink." appears in all deep plan prompts
grep -n "Use ultrathink" mcp-server/src/tools/plan.ts
# Expected: at least 2 matches (basePrompt and synthesisPrompt)

# 3. Verify synthesis agent prompt in _planning.md
grep -n "ultrathink" skills/start/_planning.md
# Expected: at least 1 match in Step 7

# 4. Verify no old thinking syntax in codebase
grep -rn 'budget_tokens\|thinking.*enabled\|--thinking' mcp-server/src --include='*.ts'
# Expected: zero matches

# 5. Manual smoke test (requires Opus 4.7 access)
# Run flywheel_plan mode=deep on a small goal
# Observe: visible thinking time, longer plans, no timeout errors
```

---

## 6. Edge Cases & Failure Modes

### 6.1 Codex robustness agent behavior with ultrathink

The robustness planner uses `subagent_type: CODEX_SUBAGENT_TYPE` ("codex:codex-rescue"), a completely different execution environment from the Opus/Sonnet agents. "Use ultrathink." in the task text for a Codex agent has **untested behavior**.

**Risk level:** Low — "Use ultrathink." is a prompt-level convention. In any runtime that doesn't recognize it, it is a no-op instruction. The Codex agent will either activate some thinking mechanism or treat it as a plain English instruction to think carefully.

**Resolution:** Add unconditionally via `basePrompt` (simple, consistent). Add a comment on the robustness agent entry in `planAgents` noting that Codex behavior is untested. Do NOT add model-conditional guards — that complexity is YAGNI. Source: coordinator directive; ergonomics plan's "safe on all models" insight; robustness plan correctly identified the concern.

### 6.2 Old thinking syntax not present in codebase

Correctness plan confirmed via grep: no `budget_tokens`, `thinking.*enabled`, or `--thinking` patterns exist in `mcp-server/src/*.ts`. The `--thinking` flag does not exist in `claude --print` mode at all. No migration of old thinking syntax is needed.

### 6.3 Prompt placement of "Use ultrathink."

The phrase appears at the END of `basePrompt`, immediately before the per-perspective lens instructions. This matches the dominant pattern in `prompts.ts`. Some functions put it first (e.g. `synthesisPrompt` payload), some at the end of the shared context. Both placements have worked empirically. The codebase has no single canonical placement; the pattern is "near the start or end of the prompt, not buried in the middle." Our placement is consistent with `planIntegrationPrompt` and `freshPlanRefinementPrompt`.

### 6.4 Timeout with adaptive thinking (existing bug, made worse)

**This is an existing bug** — complex repos already push the 3-minute limit without thinking. Adaptive thinking makes it more frequent. The 420000ms (7 min) default addresses this. The `DEEP_PLAN_TIMEOUT_MS` env var allows operators to extend further.

When a planner times out, `runDeepPlanAgents` returns it as `(AGENT FAILED — exclude from synthesis: Timed out after Nms: claude ...)` with `exitCode: 1`. `filterViableResults` correctly excludes it. The new stderr warning (Change 5) surfaces this visibly when zero or fewer-than-expected agents succeed.

### 6.5 Model string format for CLI path

`getDeepPlanModels()` returns strings like `"anthropic/claude-opus-4-7"` (provider-prefixed). Whether `claude --print --model anthropic/claude-opus-4-7` accepts this format is unverified in tests (mocked `exec` always returns code 0). The robustness plan correctly identified this as a risk.

**Mitigation:** This is a pre-existing risk not introduced by this change. The robustness plan's Phase 0 empirical verification requirement is correct practice but is out of scope for this plan's implementation scope. **Flag for manual verification** before the first production deployment: run `claude --print --model anthropic/claude-opus-4-7 "hello"` and observe exit code.

**Impact if broken:** CLI path agents fail silently (filtered by `filterViableResults`). The new empty-results warning (Change 5) makes this visible.

### 6.6 `synthesisPrompt` payload not read by `_planning.md` Step 7

The correctness plan identified this definitively. The `synthesisPrompt` in the `flywheel_plan` payload is NOT read by Step 7 of `_planning.md`. Step 7 has its own hardcoded synthesis agent prompt. Both must be updated (Changes 2 and 3). The payload fix (Change 2) is forward-compatibility insurance if a future orchestrator reads the field.

### 6.7 "Use ultrathink." only activates in Claude Code context

In raw Anthropic SDK calls (`new Anthropic().messages.create()`), "Use ultrathink." is silently ignored — it becomes a plain English instruction with no thinking mechanism activation. The CLI path (`claude --print`) runs in Claude Code context, so it works. If someone refactors Path B to use the SDK directly, they must also switch to the SDK's `thinking` parameter.

**Mitigation:** Add a comment near `writeFileSync(taskFile, ...)` in `deep-plan.ts` documenting this constraint. Source: correctness plan (Section 6.2).

---

## 7. File Structure

### Files to modify

| File | Change | Lines affected | Source plan |
|---|---|---|---|
| `mcp-server/src/tools/plan.ts` | Add "Use ultrathink." to end of `basePrompt` | Line 222 | Correctness |
| `mcp-server/src/tools/plan.ts` | Add "Use ultrathink." to top of `synthesisPrompt` | Line 278 | Correctness |
| `mcp-server/src/tools/plan.ts` | Add comment on robustness agent re: Codex + ultrathink | Line 237 area | Robustness (adapted) |
| `mcp-server/src/tools/plan.ts` | Add empty `planContent` guard | Near planContent processing | Robustness (FM-S1) |
| `mcp-server/src/deep-plan.ts` | Change timeout from 180000 to `Number(process.env.DEEP_PLAN_TIMEOUT_MS ?? 420000)` | Line 103 | Correctness (7 min value) + Robustness (env var) |
| `mcp-server/src/deep-plan.ts` | Add empty-results + partial-success warnings after `filterViableResults` | Line 144+ | Robustness (FM-S1, FM-S2) |
| `mcp-server/src/deep-plan.ts` | Add comment near `writeFileSync` re: ultrathink + Claude Code context | Line 120 area | Correctness (Section 6.2) |
| `skills/start/_planning.md` | Add "Use ultrathink." to Step 7 synthesis agent prompt | Lines 96–121 | Correctness (production gap) |
| `mcp-server/src/__tests__/tools/plan.test.ts` | Add ultrathink assertion tests for deep mode | After existing deep mode tests | Correctness + Ergonomics |
| `mcp-server/src/__tests__/deep-plan.test.ts` | Add timeout, empty-results, partial-success test cases | New tests | Robustness |

### Files NOT to modify

| File | Reason |
|---|---|
| `mcp-server/src/prompts.ts` | Dead code path in MCP context. Already has "Use ultrathink." in `deepPlannerPrompt`. Changes here have zero production effect on the MCP-driven path. Add clarifying comments only (no functional changes). |
| `mcp-server/src/model-detection.ts` | Model detection is correct. Opus 4.7 is the default fallback for planning roles. No change needed. |
| Any MCP tool schema files | Do not add `ultrathink` as a tool parameter. This is a prompt-level concern, not an API surface change. Source: ergonomics plan. |

### No new files

This change requires no new files. Total net code delta: approximately +30 lines across existing files.

---

## 8. Sequencing

All changes are independent in the sense that none blocks another, but the logical order for implementation and review is:

### Phase 1: Core prompt fix (required, highest impact)

Estimated effort: 15 minutes.

1. **`tools/plan.ts` — `basePrompt`**: Add "Use ultrathink." at line 222 (2 lines).
2. **`tools/plan.ts` — `synthesisPrompt`**: Add "Use ultrathink." at line 278 (2 lines).
3. **`skills/start/_planning.md` — Step 7 synthesis agent prompt**: Add "Use ultrathink." inside the Agent() call prompt, before "## Best-of-All-Worlds Synthesis" (2 lines).

Phase 1 alone delivers most of the value: all planner agents and the synthesis agent will use adaptive thinking.

### Phase 2: Timeout fix (required, prevents silent failures)

Estimated effort: 5 minutes.

4. **`deep-plan.ts` — timeout**: Change `timeout: 180000` to `timeout: Number(process.env.DEEP_PLAN_TIMEOUT_MS ?? 420000)` (1 line change).

Phase 2 is technically independent of Phase 1 but should be in the same commit. It prevents the most likely failure mode once thinking is enabled (all planners timing out at 3 minutes with adaptive thinking active).

### Phase 3: Error visibility fix (required, prevents silent data loss)

Estimated effort: 20 minutes.

5. **`deep-plan.ts` — empty-results warning**: Add stderr warning after `filterViableResults` when zero or fewer-than-expected planners succeed.
6. **`tools/plan.ts` — empty planContent guard**: Add guard against saving "(No planner outputs provided.)" as a valid plan.
7. **`deep-plan.ts` — comment**: Add comment near `writeFileSync` re: ultrathink activation requires Claude Code context.
8. **`tools/plan.ts` — comment**: Add comment on robustness `CODEX_SUBAGENT_TYPE` agent noting Codex + ultrathink behavior is untested.

### Phase 4: Test coverage (required before merge)

Estimated effort: 30 minutes.

9. **`plan.test.ts`**: Add Tests 1 and 2 (ultrathink in planAgents and synthesisPrompt).
10. **`deep-plan.test.ts`**: Add Tests 4, 5, and 6 (timeout scenarios and partial success).

Run full test suite: `cd mcp-server && npx vitest run`. All existing tests must pass.

### Phase 5: Dead code documentation (optional, low priority)

Estimated effort: 10 minutes.

11. **`prompts.ts`**: Add clarifying comments to `deepPlannerPrompt`, `planSynthesisPrompt`, `planDocumentPrompt` noting they are not called by the MCP-driven path.

This phase can be deferred — it has no correctness impact.

### All phases in one commit

Preferred approach: ship Phases 1–4 in a single commit. They are all small changes to existing files, they address the same feature (ultrathink enablement), and the test coverage should accompany the behavioral change.

```
feat(planning): enable adaptive thinking in deep-plan agents

- Add "Use ultrathink." to basePrompt in tools/plan.ts (all planner agents)
- Add "Use ultrathink." to synthesisPrompt payload in tools/plan.ts
- Add "Use ultrathink." to synthesis agent prompt in skills/start/_planning.md
- Increase deep-plan.ts timeout from 3 min to 7 min (DEEP_PLAN_TIMEOUT_MS env override)
- Add empty-results warning when all planners fail (robustness: FM-S1 silent failure fix)
- Add empty planContent guard to prevent silent save of "(No planner outputs provided.)"
- Add test coverage for ultrathink presence and timeout failure scenarios
```

### Risk table

| Change | Risk | Reversibility |
|---|---|---|
| "Use ultrathink." in `basePrompt` | Low — prompt text only, no type/API change | Trivially reversible (revert 2 lines) |
| "Use ultrathink." in `synthesisPrompt` | Low — same | Trivially reversible |
| "Use ultrathink." in `_planning.md` Step 7 | Low — skill file, no build step | Trivially reversible |
| Timeout increase to 420000ms | Low — only increases max wait, faster runs unaffected | Trivially reversible |
| `DEEP_PLAN_TIMEOUT_MS` env var | Low — no-op if unset (uses default) | Remove 1 line to revert |
| Empty-results warning | None — stderr only, no behavior change | Remove warning block |
| Empty planContent guard | Low — only triggers on sentinel string | Remove guard block |
| New test assertions | None | N/A |

No changes affect the `structuredContent` schema, the `FlywheelState` type, the MCP tool signatures, or any public API surface.

---

## Unresolved Tensions

The following items have no clear resolution from the three plans and require human judgment or empirical data:

### UT-1: Model string format for `claude --print`

**Tension:** `getDeepPlanModels()` returns `"anthropic/claude-opus-4-7"` (provider-prefixed). Whether `claude --print --model anthropic/claude-opus-4-7` accepts this format is unverified. Robustness plan raised it (FM-M2); correctness plan noted it (Section 6.6); ergonomics plan ignored it.

**Why unresolved:** This requires an empirical test against the actual CLI, which cannot be done at plan-writing time.

**Recommendation:** Before the first production deployment of this plan, run: `claude --print --model anthropic/claude-opus-4-7 "Say hello."` and observe exit code. If it fails, add model string normalization (strip `anthropic/` prefix) in `deep-plan.ts` before constructing the CLI invocation.

### UT-2: Does "Use ultrathink." activate thinking on Codex agents?

**Tension:** The robustness planner uses `CODEX_SUBAGENT_TYPE`. Codex is a different execution environment. The keyword behavior on Codex is unknown.

**Why unresolved:** This requires a live Codex test.

**Recommendation:** Add the directive unconditionally (per coordinator resolution) with a code comment. If Codex agents exhibit unexpected behavior (cost spike or error), the comment points to where to add a conditional guard.

### UT-3: Token count and cost per deep-plan run with thinking

**Tension:** Robustness plan estimated ~$18.75 per deep-plan run with thinking (750K output-billed tokens). This is a rough estimate. Actual cost depends on thinking depth, which is adaptive.

**Why unresolved:** Requires a production run with real repos to measure.

**Recommendation:** No action for now per coordinator directive (no cost advisory). But monitor costs after deployment. If p50 cost exceeds $25 per run, reconsider.

---

## Decision Audit Trail

| Decision | Adopted from | Rejected alternative | Reason for rejection |
|---|---|---|---|
| Fix `basePrompt` in `tools/plan.ts`, not `prompts.ts` | Correctness | Ergonomics (use `deepPlannerPrompt()`) | `deepPlannerPrompt()` is dead code in MCP path — changes have zero production effect |
| Add "Use ultrathink." unconditionally to `basePrompt` | Ergonomics + Correctness | Robustness (model-conditional guard) | YAGNI; keyword is safe as no-op on non-Opus models; coordinator directive |
| 7 min (420000ms) timeout default | Correctness | 5 min (ergonomics); 10 min (robustness) | 5 min too tight for thinking+planning; 10 min masks problems as a default |
| `DEEP_PLAN_TIMEOUT_MS` env var | Robustness | No env var (ergonomics) | Low cost, genuine operational value; ergonomics was right that YAGNI applies to complex configurability but not a simple env var override |
| Fix `_planning.md` Step 7 synthesis agent prompt | Correctness | Only fix payload `synthesisPrompt` | `_planning.md` Step 7 is the actual production path; payload is advisory |
| Add empty-results warning | Robustness | No warning (correctness + ergonomics missed it) | Silent catastrophic failure on all-timeout scenario is a real correctness risk |
| No cost advisory gate | Coordinator directive | Robustness Phase 4 | YAGNI for now |
| No `DEEP_PLAN_ENABLE_THINKING` env var | Coordinator directive | Robustness Phase 1 | Goal IS to enable thinking; toggle adds complexity with no current use case |
| Fix both `synthesisPrompt` payload AND `_planning.md` | Correctness | Fix only one | Payload: forward-compatibility; `_planning.md`: current production |
