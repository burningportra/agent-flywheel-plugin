# Synthesized Plan: Reliability Sweep

**Date:** 2026-04-09
**Synthesized from:** Correctness (LavenderBasin), Ergonomics (RoseCrane), Robustness (RusticFalcon)
**Synthesizer:** FrostyOwl (claude-opus-4-6)

---

## Wave 1: Foundation (version.ts, shared types, logger consistency)

### 1.1 Single Source of Truth for Version

**Description:** The version string is hardcoded in three places that are already out of sync: `package.json` (2.3.0), `server.ts` (2.0.0), `state.ts` (2.0.0). Create a single `version.ts` module that reads from `package.json` at startup, and import it everywhere.

**Files to modify:**
- `mcp-server/src/version.ts` -- NEW file (~5 lines)
- `mcp-server/src/server.ts` -- line 18: replace hardcoded `"2.0.0"` with import
- `mcp-server/src/state.ts` -- line 6: remove hardcoded `VERSION`, import from `version.ts`
- `mcp-server/src/checkpoint.ts` -- lines 139-150: remove `flywheelVersion` parameter, import `VERSION` directly
- `mcp-server/src/__tests__/checkpoint.test.ts` -- lines 122, 129, 137, 144, 212, 232: remove version arg from `writeCheckpoint` calls

**Approach (best of Ergonomics + Correctness):**
```typescript
// mcp-server/src/version.ts
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
export const VERSION: string = pkg.version;
```
Import `VERSION` in `server.ts`, `state.ts`, and `checkpoint.ts`. Remove the `flywheelVersion` parameter from `writeCheckpoint` entirely (Ergonomics approach) -- callers should not need to pass what is a module-level constant.

**Acceptance criteria:**
- `server.ts` reports the correct version from `package.json` to MCP SDK
- `writeCheckpoint` no longer accepts a version parameter
- Changing `package.json` version is the only step needed to update all references
- All existing checkpoint tests pass with updated call signatures

**Estimated effort:** 30 minutes
**Risk:** Very low

---

### 1.2 Deduplicate ExecFn Type Definition

**Description:** `ExecFn` is defined identically in both `exec.ts` (line 3) and `agent-mail.ts` (line 4). Several modules import from `agent-mail.ts` just to get the type. Consolidate to a single canonical definition.

**Files to modify:**
- `mcp-server/src/agent-mail.ts` -- line 4: remove `ExecFn` type, import from `exec.ts`
- `mcp-server/src/coordination.ts` -- line 4: change import to `from "./exec.js"`

**Approach:** Pure type-level refactor. The canonical `ExecFn` lives in `exec.ts`. All other modules import from there (or from `types.ts` which re-exports it).

**Acceptance criteria:**
- `ExecFn` is defined in exactly one place (`exec.ts`)
- No duplicate type definitions across the codebase
- `npm run build` passes

**Estimated effort:** 10 minutes
**Risk:** Very low

---

### 1.3 Replace `process.stderr.write` with Structured Logger in profiler.ts

**Description:** `profiler.ts` lines 27-29 write directly to `process.stderr` instead of using `createLogger`. This bypasses log-level filtering and produces unstructured output.

**Files to modify:**
- `mcp-server/src/profiler.ts` -- lines 1-2 (add import), lines 26-31 (replace stderr.write)

**Approach (Ergonomics plan):**
```typescript
import { createLogger } from './logger.js';
const log = createLogger('profiler');

// Replace process.stderr.write block with:
log.warn("collector failed", { collector: label, reason: String(...) });
```

**Acceptance criteria:**
- No `process.stderr.write` calls remain in `profiler.ts`
- Failed collector warnings appear as structured JSON on stderr
- `ORCH_LOG_LEVEL` filtering applies to profiler warnings

**Estimated effort:** 10 minutes
**Risk:** Very low

---

### 1.4 Cache Logger `resolveMinLevel` at Startup

**Description:** `logger.ts` reads `process.env.ORCH_LOG_LEVEL` on every single log call. This is both a micro-perf issue and a robustness gap (env mutation mid-run silently changes behavior). Additionally, an invalid level value silently falls back with no warning.

**Files to modify:**
- `mcp-server/src/logger.ts` -- lines 12-24

**Approach (Robustness plan):** Replace `resolveMinLevel()` function call with a module-level cached constant. Emit a startup warning if the env var value is unrecognized.

```typescript
const MIN_LEVEL: number = (() => {
  const raw = (process.env.ORCH_LOG_LEVEL ?? "warn").toLowerCase();
  const idx = LEVELS.indexOf(raw as Level);
  if (idx < 0) {
    process.stderr.write(JSON.stringify({
      ts: new Date().toISOString(), level: "warn", ctx: "logger",
      msg: `Unknown ORCH_LOG_LEVEL="${raw}", defaulting to "warn"`,
    }) + "\n");
    return 2;
  }
  return idx;
})();
```

**Acceptance criteria:**
- `process.env.ORCH_LOG_LEVEL` is read exactly once at module load
- Invalid level values produce a visible startup warning
- Existing logger.test.ts passes

**Estimated effort:** 15 minutes
**Risk:** Very low

---

## Wave 2: Error Handling (Agent Mail RPC discriminated union, schema validation)

### 2.1 Agent Mail RPC Discriminated Result Type

**Description:** `agentMailRPC` returns `Promise<any>` and swallows all errors via `catch { return null }`. All 20+ callers cannot distinguish "server down" from "permission denied" from "empty result". This is the single largest correctness gap in the codebase.

**Files to modify:**
- `mcp-server/src/types.ts` -- add `AgentMailResult<T>` type
- `mcp-server/src/agent-mail.ts` -- lines 47-70 (refactor `agentMailRPC`), lines 75-99, and all exported functions

**Approach (merged from all 3 plans -- Correctness provides the richest type, Ergonomics provides the `unwrapRPC` migration strategy, Robustness provides the health-check cache):**

Step 1 -- Define result type in `types.ts`:
```typescript
export type AgentMailResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AgentMailError };

export interface AgentMailError {
  kind: "network" | "timeout" | "parse" | "rpc_error" | "empty_response";
  message: string;
  code?: number;
  stderr?: string;
}
```

Step 2 -- Refactor `agentMailRPC` to return the discriminated union with proper error classification for each failure mode (curl exit non-zero, invalid JSON, JSON-RPC error, empty result).

Step 3 -- Add `unwrapRPC` backward-compatibility wrapper (Ergonomics approach) so existing callers can be migrated incrementally:
```typescript
function unwrapRPC(result: AgentMailResult<unknown>): unknown {
  if (!result.ok) {
    log.warn("agent-mail RPC failed", { kind: result.error.kind, message: result.error.message });
    return null;
  }
  return result.data;
}
```

Step 4 -- Wrap all 20+ existing callers with `unwrapRPC` in the same commit. New code should use the full union.

**Acceptance criteria:**
- `agentMailRPC` return type is `Promise<AgentMailResult<T>>` (not `Promise<any>`)
- Five failure kinds are distinguishable: `network`, `timeout`, `parse`, `rpc_error`, `empty_response`
- Existing callers continue to work via `unwrapRPC` wrapper
- `healthCheck` returns `null` (not throws) when server is unreachable
- Build passes with no type errors

**Estimated effort:** 2-3 hours
**Risk:** Medium (wide-reaching change -- 20+ call sites). Do in one commit to avoid partial migration.
**Dependencies:** Wave 1.2 (ExecFn dedup) to avoid merge conflicts.

---

### 2.2 Runtime Argument Validation at Tool Dispatch Boundary

**Description:** All tool handlers in `server.ts` receive `args as any`, meaning malformed arguments (missing required fields, wrong types) produce opaque runtime errors deep in tool logic rather than clear validation failures at the boundary.

**Files to modify:**
- `mcp-server/src/server.ts` -- lines 190-210 (add validator before switch)

**Approach (Robustness plan -- lightweight runtime check using existing TOOLS schema):**

Add a `validateToolArgs` function that checks `required` fields and that `cwd` is a non-empty string. This catches 90% of bugs without needing an external library:
```typescript
const validationErrors = validateToolArgs(name, args);
if (validationErrors.length > 0) {
  return {
    content: [{ type: "text", text: `Invalid arguments for ${name}: ${validationErrors.join("; ")}` }],
    isError: true,
  };
}
```

Add this as a helper function within `server.ts` (not a separate file -- it only needs ~20 lines and the TOOLS array is already in scope).

**Acceptance criteria:**
- Missing `cwd` returns a clear error message (not a deep crash)
- Wrong-type `cwd` (e.g., number) returns a clear error message
- Valid calls pass through unchanged
- Build passes

**Estimated effort:** 30 minutes
**Risk:** Low

---

## Wave 3: Type Safety (eliminate any casts in dispatch, beads.ts unsafe casts)

### 3.1 Typed Tool Dispatch in server.ts

**Description:** Every tool handler dispatches through `args as any`. Replace with typed casts from `Record<string, unknown>` to specific `*Args` interfaces.

**Files to modify:**
- `mcp-server/src/types.ts` -- add canonical `ToolArgsMap` with all arg interfaces
- `mcp-server/src/server.ts` -- lines 213-226: replace `as any` with typed casts
- Individual tool files (`profile.ts`, `discover.ts`, `select.ts`, `plan.ts`, `approve.ts`, `review.ts`, `memory-tool.ts`) -- export their `*Args` interfaces (or remove local duplicates in favor of `types.ts` imports)

**Approach (Correctness plan -- centralize Args types in `types.ts`):**

Step 1 -- Define typed argument interfaces in `types.ts`:
```typescript
export interface ProfileArgs { cwd: string; goal?: string }
export interface DiscoverArgs { cwd: string; ideas: CandidateIdea[] }
export interface SelectArgs { cwd: string; goal: string }
export interface PlanArgs { cwd: string; mode?: "standard" | "deep"; planContent?: string; planFile?: string }
export interface ApproveArgs { cwd: string; action: "start" | "polish" | "reject" | "advanced" | "git-diff-review"; advancedAction?: string }
export interface ReviewArgs { cwd: string; beadId: string; action: "hit-me" | "looks-good" | "skip" }
export interface MemoryArgs { cwd: string; query?: string; operation?: "search" | "store"; content?: string }
```

Step 2 -- Replace `args as any` with `rawArgs as ProfileArgs` etc. (narrowing from `Record<string, unknown>` rather than from opaque `any`).

Step 3 -- Remove duplicate local `Args` interfaces from individual tool files, import from `types.ts`.

**Acceptance criteria:**
- No `as any` casts remain in `server.ts` dispatch block
- All tool arg interfaces are defined in one canonical location (`types.ts`)
- Compiler catches mismatched argument shapes when handler signatures change
- Build passes

**Estimated effort:** 1 hour
**Risk:** Low
**Dependencies:** Wave 2.2 (runtime validation) should land first to provide the safety net.

---

### 3.2 Safe Bead Parsing in beads.ts

**Description:** `beads.ts` lines 244 and 258 use `as Bead[]` cast on unvalidated data. If the data contains objects that don't match the `Bead` interface, downstream code fails with cryptic property-access errors.

**Files to modify:**
- `mcp-server/src/beads.ts` -- lines 244, 258

**Approach (Correctness plan):**

Add a `parseBead` function that validates the shape of each object:
```typescript
function parseBead(raw: unknown): Bead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.title !== "string") return null;
  return {
    id: obj.id,
    title: obj.title,
    description: typeof obj.description === "string" ? obj.description : "",
    status: validateStatus(obj.status) ?? "open",
    priority: typeof obj.priority === "number" ? obj.priority : 0,
    type: typeof obj.type === "string" ? obj.type : "task",
    labels: Array.isArray(obj.labels) ? obj.labels.filter(l => typeof l === "string") : [],
  };
}
```

Replace the `as Bead[]` casts with `data.map(parseBead).filter(Boolean)`.

**Acceptance criteria:**
- No `as Bead[]` casts on unvalidated data
- Malformed bead data produces empty/filtered results instead of runtime crashes
- Existing beads.test.ts passes
- Build passes

**Estimated effort:** 45 minutes
**Risk:** Low-medium (verify downstream consumers handle potentially fewer beads)

---

## Wave 4: Robustness (abort signal propagation, checkpoint concurrency, shell injection fix)

### 4.1 Shell Injection Fix in amHelperScript

**Description:** `agent-mail.ts` lines 526-604 use partial escaping that does not handle backticks, `$(...)`, or newlines. A `cwd` path containing backticks causes shell injection in generated helper scripts. This is a **security issue**.

**Files to modify:**
- `mcp-server/src/agent-mail.ts` -- lines 526-540

**Approach (Robustness plan):**

Replace the current `safeCwd`/`safeThread` double-quote escaping with single-quote wrapping (single-quoted strings in bash cannot be broken by `$`, backtick, or `\`):
```typescript
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
```

Use `shellSingleQuote` for all variable assignments in the generated script. Remove the existing partial escaping.

**Acceptance criteria:**
- Paths with backticks, `$(...)`, single quotes, and newlines are safely quoted
- Generated helper script passes shellcheck (no injection vectors)
- Existing functionality unchanged for normal paths

**Estimated effort:** 20 minutes
**Risk:** Low (pure improvement, no behavior change for safe paths)

---

### 4.2 Abort Signal Propagation in exec.ts and profiler.ts

**Description:** Every collector function in `profiler.ts` accepts `signal?: AbortSignal` but never passes it to `exec()`. The `exec` function signature does not accept an AbortSignal either. If a caller aborts, child processes keep running.

**Files to modify:**
- `mcp-server/src/exec.ts` -- lines 3-27 (add `signal` to opts, wire to `child.kill`)
- `mcp-server/src/profiler.ts` -- lines 74-248 (thread signal through all collector calls)

**Approach (Robustness plan -- wire signal end-to-end):**

Step 1 -- Extend `ExecFn` type to accept `signal?: AbortSignal` in opts.

Step 2 -- In `makeExec`, wire `signal.addEventListener("abort", ...)` to `child.kill('SIGTERM')`.

Step 3 -- Thread signal from `profileRepo` through all collector functions to their `exec` calls.

**Acceptance criteria:**
- `ExecFn` type includes optional `signal` in opts
- Aborting the signal kills child processes
- Already-aborted signal prevents spawn
- All existing tests pass

**Estimated effort:** 1 hour
**Risk:** Low-medium
**Dependencies:** Wave 1.2 (ExecFn dedup) must land first.

---

### 4.3 Checkpoint Write-Lock for Concurrent Writes

**Description:** If two tool calls execute concurrently on the same `cwd`, both may enter `writeCheckpoint` simultaneously. The atomic rename strategy breaks down: Call A could rename B's tmp file, and Call B gets ENOENT.

**Files to modify:**
- `mcp-server/src/checkpoint.ts` -- lines 138-170 (add per-cwd write mutex)
- `mcp-server/src/state.ts` -- line 17 (await the now-async writeCheckpoint)

**Approach (Robustness plan):**

Add a per-`cwd` write mutex using a simple in-process Map of Promises:
```typescript
const writeLocks = new Map<string, Promise<boolean>>();

export async function writeCheckpoint(cwd: string, state: OrchestratorState): Promise<boolean> {
  const prev = writeLocks.get(cwd) ?? Promise.resolve(true);
  const next = prev.then(() => writeCheckpointInner(cwd, state));
  writeLocks.set(cwd, next.catch(() => true));
  return next;
}
```

**Acceptance criteria:**
- Concurrent writes to the same `cwd` are serialized
- Failed writes do not block subsequent writes
- `saveState` in `state.ts` awaits the result
- Existing checkpoint tests pass

**Estimated effort:** 45 minutes
**Risk:** Low (unlikely race in practice, but correctness matters)
**Dependencies:** Wave 1.1 (version.ts) since `writeCheckpoint` signature changes.

---

### 4.4 Checkpoint Version Mismatch Warning

**Description:** When a checkpoint written at v2.0.0 is read at v2.3.0, there is no warning. A breaking state schema change between versions would cause tools to fail unpredictably.

**Files to modify:**
- `mcp-server/src/checkpoint.ts` -- lines 71-73 (`ValidationResult` type), lines 100-105 (add version comparison)

**Approach (Robustness plan):**

Extend `ValidationResult` to include optional `warnings: string[]`. Add a version comparison in `validateCheckpoint` that emits a warning (not rejection) when the checkpoint version differs from the current version.

**Acceptance criteria:**
- `ValidationResult` has an optional `warnings` field
- Version mismatch produces a warning, not a failure
- Old checkpoints still load successfully
- New checkpoints embed the correct version

**Estimated effort:** 20 minutes
**Risk:** Very low

---

## Wave 5: Testing

### 5.1 agent-mail.test.ts

**Description:** `agent-mail.ts` has 20+ exported functions with zero test coverage. This is the highest-priority test gap.

**Files to create:**
- `mcp-server/src/__tests__/agent-mail.test.ts`

**Test cases (merged from Correctness + Ergonomics):**
- `agentMailRPC`: returns ok:true with data on success; returns ok:false with kind:network on curl failure; returns ok:false with kind:parse on invalid JSON; returns ok:false with kind:rpc_error on JSON-RPC error; returns ok:false with kind:empty_response on null data
- `matchesReservationPath`: exact match; glob wildcard; double wildcard; leading "./" normalization; empty pattern
- `normalizeReservations`: handles array directly; handles `{ reservations: [...] }`; handles `{ items: [...] }`; returns [] for null/undefined
- `amRpcCmd`: generates valid curl command; escapes single quotes in JSON body
- `healthCheck`: returns status on healthy response; returns null on RPC failure
- `unwrapRPC`: returns data on ok:true; returns null and logs on ok:false

**Acceptance criteria:**
- All listed test cases pass
- Uses `createMockExec` from existing test helpers

**Estimated effort:** 2 hours
**Risk:** Low (additive, no production code changes)
**Dependencies:** Wave 2.1 (discriminated union) should land first so tests cover the new API.

---

### 5.2 profiler.test.ts

**Description:** `profiler.ts` has complex language/framework detection logic and a `Promise.allSettled` error isolation pattern, all untested.

**Files to create:**
- `mcp-server/src/__tests__/profiler.test.ts`

**Test cases (from Ergonomics plan):**
- `profileRepo`: detects TypeScript from .ts extensions; sets hasTests when vitest found; returns partial results when a collector fails; sets name from directory path
- `createEmptyRepoProfile`: returns valid RepoProfile with correct name
- `formatBestPracticesGuides`: empty input; single guide; content included

**Acceptance criteria:**
- At least 6 passing tests covering the listed cases
- Uses `createMockExec` pattern

**Estimated effort:** 1.5 hours
**Risk:** Low (additive)

---

### 5.3 coordination.test.ts

**Description:** `selectStrategy` and `selectMode` contain decision logic that determines the entire execution strategy. Untested.

**Files to create:**
- `mcp-server/src/__tests__/coordination.test.ts`

**Test cases (from Correctness plan):**
- `selectStrategy`: beads+agentMail -> "beads+agentmail"; sophia only -> "sophia"; nothing -> "worktrees"; beads without agentMail -> "worktrees"
- `selectMode`: agentMail available -> "single-branch"; agentMail not available -> "worktree"

**Acceptance criteria:**
- All strategy/mode selection paths covered
- Tests pass

**Estimated effort:** 1 hour
**Risk:** Low (additive)

---

### 5.4 Shell Injection Safety Tests

**Description:** After fixing the shell injection in Wave 4.1, add regression tests to prevent re-introduction.

**Files to create:**
- `mcp-server/src/__tests__/agent-mail-script.test.ts`

**Test cases (from Robustness plan):**
- Paths with backticks are safe in generated script
- Paths with `$(...)` are safe
- Paths with single quotes are safe
- Paths with dollar signs are safe
- Normal paths produce valid bash

**Acceptance criteria:**
- All injection vectors tested and pass
- Generated scripts are syntactically valid bash

**Estimated effort:** 30 minutes
**Risk:** Low (additive)
**Dependencies:** Wave 4.1 (shell injection fix)

---

### 5.5 Checkpoint Edge Case Tests

**Description:** Add tests for concurrent write behavior and version mismatch warnings.

**Files to modify:**
- `mcp-server/src/__tests__/checkpoint.test.ts` -- add new test cases

**Test cases:**
- Concurrent writes to same cwd are serialized (no data loss)
- Version mismatch in checkpoint produces warning in ValidationResult
- VERSION constant matches package.json

**Acceptance criteria:**
- New test cases pass
- No regressions in existing 9 checkpoint tests

**Estimated effort:** 45 minutes
**Risk:** Low (additive)
**Dependencies:** Wave 4.3 and 4.4

---

## Wave 6: Cleanup (deduplicate buildRepoProfile, remove dead code)

### 6.1 Remove Duplicate buildRepoProfile from tools/profile.ts

**Description:** `tools/profile.ts` contains its own `buildRepoProfile()` (lines 92-229) that duplicates `profileRepo` from `profiler.ts` with different implementations (different find depth, different exclusions, different framework detection). The `profiler.ts` version is more thorough.

**Files to modify:**
- `mcp-server/src/tools/profile.ts` -- lines 92-229: remove `buildRepoProfile`, import `profileRepo` from `profiler.ts`
- `mcp-server/src/profiler.ts` -- may need to add any missing key files (CLAUDE.md, AGENTS.md) to `collectKeyFiles`

**Approach (consensus across all 3 plans):**

Step 1 -- Diff the two implementations and document any behavioral gaps.

Step 2 -- Add any missing detection from `buildRepoProfile` into `profiler.ts` collectors.

Step 3 -- Replace `buildRepoProfile` call in `runProfile` with `profileRepo` import.

Step 4 -- Remove `buildRepoProfile` function and `tryParse` helper if no longer used.

**Acceptance criteria:**
- `buildRepoProfile` in `tools/profile.ts` is removed
- `runProfile` uses `profileRepo` from `profiler.ts` directly
- All existing `profile.test.ts` tests pass
- `tools/profile.ts` shrinks by ~140 lines

**Estimated effort:** 1 hour
**Risk:** Medium (verify `profileRepo` return shape is compatible with all consumers)
**Dependencies:** Wave 1.3 (logger in profiler.ts), Wave 4.2 (signal propagation) to avoid touching profiler.ts multiple times.

---

## Summary

| Wave | Items | Estimated Effort | Risk |
|------|-------|-----------------|------|
| 1: Foundation | 1.1 version.ts, 1.2 ExecFn dedup, 1.3 profiler logger, 1.4 logger cache | 1 hour | Very low |
| 2: Error handling | 2.1 AgentMailResult union, 2.2 runtime arg validation | 3 hours | Medium |
| 3: Type safety | 3.1 typed dispatch, 3.2 safe bead parsing | 1.75 hours | Low |
| 4: Robustness | 4.1 shell injection fix, 4.2 abort signal, 4.3 checkpoint lock, 4.4 version warning | 2.5 hours | Low-medium |
| 5: Testing | 5.1 agent-mail tests, 5.2 profiler tests, 5.3 coordination tests, 5.4 injection tests, 5.5 checkpoint tests | 5.75 hours | Low |
| 6: Cleanup | 6.1 deduplicate buildRepoProfile | 1 hour | Medium |
| **Total** | **17 items** | **~15 hours** | |

**Critical path:** Waves 1-2 are highest-value and should be done first. Wave 5 (testing) can be parallelized with Waves 3-4 since tests are additive. Wave 6 should be last since it touches files modified in earlier waves.

---

## Files Index

All paths relative to `mcp-server/src/`:

| File | Wave(s) | Key changes |
|------|---------|-------------|
| `version.ts` | 1.1 | NEW -- single version source |
| `server.ts` | 1.1, 2.2, 3.1 | Version import, arg validation, typed dispatch |
| `state.ts` | 1.1, 4.3 | Version import, async saveState |
| `checkpoint.ts` | 1.1, 4.3, 4.4 | Remove version param, write lock, version warning |
| `exec.ts` | 1.2, 4.2 | ExecFn canonical home, abort signal support |
| `agent-mail.ts` | 1.2, 2.1, 4.1 | ExecFn import, discriminated union, shell injection fix |
| `profiler.ts` | 1.3, 4.2, 6.1 | Structured logger, signal threading, absorb buildRepoProfile gaps |
| `logger.ts` | 1.4 | Cached MIN_LEVEL |
| `types.ts` | 2.1, 3.1 | AgentMailResult type, ToolArgsMap |
| `beads.ts` | 3.2 | Safe bead parsing |
| `coordination.ts` | 1.2 | ExecFn import fix |
| `tools/profile.ts` | 6.1 | Remove buildRepoProfile |
| `__tests__/agent-mail.test.ts` | 5.1 | NEW |
| `__tests__/profiler.test.ts` | 5.2 | NEW |
| `__tests__/coordination.test.ts` | 5.3 | NEW |
| `__tests__/agent-mail-script.test.ts` | 5.4 | NEW |
| `__tests__/checkpoint.test.ts` | 1.1, 5.5 | Updated call sites + new edge case tests |
