# Ergonomics Plan: Enable Opus 4.7 Adaptive Thinking in Deep-Plan Agents

Date: 2026-04-16
Perspective: Ergonomics
Scope: Adaptive thinking activation for deep-plan code paths; timeout bump; prompt unification

---

## 1. Architecture Overview

Two code paths drive deep-plan agents. Only one needs surgery; the other is already correct.

### MCP-driven path (primary)
`mcp-server/src/tools/plan.ts` constructs `basePrompt` (lines 205–222) and `synthesisPrompt` (lines 278–292) inline. These prompts are shipped verbatim as task strings to spawned agents. Neither contains "ultrathink". This is the primary gap.

`mcp-server/src/prompts.ts` exports `deepPlannerPrompt()` (line 1403) which **does** contain "Use ultrathink". It is a richer prompt with the Law of Rework Escalation framing and the eight required sections. It is currently used by the MCP `flywheel_plan` standard mode path but **not** by the inline `basePrompt` in `plan.ts`. This divergence is the architectural smell.

`planSynthesisPrompt()` in `prompts.ts` (line 1437) — used by the standard single-pass synthesizer — also lacks "ultrathink". The inline `synthesisPrompt` in `plan.ts` (lines 278–292) similarly lacks it.

### CLI-driven path (legacy)
`mcp-server/src/deep-plan.ts` runs `claude --print --tools read,bash,grep,find,ls --model <model>` with a 180-second timeout. "ultrathink" in the task file would reach the subprocess correctly. The timeout is the ergonomic concern: Opus 4.7 adaptive thinking routinely uses more wall time than Opus 4.6 ultrathink, and 3 minutes is tight.

### The unified fix
The correct ergonomic move is to use `deepPlannerPrompt()` from `prompts.ts` in `plan.ts` instead of the handrolled `basePrompt`. This is one import + one function call substitution. It eliminates prompt divergence, activates ultrathink automatically for all perspectives, and keeps the Law of Rework framing consistent with the rest of the system.

For synthesis: add "Use ultrathink." to `planSynthesisPrompt()` in `prompts.ts`. That one line propagates to both paths.

---

## 2. User Workflows

### Developer triggers deep-plan today (before fix)
1. `flywheel_plan` with `mode: "deep"` → `plan.ts` constructs `basePrompt` (no ultrathink).
2. Three agents spawn with this basePrompt. Opus 4.7 does NOT enter adaptive thinking mode.
3. Plans are competent but do not exploit Opus 4.7's full reasoning budget.
4. Synthesis agent similarly receives no ultrathink directive.

### Developer triggers deep-plan after fix
1. Same invocation path — no API change needed.
2. `plan.ts` calls `deepPlannerPrompt(goal, focus, repoContext, memorySection)` instead of assembling `basePrompt` inline.
3. Each spawned planner sees "Use ultrathink and produce ONE detailed markdown plan document."
4. Synthesis agent receives "Use ultrathink." at the top of `planSynthesisPrompt()`.
5. CLI path gets a 300-second (5-min) timeout.

### Developer who reads the code
- `plan.ts` becomes simpler: imports one function, calls it for each perspective.
- No inline prompt string to maintain in `plan.ts`; single source of truth in `prompts.ts`.
- Future prompt improvements in `deepPlannerPrompt()` automatically apply to deep-plan agents.

---

## 3. Data Model / Types

No type changes required. `deepPlannerPrompt()` already accepts the parameters needed:

```typescript
// prompts.ts — existing signature (line ~1380)
export function deepPlannerPrompt(
  goal: string,
  focus: 'correctness' | 'robustness' | 'ergonomics' | 'fresh-perspective',
  repoContext: string,
  memorySection?: string
): string
```

`plan.ts` already has `goal`, `memorySection`, and `profileSummary` (which serves as `repoContext`). The `focus` maps directly to the perspective strings already used in `planAgents`. Exact fit, zero type surgery.

---

## 4. API Surface

### Changes to `mcp-server/src/tools/plan.ts`

**Before (lines 205–222):**
```typescript
const basePrompt = `You are a planning agent for an agentic coding workflow.

**Goal:** ${goal}${constraintsSummary}
...
Focus deeply on your assigned perspective lens.`;
```

**After:**
```typescript
import { deepPlannerPrompt } from '../prompts.js';

// Remove basePrompt block entirely.
// In planAgents array, replace:
//   task: `${basePrompt}\n\n## Your perspective: CORRECTNESS\n...`
// with:
//   task: deepPlannerPrompt(goal, 'correctness', profileSummary, memorySection || undefined)
```

Each `planAgents` entry gets its own `deepPlannerPrompt()` call with the correct `focus` argument. The per-perspective prose that currently follows `${basePrompt}` is already inside `deepPlannerPrompt()` via `lensInstructions`. No content is lost.

### Changes to `mcp-server/src/prompts.ts` — `planSynthesisPrompt()`

Add "Use ultrathink." as the first sentence of both return branches (lines ~1462 and ~1489). The markdown return becomes:

```
## Plan Synthesis Instructions

Use ultrathink.

${plans.length} independent plan documents...
```

### Changes to `mcp-server/src/deep-plan.ts`

Bump `timeout: 180000` to `timeout: 300000` (5 minutes). This is a one-liner. It matches Opus 4.7's observed adaptive thinking latency (typically 2–4 minutes for complex plans).

### The inline `synthesisPrompt` in `plan.ts` (lines 278–292)

This string is used as instructions to the orchestrating agent (not the synthesis subprocess) in MCP-driven deep-plan mode. Add "Use ultrathink." to its first line. This activates thinking in the synthesis agent spawned by the coordinator.

---

## 5. Testing Strategy

### Unit tests (no infrastructure needed)

1. **Prompt content test**: assert `deepPlannerPrompt('goal', 'correctness', 'ctx')` contains the string "ultrathink".
2. **Synthesis prompt test**: assert `planSynthesisPrompt([...])` (markdown format) starts with or contains "ultrathink".
3. **plan.ts agent task test**: after the refactor, assert that each entry in `planAgents` has a `task` that includes "ultrathink" (prevents regression of the old `basePrompt` being put back).

These tests are pure string assertions. They run in milliseconds and catch the most common regression: someone refactors the prompt and drops ultrathink accidentally.

### Integration smoke test

The existing `runDeepPlanAgents` tests in the test suite exercise the CLI path. No changes needed there — the task content is passed through unchanged; the timeout bump is the only behavioral change.

### Manual verification

Run `flywheel_plan` with `mode: "deep"` on a small goal. Observe: (a) Opus 4.7 spends visible thinking time, (b) plan length increases, (c) no timeout errors. The 5-minute timeout leaves a comfortable margin.

---

## 6. Edge Cases & Failure Modes

### "ultrathink" on non-Opus models
The ergonomics model defaults to `anthropic/claude-sonnet-4-6` when Codex is unavailable. "ultrathink" is a Claude Code convention that activates extended thinking in Claude Code subprocesses regardless of model — it's not Opus-specific. Sonnet 4.6 will use its own extended thinking budget (smaller than Opus but still beneficial). No guard needed; the keyword is safe for all models.

### Prompt is longer after substituting deepPlannerPrompt
`deepPlannerPrompt()` is more verbose than `basePrompt` (~40 extra lines). The per-planner token budget increases modestly. At Opus 4.7's $5/MTok input rate, this is negligible (approximately $0.01 per deep-plan session increase). Acceptable.

### Timeout for large repositories
Five minutes is generous for most repos. For very large repos where profile scanning is slow, `writeProfileSnapshot` runs before planners start (in `deep-plan.ts`), so planner time is net of profiling. The 5-minute timeout is per-planner, and planners run in parallel, so wall time stays bounded.

### constraintsSummary is lost
`basePrompt` includes `${constraintsSummary}`. `deepPlannerPrompt()` does not have a constraints parameter. This is the one content difference to handle. Two options:

1. **Preferred (simpler)**: Append `constraintsSummary` to the `goal` string before passing it in: `deepPlannerPrompt(`${goal}${constraintsSummary}`, focus, ...)`. The function uses `goal` directly in the rendered output, so the constraints appear immediately after the goal statement.
2. Alternative: Add an optional `constraints` parameter to `deepPlannerPrompt()`. This is heavier than needed; prefer option 1.

### deepPlannerPrompt focus parameter vs fresh-perspective
The `lensInstructions` in `prompts.ts` includes a `'fresh-perspective'` key (line 1395). The type already accepts it. The optional 4th planner in `plan.ts` uses perspective `'fresh-perspective'`. This maps cleanly.

---

## 7. File Structure

Changes are confined to three files:

```
mcp-server/src/tools/plan.ts          -- Remove basePrompt, call deepPlannerPrompt() per agent
mcp-server/src/prompts.ts             -- Add "Use ultrathink." to planSynthesisPrompt()
mcp-server/src/deep-plan.ts           -- Bump timeout 180000 → 300000
```

Optional (test coverage):
```
mcp-server/src/tools/__tests__/plan.test.ts   -- Assert ultrathink present in each agent task
mcp-server/src/__tests__/prompts.test.ts      -- Assert ultrathink present in synthesis prompt
```

No new files. No new exports. No schema changes. No config changes.

---

## 8. Sequencing

All three changes are independent and can land in a single commit. Recommended order for review clarity:

1. **`prompts.ts`** — Add "Use ultrathink." to `planSynthesisPrompt()` (both branches). One-liner, zero risk, no dependencies.

2. **`deep-plan.ts`** — Bump timeout from 180000 to 300000. One-liner, zero risk.

3. **`plan.ts`** — The substantive change:
   a. Add import: `import { deepPlannerPrompt } from '../prompts.js';`
   b. Delete `basePrompt` block (lines 205–222).
   c. Rewrite each `planAgents` entry's `task` field to call `deepPlannerPrompt(...)`.
   d. Add "Use ultrathink." to the inline `synthesisPrompt` string (line 278).
   e. Handle `constraintsSummary` by prepending to goal.

4. **Tests** — Add string-assertion tests for ultrathink presence.

Total code change: approximately 30 lines removed, 20 lines added (net −10). This is a simplification, not a growth.

---

## Ergonomics Summary

The minimal correct change is:
- **Use `deepPlannerPrompt()` in `plan.ts`** instead of the inline `basePrompt`. This activates ultrathink, unifies the two prompt paths into one, and makes every future prompt improvement to `deepPlannerPrompt()` automatically apply to deep-plan agents. This is the ergonomically correct fix — not adding "ultrathink" as a string to yet another inline prompt.
- **Add "Use ultrathink." to `planSynthesisPrompt()`**. Single line. No structural change.
- **Bump CLI timeout to 300s**. Single line. Prevents false failures on Opus 4.7.

What to **not** do:
- Do not add a new `ultrathink` parameter to the MCP tool schema.
- Do not add model-conditional ultrathink logic ("only if Opus"). The keyword is safe on all models.
- Do not create a new prompt function for the synthesis agent. Reuse `planSynthesisPrompt()` with the one-line addition.
- Do not make timeout configurable (YAGNI). A constant bump is simpler and correct for the known workload.
