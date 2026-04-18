# Structured Error Contracts — Correctness Plan

**Perspective:** Correctness
**Author:** CoralGorge (deep-plan agent)
**Date:** 2026-04-18
**Goal:** Replace generic `Error(string)` throws with tagged error codes so the SKILL.md orchestrator and all callers can branch deterministically on error type instead of string-matching.

---

## 1. Error Taxonomy (Full Code Enum)

The `FlywheelToolError['code']` union in `types.ts` already defines 9 codes. This audit validates each one is load-bearing and identifies gaps.

### Current codes (all retained)

| Code | Justification | Retryable? | Primary tools |
|------|--------------|------------|---------------|
| `missing_prerequisite` | Tool called out of phase order (no profile, no goal, etc.). Load-bearing: SKILL.md Step 0d bootstraps `flywheel_select` on this code. | No | discover, select, plan, approve |
| `invalid_input` | Malformed or empty required args. Deterministic — caller must fix input. | No | discover, select, plan, review, verify_beads, memory |
| `not_found` | Referenced artifact (bead, plan file) doesn't exist on disk or in br. | No | plan, approve, review |
| `cli_failure` | External CLI (`br`, `cm`, `git`) returned non-zero exit code. | Sometimes | approve, review, verify_beads, memory, profile |
| `parse_failure` | CLI stdout couldn't be parsed as expected JSON/structure. | No (fix upstream) | approve, review, verify_beads |
| `blocked_state` | Operation blocked by current flywheel state (e.g., bead reserved by another agent). | Yes (retry after delay) | approve |
| `unsupported_action` | Unknown action parameter value. | No | approve, review |
| `already_closed` | Bead is closed; requested operation is inapplicable. | No | review |
| `internal_error` | Catch-all for unexpected failures. Should be rare. | No | any |

### New codes proposed

| Code | Justification | Retryable? | Primary tools |
|------|--------------|------------|---------------|
| `exec_timeout` | `exec()` timed out. Distinct from `cli_failure` because retryable and has different diagnostic path (increase timeout vs fix command). | Yes | profile, approve, review, verify_beads, memory |
| `exec_aborted` | `AbortSignal` fired during exec. Signals session cancellation — callers should NOT retry. | No | any tool using exec |
| `cli_not_available` | External CLI binary not found (`br`, `cm`, `ccc`). Distinct from `cli_failure` (binary exists but errored). SKILL.md currently detects this via string-matching "not available". | No (install required) | profile, memory |

### Codes considered and REJECTED

| Code | Why rejected |
|------|-------------|
| `agent_mail_unreachable` | Agent Mail is checked at SKILL.md level via HTTP health probe (Step 0b), not inside MCP tools. Tools don't call Agent Mail directly. |
| `cache_stale` | Profile cache staleness is handled transparently (re-scan on miss). Not an error — it's a normal code path. |
| `bead_state_drift` | Drift is detected by SKILL.md comparing checkpoint to `br list`, not by any single tool. Would be a misplaced abstraction. |
| `transient_exec_failure` | Subsumed by `cli_failure` with `retryable: true`. Adding a separate code creates a branching tax for callers with no benefit. |

### Final enum (12 codes)

```typescript
export type FlywheelErrorCode =
  | 'missing_prerequisite'
  | 'invalid_input'
  | 'not_found'
  | 'cli_failure'
  | 'cli_not_available'
  | 'parse_failure'
  | 'blocked_state'
  | 'unsupported_action'
  | 'already_closed'
  | 'exec_timeout'
  | 'exec_aborted'
  | 'internal_error';
```

---

## 2. Error Envelope Shape

### Current shape (types.ts lines 507-532)

The existing `FlywheelToolError` and `FlywheelStructuredError` interfaces are close but need extensions.

### Proposed shape

```typescript
export interface FlywheelToolError {
  /** Deterministic error code — callers branch on this, never on `message`. */
  code: FlywheelErrorCode;
  /** Human-readable description for logs/display. NOT for programmatic branching. */
  message: string;
  /** Whether the caller should retry the same call. Default: false. */
  retryable?: boolean;
  /** Actionable hint for the SKILL.md orchestrator or human operator. */
  hint?: string;
  /** Upstream error message (e.g., stderr from a CLI, original Error.message). */
  cause?: string;
  /** Phase at the time of error (redundant with envelope but useful for flat log lines). */
  phase?: FlywheelPhase;
  /** Tool that threw (redundant with envelope but useful for flat log lines). */
  tool?: FlywheelToolName;
  /** ISO timestamp of the error. */
  timestamp?: string;
  /** Arbitrary structured details for debugging. */
  details?: Record<string, unknown>;
}
```

### Changes from current

1. **`code` type** changes from inline union literal to `FlywheelErrorCode` (named type alias). This enables `switch` exhaustiveness checking.
2. **`hint`** added — tells the caller what to do. Example: `"Install br CLI: npm install -g @anthropic/br"`. The SKILL.md already hard-codes these hints via string matching; moving them into the error contract makes them machine-readable.
3. **`cause`** added — preserves the original error chain without polluting `message`. Useful for `exec_timeout` (includes the timed-out command) and `cli_failure` (includes stderr).
4. **`phase`** and **`tool`** added as optional flat fields — they're already in the envelope's `structuredContent`, but having them on the error itself enables log-only consumers (stderr JSON lines) to see the full context without the MCP envelope.
5. **`timestamp`** added — the envelope has `writtenAt` for checkpoints but errors don't currently have timestamps for log correlation.

### Envelope (unchanged except type reference)

```typescript
export interface FlywheelStructuredError {
  tool: FlywheelToolName;
  version: 1;
  status: 'error';
  phase: FlywheelPhase;
  data: {
    kind: 'error';
    error: FlywheelToolError;
  };
}
```

No structural change needed — the envelope is already well-designed.

---

## 3. Per-Tool Error-Site Audit

### 3.1 `flywheel_profile` (profile.ts)

**Current state:** ZERO error returns. The tool always returns `status: 'ok'`. If `profileRepo()` throws, the error propagates as an unhandled rejection through the MCP server's generic catch.

**Error sites to add:**

| Line(s) | Current behavior | Required error |
|---------|-----------------|----------------|
| L36-47 | `profileRepo(exec, cwd)` can throw if git commands fail | `cli_failure` with `cause: err.message` |
| L40 | `loadCachedProfile` can throw on corrupted JSON | `parse_failure` with `retryable: true, hint: "Pass force: true to bypass cache"` |
| L50-51 | `exec('br', ['--version'], ...)` — if exec itself rejects (timeout, abort) | `exec_timeout` or `exec_aborted` |
| L84 | `exec('br', ['list', '--json'], ...)` — br list for bead status | `cli_failure` (non-fatal — tool should degrade gracefully, not error) |

**Decision:** Profile should be resilient — most failures should be warnings in the text output, not error returns. Only `profileRepo()` throwing should be a hard error (`cli_failure`), because without a profile the downstream tools have nothing to work with. The `br` detection and bead listing should degrade gracefully (already do).

**Wrap `profileRepo()` in try/catch:**
```typescript
try {
  profile = await profileRepo(exec, cwd);
} catch (err) {
  return makeToolError('flywheel_profile', 'profiling', 'cli_failure',
    `Failed to profile repository: ${String(err)}`,
    { retryable: true, cause: String(err), hint: 'Check git is installed and cwd is a git repo.' });
}
```

### 3.2 `flywheel_discover` (discover.ts)

**Current state:** ✅ Already uses `makeToolError` correctly.

| Error | Code | Structured? |
|-------|------|------------|
| No repo profile | `missing_prerequisite` | ✅ Yes |
| No ideas provided | `invalid_input` | ✅ Yes |

**Required changes:** None. Already correct.

### 3.3 `flywheel_select` (select.ts)

**Current state:** ✅ Already uses `makeToolError` correctly.

| Error | Code | Structured? |
|-------|------|------------|
| Empty goal | `invalid_input` | ✅ Yes |

**Required changes:** None. Already correct.

### 3.4 `flywheel_plan` (plan.ts)

**Current state:** Partially structured. Has local `errorResult()` that produces the right envelope shape, PLUS one raw `throw new Error()`.

| Error | Code | Structured? | Line |
|-------|------|------------|------|
| No goal selected | `missing_prerequisite` | ✅ Local `errorResult` | L59 |
| planFile not found | `not_found` | ✅ Local `errorResult` | L74 |
| Deep plan all-failed | (none) | ❌ Raw `throw new Error(...)` | L113 |

**Required changes:**

1. **Line 113:** Replace `throw new Error("Deep plan failed: all perspective planners timed out or produced no output.")` with:
   ```typescript
   return errorResult('planning', 'internal_error',
     'Deep plan failed: all perspective planners timed out or produced no output.',
     { retryable: true, hint: 'Retry with mode="standard" as fallback.' });
   ```

2. **Refactor `errorResult`** to use `makeToolError` from shared.ts instead of duplicating the envelope construction. This ensures future schema changes propagate automatically.

### 3.5 `flywheel_approve_beads` (approve.ts)

**Current state:** ✅ Most mature error handling. Has local `makeApproveError()` with fully typed code union.

| Error | Code | Line |
|-------|------|------|
| No goal selected | `missing_prerequisite` | L143 |
| br list failed | `cli_failure` | L160 |
| br list parse failure | `parse_failure` | L178 |
| Plan file not found | `not_found` | L296 |
| advancedAction missing | `invalid_input` | L679 |
| Unknown advancedAction | (bare `isError` without structured envelope) | L793 |

**Required changes:**

1. **Line 793:** The `Unknown advancedAction` error at the end of `handleAdvanced` returns a bare `{ content, isError }` without a structured envelope. Refactor to use `makeApproveError`:
   ```typescript
   return makeApproveError(
     `Unknown advancedAction: ${advancedAction}. Valid options: ...`,
     state.phase, 'beads', 'unsupported_action',
     { validAdvancedActions: [...ADVANCED_ACTIONS] });
   ```

2. **Lines 710-738:** The `blunder-hunt`, `dedup`, and `cross-model` branches return bare `{ content }` objects for their OK paths — no `structuredContent`. While not errors, this inconsistency means callers can't reliably check `result.structuredContent.status`. Convert to `makeApproveResult`. (Out of scope for error contracts but flagged for consistency.)

### 3.6 `flywheel_review` (review.ts)

**Current state:** Has local `errorResult()` but with `code: string` — loses type safety.

| Error | Code | Line |
|-------|------|------|
| Missing beadId | `invalid_input` | L78 |
| Bead not found (br show failed) | `not_found` | L99 |
| Bead parse failure | `parse_failure` | L110 |
| Bead already closed + skip | `already_closed` | L139 |
| Unknown action | `unsupported_action` | L347 |

**Required changes:**

1. **Type the `code` parameter:** Change `function errorResult(phase: string, code: string, ...)` to `function errorResult(phase: FlywheelPhase, code: FlywheelErrorCode, ...)`. This catches typos at compile time.

2. **Refactor `errorResult`** to use `makeToolError` from shared.ts (same as plan.ts refactor). The local function duplicates the envelope shape.

3. **Add `retryable` flags:** `not_found` when br show fails should be `retryable: false`; `parse_failure` should be `retryable: false` (fix br output format).

### 3.7 `flywheel_verify_beads` (verify-beads.ts)

**Current state:** ✅ Uses `makeToolError` for the one error case.

| Error | Code | Structured? |
|-------|------|------------|
| Empty beadIds array | `invalid_input` | ✅ Yes |

**Required changes:**

1. **Add error handling for `verifyBeadsClosed()` rejection.** If the function throws (e.g., all `br show` calls fail simultaneously), it propagates as an unhandled rejection. Wrap in try/catch:
   ```typescript
   try {
     const report = await verifyBeadsClosed(exec, cwd, args.beadIds);
   } catch (err) {
     return makeToolError('flywheel_verify_beads', state.phase, 'cli_failure',
       `Bead verification failed: ${String(err)}`,
       { retryable: true, cause: String(err) });
   }
   ```

### 3.8 `flywheel_memory` (memory-tool.ts)

**Current state:** ❌ Completely unstructured errors. Returns bare `{ content, isError: true }` objects with no `structuredContent` envelope.

| Error | Current code | Line |
|-------|-------------|------|
| cm CLI not available | (none) | L19 |
| Empty content for store | (none) | L30 |
| Store failed | (none) | L37 |
| Search failed | (none) | L75 |
| List failed | (none) | L52 |

**Required changes (all 5 error paths):**

```typescript
// cm not available
return makeToolError('flywheel_memory', state.phase, 'cli_not_available',
  'CASS memory (cm CLI) is not available.',
  { hint: 'Install with: npm install -g @cass/cm' });

// Empty content for store
return makeToolError('flywheel_memory', state.phase, 'invalid_input',
  'Error: content is required for store operation.');

// Store failed
return makeToolError('flywheel_memory', state.phase, 'cli_failure',
  `Failed to store memory: ${storeResult.stderr}`,
  { retryable: true, cause: storeResult.stderr });

// Search failed
return makeToolError('flywheel_memory', state.phase, 'cli_failure',
  `Search failed: ${searchResult.stderr}`,
  { retryable: true, cause: searchResult.stderr });

// List failed
return makeToolError('flywheel_memory', state.phase, 'cli_failure',
  `Failed to list memory: ${listResult.stderr}`,
  { retryable: true, cause: listResult.stderr });
```

---

## 4. Backward-Compat Plan (orch_* Aliases)

### How aliases work (server.ts lines 250-258)

```typescript
orch_profile: runProfile as ToolRunner,
orch_discover: runDiscover as ToolRunner,
// ... same runner functions
```

The `orch_*` names dispatch to the **same runner functions** as `flywheel_*`. The runner functions reference `tool` names in their structured errors via parameters passed in.

### Compatibility impact

**Zero breaking changes.** Because:
1. `orch_*` calls the same runner → gets the same structured error.
2. The error envelope's `tool` field is set by the runner, not the dispatch key. So `orch_profile` returns `{ tool: 'flywheel_profile', ... }`. This is correct — the canonical tool name is `flywheel_*`.
3. The `FlywheelToolName` type already includes both `flywheel_*` and `orch_*` variants. No changes needed.
4. Old callers that don't read `structuredContent` still get `isError: true` and a `content[0].text` message — the unstructured path is preserved.

### One concern: `makeToolError` hardcodes the tool name

When `makeToolError` is called from `discover.ts`, it passes `'flywheel_discover'` as the first argument. An `orch_discover` call returns `tool: 'flywheel_discover'` in the error envelope. This is the intended behavior per the deprecation plan, but we should verify no downstream code dispatches on `structuredContent.tool` matching the call name. Search for this pattern:

```bash
grep -r "structuredContent\.tool" mcp-server/src/
```

If any code compares `structuredContent.tool` to the invoked tool name, we have a mismatch for `orch_*` callers. However, this is unlikely given the deprecation strategy.

---

## 5. Zod Schema + Derived TypeScript Type

### Why Zod?

Runtime validation of error payloads for:
1. **Test assertions** — validate that tool errors match the contract.
2. **Client-side parsing** — callers can `safeParse` the error to get typed access.
3. **Schema export** — auto-generate JSON Schema for documentation.

### Schema definition

```typescript
// mcp-server/src/error-schema.ts (new file)

import { z } from 'zod';

export const FlywheelErrorCodeSchema = z.enum([
  'missing_prerequisite',
  'invalid_input',
  'not_found',
  'cli_failure',
  'cli_not_available',
  'parse_failure',
  'blocked_state',
  'unsupported_action',
  'already_closed',
  'exec_timeout',
  'exec_aborted',
  'internal_error',
]);

export const FlywheelToolErrorSchema = z.object({
  code: FlywheelErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  hint: z.string().optional(),
  cause: z.string().optional(),
  phase: z.string().optional(),  // FlywheelPhase — not importing to avoid circular
  tool: z.string().optional(),   // FlywheelToolName
  timestamp: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

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

// Derive TypeScript types from Zod (use these instead of manual interfaces)
export type FlywheelErrorCode = z.infer<typeof FlywheelErrorCodeSchema>;
export type FlywheelToolError = z.infer<typeof FlywheelToolErrorSchema>;
export type FlywheelStructuredError = z.infer<typeof FlywheelStructuredErrorSchema>;
```

### Migration from manual types

The existing `FlywheelToolError` and `FlywheelStructuredError` interfaces in `types.ts` will be replaced with re-exports from `error-schema.ts`:

```typescript
// types.ts — replace the interface definitions with:
export type { FlywheelErrorCode, FlywheelToolError, FlywheelStructuredError } from './error-schema.js';
```

This ensures the runtime schema (Zod) and compile-time types (TypeScript) are always in sync.

### Zod as a dependency

Check if Zod is already in `package.json`:
```bash
grep zod mcp-server/package.json
```

If not, `npm install zod` in `mcp-server/`. Zod is zero-dependency, ~50KB, and tree-shakeable. The MCP server already uses Node.js runtime validation in multiple places (parsers.ts, etc.) — Zod centralizes this.

**Alternative (if Zod is rejected):** Keep the manual interfaces but extract `FlywheelErrorCode` as a const array + derived type:

```typescript
export const FLYWHEEL_ERROR_CODES = [
  'missing_prerequisite', 'invalid_input', 'not_found',
  'cli_failure', 'cli_not_available', 'parse_failure',
  'blocked_state', 'unsupported_action', 'already_closed',
  'exec_timeout', 'exec_aborted', 'internal_error',
] as const;

export type FlywheelErrorCode = typeof FLYWHEEL_ERROR_CODES[number];
```

This achieves type safety without a runtime dependency. Trade-off: no runtime validation of error payloads in tests.

---

## 6. Migration Order Across Tools

### Ordering rationale

Migrate from "most broken" to "already correct" so each step has immediate value and tests accumulate progressively.

### Phase 1: Foundation (types + shared utilities)

1. **`types.ts`** — Extract `FlywheelErrorCode` type alias (either Zod-derived or const-array-derived). Add `hint`, `cause`, `phase`, `tool`, `timestamp` to `FlywheelToolError`. Update `FlywheelStructuredError` type reference.

2. **`shared.ts`** — Update `makeToolError` signature to accept the new optional fields. Add `timestamp: new Date().toISOString()` by default. Ensure `retryable` defaults to `false` when omitted.

3. **`error-schema.ts`** (new, optional) — Zod schema if approved. Otherwise skip.

### Phase 2: Fully unstructured tools (highest impact)

4. **`memory-tool.ts`** — 5 error paths, all bare. Convert all to `makeToolError`. Add new `cli_not_available` code usage.

5. **`profile.ts`** — 0 error returns. Add try/catch around `profileRepo()` and cache loading.

### Phase 3: Partially structured tools (type safety fixes)

6. **`review.ts`** — Change `code: string` to `code: FlywheelErrorCode` in local `errorResult`. Refactor to delegate to `makeToolError`.

7. **`plan.ts`** — Replace raw `throw new Error(...)` with structured return. Refactor local `errorResult` to delegate to `makeToolError`.

### Phase 4: Already correct tools (consistency pass)

8. **`approve.ts`** — Fix the one bare error return (L793). Refactor local `makeApproveError` to delegate to `makeToolError` internally while preserving the `ApproveStructuredContent` wrapper.

9. **`verify-beads.ts`** — Add try/catch around `verifyBeadsClosed()`.

10. **`discover.ts`** — No changes needed. Add `hint` field to existing errors.

11. **`select.ts`** — No changes needed. Add `hint` field to existing errors.

### Phase 5: exec layer

12. **`exec.ts`** — Consider wrapping timeout and abort errors into typed objects so callers can distinguish them from other rejections. This is OPTIONAL — the tools can catch `Error` and check the message pattern `"Timed out after"` / `"Aborted"` to set the appropriate code. But a clean approach:

```typescript
export class ExecTimeoutError extends Error {
  readonly code = 'exec_timeout' as const;
  constructor(cmd: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms: ${cmd}`);
  }
}

export class ExecAbortedError extends Error {
  readonly code = 'exec_aborted' as const;
  constructor() { super('Aborted'); }
}
```

Callers then: `catch (err) { if (err instanceof ExecTimeoutError) return makeToolError(..., 'exec_timeout', ...) }`

**Note:** AGENTS.md says "Errors throw `new Error(message)` — no custom error classes." This constraint may apply to MCP tool code but not to internal utilities. Discuss with the user before adding exec error classes. If rejected, use string matching as the fallback.

---

## 7. Test Plan

### 7.1 Unit tests for error contract

**File:** `mcp-server/src/__tests__/error-contract.test.ts` (new)

```typescript
describe('FlywheelToolError contract', () => {
  it('makeToolError returns valid FlywheelStructuredError envelope', () => {
    const result = makeToolError('flywheel_profile', 'profiling', 'cli_failure', 'git not found');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent!.status).toBe('error');
    expect(result.structuredContent!.data.kind).toBe('error');
    expect(result.structuredContent!.data.error.code).toBe('cli_failure');
    // If Zod: FlywheelStructuredErrorSchema.parse(result.structuredContent);
  });

  it('all error codes are in the FlywheelErrorCode union', () => {
    // Compile-time test: assigning each code to the type must not error
    const codes: FlywheelErrorCode[] = [
      'missing_prerequisite', 'invalid_input', 'not_found',
      'cli_failure', 'cli_not_available', 'parse_failure',
      'blocked_state', 'unsupported_action', 'already_closed',
      'exec_timeout', 'exec_aborted', 'internal_error',
    ];
    expect(codes).toHaveLength(12);
  });

  it('timestamp is auto-populated', () => {
    const result = makeToolError('flywheel_memory', 'idle', 'cli_not_available', 'cm not found');
    expect(result.structuredContent!.data.error.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('retryable defaults to false', () => {
    const result = makeToolError('flywheel_plan', 'planning', 'not_found', 'file missing');
    expect(result.structuredContent!.data.error.retryable).toBeUndefined();
    // Callers treat undefined as false
  });
});
```

### 7.2 Per-tool regression tests

For each tool that changes, add a test that:
1. Triggers the error path (mock exec to fail, pass invalid args).
2. Asserts `result.isError === true`.
3. Asserts `result.structuredContent.data.error.code` matches expected code.
4. If Zod: `FlywheelStructuredErrorSchema.safeParse(result.structuredContent).success === true`.

**Existing test files to extend:**

| Tool | Test file | Error paths to cover |
|------|-----------|---------------------|
| profile | `__tests__/profiler.test.ts` | profileRepo throws, cache corrupt |
| plan | `__tests__/deep-plan.test.ts` | all-planners-failed (currently tests raw throw) |
| review | `__tests__/tools/` (may need new file) | bead not found, parse failure, already_closed |
| memory | `__tests__/` (new file needed) | cm not available, store failure |
| verify_beads | `__tests__/beads.test.ts` | verifyBeadsClosed throws |
| approve | `__tests__/tools/` | unknown advancedAction |

### 7.3 Exhaustiveness test

Ensure every `makeToolError` call site uses a valid `FlywheelErrorCode`. TypeScript strict mode already guarantees this at compile time if the type is correct. But add a grep-based CI check:

```bash
# Verify no string-literal error codes outside the enum
grep -rn "code:" mcp-server/src/tools/ | grep -v "FlywheelErrorCode" | grep -v "test"
```

### 7.4 SKILL.md contract test

The skill linter (`npm run lint:skill`) should be extended with a rule that flags string-matching on error messages when a `structuredContent.data.error.code` branch would be deterministic. This is a future enhancement — not blocking for this PR.

---

## 8. Verification Commands

After implementation, run these commands to verify correctness:

```bash
# 1. TypeScript compilation (strict mode catches type mismatches)
cd mcp-server && npx tsc --noEmit

# 2. Full build (catches tsconfig/dist issues)
cd mcp-server && npm run build

# 3. Run all tests
cd mcp-server && npm test

# 4. Verify no raw throws remain in tool files (should be 0)
grep -rn "throw new Error" mcp-server/src/tools/

# 5. Verify no bare isError returns without structuredContent
grep -rn "isError: true" mcp-server/src/tools/ | grep -v "structuredContent"

# 6. Verify all error returns use makeToolError or tool-specific wrappers
grep -rn "isError: true" mcp-server/src/tools/ --include="*.ts" -l

# 7. Verify FlywheelErrorCode type is used (not string) in all error functions
grep -rn "code: string" mcp-server/src/tools/

# 8. Verify dist/ is in sync with src/
cd mcp-server && npm run build && git diff --stat dist/

# 9. Skill linter still passes
cd mcp-server && npm run lint:skill

# 10. Verify orch_* aliases return identical structured errors
# (Manual: call orch_profile and flywheel_profile with same args, diff structuredContent)
```

---

## Appendix A: State-Transition Correctness

Which tools can throw which codes, mapped to the phase they're called in:

| Tool | Callable in phases | Possible error codes |
|------|-------------------|---------------------|
| `flywheel_profile` | idle, profiling | `cli_failure`, `exec_timeout`, `exec_aborted`, `internal_error` |
| `flywheel_discover` | discovering | `missing_prerequisite`, `invalid_input` |
| `flywheel_select` | awaiting_selection, any | `invalid_input` |
| `flywheel_plan` | planning | `missing_prerequisite`, `invalid_input`, `not_found`, `internal_error` |
| `flywheel_approve_beads` | planning thru awaiting_bead_approval | `missing_prerequisite`, `invalid_input`, `not_found`, `cli_failure`, `parse_failure`, `unsupported_action` |
| `flywheel_review` | implementing, reviewing, iterating | `invalid_input`, `not_found`, `parse_failure`, `already_closed`, `unsupported_action` |
| `flywheel_verify_beads` | implementing, reviewing | `invalid_input`, `cli_failure` |
| `flywheel_memory` | any | `cli_not_available`, `invalid_input`, `cli_failure` |

**Invariant:** No tool should return `blocked_state` unless it checks `state.phase` against an allowlist. Currently only `approve.ts` could return this, and it doesn't — the phase check is implicit via the prerequisite check. This is correct.

**Invariant:** `exec_timeout` and `exec_aborted` can only originate from `exec()` calls. Tools that don't call `exec()` (select, discover) cannot return these codes. This is enforced by the call graph, not by type constraints.

## Appendix B: SKILL.md Branching Implications

Current SKILL.md error branches that will benefit from structured codes:

| SKILL.md location | Current branch method | New branch method |
|-------------------|-----------------------|-------------------|
| Step 0b: MCP detection | `flywheel_profile` "call succeeds" vs "errors" | Branch on `!result.isError` vs `result.structuredContent.data.error.code` |
| Step 0d: Work-on-beads bootstrap | String match "missing_prerequisite" in error text | `error.code === 'missing_prerequisite'` |
| Step 2: Profile degraded mode | `MCP_DEGRADED` flag from Step 0b | Same flag, but set more precisely: only on `cli_failure`/`internal_error`, not on `invalid_input` |
| Step 3: Discover fallback | `flywheel_discover` "fails" | `error.code !== 'missing_prerequisite'` (prerequisite = skip, other = retry) |
| Step 9: verify_beads fallback | `parse_failure` → manual fallback | `error.code === 'parse_failure'` (exact match) |
| Step 7: Agent Mail offline | Separate health probe, not tool error | No change — Agent Mail is checked outside MCP |

The SKILL.md does NOT need to be updated in this PR — it already works with the `isError` / text pattern. But the structured codes enable future SKILL.md improvements where branching is deterministic.
