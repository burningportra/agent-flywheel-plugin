# Structured Error Contracts — Synthesized Plan

**Date:** 2026-04-18
**Scope:** All 8 `flywheel_*` MCP tools + `orch_*` aliases, supporting modules (`exec.ts`, `checkpoint.ts`, `deep-plan.ts`), and SKILL.md consumption patterns.
**Synthesizes:**
- `docs/plans/2026-04-18-correctness.md` (CoralGorge) — 12-code enum, per-tool audit, 5-phase migration.
- `docs/plans/2026-04-18-ergonomics.md` — envelope choice, helper API, hint rubric, 9th-tool walkthrough.
- `docs/plans/2026-04-18-robustness.md` — 16-code enum, exec signal audit, silent-catch audit, state invariants, rollback.

**Authoritative output for Phase 2 bead authors:** this document is self-contained. Do not read the three input plans to implement beads; all decisions are merged here.

---

## 1. Per-plan acknowledgement

### Correctness plan — what it does best
- **Definitive code justification.** Each proposed code includes a one-line justification + "retryable?" + "primary tools" column. No other plan ties codes to tool call graphs this tightly.
- **Honesty about rejected codes.** It calls out `agent_mail_unreachable`, `cache_stale`, `bead_state_drift`, `transient_exec_failure` and explains *why they are out of scope*. This saves future authors from re-litigating.
- **Per-tool audit with line numbers.** Sections 3.1–3.8 list exact line numbers for every error site in every tool. This is the only plan that maps "what exists today" to "what needs to change" at source-level fidelity.
- **Backward-compat proof.** Section 4 explicitly argues `orch_*` aliases inherit changes for free and tells you the one grep to run to verify.
- **Unique insight the others miss:** *tools that degrade gracefully should not return errors.* Section 3.1 argues `flywheel_profile`'s `br list` and `br --version` calls should stay warnings, not errors — only `profileRepo()` failure is fatal. This prevents code inflation of the error surface.

### Ergonomics plan — what it does best
- **Hint quality rubric with negative examples.** Section 4 ("Try again later.", "Something went wrong.", "Error: command failed") is the only concrete, testable standard for hint quality in any of the three plans.
- **Before/after SKILL.md code.** Section 3's `handlers: Record<string, () => Promise<void>>` pattern shows the orchestrator branching shape the contract is ultimately serving. This is the single most important alignment artifact for Phase 2 bead authors.
- **9th-tool walkthrough.** Section 8's 10-step checklist for adding a new tool with the new contract is the closest thing to a template the repo will have.
- **Retry UX policy.** Max 2 retries, `250ms` / `1000ms` backoff, idempotency gate for mutating actions — operational numbers the other plans leave as "TBD".
- **Unique insight the others miss:** *both* throw and return envelopes are needed. Return envelope for tool boundaries; `throwFlywheelError(...)` for nested helpers where threading a return type is noisy. The central handler converts the throw to a return at the boundary.

### Robustness plan — what it does best
- **Failure-mode scenarios per code.** Section 1's A/B/C scenarios for `CLI_TIMEOUT`, `CHECKPOINT_CORRUPT`, `DEEP_PLAN_ALL_FAILED`, `EMPTY_PLAN` are the only adversarial thinking in the three plans — they surface the zombie-subprocess risk, the NFS rename hazard, and the `(No planner outputs provided.)` substring bug.
- **exec() signal audit.** Section 5 enumerates all 19 sites missing `signal`, with file/line/command/timeout — the most actionable table in any of the plans.
- **Silent-catch audit.** Section 8's catalog of 8 silent catches (with the code each should emit) is the robustness plan's core contribution.
- **State invariants table.** Section 2's field-pair invariants (`phase + selectedGoal`, `phase + planDocument`, etc.) is the only durable articulation of what "successful saveState" must mean.
- **Rollback paths table.** Section 4's per-tool mutation × failure × rollback-needed matrix is the blueprint for preventing the `flywheel_plan` "file-not-written-but-state-set" bug class.
- **Unique insight the others miss:** *sentinel strings masquerading as content*. Section 8 Pattern B — the `"(No planner outputs provided.)"` substring check, the `"(AGENT RETURNED EMPTY — …)"` startsWith, and the empty-string bypass — all point to a single structural mistake: preconditions on non-emptiness instead of non-sentinel-ness. No other plan names this pattern.

---

## 2. Unified Error Code Enum (definitive)

### Reconciling correctness's 12 vs robustness's 16

Robustness proposes 16 codes. Correctness proposes 12 and rejects 4 (`agent_mail_unreachable`, `cache_stale`, `bead_state_drift`, `transient_exec_failure`). Robustness's extra codes over correctness are:

| Robustness extra code | Decision | Rationale |
|---|---|---|
| `schema_drift` | **Merge into `parse_failure`** with `details.reason = "schema_drift"`. Schema drift is a subtype of parse failure; callers branching on it is premature. |
| `checkpoint_corrupt` | **Keep as a discrete code.** This is *not* a tool-surface error — checkpoint corruption is a session-startup concern surfaced by the server, not a tool return. But adding it to the enum lets `log.warn` in `checkpoint.ts` emit a structured `code`. It will never appear in a tool's `FlywheelStructuredError` return, only in stderr logs. |
| `partial_state` | **Keep as a discrete code.** Same rationale as `checkpoint_corrupt`: logging-only. Fires when `saveState` returns `false` after a phase transition. |
| `concurrent_write` | **Keep.** This *will* be returned by tools (`flywheel_review`, `flywheel_approve_beads` action=start) when the per-bead or per-cwd mutex is held. |
| `bead_cycle` | **Reject.** Beads dependency cycle is detected by `br` CLI itself, not by MCP tools. If `br ready` surfaces a cycle, it's a `cli_failure` with `details.reason = "bead_cycle"`. |
| `empty_plan` | **Keep.** Pattern B from robustness — a non-empty string that is semantically empty (the sentinel). Distinct from `invalid_input` because the input *looked* valid to the type system. This is the bug from commit 40be5db. Separating it enables a discrete test and a discrete SKILL.md branch ("re-run deep plan"). |
| `agent_mail_unreachable` | **Reject** (agrees with correctness). Agent Mail is probed at SKILL.md Step 0b, not inside MCP tools. |
| `git_dirty` | **Reject.** Not raised by any of the 8 tools today. Future tools (e.g., a hypothetical `flywheel_release`) can add it then. |
| `deep_plan_all_failed` | **Keep.** Robustness Section 1 argues this must be a hard error surfaced to the LLM, not a degraded empty result. Correctness lumps this into `internal_error`; that's wrong because SKILL.md wants to branch ("retry mode=standard"). |
| `retry_storm` | **Reject.** This is an attribute of `cli_failure` (exceeded `maxRetries`), not a separate category. Surface via `details.retryCount`. |
| `cli_unavailable` / `cli_not_available` | **Keep** (correctness uses `cli_not_available`; robustness uses `cli_unavailable`). **Final name: `cli_not_available`** — consistent with correctness's `cli_failure` / `cli_not_available` pair; `unavailable` is ambiguous with "degraded". |
| `cli_timeout` / `exec_timeout` | **Final name: `exec_timeout`** (correctness's term). The subject is the exec layer, not the CLI contract. |
| `cli_aborted` / `exec_aborted` | **Final name: `exec_aborted`**. Same rationale. |

### Definitive 13-code enum

```typescript
export const FLYWHEEL_ERROR_CODES = [
  // Input / prerequisite (caller must fix input)
  'missing_prerequisite',   // Phase order violated (no profile, no goal, no plan)
  'invalid_input',          // Malformed or empty required args
  'not_found',              // Referenced artifact (bead, plan file) doesn't exist
  // CLI layer (external command outcome)
  'cli_failure',            // br/cm/git exited non-zero
  'cli_not_available',      // Binary not installed (br/cm/ccc `which` failed)
  // Parse layer (CLI output malformed)
  'parse_failure',          // JSON.parse or schema mismatch on CLI stdout
  // Exec layer (subprocess lifecycle)
  'exec_timeout',           // timeout fired — child was SIGTERMed
  'exec_aborted',           // AbortSignal from MCP client cancelled the request
  // State (session / concurrency)
  'blocked_state',          // Phase allowlist rejected this action
  'concurrent_write',       // Per-bead / per-cwd mutex held by another in-flight call
  // Orchestration (multi-subprocess outcomes)
  'deep_plan_all_failed',   // All parallel planners produced no viable output
  'empty_plan',             // planContent is empty / whitespace / a known sentinel
  // Bead lifecycle
  'already_closed',         // Requested operation inapplicable — bead is closed
  // Action dispatch
  'unsupported_action',     // Unknown action / advancedAction parameter
  // Catch-all (only when no other code fits — rare)
  'internal_error',
] as const;

export type FlywheelErrorCode = typeof FLYWHEEL_ERROR_CODES[number];
```

That is **15 codes** (the four "keep"s + correctness's 11 = 15 after removing the duplicates). Let me re-count:

`missing_prerequisite`, `invalid_input`, `not_found`, `cli_failure`, `cli_not_available`, `parse_failure`, `exec_timeout`, `exec_aborted`, `blocked_state`, `concurrent_write`, `deep_plan_all_failed`, `empty_plan`, `already_closed`, `unsupported_action`, `internal_error` = **15 codes**.

Robustness's `checkpoint_corrupt` and `partial_state` are logging-only and do not appear in the tool return surface. They live as literal string tags in `log.warn({ code: 'checkpoint_corrupt', ... })` but are intentionally **excluded from `FlywheelErrorCode`** to keep the tool-return type minimal. SKILL.md never sees them; operator logs do.

### Retryable defaults per code

| Code | `retryable` default | When to override |
|---|---|---|
| `missing_prerequisite` | `false` | Never. |
| `invalid_input` | `false` | Never. |
| `not_found` | `false` | Never — retrying won't make the file appear. |
| `cli_failure` | `true` | Set `false` when stderr indicates a deterministic error (e.g., `br: bead does not exist`). |
| `cli_not_available` | `false` | Never — install required. |
| `parse_failure` | `false` | Never — upstream format must be fixed. |
| `exec_timeout` | `true` | Set `false` if the same call has already timed out twice in this session. |
| `exec_aborted` | `false` | Client explicitly cancelled — do not retry. |
| `blocked_state` | `true` | After backoff. |
| `concurrent_write` | `true` | After short backoff (`250ms`, `1000ms`). |
| `deep_plan_all_failed` | `true` | With `hint: "Retry with mode=standard as fallback."` |
| `empty_plan` | `false` | Upstream produced a sentinel — re-running same call reproduces same sentinel. |
| `already_closed` | `false` | Never. |
| `unsupported_action` | `false` | Never. |
| `internal_error` | `true` | With 1 retry cap. |

---

## 3. Envelope Shape (single authoritative schema)

Correctness's envelope shape + ergonomics's required-fields list, derived from Zod so TypeScript and runtime validation stay in sync. Zod is already a dependency (`mcp-server/package.json` has `"zod": "^4.3.6"`).

### TypeScript + Zod (authoritative)

Target file: **`mcp-server/src/errors.ts`** (new).

```typescript
import { z } from 'zod';

export const FLYWHEEL_ERROR_CODES = [
  'missing_prerequisite', 'invalid_input', 'not_found',
  'cli_failure', 'cli_not_available', 'parse_failure',
  'exec_timeout', 'exec_aborted',
  'blocked_state', 'concurrent_write',
  'deep_plan_all_failed', 'empty_plan',
  'already_closed', 'unsupported_action', 'internal_error',
] as const;

export const FlywheelErrorCodeSchema = z.enum(FLYWHEEL_ERROR_CODES);
export type FlywheelErrorCode = z.infer<typeof FlywheelErrorCodeSchema>;

export const FlywheelToolErrorSchema = z.object({
  code: FlywheelErrorCodeSchema,
  message: z.string(),                             // human-readable; not for branching
  retryable: z.boolean().optional(),               // default read from table above
  hint: z.string().optional(),                     // actionable next step (see rubric)
  cause: z.string().optional(),                    // upstream err.message / stderr
  phase: z.string().optional(),                    // duplicate of envelope.phase
  tool: z.string().optional(),                     // duplicate of envelope.tool
  timestamp: z.string().optional(),                // ISO-8601, auto-populated
  details: z.record(z.unknown()).optional(),       // structured debug bag
});
export type FlywheelToolError = z.infer<typeof FlywheelToolErrorSchema>;

export const FlywheelStructuredErrorSchema = z.object({
  tool: z.string(),
  version: z.literal(1),
  status: z.literal('error'),
  phase: z.string(),
  data: z.object({
    kind: z.literal('error'),
    error: FlywheelToolErrorSchema,
  }),
});
export type FlywheelStructuredError = z.infer<typeof FlywheelStructuredErrorSchema>;
```

In `types.ts`, replace the inline `FlywheelToolError` / `FlywheelStructuredError` interfaces with re-exports:

```typescript
export type { FlywheelErrorCode, FlywheelToolError, FlywheelStructuredError } from './errors.js';
export { FLYWHEEL_ERROR_CODES, FlywheelStructuredErrorSchema } from './errors.js';
```

This avoids a type duplication split-brain.

### Field rationale (reconciled)

- **`code`** — from all three plans. The only field callers branch on.
- **`message`** — from all three. Human-readable, not machine.
- **`retryable`** — from all three. Optional; treated as `false` if absent.
- **`hint`** — from correctness + ergonomics. Actionable next step (see §6 rubric).
- **`cause`** — from correctness. Upstream `err.message` or `stderr`; preserves chain.
- **`phase`** / **`tool`** — from correctness. Redundant with envelope but valuable for flat stderr log lines.
- **`timestamp`** — from correctness + ergonomics. Auto-populated via `new Date().toISOString()`.
- **`details`** — from all three. Arbitrary structured bag (e.g., `{ command: 'br list', exitCode: 1, elapsedMs: 8200 }`).

---

## 4. Error Helper API (resolving "both" proposal)

Ergonomics asked for `makeFlywheelErrorResult` + `throwFlywheelError` + `FlywheelError`. Correctness asked for just `makeToolError` (already exists). This is resolved as:

### Three helpers, one source of truth

Target file: **`mcp-server/src/errors.ts`**.

```typescript
import type { FlywheelToolName, FlywheelPhase, McpToolResult } from './types.js';

/** Internal error class for deep helper paths. Never escapes beyond the tool boundary. */
export class FlywheelError extends Error {
  readonly code: FlywheelErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly cause?: string;
  readonly details?: Record<string, unknown>;
  constructor(input: Omit<FlywheelToolError, 'message' | 'phase' | 'tool' | 'timestamp'> & { message: string }) {
    super(input.message);
    this.name = 'FlywheelError';
    this.code = input.code;
    this.retryable = input.retryable ?? DEFAULT_RETRYABLE[input.code];
    this.hint = input.hint;
    this.cause = input.cause;
    this.details = input.details;
  }
}

/** Convenience throw for nested helpers. Caught at the tool boundary or central handler. */
export function throwFlywheelError(
  input: Omit<FlywheelToolError, 'message' | 'phase' | 'tool' | 'timestamp'> & { message: string }
): never {
  throw new FlywheelError(input);
}

/** Tool-boundary helper: returns a valid McpToolResult<FlywheelStructuredError>. */
export function makeFlywheelErrorResult(
  tool: FlywheelToolName,
  phase: FlywheelPhase,
  input: Omit<FlywheelToolError, 'phase' | 'tool' | 'timestamp'>
): McpToolResult<FlywheelStructuredError> {
  const error: FlywheelToolError = {
    ...input,
    retryable: input.retryable ?? DEFAULT_RETRYABLE[input.code],
    phase,
    tool,
    timestamp: new Date().toISOString(),
  };
  return {
    content: [{ type: 'text', text: input.message }],
    isError: true,
    structuredContent: {
      tool, version: 1, status: 'error', phase,
      data: { kind: 'error', error },
    },
  };
}

const DEFAULT_RETRYABLE: Record<FlywheelErrorCode, boolean> = { /* per §2 table */ };
```

### Compatibility with existing `makeToolError`

Keep `makeToolError` in `tools/shared.ts` as a **thin wrapper** so existing call sites don't break during staged migration:

```typescript
export function makeToolError(
  tool: FlywheelToolName, phase: FlywheelPhase, code: FlywheelErrorCode,
  message: string, options: Omit<FlywheelToolError, 'code' | 'message'> = {}
): McpToolResult<FlywheelStructuredError> {
  return makeFlywheelErrorResult(tool, phase, { code, message, ...options });
}
```

Phase 2 beads can land `makeFlywheelErrorResult` for new sites while `makeToolError` continues to work. A future cleanup bead removes `makeToolError`.

### Usage policy (from ergonomics, ratified)

- **Top-level tool handlers (`run*`):** `return makeFlywheelErrorResult(...)`.
- **Nested helpers (`deep-plan.ts::runDeepPlanAgents`, `checkpoint.ts::writeCheckpoint`):** `throwFlywheelError(...)` and catch at the tool boundary.
- **Central handler (`server.ts::createCallToolHandler`):** already wraps in `try/catch` and converts raw thrown `Error` to `makeToolError(..., 'internal_error', ..., { retryable: true })`. Add a pre-check:
  ```typescript
  } catch (err: unknown) {
    if (err instanceof FlywheelError) {
      return makeFlywheelErrorResult(name, state.phase, {
        code: err.code, message: err.message, retryable: err.retryable,
        hint: err.hint, cause: err.cause, details: err.details,
      });
    }
    log.error('Tool error', { tool: name, err: String(err) });
    return makeFlywheelErrorResult(name, state.phase, {
      code: 'internal_error', message: `Error in ${name}: ${(err as Error)?.message ?? String(err)}`,
      retryable: true, cause: String(err),
    });
  }
  ```

---

## 5. Client Consumption Patterns (SKILL.md)

### Before (string-coupled — fragile)

```md
If the tool errors and the error text contains "missing_prerequisite", bootstrap the goal first by calling flywheel_select with an LLM-synthesized goal.
```

### After (code-coupled — deterministic)

```ts
// Pseudocode the SKILL.md orchestrator executes
const res = await flywheel_approve_beads({ cwd, action: 'start' });
const sc = res.structuredContent;

if (sc?.status === 'error') {
  const err = sc.data.error;
  switch (err.code) {
    case 'missing_prerequisite':
      // Bootstrap goal + re-call
      await synthesizeGoalAndCallSelect(cwd);
      return await flywheel_approve_beads({ cwd, action: 'start' });
    case 'cli_not_available':
      // Surface install instructions from err.hint
      return showInstallGuide(err.hint);
    case 'concurrent_write':
      await sleep(err.retryable ? 1000 : 0);
      return await flywheel_approve_beads({ cwd, action: 'start' });
    case 'deep_plan_all_failed':
      // Retry with standard mode as fallback (hint says so)
      return await flywheel_plan({ cwd, mode: 'standard' });
    case 'empty_plan':
    case 'parse_failure':
    case 'invalid_input':
    case 'not_found':
    case 'unsupported_action':
    case 'already_closed':
      // Fatal — surface hint to user, do not auto-retry
      return escalate(err);
    case 'cli_failure':
    case 'exec_timeout':
    case 'internal_error':
      // Retry policy per §6 (max 2, 250ms/1000ms backoff)
      return await withRetry(() => flywheel_approve_beads({ cwd, action: 'start' }));
    case 'exec_aborted':
      // Client cancelled — exit cleanly
      return;
    case 'blocked_state':
      // Phase not ready — display hint and wait
      return waitAndHint(err.hint);
  }
}
```

The key change: `SKILL.md` has a **finite list of codes to branch on** (15), and every one has a deterministic recovery. Adding a new tool never requires an SKILL.md update unless the tool introduces a new code (at which point the enum grows by one).

---

## 6. Hint Quality Rubric (from ergonomics, preserved)

### Rubric

A hint must:
1. **Name the failing precondition or command.** ("state.selectedGoal is empty", "br list --json returned exit 127").
2. **Provide one immediate next action.** ("Call flywheel_select first.", "Install br: npm install -g @beads-rust/br".)
3. **Stay under ~140 chars** unless a path/command is required.
4. **Avoid stack traces.** Put diagnostics in `details`/logs.
5. **Be deterministic.** Don't say "maybe"; say what to do.

### Examples — good

1. `Call flywheel_select before flywheel_approve_beads. state.selectedGoal is empty.`
2. `br list --json failed. Install br and run \`br init\` in this repo, then retry.`
3. `planFile not found at docs/plans/2026-04-18-x.md. Write the file first or pass a valid relative path from cwd.`
4. `Deep plan: 0/4 planners produced output. Retry with mode="standard" as fallback.`
5. `cm (CASS memory) not installed. Install: npm install -g @cass/cm, then retry.`

### Examples — bad

1. `Try again later.` (not actionable)
2. `Something went wrong.` (no precondition named)
3. `Error: command failed` (no command, no reason, no next step)
4. `CLI error: exit code 1` (which CLI? what command? why?)
5. `Retry the operation.` (doesn't say under what condition the retry will succeed)

### Testability

A unit test scans all `makeFlywheelErrorResult` call sites (via AST or regex on src) and asserts each literal `hint:` string is ≤ 140 chars AND starts with a capital letter AND ends with a period. CI-enforceable.

---

## 7. Per-Tool Migration Order (5 phases, stage-able)

Adopted from correctness's Phase 1–5 ordering, annotated with robustness's staging. Each phase ships as its own PR and is non-breaking.

### Phase 1 — Foundation (types + helpers)
1. **New file: `mcp-server/src/errors.ts`** — Zod schema, `FlywheelError` class, `throwFlywheelError`, `makeFlywheelErrorResult`, `DEFAULT_RETRYABLE` table.
2. **`types.ts`** — Re-export from `errors.ts`; delete inline interface.
3. **`shared.ts::makeToolError`** — Reduce to thin wrapper over `makeFlywheelErrorResult`.
4. **`server.ts::createCallToolHandler`** — Add `instanceof FlywheelError` branch before the generic `internal_error` fallthrough (see §4).
5. **Ship bead:** "Introduce `errors.ts` with Zod-backed types and helpers."

### Phase 2 — Fully unstructured tools (highest impact)
6. **`memory-tool.ts`** — All 5 error paths (lines 19, 30, 37, 52, 75) converted to `makeFlywheelErrorResult`. New code `cli_not_available` usage.
7. **`profile.ts`** — Wrap `profileRepo()` in try/catch → `cli_failure`. Wrap `loadCachedProfile` → `parse_failure` with `retryable: true, hint: "Pass force:true to bypass cache"`. Leave `br list` / `br --version` as graceful-degrade warnings (per correctness §3.1).
8. **Ship bead:** "Structure errors in flywheel_memory and flywheel_profile."

### Phase 3 — Partially structured tools (type safety)
9. **`review.ts`** — Type local `errorResult`: `code: string` → `code: FlywheelErrorCode`. Delegate to `makeFlywheelErrorResult`. Replace the `ready = []` silent catch (line 368) with `parse_failure` return.
10. **`plan.ts`** — Replace the raw `throw new Error("Deep plan failed…")` (line 113) with `makeFlywheelErrorResult(..., 'deep_plan_all_failed', …)`. Add `empty_plan` pre-check (see §8 guardrails).
11. **Ship bead:** "Structure errors in flywheel_review and flywheel_plan."

### Phase 4 — Already correct tools (consistency pass)
12. **`approve.ts`** — Fix bare `isError` return at line 793 (unknown `advancedAction` → `unsupported_action`). Refactor `makeApproveError` to internally call `makeFlywheelErrorResult` while preserving the `ApproveStructuredContent` wrapper.
13. **`verify-beads.ts`** — Add try/catch around `verifyBeadsClosed()` → `cli_failure`.
14. **`discover.ts`** / **`select.ts`** — Add `hint` to existing errors. No structural change.
15. **Ship bead:** "Consistency pass on remaining tools."

### Phase 5 — exec layer + signal propagation + silent catches
16. **`types.ts::ToolContext`** — Add `signal?: AbortSignal`.
17. **`server.ts`** — Bind a per-request `AbortController`, pass `signal` through `ctx`.
18. **All 19 exec sites (§10)** — Add `signal: ctx.signal`.
19. **`exec.ts`** — Convert timeout and abort rejections into discriminated objects so tool handlers can map them to `exec_timeout` / `exec_aborted`. Use message-match fallback if AGENTS.md forbids custom error classes (see §15).
20. **8 silent catches (§11)** — Replace with `log.warn({ code, ... })`.
21. **Ship bead:** "Propagate AbortSignal, structure exec errors, and close silent catches."

---

## 8. Rollback + State Invariants

### State invariants (from robustness §2)

These must hold post-`saveState`:

| Field pair | Invariant |
|---|---|
| `phase` + `selectedGoal` | `phase ∈ {planning, awaiting_plan_approval, creating_beads, awaiting_bead_approval, implementing, reviewing, iterating}` ⇒ `selectedGoal` non-empty. |
| `phase` + `planDocument` | `phase === 'awaiting_plan_approval'` ⇒ `planDocument` non-empty. |
| `phase` + `activeBeadIds` | `phase ∈ {implementing, reviewing}` ⇒ `activeBeadIds.length > 0`. |
| `beadResults[id].status` + bead CLI | `beadResults[id].status === 'success'` ⇒ `br show id` reports `closed`. |
| `polishRound` + `polishChanges.length` | Equal counts. |

### `saveState` must return boolean

From robustness §2 Gap A: `saveState` currently discards the `writeCheckpoint` boolean. Change:

```typescript
export async function saveState(cwd: string, state: FlywheelState): Promise<boolean> {
  const ok = await writeCheckpoint(cwd, state);
  if (!ok) log.warn('saveState failed — checkpoint not persisted', {
    code: 'partial_state', phase: state.phase, cwd
  });
  return ok;
}
```

Tool handlers should surface `checkpointPersisted: false` in their `structuredContent.data` when `saveState` returns `false` but the call otherwise succeeded. This is *not* an error — the call succeeded — but the caller should know the state might not survive restart.

### Rollback wrappers (from robustness §4)

| Tool / mutation | Failure mode | Required rollback |
|---|---|---|
| `flywheel_plan` writes `.md` | write throws | Do not set `state.planDocument` or `state.phase`. Return `cli_failure`. |
| `flywheel_approve_beads` action=start | `br update <id> --status in_progress` fails mid-loop | Roll back already-updated beads to `open` with `br update <id> --status open`. Return `cli_failure` with `details.partialRollback: true`. |
| `flywheel_review` action=looks-good | `saveState` returns `false` after `br update --status closed` | Do not revert `br` state (idempotent); log `partial_state`; return success with `checkpointPersisted: false` warning. |

### Zod validation on saveState (from correctness §5)

Before persisting, run the state shape through a `FlywheelStateSchema` (defined alongside the existing error schema). If it fails validation, **do not write the checkpoint**. Return the checkpoint's previous contents untouched and emit `log.error({ code: 'internal_error', reason: 'state_schema_validation_failed' })`. This prevents corrupt checkpoints from poisoning future sessions.

### Sentinel-string guardrails (from robustness §8)

Add to `plan.ts` before writing the plan file:

```typescript
function assertPlanContentSubstance(content: string): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throwFlywheelError({ code: 'empty_plan', message: 'planContent is empty or whitespace.' });
  }
  if (trimmed === '(No planner outputs provided.)') {
    throwFlywheelError({ code: 'empty_plan', message: 'planContent is the failure sentinel, not a real plan.' });
  }
  if (trimmed.startsWith('(AGENT')) {
    throwFlywheelError({
      code: 'empty_plan',
      message: `planContent is an agent failure sentinel: ${trimmed.slice(0, 80)}`,
      details: { sentinelPrefix: '(AGENT' },
    });
  }
  if (trimmed.split('\n').length < 10) {
    throwFlywheelError({
      code: 'empty_plan',
      message: `planContent has only ${trimmed.split('\n').length} lines — too short to be a real plan.`,
      details: { lineCount: trimmed.split('\n').length },
    });
  }
}
```

Parallel guard in `deep-plan.ts::runDeepPlanAgents` — after `filterViableResults`, if the filtered list is empty, throw `deep_plan_all_failed`.

---

## 9. Concurrent Invocation Safety

### Per-process mutex (immediate, from robustness §3)

Module-level `Set<string>` in `review.ts` and `approve.ts`:

```typescript
// review.ts — module level
const _beadOpInFlight = new Set<string>();

export async function runReview(ctx: ToolContext, args: ReviewArgs) {
  const { beadId } = args;
  if (_beadOpInFlight.has(beadId)) {
    return makeFlywheelErrorResult('flywheel_review', state.phase, {
      code: 'concurrent_write',
      message: `Bead ${beadId} is being processed — retry after current operation completes.`,
      retryable: true, hint: 'Wait ~1s and retry.',
      details: { beadId },
    });
  }
  _beadOpInFlight.add(beadId);
  try {
    // existing logic
  } finally {
    _beadOpInFlight.delete(beadId);
  }
}
```

Same pattern for `approve.ts::handleStart` with a per-cwd key (`action=start` mutates ready-bead list, not a single bead).

### Cross-process coordination (deferred to Agent Mail)

Per-process locks don't guard two worktrees pointing at the same `.pi-flywheel`. For that, Agent Mail's file reservation API (`mcp__mcp-agent-mail__file_reservation_paths`) reserves the checkpoint path. Integration point:
- `saveState` optionally calls Agent Mail to reserve `.pi-flywheel/checkpoint.json` before write.
- If Agent Mail is unavailable (per SKILL.md Step 0b probe), fall back to `writeLocks` only — log `warn` that cross-process safety is off.

This is **out of scope** for the 5 migration phases but mentioned so bead authors don't redesign it later.

---

## 10. exec() signal propagation audit (verified 19 sites)

Verified via `grep -n "await exec(" mcp-server/src/tools/**/*.ts`. The count matches robustness's claim: **19 sites** in tool files, all missing `signal`.

| # | File | Line | Command | Timeout (ms) |
|---|---|---|---|---|
| 1 | `tools/memory-tool.ts` | 15 | `cm --version` | 5000 |
| 2 | `tools/memory-tool.ts` | 36 | `cm add <content>` | 10000 |
| 3 | `tools/memory-tool.ts` | 52 | `cm ls --limit 10` | 10000 |
| 4 | `tools/memory-tool.ts` | 74 | `cm context <query> --json` | 10000 |
| 5 | `tools/profile.ts` | 50 | `br --version` | 5000 |
| 6 | `tools/profile.ts` | 84 | `br list --json` | 10000 |
| 7 | `tools/approve.ts` | 158 | `br list --json` | 10000 |
| 8 | `tools/approve.ts` | 448 | `br ready --json` | 10000 |
| 9 | `tools/approve.ts` | 489 | `br update <id> --status in_progress` (loop) | 5000 |
| 10 | `tools/review.ts` | 97 | `br show <id> --json` | 8000 |
| 11 | `tools/review.ts` | 164 | `br update <id> --status deferred` | 5000 |
| 12 | `tools/review.ts` | 180 | `br update <id> --status closed` | 5000 |
| 13 | `tools/review.ts` | 195 | `br list --json` (parent auto-close) | 8000 |
| 14 | `tools/review.ts` | 202 | `br update <parent> --status closed` | 5000 |
| 15 | `tools/review.ts` | 362 | `br ready --json` | 8000 |
| 16 | `tools/review.ts` | 405 | `br update <next> --status in_progress` | 5000 |
| 17 | `tools/review.ts` | 436 | `br update <id> --status in_progress` (loop) | 5000 |
| 18 | `tools/verify-beads.ts` | 65 | `git log --grep <beadId>` | 5000 |
| 19 | `tools/verify-beads.ts` | 74 | `br update <id> --status closed` | 5000 |

`deep-plan.ts:102` already passes `signal` correctly. `bead-review.ts:74` is in `pi` CLI code path and should also be updated, but it's outside the 8-tool contract scope.

**Fix:** add `signal?: AbortSignal` to `ToolContext`, bind `AbortController` per-request in `server.ts`, and update all 19 sites to `{ cwd, timeout: N, signal: ctx.signal }`.

---

## 11. Silent catch audit (verified 8 sites)

Verified via `grep -nE "catch\s*(\([^)]*\))?\s*\{" mcp-server/src --include="*.ts"` excluding tests. The 8 silent catches that warrant structured logging:

| # | File:Line | Context | Code to emit on entry |
|---|---|---|---|
| 1 | `beads.ts:549` | Orphan detection `// Non-fatal` | `log.warn({ code: 'parse_failure', reason: 'orphan_scan_failed' })` |
| 2 | `beads.ts:627` | Template hygiene scan `// Non-fatal` | `log.warn({ code: 'parse_failure', reason: 'template_scan_failed' })` |
| 3 | `tools/review.ts:206` | Parent auto-close parse `/* parse failure ok */` | `log.warn({ code: 'parse_failure', reason: 'parent_auto_close_skipped' })` — *no tool error return* (this is a best-effort branch) |
| 4 | `tools/review.ts:368` | `br ready` parse fallback `ready = []` | **Tool-return error:** `parse_failure` with `hint: "br ready produced malformed JSON — fall back to manual bead selection"`. Do NOT silently set `ready = []`; that caused the "all done" false positive. |
| 5 | `feedback.ts:96` | Feedback loading `return []` | `log.warn({ code: 'parse_failure', reason: 'feedback_load_failed' })` |
| 6 | `feedback.ts:306` | Feedback write `/* best-effort */` | `log.warn({ code: 'cli_failure', reason: 'feedback_write_failed' })` |
| 7 | `tools/discover.ts:71` | Tmpdir artifact write `/* best-effort */` | `log.warn({ code: 'cli_failure', reason: 'artifact_write_failed' })` |
| 8 | `checkpoint.ts:290-292` | `moveToCorrupt` failure `// Give up silently` | `log.error({ code: 'internal_error', reason: 'quarantine_failed' })` |

Rule: **no silent catches in non-test src.** Every catch must either (a) log with a `code` tag, (b) throw a `FlywheelError`, or (c) return a `makeFlywheelErrorResult`.

---

## 12. Test Plan (merged — no duplication)

Target files and what each covers:

### `__tests__/error-contract.test.ts` (new)

From correctness §7.1 + robustness §7:
- `makeFlywheelErrorResult` returns a valid `FlywheelStructuredError` envelope.
- `FLYWHEEL_ERROR_CODES` has exactly 15 entries.
- `timestamp` is auto-populated and ISO-8601.
- `retryable` defaults match `DEFAULT_RETRYABLE` table.
- All `FLYWHEEL_ERROR_CODES` round-trip through Zod `FlywheelToolErrorSchema.parse`.
- `FlywheelError` thrown deep is converted to `makeFlywheelErrorResult` at the central handler (integration-style test with a mock tool).
- `throwFlywheelError` preserves `code`, `hint`, `cause`, `details` across `try/catch`.
- Hint rubric CI check: every literal `hint:` in `mcp-server/src/tools/**` is ≤ 140 chars, capitalized, ends with period.

### Per-tool fault-injection tests

Merged table from robustness §7 + correctness §7.2:

| Code to exercise | Fault to inject | Test file | Status |
|---|---|---|---|
| `cli_not_available` | `cm --version` exits 127 | `tools/memory-tool.test.ts` (new) | Missing |
| `invalid_input` (memory) | `content` empty on store | `tools/memory-tool.test.ts` | Missing |
| `cli_failure` (memory store) | `cm add` exits 1 | `tools/memory-tool.test.ts` | Missing |
| `cli_failure` (memory list) | `cm ls` exits 1 | `tools/memory-tool.test.ts` | Missing |
| `cli_failure` (memory search) | `cm context` exits 1 | `tools/memory-tool.test.ts` | Missing |
| `cli_failure` (profile) | `profileRepo()` throws | `profiler.test.ts` | Missing |
| `parse_failure` (profile cache) | corrupt JSON in `loadCachedProfile` | `profiler.test.ts` | Missing |
| `empty_plan` (empty string) | `planContent = ""` | `tools/plan.test.ts` | Missing |
| `empty_plan` (whitespace) | `planContent = "   "` | `tools/plan.test.ts` | Missing |
| `empty_plan` (sentinel) | `planContent = "(No planner outputs provided.)"` | `tools/plan.test.ts` | Missing |
| `empty_plan` (agent sentinel) | `planContent.startsWith('(AGENT')` | `tools/plan.test.ts` | Missing |
| `deep_plan_all_failed` | All `exec('claude', …)` return code 1 | `deep-plan.test.ts` | Partial (filter tested; tool-level not) |
| `exec_timeout` (plan) | `exec` throws `Timed out after 420000ms` | `tools/plan.test.ts` | Missing |
| `exec_timeout` (review) | `exec` throws timeout at `br show` | `tools/review.test.ts` | Missing |
| `exec_aborted` | `AbortController.abort()` during exec | `exec.test.ts` (extend) | Missing |
| `parse_failure` (review br ready) | `br ready --json` returns malformed JSON | `tools/review.test.ts` | Missing |
| `parse_failure` (approve br list) | `br list --json` malformed | `tools/approve.test.ts` | Present (line ~94) |
| `concurrent_write` (review) | Two concurrent `runReview` for same beadId | `tools/review.test.ts` | Missing |
| `concurrent_write` (approve start) | Two concurrent `action=start` for same cwd | `tools/approve.test.ts` | Missing |
| `already_closed` | `br show` returns `closed`, action=`skip` | `tools/review.test.ts` | Present (line ~549) |
| `not_found` (plan file) | `planFile` path doesn't exist | `tools/plan.test.ts` | Partial |
| `not_found` (bead) | `br show` returns 1 | `tools/review.test.ts` | Missing |
| `unsupported_action` | Unknown `advancedAction` | `tools/approve.test.ts` | Missing |
| `missing_prerequisite` | No profile → discover | `tools/discover.test.ts` | Present |
| `missing_prerequisite` | No goal → plan | `tools/plan.test.ts` | Present (line ~59) |
| `missing_prerequisite` | No goal → approve | `tools/approve.test.ts` | Present (line ~143) |
| partial_state log | `saveState` returns false after phase transition | `state.test.ts` (new) | Missing |
| rollback plan write | `writeFileSync` throws; verify `state.planDocument` unchanged | `tools/plan.test.ts` | Missing |
| rollback approve start | `br update` fails mid-loop; verify earlier beads rolled back to `open` | `tools/approve.test.ts` | Missing |

### Fault-injection template

```typescript
it('returns exec_timeout error when br show times out', async () => {
  const { ctx } = makeCtx({}, []);
  vi.spyOn(ctx, 'exec').mockRejectedValueOnce(
    new Error('Timed out after 8000ms: br show br-5 --json')
  );
  const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'br-5', action: 'looks-good' });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: 'error',
    data: { kind: 'error', error: { code: 'exec_timeout', retryable: true } },
  });
});
```

### SKILL.md lint extension (future)

`npm run lint:skill` should flag string-matching on error messages where a `structuredContent.data.error.code` branch is available. Non-blocking for this PR.

---

## 13. Migration Safety (4-stage non-breaking)

From robustness §9, annotated with the 5 migration phases.

| Stage | Phases | Breaking? | Description |
|---|---|---|---|
| Stage 1 — Observability | Phase 1 + silent-catch logging from Phase 5 | No | Add `errors.ts`, wrap `saveState` return, tag silent catches with `code`. Existing tool returns unchanged. |
| Stage 2 — Structure unstructured tools | Phase 2–4 | No | Tools that returned bare `isError` now return `FlywheelStructuredError`. Old callers reading `content[0].text` still work. New callers gain structured access. |
| Stage 3 — Signal propagation | Phase 5 (signal) | No | Optional `signal?: AbortSignal` on `ToolContext`; absent = current behavior. |
| Stage 4 — Concurrency + rollback | Phase 5 (mutex + rollback) | No | New `concurrent_write` code is *additive*. Rollback paths change only failure behavior. |

### `orch_*` alias compatibility

From correctness §4, verified:
- `server.ts` dispatches `orch_*` to the same runner functions.
- Structured errors use `tool: 'flywheel_*'` regardless of dispatch key (intended per the deprecation plan).
- No downstream code compares `structuredContent.tool` to the invoked call name. Verify pre-merge with:
  ```bash
  grep -rn "structuredContent\.tool" mcp-server/src/ skills/
  ```
- Old callers not reading `structuredContent` still get `isError: true` + `content[0].text`.

---

## 14. Verification Commands

```bash
# 1. TypeScript compiles with strict mode
cd mcp-server && npx tsc --noEmit

# 2. Full build
cd mcp-server && npm run build

# 3. All tests pass (including new fault-injection tests)
cd mcp-server && npm test

# 4. No raw throw new Error remaining in tool files
grep -rn "throw new Error" mcp-server/src/tools/

# 5. No bare isError returns without structuredContent
grep -rn "isError: true" mcp-server/src/tools/ | grep -v "structuredContent"

# 6. No code: string (untyped error codes) in tool files
grep -rn "code: string" mcp-server/src/tools/

# 7. All 19 exec() sites in tools/ now pass signal
grep -rn "await exec(" mcp-server/src/tools/ | grep -v "signal"
# Expected output: empty

# 8. No silent catches in non-test src (allowed: catches that log with code tag)
grep -rnE "catch\s*(\([^)]*\))?\s*\{\s*\}" mcp-server/src --include="*.ts" | grep -v __tests__
# Expected output: empty

# 9. dist/ matches src/
cd mcp-server && npm run build && git diff --stat dist/

# 10. Skill linter passes
cd mcp-server && npm run lint:skill

# 11. Hint rubric — every literal hint: is ≤ 140 chars
node -e "
  const fs = require('fs');
  const { globSync } = require('glob');
  let ok = true;
  for (const f of globSync('mcp-server/src/tools/**/*.ts')) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/hint:\s*['\`]([^'\`]+)['\`]/g)) {
      if (m[1].length > 140) { console.log(f, m[1].slice(0, 40) + '...'); ok = false; }
    }
  }
  process.exit(ok ? 0 : 1);
"

# 12. orch_* aliases return identical structured errors (manual smoke)
# Call both orch_profile and flywheel_profile with same args; diff structuredContent.data.error
```

---

## 15. Unresolved Tensions + Decisions

### Tension 1 — Error-as-return vs throw (ergonomics §1 vs AGENTS.md)

**Ergonomics says:** error-as-return at tool boundary, `throwFlywheelError` in nested helpers.
**AGENTS.md says:** "Errors throw `new Error(message)` — no custom error classes."
**Decision:** Adopt ergonomics's hybrid. Introduce `FlywheelError` as an *internal* class (the `throwFlywheelError` implementation detail) scoped to `errors.ts`. AGENTS.md's rule applies to tool authors writing their own error types, not to one shared helper class provided by the framework. If the user objects, fall back to `throw new Error(JSON.stringify({ code, message, ... }))` and parse at the boundary — uglier but complies.

### Tension 2 — 12 vs 16 error codes (correctness vs robustness)

**Decision:** 15 codes, justified per-code in §2. Reject `schema_drift` (subtype of `parse_failure`), `bead_cycle` (subtype of `cli_failure`), `retry_storm` (attribute of `cli_failure`), `agent_mail_unreachable` (out of MCP scope), `git_dirty` (no tool raises it today). Keep `checkpoint_corrupt` and `partial_state` as *logging-only* tags — not part of `FlywheelErrorCode`.

### Tension 3 — `cli_failure` + `retryable: true` vs separate `transient_exec_failure` code

**Decision:** Correctness wins. Subsume transient failures under `cli_failure` with `retryable: true`. Adding a separate code is a branching tax with no operational benefit — SKILL.md consults `retryable`, not the code, for retry policy.

### Tension 4 — Zod runtime validation vs const-array-only types

**Decision:** Zod. It's already a dependency (`"zod": "^4.3.6"` in `mcp-server/package.json`). Runtime validation lets tests `safeParse` error payloads for contract assertions and enables future JSON Schema export.

### Tension 5 — `deep_plan_all_failed` granularity

**Correctness** lumps it into `internal_error`. **Robustness** makes it discrete.
**Decision:** Discrete. SKILL.md wants to branch ("retry with mode=standard"), and `internal_error` is too generic for that recovery. `internal_error` stays as a genuine catch-all.

### Tension 6 — Synchronous vs async `saveState`

Current: `saveState` in `state.ts` is `await`ed but discards `boolean`. Robustness says return it; correctness doesn't address.
**Decision:** Return `Promise<boolean>`. Callers that don't check it still work (implicit `void`). New callers can check for `checkpointPersisted: false` and surface it in `structuredContent.data.warnings[]`. Not a breaking change.

### Tension 7 — Graceful-degradation vs hard-error in `flywheel_profile`

**Correctness** argues `br list` failure in profile should stay a warning (graceful). **Robustness** would surface it.
**Decision:** Correctness wins. `flywheel_profile` is a best-effort enricher; a failing `br list` means "no beads exist yet", not "tool broken". Keep as warning; only `profileRepo()` failure is fatal.

### Tension 8 — Concurrent-write mutex: in-process `Set` vs Agent Mail reservation

**Robustness** proposes per-process `Set<string>`. Agent Mail has file reservation primitives.
**Decision:** Start with the in-process `Set` (Phase 5). Cross-process coordination via Agent Mail file reservations is out of scope for this migration. Note it in `§9` so a future bead can add it without redesign.

---

## Phase 2 bead author checklist

When authoring beads from this plan:

1. Each phase in §7 maps to 1–2 beads (atomic, PR-sized).
2. Every bead must declare its acceptance criteria using the verification commands in §14.
3. No bead may break the tests enumerated in §12 — each phase's test additions must land in the same bead as the code change.
4. Any new error code proposed outside the 15 in §2 must first update §2 (reopen the synthesis decision).
5. The SKILL.md pseudocode in §5 is the north star — if a code change would require a new `case` the SKILL.md can't handle deterministically, push back.
