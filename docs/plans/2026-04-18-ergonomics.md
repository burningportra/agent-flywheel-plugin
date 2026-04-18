# 2026-04-18 Ergonomics Plan: Structured Error Contract

## 1. Envelope choice: error-as-return vs throw

**Decision:** Use **error-as-return** as the default contract for all 8 `flywheel_*` tools, and reserve `throw` for unexpected programmer/runtime faults.

Why this is the best UX for this codebase:
- `server.ts` currently catches thrown errors and converts them to `internal_error` (`createCallToolHandler`, lines 351-362), which destroys specific context unless each tool returns structured errors itself.
- Skill routing is easier and safer when errors are data (`status: "error"`, `data.error.code`) rather than free-text `Error:` strings.
- Current tool behavior is inconsistent; return-envelope standardization removes surprises:
  - `discover/select/verify-beads` use `makeToolError` envelope.
  - `approve/plan/review` each define local error helpers.
  - `memory-tool` often returns only `isError: true` text, no structured envelope.
  - `approve` has at least one `isError` return with no structured content (`unknown advancedAction`).
  - `plan` throws on one path (`Deep plan failed...`), so callers only see a generic catch-wrapped internal error.

Policy:
- Expected/domain errors: `return makeFlywheelError(...)`.
- Unexpected bugs: `throw` (caught centrally as `internal_error` with retryable true).

## 2. Helper API: throwFlywheelError? FlywheelError class? both?

**Decision:** Provide both, but keep one flat model (no class hierarchy).

Proposed API surface:
- `mcp-server/src/errors.ts`:
  - `FLYWHEEL_ERROR_CODES` (single enum source of truth)
  - `type FlywheelErrorCode`
  - `interface FlywheelErrorEnvelope` (contract payload)
  - `makeFlywheelErrorResult(tool, phase, input)` for return-style handlers
  - `class FlywheelError extends Error` for deep helper paths
  - `throwFlywheelError(input): never` convenience wrapper

Usage guidance:
- In top-level tool handlers (`run*`): prefer `return makeFlywheelErrorResult(...)`.
- In nested helper functions where threading returns is noisy: `throwFlywheelError(...)` and catch at tool boundary (or central handler if tool/phase can be inferred).
- Avoid subclass trees (`ValidationFlywheelError`, `CliFlywheelError`, etc.). A single typed payload keeps maintenance low.

Contract shape from helper:
- `code` (required)
- `message` (required)
- `retryable` (required in emitted payload, default from code map)
- `hint` (optional but strongly recommended)
- `cause` (optional structured source info)
- `phase` (required)
- `tool` (required)
- `timestamp` (required ISO-8601)
- `details` (optional)

## 3. Client-side consumption: SKILL.md missing_prerequisite before/after

Current pattern in `skills/start/SKILL.md` (Work-on-beads bootstrap) assumes this branch textually:
- "`flywheel_approve_beads` errors with `missing_prerequisite` ... bootstrap goal first"

**Before (text-coupled):**
- Branches are described in prose and rely on known wording.
- Fragile if message text changes.

**After (code-coupled, deterministic):**

```ts
const res = await flywheel_approve_beads({ cwd, action: "start" });
const sc = res.structuredContent;

if (sc?.status === "error" && sc.data?.kind === "error") {
  const err = sc.data.error;

  const handlers: Record<string, () => Promise<void>> = {
    missing_prerequisite: async () => {
      // Exact branch used by Work-on-beads bootstrap
      // If requiredTool === "flywheel_select", run goal synthesis + flywheel_select.
      await runGoalBootstrap();
    },
    invalid_input: async () => showGuidedFix(err.hint),
    cli_failure: async () => showCliRecovery(err.hint),
  };

  await (handlers[err.code] ?? (async () => escalateUnknownError(err)))();
  return;
}
```

Ergonomic gain:
- One handler map by `error.code`.
- Message text becomes human-facing only.
- SKILL authoring becomes branch-on-code, not regex-on-message.

## 4. Hint quality rubric: good vs bad

Good hints (specific, actionable, next-step clear):
1. `Call flywheel_select before flywheel_approve_beads. state.selectedGoal is empty.`
2. `br list --json failed. Install br and run br init in this repo, then retry.`
3. `planFile not found at docs/plans/x.md. Write the file first or pass a valid relative path from cwd.`

Bad hints (vague, noisy, or not actionable):
1. `Try again later.`
2. `Something went wrong.`
3. `Error: command failed` (without command, reason, or next step).

Rubric:
- Must name the failing precondition or command.
- Must provide one immediate next action.
- Keep under ~140 chars unless a path/command is required.
- Avoid stack traces in hint; put diagnostics in `details`/logs.

## 5. Retry UX: retryable flag and automatic retry

Contract behavior:
- Every error includes explicit `retryable`.
- Orchestrator auto-retries only when `retryable === true`.

Recommended default mapping:
- `retryable: false`: `missing_prerequisite`, `invalid_input`, `not_found`, `parse_failure`, `blocked_state`, `unsupported_action`, `already_closed`.
- `retryable: true`: transient `cli_failure` (timeout/network/spawn), `internal_error` (with guardrails).

Auto-retry policy:
- Max 2 retries with short backoff (`250ms`, `1000ms`).
- Retry only idempotent actions or read-like operations by default.
- For mutating flows (`review looks-good`, `skip`, `approve start`) require an idempotency guard or re-check before retry.
- After retries exhausted: surface `hint` + `details.command` in one concise recovery message.

## 6. Logging conventions: single structured line per error

Emit exactly one structured log line per surfaced error via `createLogger` (stderr-only).

Log fields:
- `event: "tool_error"`
- `tool`, `phase`, `code`, `retryable`
- `message` (human-safe)
- `hint` (if present)
- `details.command`, `details.exitCode` (if present)
- `cause.kind` (timeout/network/parse/etc.)
- `error_id` (uuid for correlation)

Guidelines:
- No `console.*`.
- No multiline stack dumps in normal warn path.
- Include full stack only at debug level.

## 7. Docs location: where tool authors find the enum

Single source of truth:
- `mcp-server/src/errors.ts` (enum, envelope, helper APIs, code docs)

Type exports:
- Re-export `FlywheelErrorCode` and `FlywheelErrorEnvelope` from `mcp-server/src/types.ts` for easy import ergonomics.

Author docs:
- Add `docs/error-contract.md`:
  - code catalog with when-to-use
  - retryability defaults
  - hint-writing rubric
  - sample `makeFlywheelErrorResult` usage
- Add short pointer in `AGENTS.md` under Code Conventions: "Use structured error helpers from `errors.ts`; do not hand-roll error payloads."

## 8. Adding a 9th tool: step-by-step walkthrough

1. Add tool name to `FlywheelToolName` (+ `orch_*` alias if needed for back-compat).
2. Define success payload type (`<ToolName>StructuredContent`) with `status/phase/data/nextStep` pattern.
3. Use centralized helpers:
   - success: `makeToolResult(...)`
   - error: `makeFlywheelErrorResult(...)`
4. Map each failure site to a code intentionally (no free-form `isError` text-only returns).
5. Add hints for user-fixable cases and retryable defaults for transient failures.
6. Ensure no raw `throw` escapes expected paths; if using `throwFlywheelError`, ensure conversion at boundary.
7. Register both canonical and alias runners in `server.ts`.
8. Add tests:
   - one happy-path envelope test
   - one error-per-code test for each declared code
   - one `retryable` policy test
9. Update skill branching examples (if the tool introduces new branchable errors).
10. Run verification:
   - `cd mcp-server && npm run build`
   - `cd mcp-server && npm test`
   - `cd mcp-server && npm run lint:skill`

