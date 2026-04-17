# Correctness Plan: Enable Opus 4.7 Adaptive Thinking in Deep-Plan Agents

**Date:** 2026-04-16  
**Perspective:** Correctness  
**Goal:** Enable Opus 4.7 adaptive thinking in the agent-flywheel's deep-plan agents (correctness, ergonomics, robustness, synthesis planners) for higher-quality plan synthesis.

---

## 1. Architecture Overview

### The Two Deep-Plan Code Paths (Critical Distinction)

The flywheel has two completely separate execution paths for deep planning, and they must be treated as independent targets:

#### Path A: MCP-Driven Path (`mcp-server/src/tools/plan.ts`)

This is the **primary production path**. When `flywheel_plan(mode: "deep")` is called, it does **not** invoke `runDeepPlanAgents` or any CLI directly. Instead, it returns a JSON payload (`kind: "deep_plan_spawn"`) to the orchestrating agent (the human-facing Claude Code session), which is expected to read `planAgents` and spawn agents via `Agent()` tool calls or NTM.

Key finding: `runDeepPlanAgents` in `deep-plan.ts` is **never called by the MCP tools at runtime**. The function exists as an exported utility that tests and scripts can use, but the MCP tools/plan.ts workflow bypasses it entirely. The `planAgents` array in the returned payload contains `task` strings (the prompts) that the orchestrator passes to Agent() — these task strings are where "Use ultrathink." must appear.

**Current state of `basePrompt` (plan.ts lines 205–222):**
```
You are a planning agent for an agentic coding workflow.
...
Focus deeply on your assigned perspective lens.
```
No "ultrathink". No "Use ultrathink." anywhere in `basePrompt` or in the per-perspective appended text (lines 230–254).

**Current state of `synthesisPrompt` (plan.ts lines 278–292):**
```
## Best-of-All-Worlds Synthesis
Read all N competing plans. For EACH plan, BEFORE proposing any changes: ...
```
No "ultrathink." in this text either.

#### Path B: CLI-Driven Path (`mcp-server/src/deep-plan.ts`)

This is a **legacy/utility path**. `runDeepPlanAgents` builds task files and calls:
```bash
claude --print --tools read,bash,grep,find,ls --model <model> @<taskFile>
```
No thinking flags. 3-minute timeout. Task content comes from `agent.task` (which is `basePrompt + perspective suffix` from the caller if called). In tests, this path is exercised directly.

**Critical finding:** `claude --help` output confirms there is **no `--thinking` flag** for `--print` mode. The claude CLI does not expose a dedicated thinking control flag. The `--effort` flag exists (`low`, `medium`, `high`, `xhigh`, `max`) but this is not thinking-specific.

**Therefore:** The only mechanism to activate adaptive thinking in `--print` mode is the **"Use ultrathink." text in the task file or prompt**. This applies to both Path A (Agent() calls) and Path B (task file `@<path>`).

#### Path C: `competingPlanAgentPrompt` (prompts.ts line 1367)

This function is exported but **never called by any runtime code** — only referenced in `dist/prompts.d.ts` (the compiled declaration). It already contains "Use ultrathink." at line 1403. This is a dead code path in the current MCP server flow.

Similarly, `planSynthesisPrompt` (prompts.ts line 1437) and `planDocumentPrompt` (prompts.ts line 1486) are exported but **not imported or called** by any `tools/` or server code. They contain "Use ultrathink." already but have no effect in production.

### Component Relationship

```
User triggers deep plan
        │
        ▼
flywheel_plan(mode: "deep")   [mcp-server/src/tools/plan.ts]
        │ returns planAgents[] with `task` strings (NO ultrathink)
        ▼
Orchestrator reads planAgents[]
        │
        ├─► Agent(model: "opus", prompt: agent.task)  ← needs "Use ultrathink."
        ├─► Agent(model: "sonnet", prompt: agent.task)
        └─► Agent(subagent_type: "codex:...", prompt: agent.task)
```

The fix must add "Use ultrathink." to the `task` field of each `planAgents` entry returned by `tools/plan.ts`, not to the unused `prompts.ts` functions.

---

## 2. User Workflows

### Workflow 1: Deep Plan via MCP (Production Path)

1. User calls `/start` or `flywheel_plan(mode: "deep")`.
2. `tools/plan.ts` constructs `basePrompt` + per-perspective suffix → stored as `agent.task`.
3. Orchestrator spawns agents using `agent.task` as their prompt.
4. **After fix:** Each agent receives "Use ultrathink." in their prompt → Opus 4.7 activates adaptive thinking.
5. Agents write plans to `docs/plans/<date>-<perspective>.md`.
6. Synthesis agent reads all plans and synthesizes.
7. `synthesisPrompt` from `tools/plan.ts` is used as the synthesis agent's prompt.
8. **After fix:** "Use ultrathink." in `synthesisPrompt` → synthesis agent thinks adaptively too.

### Workflow 2: Deep Plan via CLI (Utility/Test Path)

1. Code calls `runDeepPlanAgents(exec, cwd, agents)`.
2. `agents[i].task` is written to a temp `.md` file.
3. `claude --print --tools ... @<taskFile>` is invoked.
4. **After fix:** Task file content includes "Use ultrathink." → CLI `--print` mode activates adaptive thinking.
5. The 3-minute timeout may be insufficient with adaptive thinking (see Section 6).

### Workflow 3: Standard Plan (Unchanged)

Standard plan mode calls `planDocumentPrompt` (prompts.ts line 1486) which already has "Use ultrathink." This path is not broken and does not need changes.

---

## 3. Data Model / Types

### `DeepPlanAgent` interface (`deep-plan.ts` lines 7–11)

```typescript
export interface DeepPlanAgent {
  name: string;
  task: string;     // ← "Use ultrathink." must appear here
  model?: string;
}
```

No type change needed. The `task` string is written verbatim to the task file in Path B, and passed as the prompt in Path A's `planAgents` array.

### `planAgents` array in `tools/plan.ts` (lines 226–254)

The array entries have a `task` field that combines `basePrompt` + perspective-specific suffix. The fix adds "Use ultrathink." to `basePrompt` (affects all agents) or to each suffix individually.

**Recommendation:** Add once to `basePrompt` at the end (line 222), after "Focus deeply on your assigned perspective lens." This is the single source of truth and ensures all perspectives (including the optional fresh-perspective planner added later) get adaptive thinking without per-agent duplication.

### `synthesisPrompt` string in `tools/plan.ts` (lines 278–292)

Currently a string literal starting with `## Best-of-All-Worlds Synthesis`. Adding "Use ultrathink." to the top of this string ensures the synthesis agent also reasons adaptively.

---

## 4. API Surface

### Changes to `mcp-server/src/tools/plan.ts`

#### Change 1: Add "Use ultrathink." to `basePrompt`

**Location:** Line 222 (end of `basePrompt` definition)

**Current:**
```typescript
Focus deeply on your assigned perspective lens.`;
```

**After:**
```typescript
Focus deeply on your assigned perspective lens.

Use ultrathink.`;
```

**Why this location:** `basePrompt` is shared by all 3–4 plan agents (correctness, robustness, ergonomics, and optional fresh-perspective). Adding here guarantees coverage for all agents, including any future fourth planner, without needing per-agent copies.

**Why not in the per-perspective suffixes:** The perspective-specific blocks are appended after `basePrompt` via template literals. If "Use ultrathink." appears only in `basePrompt`, it will be at the end of the shared context but before the per-perspective lens instructions. This is the correct placement — the agent reads the full task file top-to-bottom, sees "Use ultrathink." after the plan requirements, then continues to the per-perspective focus. This matches the convention used throughout `prompts.ts` where "Use ultrathink." appears at the END of prompts, near instructions.

**Alternative considered:** Adding "Use ultrathink." to each perspective suffix. Rejected because: (a) it's 3–4 repeated copies, (b) any future fourth planner added to `planAgents` without including the suffix would silently miss thinking, (c) the base prompt already establishes the full context.

#### Change 2: Add "Use ultrathink." to `synthesisPrompt`

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

**Why at the top:** The synthesis prompt is long and detailed. Placing "Use ultrathink." first ensures it is encountered immediately. Some implementations of adaptive thinking activation are position-sensitive in the prompt.

### Changes to `mcp-server/src/deep-plan.ts`

#### Change 3: Increase timeout for adaptive thinking latency

**Location:** Line 103

**Current:**
```typescript
timeout: 180000, // 3 min timeout per planner
```

**After:**
```typescript
timeout: 420000, // 7 min timeout per planner (adaptive thinking latency)
```

**Rationale:** Adaptive thinking (ultrathink) in Opus 4.7 can significantly increase response time for complex tasks. The 3-minute timeout was set for standard (non-thinking) mode. Planning tasks with full repo context and 500–2000 line output targets routinely push toward the 3-minute limit even without thinking. With adaptive thinking enabled, hitting the timeout and silently returning an empty plan (`(AGENT RETURNED EMPTY — exclude from synthesis)`) is a correctness failure that produces degraded synthesis. 7 minutes provides a reasonable buffer while remaining within acceptable user-wait bounds for a background planning operation. The timeout should be documented as thinking-aware.

**No change needed for Path A (MCP-driven):** Agent() calls via the orchestrator do not have a 3-minute timeout from this code — they use the Claude Code agent timeout, which is much longer (10+ minutes).

### No Changes Needed to `prompts.ts`

`competingPlanAgentPrompt`, `planSynthesisPrompt`, and `planDocumentPrompt` are not called by any production code path. They already contain "Use ultrathink." and are effectively dead code in the current flow. They should not be modified (changes there have zero effect on runtime behavior) but should be noted in a comment.

**Correctness risk of touching dead code:** Modifying dead code creates false confidence that the fix is complete. The real fix is in `tools/plan.ts`. Adding a comment to the unused functions clarifying they are not called by the MCP tools path is the only warranted change.

---

## 5. Testing Strategy

### Test File: `mcp-server/src/__tests__/tools/plan.test.ts`

This test file covers `runPlan` from `tools/plan.ts`. Current deep-mode tests (lines 241–280) verify that `planAgents` is returned with 3 perspectives but do **not** assert on the content of `task` strings.

**New test to add:**

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

it('includes "Use ultrathink." in synthesisPrompt in deep mode', async () => {
  const { ctx } = makeCtx();
  
  const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
  
  const structured = result.structuredContent as {
    data: { synthesisPrompt: string }
  };
  expect(structured.data.synthesisPrompt).toContain('Use ultrathink.');
});
```

**Why these tests:** They pin the exact requirement that was previously unspecified. Without them, a future refactor could silently drop "Use ultrathink." from the prompts with no failing tests.

### Test File: `mcp-server/src/__tests__/deep-plan.test.ts`

The existing tests in this file do not assert on the content of `agent.task`. The task is written to a temp file and the file's content is partially checked (tests verify preamble + task are present). Since `deep-plan.ts` receives pre-composed task strings from the caller, there is no new test needed here for the thinking activation — that is tested at the `plan.ts` level.

**One useful addition to prevent regression in deep-plan.ts timeout:**

```typescript
it('uses a timeout of at least 300000ms per planner (supports thinking latency)', async () => {
  const { exec, calls } = makeExec();
  const agents = [{ name: 'test', task: 'Plan it.' }];
  
  await runDeepPlanAgents(exec, '/fake/cwd', agents);
  
  // Verify the exec call used the expected minimum timeout.
  // The exec mock in tests doesn't expose timeout, so this test 
  // serves as documentation — inspect via code review.
  // A future improvement: make ExecFn record options including timeout.
  expect(calls.some(c => c.cmd === 'claude')).toBe(true);
});
```

**Note:** The current `ExecFn` type and mock do not capture the `options` (including `timeout`) passed to `exec`. A proper timeout assertion would require updating the mock to capture options. This is worth doing but is a secondary improvement — the primary correctness fix is the prompt content change. Tracking as a separate concern.

### Regression Tests

The existing tests in `plan.test.ts` must continue to pass:
- `returns agent spawn configs in deep mode` — passes because structuredContent shape is unchanged
- `includes correctness, robustness, and ergonomics perspectives in deep mode` — passes because perspective list is unchanged
- All `standard` mode tests — unaffected (different code path)
- All `planFile` and `planContent` tests — unaffected (early-return code paths)

---

## 6. Edge Cases & Failure Modes

### 6.1 Old Thinking Syntax Must Not Be Used

**Failure mode:** Any code path that passes `thinking: { type: "enabled", budget_tokens: N }` to the Anthropic SDK or any `--thinking` CLI flag will receive a 400 error on Opus 4.7.

**Verification:** Grep the entire codebase for `thinking:`, `budget_tokens`, and `--thinking`.

```bash
grep -rn "budget_tokens\|thinking.*enabled\|--thinking" \
  mcp-server/src --include="*.ts" --exclude-dir=node_modules
```

**Result from inspection:** No occurrences found. The codebase does not use old thinking syntax. Risk is low but the grep should be added as a CI check or pre-commit lint rule.

### 6.2 "Use ultrathink." Only Works in Claude Code Context

**Failure mode:** "Use ultrathink." is a Claude Code-specific activation phrase. It has no effect in raw Anthropic API calls. If `deep-plan.ts` is called via a non-Claude Code execution environment (e.g. direct anthropic SDK test), thinking will not activate despite the phrase being present.

**Current exposure:** `runDeepPlanAgents` calls `claude` (the CLI) with `--print`, which runs in Claude Code context. This is correct. The phrase will be interpreted by Claude Code's extended thinking heuristics.

**What breaks:** If someone refactors Path B to use the Anthropic SDK directly (e.g. `new Anthropic().messages.create()`), they must also switch to the SDK's thinking parameter. The plan text "Use ultrathink." would be silently ignored and thinking would not activate.

**Mitigation:** Document this constraint in a comment near the `writeFileSync(taskFile, ...)` call in `deep-plan.ts`.

### 6.3 Timeout Expiration with Adaptive Thinking

**Failure mode:** Adaptive thinking increases output latency. The current 3-minute timeout is too short for complex planning tasks with thinking enabled. When a planner agent times out, `runDeepPlanAgents` returns it as `(AGENT RETURNED EMPTY — exclude from synthesis)`, which silently reduces the number of input plans for synthesis.

**Concrete scenario:** 3 planners are spawned. Correctness and robustness complete in 4 minutes. Ergonomics times out at 3 minutes. Synthesis receives only 2 plans. The synthesis is lower quality and the user has no visibility into the failure.

**Fix:** Increase timeout to 420000ms (7 min) as specified in Section 4.

**Secondary mitigation:** Log a warning when a planner agent hits the timeout vs. genuinely fails:
```typescript
error: `timeout after ${timeout}ms — consider increasing timeout for thinking-enabled models`
```

**This is an existing bug even without thinking enabled** (complex repos + large context can already push past 3 min) — adaptive thinking makes it more likely to surface.

### 6.4 Empty Plan from Planner Agent

**Failure mode:** A planner returns an empty stdout (or only whitespace). This is already handled by `filterViableResults` in `deep-plan.ts`, which filters out agents where `plan.startsWith("(AGENT")`. No change needed, but the fix must not alter this filtering logic.

### 6.5 "Use ultrathink." Placement in Prompt

**Failure mode:** If "Use ultrathink." appears in a section of the prompt that the model deprioritizes (e.g. buried in the middle of a long tools/instructions section), adaptive thinking may not activate reliably.

**Mitigation:** Place "Use ultrathink." at the end of `basePrompt`, immediately before the perspective-specific instructions. This matches the proven pattern used in `prompts.ts` throughout the codebase (e.g., `planIntegrationPrompt`, `freshPlanRefinementPrompt`, `planRefinementPrompt` all terminate or open with "Use ultrathink.").

**Observation:** `planIntegrationPrompt` (prompts.ts line 1556) places "use ultrathink" in the middle of the first sentence. `freshPlanRefinementPrompt` (line 1604) places it at the end of the first line. Both patterns are used. The codebase has no single canonical placement. Consistency argues for end-of-shared-context placement in `basePrompt`.

### 6.6 Model String Format

**Failure mode:** `getDeepPlanModels()` returns model strings in `provider/model` format (e.g. `"anthropic/claude-opus-4-7"`). The `--model` flag in `claude --print` may or may not accept the `/`-delimited format. If it does not, the `--model` flag is ignored and the default model is used, which may not be Opus 4.7.

**Verification needed:** Test `claude --print --model anthropic/claude-opus-4-7 "hello"` vs `claude --print --model claude-opus-4-7 "hello"`.

**Current fallback:** If `getDeepPlanModels()` throws, the fallback is `"anthropic/claude-opus-4-7"`. This uses the slash-delimited format which is consistent with the rest of the codebase.

**Impact on thinking:** If the wrong model is used (e.g. falls back to a non-Opus-4.7 model), adaptive thinking behavior may differ (older models used different thinking syntax). The "Use ultrathink." phrase is safe for older models — it simply becomes a high-effort instruction rather than a specific thinking mode activation.

### 6.7 `synthesisPrompt` Is a String in the Payload, Not an Agent Prompt

**Failure mode:** Looking at `plan.ts` more carefully, `synthesisPrompt` is part of the JSON payload returned to the orchestrator (structuredContent). It is the orchestrator's responsibility to use this string as the synthesis agent's prompt. If the orchestrator ignores `synthesisPrompt` and writes its own synthesis instructions, "Use ultrathink." will be missing from synthesis.

**Trace of actual use:**
- `_planning.md` (Step 7, synthesis agent): The synthesis agent prompt in `_planning.md` is hardcoded with its own instructions — it does NOT read `synthesisPrompt` from the `flywheel_plan` payload.
- The `synthesisPrompt` in the payload appears to be advisory only.

**Implication:** Adding "Use ultrathink." to `synthesisPrompt` in `tools/plan.ts` MAY be insufficient to affect the synthesis agent. The synthesis agent prompt in `_planning.md` needs to independently include "Use ultrathink."

**Inspection of `_planning.md` synthesis agent prompt (Step 7, lines 95–122):**
```
Agent(model: "opus", name: "plan-synthesizer", team_name: "<team>", run_in_background: true,
  prompt: "
    Read the plan files written by the planning agents:
    ...
    ## Best-of-All-Worlds Synthesis
    For EACH plan, BEFORE proposing any changes:
    1. Honestly acknowledge what that plan does better than the others.
    ...
    Write the result to: docs/plans/<date>-<goal-slug>-synthesized.md
    Send the file path to <your-coordinator-name> via Agent Mail when done.
  "
)
```

**No "Use ultrathink." in this prompt.** This is a gap the correctness fix must address.

**Fix:** Add "Use ultrathink." to the synthesis agent prompt in `skills/start/_planning.md`. The payload's `synthesisPrompt` field from `tools/plan.ts` is informational; the orchestrator-level skill file controls the actual synthesis agent prompt.

---

## 7. File Structure

### Files to Modify

| File | Change | Lines Affected |
|------|--------|----------------|
| `mcp-server/src/tools/plan.ts` | Add "Use ultrathink." to `basePrompt` | Line 222 |
| `mcp-server/src/tools/plan.ts` | Add "Use ultrathink." to `synthesisPrompt` | Line 278 |
| `mcp-server/src/deep-plan.ts` | Increase timeout from 180000ms to 420000ms | Line 103 |
| `skills/start/_planning.md` | Add "Use ultrathink." to synthesis agent prompt | Step 7, ~line 97 |
| `mcp-server/src/__tests__/tools/plan.test.ts` | Add ultrathink assertion tests (deep mode) | New tests after line 280 |

### Files Not to Modify

| File | Reason |
|------|--------|
| `mcp-server/src/prompts.ts` | Dead code path — `competingPlanAgentPrompt`, `planSynthesisPrompt`, `planDocumentPrompt` are not called by production paths. Already have "Use ultrathink.". Adding more would create misleading noise. |
| `mcp-server/src/__tests__/deep-plan.test.ts` | The task content comes from callers, not from `deep-plan.ts` itself. No new assertions needed for thinking activation. |
| `mcp-server/src/model-detection.ts` | Model detection logic is correct. Opus 4.7 is already the default fallback for planning roles. |

### Files to Consider (Secondary)

| File | Action |
|------|--------|
| `mcp-server/src/deep-plan.ts` | Add comment near `writeFileSync(taskFile, ...)` documenting that task content must include "Use ultrathink." for thinking to activate in Claude Code `--print` mode |
| `mcp-server/src/prompts.ts` | Add comments to `competingPlanAgentPrompt`, `planSynthesisPrompt`, `planDocumentPrompt` noting they are not called by production MCP tool paths |

---

## 8. Sequencing

The changes are independent and can be applied in one commit, but the logical order if doing it incrementally is:

### Phase 1: Core Prompt Fix (Required, High Confidence)

1. **`tools/plan.ts` — `basePrompt`**: Add "Use ultrathink." at end of shared base prompt. This is the highest-leverage change: it activates thinking for all 3–4 planner agents.

2. **`tools/plan.ts` — `synthesisPrompt`**: Add "Use ultrathink." at top. This covers the case where the orchestrator does use the payload's synthesisPrompt instead of its own hardcoded prompt.

3. **`skills/start/_planning.md` — synthesis agent prompt**: Add "Use ultrathink." to the synthesis agent prompt in the hardcoded Agent() call. This is the actual production synthesis path and is where the fix matters most for synthesis quality.

### Phase 2: Timeout Fix (Required, High Confidence)

4. **`deep-plan.ts` — timeout**: Increase from 180000ms to 420000ms. This prevents silent plan loss from timeout expiration when thinking adds latency. Independent of Phase 1; can be applied in the same commit.

### Phase 3: Test Coverage (Required Before Merge)

5. **`plan.test.ts` — ultrathink in planAgents**: Add assertion that all plan agent `task` fields contain "Use ultrathink." Protects against future regression.

6. **`plan.test.ts` — ultrathink in synthesisPrompt**: Add assertion for the `synthesisPrompt` payload field. Secondary coverage.

### Verification Steps

After applying changes:

```bash
# 1. Run existing tests (must all pass)
cd mcp-server && npx vitest run

# 2. Verify "Use ultrathink." appears in deep plan prompts
node -e "
  const { runPlan } = await import('./dist/tools/plan.js');
  // requires a built dist — or use the test suite instead
"

# 3. Grep for old thinking syntax (must return empty)
grep -rn 'budget_tokens\|thinking.*enabled\|--thinking' mcp-server/src \
  --include='*.ts' --exclude-dir=node_modules

# 4. Manual smoke test: run a deep plan and verify thinking tokens appear
# (requires Opus 4.7 access and the full flywheel setup)
```

### Risk of Each Change

| Change | Risk | Reversibility |
|--------|------|---------------|
| Add "Use ultrathink." to `basePrompt` | Low — only affects model behavior, not TypeScript types or tool contracts | Trivially reversible |
| Add "Use ultrathink." to `synthesisPrompt` | Low — same as above | Trivially reversible |
| Add "Use ultrathink." to `_planning.md` | Low — skill file, no build step | Trivially reversible |
| Increase timeout to 420000ms | Low — only increases max wait, does not change behavior on fast runs | Trivially reversible |
| New test assertions | None | N/A |

No changes affect the `structuredContent` schema, the `FlywheelState` type, the MCP tool signatures, or any public API surface. All changes are prompt text or internal timeout constants.

---

## Key Correctness Findings Summary

1. **`deepPlannerPrompt()` is never called in the MCP-driven flow.** The function at `prompts.ts:1367` is dead code. "Use ultrathink." must be added to `tools/plan.ts` where the actual prompts are constructed.

2. **`claude --print` has no `--thinking` flag.** Confirmed via `claude --help`. The only mechanism for adaptive thinking in `--print` mode is the "Use ultrathink." phrase in the task content.

3. **The `synthesisPrompt` in the `flywheel_plan` payload is not used by the hardcoded skill.** `_planning.md` has its own synthesis agent prompt. Both must be fixed (the payload for future-proofing, the skill file for current production behavior).

4. **The 3-minute timeout in `deep-plan.ts` is insufficient for thinking-enabled models** and is already potentially too short even without thinking. Increase to 7 minutes.

5. **Old thinking syntax (`budget_tokens`) does not appear anywhere in the codebase.** This potential breaking change is not a risk. No migration needed.

6. **"Use ultrathink." should be added once to `basePrompt`**, not to each per-perspective suffix, to guarantee all plan agents (including future fourth planners) inherit the directive.
