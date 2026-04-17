# Robustness Plan: Opus 4.7 Adaptive Thinking in Deep-Plan Agents

**Date:** 2026-04-16
**Perspective:** ROBUSTNESS
**Author:** DustyForest (agent-mail, claude-opus-4-7)

---

## Executive Summary

This plan addresses enabling Claude Opus 4.7 adaptive thinking ("ultrathink") in the agent-flywheel's deep-plan agents, with a conservative safety-first approach. The goal is higher-quality plan synthesis through extended thinking, while protecting against timeout explosions, cost overruns, graceful degradation on incompatible models, and zero-disruption backward compatibility.

The change is small in code surface (prepending "ultrathink" to task prompts in the CLI-driven path, or via the MCP-driven path's basePrompt) but large in operational impact. Every failure mode must be enumerated and addressed before the first merge.

---

## 1. Architecture Overview

### Two Code Paths — Both Need Attention

**Path A: CLI-driven (`mcp-server/src/deep-plan.ts`)**
- `runDeepPlanAgents()` writes per-agent task files, then shells out: `claude --print --tools read,bash,grep,find,ls --model <model> @<taskFile>`
- 3-minute hard timeout (180000ms) per agent via `exec.ts` `setTimeout → child.kill('SIGTERM') → reject()`
- `filterViableResults()` requires `exitCode === 0 AND !plan.startsWith("(AGENT")`
- Agents run in parallel via `Promise.all()`; all latency is additive with thinking overhead
- AbortSignal flows: `signal` → `exec()` → `spawn({ signal })` + abort handler → `child.kill('SIGTERM')`

**Path B: MCP-driven (`mcp-server/src/tools/plan.ts`)**
- Returns spawn configs (`deep_plan_spawn`) with `basePrompt` + per-perspective task text
- No subprocess management; orchestrating agent spawns sub-agents via TeamCreate
- "ultrathink" would appear in the task text itself, not as a CLI flag
- No timeout enforcement in this path; the orchestrator or its tool invocation layer governs

**Path C: Synthesis (`mcp-server/src/deep-plan-synthesis.ts`)**
- Pure mechanical section-wise merge — no LLM, no thinking tokens
- Not affected by ultrathink addition; only receives final plan strings

### Where "ultrathink" Activates Adaptive Thinking

In Claude Code agents, the word "ultrathink" anywhere in the prompt triggers the adaptive thinking budget mechanism. It is not a CLI flag. It is a prompt-level signal. This means:
- Path A: adding "ultrathink" to the task file content is sufficient
- Path B: adding "ultrathink" to `basePrompt` or each perspective task is sufficient
- Adding to both is idempotent (the signal does not compound)

---

## 2. Failure Mode Catalog

Before any solution, enumerate every failure mode thoroughly.

### 2.1 Timeout Failures

**FM-T1: 3-minute timeout is inadequate for thinking + planning**
- Current: 180000ms (3 min) is sized for standard non-thinking model runs
- With adaptive thinking, Opus 4.7 may think for 1–3 minutes *before* writing a word of output
- A complex planning task could require: ~2 min thinking + ~3 min writing = ~5 min total
- Risk: ALL parallel planners time out simultaneously → `filterViableResults` returns empty array → synthesis receives 0 plans → output: "(No planner outputs provided.)"
- This is a silent catastrophic failure from the user's perspective

**FM-T2: SIGTERM on thinking mid-stream produces no partial output**
- `exec.ts` on timeout: kills with SIGTERM, then *rejects* the promise (throws Error)
- The catch block in `runDeepPlanAgents` returns `exitCode: 1` with error message as plan text
- `filterViableResults` filters this out (exitCode !== 0)
- Result: timed-out planners are silently dropped, not surfaced to user

**FM-T3: Parallel thinking planners compound latency**
- `Promise.all()` means ALL planners run simultaneously
- With 3 Opus 4.7 planners all thinking, wall-clock time is max(individual times), not sum
- BUT if all 3 exceed 3 min, all 3 fail simultaneously — no survivor
- The timeout does not stagger; there is no fallback to shorter-timeout retry

**FM-T4: Timeout race condition — child process close vs timer**
- `exec.ts`: timer fires → `child.kill('SIGTERM')` → `reject(Error("Timed out..."))` 
- BUT `child.on('close')` listener also fires after SIGTERM
- The `resolve` in `close` handler races with `reject` from timer
- In practice, Node.js Promise semantics mean the first settlement wins, but stdout captured before kill may be partially written
- Non-issue for correctness but understanding confirms no partial-plan recovery

### 2.2 Cost and Token Budget Failures

**FM-C1: No cost warning before enabling ultrathink on Opus 4.7**
- Opus 4.7: $5/MTok input, $25/MTok output; thinking tokens billed as output
- A single complex planning run with 3 Opus 4.7 planners, each thinking heavily:
  - Estimate: 200K thinking tokens + 50K output tokens per planner × 3 = ~750K output-billed tokens
  - Cost: ~$18.75 per deep-plan invocation, vs ~$1.50 without thinking
- No existing guardrail, warning, or acknowledgment step in the flow
- User could trigger this inadvertently via `flywheel_plan mode=deep`

**FM-C2: Ergonomics agent uses `claude-sonnet-4-6` (not Opus 4.7)**
- `dynamicModels.ergonomics` falls back to `anthropic/claude-sonnet-4-6`
- "ultrathink" on claude-sonnet-4-6: does it activate thinking? 
- If it does: unexpected cost on a model not intended for heavy thinking
- If it does not: the word is silently ignored; ergonomics planner runs normally (safe, but misleading)
- The behavior is model-dependent and undocumented in this codebase

**FM-C3: CODEX_SUBAGENT_TYPE robustness perspective bypasses model selection entirely**
- In `plan.ts`, the robustness agent uses `subagent_type: CODEX_SUBAGENT_TYPE` (`"codex:codex-rescue"`)
- This is NOT the CLI-driven path in `deep-plan.ts`; it spawns a Codex agent via skill
- "ultrathink" in the task prompt for Codex agents: behavior unknown
- Codex agents have different token economics; the cost model is unclear

**FM-C4: No per-session or per-invocation token budget cap**
- The codebase has no `--max-tokens` flag passed to `claude --print`
- With thinking, model may generate up to its context limit before stopping
- No hard cap means runaway cost on a single deep-plan invocation is possible

### 2.3 Model Compatibility Failures

**FM-M1: "ultrathink" silently ignored on non-Opus models**
- On claude-sonnet-4-6, "ultrathink" may be ignored entirely (no thinking budget allocated)
- The plan is still generated, but without the quality benefit
- No indication to the user that thinking was skipped
- Test gap: no assertion that thinking actually occurred

**FM-M2: Model string format mismatch**
- `getDeepPlanModels()` returns `"anthropic/claude-opus-4-7"` (provider-prefixed)
- `claude --model anthropic/claude-opus-4-7` — does the Claude CLI accept this format?
- OR does it expect bare `claude-opus-4-7`?
- If the CLI rejects the prefixed form, the agent exits with non-zero code
- `filterViableResults` drops it; silent failure
- Current tests use `makeExec` which mocks `claude` and always returns code 0 — this bug would not be caught by tests

**FM-M3: Model unavailable at inference time**
- `claude-opus-4-7` may not be in the user's model list at the moment of invocation
- The CLI would return a non-zero exit code with stderr: "model not found" or similar
- `filterViableResults` drops these results
- If correctness + robustness both fail (both Opus 4.7), only ergonomics (Sonnet) survives
- Synthesis with 1 planner produces a valid but unreviewed plan — no visible warning

**FM-M4: Adaptive thinking not available on all Opus 4.7 deployments**
- Opus 4.7 adaptive thinking may require specific API entitlements
- Some enterprise or rate-limited accounts may not have it enabled
- In this case, "ultrathink" is silently ignored; plan is generated without thinking
- No observable failure but the quality promise is unmet

### 2.4 AbortSignal and Cancellation Failures

**FM-A1: AbortSignal propagated to spawn but thinking cannot be interrupted cleanly**
- `exec.ts`: `spawn({ signal: opts.signal })` — Node passes AbortSignal to child spawn
- If signal fires mid-thinking: SIGTERM sent to `claude` process
- Claude's thinking state is not written to stdout; all thinking work is lost
- The catch block records elapsed time (potentially 2+ minutes) but no partial output

**FM-A2: AbortSignal not checked before Promise.all starts**
- `runDeepPlanAgents` does not check `signal?.aborted` before launching agents
- If the parent operation was already aborted, all agents spin up anyway (briefly)
- The `exec` function does check `signal?.aborted` early, so agents fail immediately
- But this is a small inefficiency: tmpdir creation and profile snapshot still occur

**FM-A3: AbortSignal not passed to `writeProfileSnapshot`**
- `writeProfileSnapshot` receives and passes `signal` to `profileRepo` — this is correct
- But if `loadCachedProfile` hangs (unusual), the signal is not propagated to it
- Minor issue; `loadCachedProfile` is sync in practice

### 2.5 Synthesis Quality Failures

**FM-S1: All planners time out → synthesis receives empty array**
- `synthesizePlans([])` returns `"# Synthesized Plan\n\n(No planner outputs provided.)\n"`
- This string is then passed to `flywheel_plan` as `planContent`
- `runPlan` with `planContent = "(No planner outputs provided.)"` will accept it and save it
- The saved file will appear as a valid plan to the user; they may not notice it's empty
- No error is surfaced; no retry mechanism exists

**FM-S2: Only 1 planner succeeds → "synthesis" is effectively single-plan output**
- `synthesizePlans([single])` produces a valid synthesized plan from one source
- The header says "Assembled from 1 planner output(s)" which is technically honest
- But the quality benefit of multi-perspective synthesis is entirely lost
- No warning is emitted to the user about degraded synthesis quality

**FM-S3: Section-wise synthesis with thinking-heavy plans**
- Thinking-enabled planners may produce much longer plans (2000+ lines)
- `SECTION_WISE_FILE_THRESHOLD = 500` applies to repo file count, not plan length
- Very long plans may produce many divergent sections → many "Synthesis required" blocks
- The synthesized document becomes unwieldy for human review

### 2.6 Test Coverage Gaps

**FM-Test1: No test for timeout scenario in `deep-plan.test.ts`**
- Current tests mock `claude` as always returning code 0 with "fake plan body"
- No test for: exec rejects (timeout) → catch block → filterViableResults excludes it
- No test for: all agents time out → empty results returned

**FM-Test2: No test for empty-plan synthesis propagation**
- No test verifying that a plan with "(No planner outputs provided.)" does not silently become a saved plan file

**FM-Test3: No test for partial success (some agents succeed, some fail)**
- No test for: 2 of 3 agents succeed; verify filterViableResults count and synthesis uses 2

**FM-Test4: No test for AbortSignal pre-check**
- No test for: signal already aborted before runDeepPlanAgents → agents don't spawn

**FM-Test5: No test verifying "ultrathink" appears in task file content**
- Once ultrathink is added to task content, there is no test asserting the word is present in the written task file

**FM-Test6: No integration test for MCP-driven path with ultrathink**
- `plan.test.ts` tests deep mode returns the correct spawn config structure
- But no test verifies the task text for each perspective contains "ultrathink"

### 2.7 Backward Compatibility Concerns

**FM-B1: Existing cached tool responses**
- If an orchestrating agent has a cached/memoized tool response from a prior `flywheel_plan` call (before ultrathink), the task texts won't contain "ultrathink"
- The feature is a no-op for that agent session
- This is acceptable degradation; it is not a breakage

**FM-B2: Older Claude CLI versions**
- "ultrathink" as a prompt-level signal relies on CLI behavior, not flags
- Older CLI versions may not recognize it and generate a plan without thinking
- Again acceptable degradation; not a breakage

**FM-B3: `filterViableResults` contract is stable**
- Adding "ultrathink" to task content does not change the output format contract
- Plans still pass through `filterViableResults(r.exitCode === 0 && !r.plan.startsWith("(AGENT"))` correctly
- No breaking change here

**FM-B4: Model string format stability**
- If `getDeepPlanModels` returns `"anthropic/claude-opus-4-7"` and the CLI expects `claude-opus-4-7`
- This is a pre-existing bug, not introduced by ultrathink
- But ultrathink makes it more impactful: if Opus 4.7 with thinking fails, fallback is Sonnet without thinking

---

## 3. Implementation Phases

### Phase 0: Pre-Condition Verification (no code changes)
**Goal:** Confirm empirical answers to key unknowns before writing a line of production code.

- [ ] **P0.1** Run `claude --print --model claude-opus-4-7 @testfile.md` where `testfile.md` contains "ultrathink". Observe: (a) does it produce thinking output? (b) how long does it take for a planning-scale task? (c) what is the typical token count?
- [ ] **P0.2** Run the same with `--model anthropic/claude-opus-4-7` to verify whether the prefixed format is accepted by the CLI
- [ ] **P0.3** Run with `--model claude-sonnet-4-6` to confirm behavior of "ultrathink" on Sonnet
- [ ] **P0.4** Measure actual latency for a planning-scale task (500-2000 line output) with thinking enabled on Opus 4.7. Record p50/p95 for timeout sizing.
- [ ] **P0.5** Confirm cost per run by inspecting token counts after Phase 0.1 experiment

Only proceed to Phase 1 after P0 answers are documented.

### Phase 1: Timeout and Error Handling Hardening
**Goal:** Make the system resilient to timeout failures before adding thinking.

Files to modify:
- `mcp-server/src/deep-plan.ts`: increase timeout, add empty-results guard
- `mcp-server/src/__tests__/deep-plan.test.ts`: add missing test cases

Changes:
1. **Increase timeout** from 180000ms (3 min) to a value informed by Phase 0.4 findings
   - Conservative recommendation: 600000ms (10 min) — 3x typical thinking+planning time
   - Make the timeout configurable via environment variable `DEEP_PLAN_TIMEOUT_MS` with the hardcoded value as default
2. **Empty-results guard in `runDeepPlanAgents`**: if `filterViableResults` returns empty array, log a clear warning to stderr with the error messages from failed agents, and return a structured error object rather than an empty array
3. **Minimum-viable-result warning**: if fewer than 2 planners succeed, emit a stderr warning: `[deep-plan] WARNING: Only N of M planners succeeded; synthesis quality is degraded`
4. **Expose timeout error detail**: on timeout, include elapsed time and the model name in the error message so downstream debugging is possible

Test additions for `deep-plan.test.ts`:
- Test: exec rejects with "Timed out" error → caught → result has exitCode 1 → filterViableResults excludes it
- Test: all 3 agents fail → filterViableResults returns [] → runDeepPlanAgents still returns [] (does not throw)
- Test: 2 of 3 agents succeed → filterViableResults returns 2 results
- Test: AbortSignal already aborted → exec rejects with "Aborted" → caught → excluded from results

### Phase 2: Add ultrathink to CLI-Driven Path (deep-plan.ts)
**Goal:** Enable adaptive thinking for Opus 4.7 agents in `runDeepPlanAgents`.

Files to modify:
- `mcp-server/src/deep-plan.ts`

Change: in the task file construction, prepend "ultrathink" as the first word of the task (or append to the end — location matters for attention, but functional either way):

```typescript
// Before writing taskFile:
const ultrathinkPrefix = "ultrathink\n\n";
writeFileSync(taskFile, `${snapshotPreamble}${ultrathinkPrefix}${agent.task}`, "utf8");
```

Alternative: only add "ultrathink" when the model is Opus 4.7:
```typescript
const isOpus47 = agent.model?.includes("opus-4-7") ?? false;
const thinkingPrefix = isOpus47 ? "ultrathink\n\n" : "";
```

Recommendation: **model-conditional addition** is safer. It avoids silently activating thinking on Sonnet (cost risk) and provides clarity about intent.

Test additions for `deep-plan.test.ts`:
- Test: agent with Opus 4.7 model → task file contains "ultrathink"
- Test: agent with Sonnet model → task file does NOT contain "ultrathink"
- Test: agent with no model specified → task file does NOT contain "ultrathink"

### Phase 3: Add ultrathink to MCP-Driven Path (plan.ts)
**Goal:** Enable adaptive thinking in the MCP-driven spawn config path.

Files to modify:
- `mcp-server/src/tools/plan.ts`

The `basePrompt` currently does not include "ultrathink". The MCP-driven planners receive the task text and run it via TeamCreate. Adding "ultrathink" to the per-perspective task texts for the correctness and robustness perspectives (both use Opus 4.7 by default) is the minimal, safest change:

```typescript
// In the correctness agent task:
task: `ultrathink\n\n${basePrompt}\n\n## Your perspective: CORRECTNESS\n...`

// In the robustness agent task:
// NOTE: robustness uses CODEX_SUBAGENT_TYPE (Codex agent, not Opus 4.7)
// DO NOT add ultrathink to the robustness perspective until Codex thinking behavior is confirmed
```

The ergonomics perspective uses Sonnet by default — do not add ultrathink without confirming cost/behavior.

Test additions for `plan.test.ts`:
- Test: deep mode → correctness perspective task contains "ultrathink"
- Test: deep mode → robustness perspective task does NOT contain "ultrathink" (until Codex behavior confirmed)
- Test: deep mode → ergonomics perspective task does NOT contain "ultrathink" (Sonnet model)

### Phase 4: Cost Advisory (Optional but Recommended)
**Goal:** Warn users before a potentially expensive deep-plan run.

Files to modify:
- `mcp-server/src/tools/plan.ts`

When `mode === 'deep'` and the detected models include Opus 4.7 with ultrathink, add a cost advisory to the returned instructions text:

```
> Cost advisory: This deep-plan run uses Opus 4.7 with adaptive thinking (~$15-25 per run).
> Confirm before proceeding, or set mode=standard for lower cost.
```

This is advisory only — no blocking gate. The orchestrating agent can decide whether to surface it to the user.

---

## 4. File-Level Changes

### `mcp-server/src/deep-plan.ts`
- Line 103: Change `timeout: 180000` to `timeout: Number(process.env.DEEP_PLAN_TIMEOUT_MS ?? 600000)`
- Lines 83-142 (agent map): Add model-conditional ultrathink prefix to task file content
- Lines 144-147 (after Promise.all): Add empty-results warning and structured return
- Export `DEEP_PLAN_TIMEOUT_MS_DEFAULT = 600000` for testability

### `mcp-server/src/tools/plan.ts`
- Lines 230-244 (correctness agent): Add ultrathink prefix to task text, conditional on model being Opus 4.7
- Lines 237-243 (robustness agent via CODEX_SUBAGENT_TYPE): NO change until Codex behavior confirmed
- Lines 245-254 (ergonomics agent): NO change (Sonnet model)
- Lines 276-278 (instructions): Add cost advisory mention

### `mcp-server/src/__tests__/deep-plan.test.ts`
- Add `makeExecWithTimeout()` helper that rejects with timeout error
- Add 4 new test cases (see Phase 1 and Phase 2 above)

### `mcp-server/src/__tests__/tools/plan.test.ts`
- Add 3 new test cases verifying ultrathink presence/absence by perspective (Phase 3)

---

## 5. Testing Strategy

### Unit Tests (vitest, existing framework)

**Timeout scenarios (highest priority):**
```typescript
it('excludes timed-out agent from results', async () => {
  const exec: ExecFn = async (cmd) => {
    if (cmd === 'claude') throw new Error('Timed out after 600000ms: claude ...');
    // ... profile mocks
    return { code: 0, stdout: '', stderr: '' };
  };
  const results = await runDeepPlanAgents(exec, '/fake', [
    { name: 'correctness', task: 'plan', model: 'claude-opus-4-7' }
  ]);
  expect(results).toHaveLength(0);
});

it('returns empty array (does not throw) when all agents time out', async () => {
  // all claude calls throw
  const results = await runDeepPlanAgents(exec, '/fake', threeAgents);
  expect(results).toHaveLength(0);
  expect(Array.isArray(results)).toBe(true);
});
```

**Ultrathink presence tests:**
```typescript
it('prepends ultrathink to Opus 4.7 task files', async () => {
  const agent = { name: 'correctness', task: 'Plan it.', model: 'claude-opus-4-7' };
  await runDeepPlanAgents(exec, '/fake', [agent]);
  const taskContent = readFileSync(join(outDir, 'correctness-task.md'), 'utf8');
  expect(taskContent).toMatch(/^ultrathink/);
});

it('does NOT prepend ultrathink to Sonnet task files', async () => {
  const agent = { name: 'ergonomics', task: 'Plan it.', model: 'claude-sonnet-4-6' };
  await runDeepPlanAgents(exec, '/fake', [agent]);
  const taskContent = readFileSync(join(outDir, 'ergonomics-task.md'), 'utf8');
  expect(taskContent).not.toMatch(/^ultrathink/);
});
```

**Partial success tests:**
```typescript
it('returns only successful agents when some fail', async () => {
  let callCount = 0;
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === 'claude') {
      callCount++;
      if (callCount === 1) throw new Error('Timed out...');
      return { code: 0, stdout: '## Plan\ncontent', stderr: '' };
    }
    // profile mocks...
  };
  const results = await runDeepPlanAgents(exec, '/fake', twoAgents);
  expect(results).toHaveLength(1);
});
```

### Integration / Manual Tests (Phase 0)

These are NOT automated but MUST be run before merging:
1. Real `claude --print --model claude-opus-4-7 @testfile.md` with ultrathink, measure latency
2. Verify prefixed model string `anthropic/claude-opus-4-7` is accepted by CLI
3. Confirm behavior on `claude-sonnet-4-6` with ultrathink word present

### Regression Tests

After changes, run full vitest suite:
```bash
cd mcp-server && npm test
```

Confirm no existing tests regress. The timeout change (3 min → 10 min) will only be visible in real exec calls, not mocked tests.

---

## 6. Acceptance Criteria

### Must Pass (Phase 0)
- [ ] Empirical latency measurement shows Opus 4.7 with ultrathink completes planning tasks in under 8 minutes p95
- [ ] CLI accepts the model string format used by `getDeepPlanModels()`
- [ ] "ultrathink" activates thinking on Opus 4.7 (confirmed by response format or token count)

### Must Pass (Phase 1)
- [ ] All new timeout/error tests pass
- [ ] Existing test suite passes without regression
- [ ] `DEEP_PLAN_TIMEOUT_MS` env var is respected (unit testable)
- [ ] Empty-results condition emits a stderr warning (unit testable)

### Must Pass (Phase 2 + 3)
- [ ] Task files for Opus 4.7 agents contain "ultrathink" prefix
- [ ] Task files for Sonnet agents do NOT contain "ultrathink" prefix
- [ ] `filterViableResults` behavior is unchanged (existing tests still pass)
- [ ] No change to the structured output contract of `flywheel_plan`

### Must Pass (Phase 4, optional)
- [ ] Cost advisory appears in deep-mode instructions when Opus 4.7 is in use

---

## 7. Risk & Mitigation

### Risk 1: Timeout too short → all planners fail silently
**Likelihood:** HIGH (current 3 min is likely insufficient for thinking-enabled Opus 4.7)
**Impact:** HIGH (synthesis produces empty or "(No planner outputs provided.)" output)
**Mitigation:** Phase 1 — increase timeout to 10 min with env var override; add empty-results warning
**Contingency:** If 10 min is still too short, the env var allows operators to increase further without a code change

### Risk 2: Cost overrun on accidental deep-plan invocation
**Likelihood:** MEDIUM (users may invoke mode=deep without understanding new cost)
**Impact:** MEDIUM ($15-25 per accidental run vs $1.50 before)
**Mitigation:** Phase 4 — cost advisory in returned instructions
**Contingency:** Accept risk if Phase 4 is deferred; the advisory is non-blocking

### Risk 3: "ultrathink" silently ignored on Sonnet (ergonomics planner)
**Likelihood:** LIKELY (if not added to Sonnet task — which is the recommended approach)
**Impact:** LOW (ergonomics planner runs normally at standard cost; no behavior change)
**Mitigation:** Don't add ultrathink to Sonnet model tasks (by design, per Phase 2/3 plan)

### Risk 4: Model string format mismatch (`anthropic/claude-opus-4-7` vs `claude-opus-4-7`)
**Likelihood:** UNKNOWN — must verify in Phase 0.2
**Impact:** HIGH if broken (all Opus 4.7 agents silently fail; only Sonnet ergonomics survives)
**Mitigation:** Phase 0.2 empirical test; if broken, add model string normalization in `exec.ts` or `deep-plan.ts` before agent spawn

### Risk 5: Codex agent (robustness perspective) plus ultrathink = unknown behavior
**Likelihood:** UNKNOWN
**Impact:** UNKNOWN (potentially cost, potentially no-op, potentially error)
**Mitigation:** Explicitly exclude Codex/robustness perspective from ultrathink addition until behavior is confirmed (documented in Phase 3 as explicit non-change)

### Risk 6: Parallel thinking planners consume all available API concurrency
**Likelihood:** LOW-MEDIUM (depends on account rate limits)
**Impact:** MEDIUM (one or more planners receive rate limit errors → exitCode != 0 → filtered out)
**Mitigation:** Existing `filterViableResults` already handles this gracefully; add Phase 1 partial-success warning to make it visible

### Risk 7: No rollback mechanism if ultrathink causes persistent quality regression
**Likelihood:** LOW (thinking generally improves quality)
**Impact:** MEDIUM (plans are longer/different; beads may not match expectations)
**Mitigation:** The `DEEP_PLAN_TIMEOUT_MS` env var provides a partial lever; adding a `DEEP_PLAN_ENABLE_THINKING=false` env var would provide a clean disable toggle (add to Phase 1)

---

## 8. Operational Concerns

### 8.1 Environment Variable Controls
Recommend adding these env vars for operational control without code changes:
- `DEEP_PLAN_TIMEOUT_MS` (default: 600000) — adjust per environment
- `DEEP_PLAN_ENABLE_THINKING` (default: `true`) — set to `false` to disable ultrathink globally; useful for cost-sensitive environments or debugging
- `DEEP_PLAN_MIN_VIABLE_PLANNERS` (default: 1) — minimum number of planners that must succeed; if not met, surface an error instead of proceeding with degraded synthesis

### 8.2 Observability
Current state: minimal. `[deep-plan]` prefix on stderr warnings is good but not structured.
Recommended additions:
- Log elapsed time per agent to stderr when an agent completes (success or failure)
- Log the model used per agent so operators can trace which model caused a timeout
- Log total cost estimate (tokens × rate) if token counts are available in Claude CLI output

### 8.3 Deployment / Rollout
- Phase 1 (timeout/error hardening): deploy independently, no user-visible behavior change
- Phase 2 (ultrathink in CLI path): deploy behind `DEEP_PLAN_ENABLE_THINKING` env var defaulting to `false` initially; flip to `true` after Phase 0 empirical verification
- Phase 3 (ultrathink in MCP path): same env var controls both paths
- Phase 4 (cost advisory): deploy with Phase 2/3

### 8.4 Monitoring
After enabling thinking:
- Monitor p95 latency of deep-plan invocations
- Monitor rate of empty/degraded synthesis (0 or 1 viable planner)
- Monitor per-invocation cost if token reporting is available
- Alert if more than 2 consecutive deep-plan invocations produce zero viable results

### 8.5 Known Unknowns (Require Phase 0 Resolution)
1. Exact latency distribution for Opus 4.7 thinking on planning-scale tasks
2. Whether `anthropic/claude-opus-4-7` (prefixed) is accepted by `claude --model`
3. Whether "ultrathink" activates thinking on claude-sonnet-4-6
4. Token count typical for Opus 4.7 thinking on a planning task (for cost estimate accuracy)
5. Codex agent behavior with "ultrathink" in task text
6. Whether adaptive thinking is available on all Opus 4.7 API entitlements

---

## Summary of Required Changes (Priority Order)

| Priority | Phase | File | Change |
|---|---|---|---|
| P0 | 0 | (none) | Empirical verification: latency, model string, thinking activation |
| P1 | 1 | `deep-plan.ts` | Increase timeout to 10 min (env var configurable) |
| P1 | 1 | `deep-plan.ts` | Add DEEP_PLAN_ENABLE_THINKING env var toggle |
| P1 | 1 | `deep-plan.ts` | Empty-results warning + partial-success warning |
| P1 | 1 | `deep-plan.test.ts` | Add timeout, empty-results, partial-success test cases |
| P2 | 2 | `deep-plan.ts` | Model-conditional ultrathink prefix in task file (Opus 4.7 only) |
| P2 | 2 | `deep-plan.test.ts` | Add ultrathink presence/absence tests |
| P3 | 3 | `plan.ts` | Add ultrathink to correctness perspective task (Opus 4.7 only) |
| P3 | 3 | `plan.test.ts` | Add ultrathink presence/absence tests by perspective |
| P4 | 4 | `plan.ts` | Add cost advisory to deep-mode instructions |
