# Correctness Plan — 2026-04-09

**Agent:** LavenderBasin (claude-opus-4-6)
**Focus:** Type safety, error discrimination, version consistency, schema validation, test coverage

---

## 1. Eliminate `as any` in Tool Dispatch (server.ts)

### Problem

`server.ts` lines 192-226 cast every tool argument to `any`:

```ts
const cwd = (args as any)?.cwd as string;
// ...
return await runProfile(ctx, args as any);
```

This defeats TypeScript's type system entirely. A malformed argument object (missing required fields, wrong types) is never caught at compile time and produces opaque runtime errors instead of clear validation failures.

### Solution: Discriminated union + runtime validation

**Files to modify:**
- `mcp-server/src/types.ts` — Add a `ToolArgs` discriminated union (lines ~460-475)
- `mcp-server/src/server.ts` — Replace `as any` casts with validated narrowing (lines 190-228)

**Step 1: Define typed argument interfaces in types.ts**

```ts
// Add after McpToolResult definition (~line 474)
export type ToolName =
  | "flywheel_profile"
  | "flywheel_discover"
  | "flywheel_select"
  | "flywheel_plan"
  | "flywheel_approve_beads"
  | "flywheel_review"
  | "flywheel_memory";

export interface ProfileArgs { cwd: string; goal?: string }
export interface DiscoverArgs { cwd: string; ideas: CandidateIdea[] }
export interface SelectArgs { cwd: string; goal: string }
export interface PlanArgs { cwd: string; mode?: "standard" | "deep"; planContent?: string; planFile?: string }
export interface ApproveArgs { cwd: string; action: "start" | "polish" | "reject" | "advanced" | "git-diff-review"; advancedAction?: string }
export interface ReviewArgs { cwd: string; beadId: string; action: "hit-me" | "looks-good" | "skip" }
export interface MemoryArgs { cwd: string; query?: string; operation?: "search" | "store"; content?: string }

export type ToolArgsMap = {
  flywheel_profile: ProfileArgs;
  flywheel_discover: DiscoverArgs;
  flywheel_select: SelectArgs;
  flywheel_plan: PlanArgs;
  flywheel_approve_beads: ApproveArgs;
  flywheel_review: ReviewArgs;
  flywheel_memory: MemoryArgs;
};
```

Note: Each tool file (profile.ts, discover.ts, etc.) already defines its own local `interface XxxArgs`. These should be **removed** from the individual tool files and the canonical definitions imported from `types.ts` to avoid drift.

**Step 2: Add a `validateCwd` helper and narrow in server.ts**

```ts
function extractCwd(args: Record<string, unknown>): string | null {
  return typeof args?.cwd === "string" && args.cwd.length > 0 ? args.cwd : null;
}
```

Replace the switch block to use typed casts only after `cwd` extraction:

```ts
const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
const cwd = extractCwd(rawArgs);
if (!cwd) { return { content: [...], isError: true }; }
// Now dispatch with typed args:
case "flywheel_profile":
  return await runProfile(ctx, rawArgs as ProfileArgs);
```

This is still a cast, but it is narrowing from `Record<string, unknown>` (which the MCP SDK guarantees) rather than from a fully opaque `any`. The individual tool handlers already do their own required-field checking.

**Step 3 (future, optional): Add @sinclair/typebox runtime validation**

`@sinclair/typebox` is already in `package.json` dependencies (line 15). Define TypeBox schemas that mirror the JSON Schema in `TOOLS[]` and validate before dispatch. This catches invalid args at the boundary instead of deep in tool logic.

**Risk:** Low. The interface definitions already exist locally in each tool file. This is a unification step.

**Dependencies:** None. Can be done independently.

---

## 2. Agent Mail RPC Error Discrimination (agent-mail.ts)

### Problem

`agentMailRPC` (lines 47-70) returns `Promise<any>` and swallows all errors:

```ts
} catch {
  return null;
}
```

Every caller must then guess whether `null` means "agent-mail is down", "permission denied", "invalid arguments", or "empty result". This is the single largest correctness gap in the codebase — 20+ call sites all use fallible `result?.something ?? fallback` patterns that silently hide real failures.

### Solution: Return a discriminated Result type

**Files to modify:**
- `mcp-server/src/agent-mail.ts` — lines 47-70, 75-99, and all exported functions
- `mcp-server/src/types.ts` — Add `AgentMailResult<T>` type

**Step 1: Define result type in types.ts**

```ts
export type AgentMailResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AgentMailError };

export interface AgentMailError {
  kind: "network" | "timeout" | "parse" | "rpc_error" | "empty_response";
  message: string;
  /** JSON-RPC error code if available */
  code?: number;
  /** Raw stderr from curl if available */
  stderr?: string;
}
```

**Step 2: Refactor agentMailRPC**

```ts
export async function agentMailRPC<T = unknown>(
  exec: ExecFn,
  toolName: string,
  args: Record<string, unknown>
): Promise<AgentMailResult<T>> {
  let result;
  try {
    result = await exec("curl", [...], { timeout: 8000 });
  } catch (err) {
    return { ok: false, error: { kind: "network", message: String(err) } };
  }

  if (result.code !== 0) {
    return { ok: false, error: { kind: "network", message: `curl exit ${result.code}`, stderr: result.stderr } };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: { kind: "parse", message: "Invalid JSON from agent-mail" } };
  }

  if (parsed?.error) {
    return { ok: false, error: { kind: "rpc_error", message: parsed.error.message, code: parsed.error.code } };
  }

  const data = parsed?.result?.structuredContent ?? parsed?.result;
  if (data === undefined || data === null) {
    return { ok: false, error: { kind: "empty_response", message: `No data from ${toolName}` } };
  }

  return { ok: true, data: data as T };
}
```

**Step 3: Update all callers (20+ functions)**

Each function that calls `agentMailRPC` needs to handle the result properly. Example for `ensureAgentMailProject`:

```ts
export async function ensureAgentMailProject(exec: ExecFn, cwd: string): Promise<AgentMailResult<void>> {
  const result = await agentMailRPC(exec, "ensure_project", { human_key: cwd });
  if (!result.ok) return result;
  return { ok: true, data: undefined };
}
```

Callers in tool files (e.g. `tools/profile.ts`) that currently ignore agent-mail failures can continue to do so, but now they can log the specific error kind.

**Risk:** Medium. This is a wide-reaching change (20+ call sites). Should be done in one commit to avoid partial migration.

**Dependencies:** Should be done after item 1 (types.ts changes) to avoid merge conflicts.

---

## 3. Version Consistency (3 hardcoded locations)

### Problem

The version string is hardcoded in three separate places that are already out of sync:

| Location | Value | Line |
|---|---|---|
| `mcp-server/package.json` | `"2.3.0"` | line 3 |
| `mcp-server/src/server.ts` | `"2.0.0"` | line 18 |
| `mcp-server/src/state.ts` | `"2.0.0"` | line 6 |

`server.ts` reports version `2.0.0` to the MCP SDK, but the actual package is `2.3.0`. `state.ts` writes `2.0.0` into checkpoint files, so crash recovery cannot detect version mismatches.

### Solution: Single source of truth from package.json

**Files to modify:**
- `mcp-server/src/version.ts` — **New file** (3 lines)
- `mcp-server/src/server.ts` — line 18
- `mcp-server/src/state.ts` — line 6

**Step 1: Create version.ts**

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
export const VERSION: string = pkg.version;
```

**Step 2: Import in server.ts and state.ts**

```ts
// server.ts line 18
import { VERSION } from './version.js';
const server = new Server(
  { name: "agent-flywheel", version: VERSION },
  ...
);

// state.ts line 6
import { VERSION } from './version.js';
// Remove: const VERSION = '2.0.0';
```

**Risk:** Very low. Pure refactor, no behavior change.

**Dependencies:** None.

---

## 4. profiler.ts: Unused AbortSignal Parameter

### Problem

Every collector function in `profiler.ts` accepts `signal?: AbortSignal` but never passes it to `exec()`. The `exec` function signature in `exec.ts` does not accept an AbortSignal either. These parameters are dead code that suggests unfinished cancellation support.

**Locations:**
- `collectFileTree` (line 74, param `signal`)
- `collectCommits` (line 97, param `signal`)
- `collectTodos` (line 123, param `signal`)
- `collectKeyFiles` (line 169, param `signal`)
- `collectBestPracticesGuides` (line 203, param `signal`)
- `profileRepo` (line 10, param `signal`)

### Solution: Two options

**Option A (recommended): Remove unused signal params**

Simply delete the `signal?: AbortSignal` parameter from all 6 functions. This eliminates dead code and false promises to callers.

**Option B (future): Wire up AbortSignal to exec**

Add `signal?: AbortSignal` to `ExecFn` type in `exec.ts`, call `child.kill()` on signal abort. This is a larger change and belongs in a "robustness" plan.

**Risk:** Very low for option A.

**Dependencies:** None.

---

## 5. profiler.ts: Direct process.stderr.write

### Problem

`profiler.ts` line 27-29 writes directly to `process.stderr` instead of using the structured logger:

```ts
process.stderr.write(
  `[profiler] ${label} collector failed: ${(results[i] as PromiseRejectedResult).reason}\n`
);
```

This bypasses log-level filtering and produces unstructured output mixed with the JSON log lines from `logger.ts`.

### Solution

**File:** `mcp-server/src/profiler.ts` lines 1, 27-29

Add `import { createLogger } from "./logger.js"` and replace `process.stderr.write(...)` with `log.warn(...)`.

**Risk:** Minimal.

**Dependencies:** None.

---

## 6. Duplicate ExecFn Type Definition

### Problem

`ExecFn` is defined in two places:
- `mcp-server/src/exec.ts` line 3 (canonical, used by server.ts)
- `mcp-server/src/agent-mail.ts` line 4 (duplicate, used by agent-mail and coordination modules)

The types are identical today but can drift. Several modules import from `agent-mail.ts` just to get `ExecFn`:
- `coordination.ts` line 4: `import type { ExecFn } from "./agent-mail.js"`

### Solution

**Files to modify:**
- `mcp-server/src/agent-mail.ts` — Remove `ExecFn` type, import from `exec.ts`
- `mcp-server/src/coordination.ts` — Change import to `from "./exec.js"`
- `mcp-server/src/types.ts` — Already re-exports `ExecFn` from `exec.ts` (line 461)

**Risk:** Low. Type-only change.

**Dependencies:** None.

---

## 7. beads.ts: Unsafe Array Coercion

### Problem

`beads.ts` lines 244 and 258 use unsafe coercion:

```ts
return (Array.isArray(data) ? data : (data as any)?.issues ?? []) as Bead[];
```

If `data.issues` contains objects that don't match the `Bead` interface, downstream code will fail with cryptic property-access errors instead of a clear "invalid bead data" message.

### Solution

Add a `parseBead` function that validates shape:

```ts
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
    // ... remaining optional fields
  };
}
```

Replace the `as Bead[]` cast with `data.map(parseBead).filter(Boolean)`.

**Risk:** Low-medium. Need to check all downstream consumers handle potentially fewer beads.

**Dependencies:** None.

---

## 8. Missing Test Coverage

### Current state

Existing test files (15 files under `mcp-server/src/__tests__/`):
- `checkpoint.test.ts` — thorough (9 tests)
- `logger.test.ts` — exists
- `state.test.ts` — exists
- `types.test.ts` — exists
- `beads.test.ts` — exists
- `tender.test.ts` — exists
- `tools/approve.test.ts` — exists
- `tools/discover.test.ts` — exists
- `tools/memory-tool.test.ts` — exists
- `tools/plan.test.ts` — exists
- `tools/profile.test.ts` — exists
- `tools/review.test.ts` — exists
- `tools/select.test.ts` — exists
- `tools/shared.test.ts` — exists

### Missing test files (correctness-critical)

| Module | Why it needs tests | Priority |
|---|---|---|
| `agent-mail.ts` | 20+ exported functions, all untested. `agentMailRPC` error paths, `matchesReservationPath` glob logic, `normalizeReservations` shape handling | P0 |
| `coordination.ts` | `selectStrategy`, `selectMode` decision logic; `detectCoordinationBackend` caching behavior | P1 |
| `exec.ts` | Timeout behavior, error propagation, stderr capture | P1 |
| `profiler.ts` | Language/framework detection logic (pure functions), `detectEntrypoints` | P2 |
| `server.ts` | Tool dispatch routing, unknown tool handling, cwd validation | P2 |

### Specific test cases needed for agent-mail.ts

```
describe("agentMailRPC")
  - returns null on curl timeout
  - returns null on invalid JSON
  - returns structuredContent when present
  - returns result when structuredContent absent
  - handles empty stdout

describe("matchesReservationPath")
  - exact match: "src/foo.ts" matches "src/foo.ts"
  - glob wildcard: "src/*.ts" matches "src/foo.ts"
  - glob wildcard: "src/*.ts" does NOT match "src/sub/foo.ts"
  - double wildcard: "src/**" matches "src/sub/foo.ts"
  - double wildcard: "src/**" matches "src" (edge case)
  - leading "./" normalization: "./src/foo.ts" matches "src/foo.ts"
  - empty pattern returns false

describe("normalizeReservations")
  - handles array directly
  - handles { reservations: [...] }
  - handles { items: [...] }
  - returns [] for null/undefined
  - returns [] for non-array non-object

describe("amRpcCmd")
  - generates valid curl command
  - escapes single quotes in JSON body

describe("agentMailTaskPreamble")
  - includes agent name placeholder
  - includes thread ID
  - escapes special characters in description
```

### Specific test cases for coordination.ts

```
describe("selectStrategy")
  - beads+agentMail -> "beads+agentmail"
  - sophia only -> "sophia"
  - nothing -> "worktrees"
  - beads without agentMail -> "worktrees" (NOT "beads")

describe("selectMode")
  - agentMail available -> "single-branch"
  - agentMail not available -> "worktree"
```

---

## 9. state.ts: Hardcoded Version (see item 3)

Covered in item 3 above. The `VERSION = '2.0.0'` constant in `state.ts` line 6 is out of sync with `package.json` version `2.3.0`.

---

## 10. tools/profile.ts: Duplicate Profiling Logic

### Problem

`tools/profile.ts` contains its own `buildRepoProfile()` function (lines 92-229) that duplicates much of the logic in `profiler.ts`. Both detect languages, frameworks, CI, tests, TODOs, and key files — but with different implementations:

- `profiler.ts` uses `find` with `-maxdepth 4` and ignores more directories
- `tools/profile.ts` uses `find` with `-maxdepth 3` and fewer exclusions
- `profiler.ts` detects more frameworks (Hono, NestJS, Drizzle, etc.)
- `tools/profile.ts` uses `cat` to read key files; `profiler.ts` uses `head -c 4096`

### Solution

Remove `buildRepoProfile()` from `tools/profile.ts` and import `profileRepo` from `profiler.ts` instead. The `profiler.ts` implementation is more thorough and has the `Promise.allSettled` error isolation pattern.

**Risk:** Medium. The profiler.ts version returns a slightly different shape (includes `bestPracticesGuides`, `readme`, `packageManager`). Need to verify all consumers handle the richer type.

**Dependencies:** Should be done after item 4 (signal cleanup) to avoid touching the same code twice.

---

## Implementation Order

The items are ordered by dependency chain and risk:

| Phase | Items | Risk | Estimated effort |
|---|---|---|---|
| 1 | 3 (version), 5 (stderr), 6 (ExecFn dedup) | Very low | 30 min |
| 2 | 4 (AbortSignal removal) | Very low | 15 min |
| 3 | 1 (type-safe dispatch) | Low | 1 hour |
| 4 | 7 (beads parse safety) | Low-medium | 45 min |
| 5 | 2 (AgentMailResult) | Medium | 2-3 hours |
| 6 | 10 (profile dedup) | Medium | 1 hour |
| 7 | 8 (missing tests) | Low (additive) | 3-4 hours |

**Total estimated effort:** ~8-10 hours

**Critical path:** Items 1 and 2 are the highest-value correctness wins. Item 3 is the easiest quick win. Item 8 (tests) can be parallelized with any other item.

---

## Files Index

All paths relative to `mcp-server/src/`:

| File | Items | Key lines |
|---|---|---|
| `server.ts` | 1, 3 | 18, 192, 214-226 |
| `types.ts` | 1, 2 | 460-475 (new), 471-474 |
| `agent-mail.ts` | 2, 6 | 4, 47-70, 75-99 |
| `state.ts` | 3 | 6 |
| `version.ts` | 3 | New file |
| `profiler.ts` | 4, 5 | 10, 27-29, 74, 97, 123, 169, 203 |
| `exec.ts` | 6 | 3 |
| `coordination.ts` | 6 | 4 |
| `beads.ts` | 7 | 244, 258 |
| `tools/profile.ts` | 10 | 92-229 |
| `__tests__/agent-mail.test.ts` | 8 | New file |
| `__tests__/coordination.test.ts` | 8 | New file |
| `__tests__/exec.test.ts` | 8 | New file |
| `package.json` | 3 | 3 |
