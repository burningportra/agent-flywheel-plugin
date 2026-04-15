# Ergonomics Plan: Reliability Sweep — Developer Experience Focus

**Date:** 2026-04-09
**Agent:** RoseCrane
**Perspective:** Ergonomics — developer experience, readable APIs, friction-free maintenance, testable design.

---

## 1. Problem Statement

This plan examines six ergonomic friction points found across the MCP server source:

1. **`server.ts` — hardcoded version + `any` type casts in dispatch**: The version string `"2.0.0"` is hardcoded separately from `package.json`. Every tool handler dispatches through `args as any` — callers cannot be guided by the type system.
2. **`agent-mail.ts` — silent RPC failures**: `agentMailRPC` swallows all errors and returns `null`. Call sites cannot distinguish "server unreachable," "tool call rejected," and "malformed response" — all look identical at the call site.
3. **`profiler.ts` — bare `process.stderr.write` for collector failures**: Error signals from failed collectors are written as raw strings via `process.stderr.write`, bypassing the structured `createLogger` pattern used everywhere else.
4. **`tools/profile.ts` — duplicate repo-scanning logic**: `buildRepoProfile` in `profile.ts` reimplements most of `profileRepo` from `profiler.ts`. Two divergent implementations of the same thing increases the maintenance cost of changes.
5. **`checkpoint.ts` — version string passed as bare string parameter**: `writeCheckpoint(cwd, state, flywheelVersion)` receives a string. Every caller must know to pass `"2.3.0"` — with no single source of truth, versions drift.
6. **Testing patterns — no `agent-mail.ts` tests, no `profiler.ts` tests**: The two files with the highest external I/O surface have zero test coverage.

---

## 2. Ergonomic Principles Applied

1. **The type system should eliminate entire classes of bugs**: Removing `as any` from dispatch means TypeScript enforces tool argument shapes at compile time.
2. **Errors should be informative at the call site, not just at the throw site**: A caller of `agentMailRPC` that receives `null` cannot write a useful error message. Return a discriminated union so callers know what happened.
3. **Logging should use one pattern, not two**: Using `process.stderr.write` alongside `createLogger` creates two mental models. Consolidate on the logger.
4. **Single source of truth for version**: The version should be read from `package.json` once at startup. No magic strings scattered in source.
5. **Tests should be writable, not just runnable**: Test patterns should be easy to clone for new cases. The existing `createMockExec` pattern is excellent — it should be extended to cover `agent-mail.ts` and `profiler.ts`.

---

## 3. Detailed Change Plan

---

### 3.1 Version Management — Single Source of Truth

**Files:** `mcp-server/src/server.ts` (line 18), `mcp-server/src/checkpoint.ts` (line 142)

**Current state:**
- `server.ts` line 18: `{ name: "agent-flywheel", version: "2.0.0" }` — hardcoded, diverges from `package.json` (`"2.3.0"`).
- `checkpoint.ts` `writeCheckpoint(cwd, state, flywheelVersion: string)` — callers must pass the version string manually.

**Change:**
Create `mcp-server/src/version.ts`:

```typescript
// mcp-server/src/version.ts
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
/** Package version read from package.json at startup. Never hardcode this elsewhere. */
export const ORCHESTRATOR_VERSION: string = pkg.version;
```

Update `server.ts` line 17-20:
```typescript
import { ORCHESTRATOR_VERSION } from './version.js';
const server = new Server(
  { name: "agent-flywheel", version: ORCHESTRATOR_VERSION },
  { capabilities: { tools: {} } }
);
```

Update `checkpoint.ts`: remove the `flywheelVersion` parameter from `writeCheckpoint` and import `ORCHESTRATOR_VERSION` directly:

```typescript
// Before (line 139-143):
export function writeCheckpoint(
  cwd: string,
  state: OrchestratorState,
  flywheelVersion: string
): boolean {

// After:
import { ORCHESTRATOR_VERSION } from './version.js';
export function writeCheckpoint(
  cwd: string,
  state: OrchestratorState
): boolean {
  // ... uses ORCHESTRATOR_VERSION internally
```

**Why this improves ergonomics:**
- A contributor editing the version in `package.json` gets a correct version everywhere automatically.
- `writeCheckpoint` call sites no longer need to pass a string they have no way of knowing — callers just pass `(cwd, state)`.
- Test helpers that call `writeCheckpoint` can be simplified (see §3.6).

**Implementation order:** First (no dependencies).

**Line numbers to change:**
- `server.ts` line 18: replace `version: "2.0.0"` with `version: ORCHESTRATOR_VERSION`
- `checkpoint.ts` line 139-143: remove `flywheelVersion` parameter
- `checkpoint.ts` line 150: use `ORCHESTRATOR_VERSION` instead of parameter
- All test callsites: `writeCheckpoint(dir, state, '1.0.0-test')` → `writeCheckpoint(dir, state)` (checkpoint.test.ts lines 122, 129, 137, 144, 212, 232)

---

### 3.2 Discriminated Union for `agentMailRPC` Return Type

**File:** `mcp-server/src/agent-mail.ts` (lines 47-70)

**Current state:**
```typescript
export async function agentMailRPC(
  exec: ExecFn,
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  // ...
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.result?.structuredContent ?? parsed?.result ?? null;
  } catch {
    return null;
  }
}
```

Every caller (e.g. `ensureAgentMailProject`, `reserveFileReservations`, `fetchInbox`) receives `null` on any failure. They cannot tell the server was unreachable vs. the response was malformed vs. the tool returned a JSON-RPC error.

**Change — introduce a typed result union:**

```typescript
// In agent-mail.ts, replace return type of agentMailRPC:
export type AgentMailRPCSuccess = { ok: true; data: unknown };
export type AgentMailRPCFailure = {
  ok: false;
  reason: "unreachable" | "json_parse_error" | "rpc_error" | "timeout";
  message: string;
  rawStdout?: string;
};
export type AgentMailRPCResult = AgentMailRPCSuccess | AgentMailRPCFailure;

export async function agentMailRPC(
  exec: ExecFn,
  toolName: string,
  args: Record<string, unknown>
): Promise<AgentMailRPCResult> {
  const body = JSON.stringify({ ... });

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await exec("curl", [...], { timeout: 8000 });
  } catch (err) {
    return { ok: false, reason: "unreachable", message: String(err) };
  }

  if (result.code !== 0) {
    return {
      ok: false,
      reason: "unreachable",
      message: `curl exited ${result.code}: ${result.stderr.trim() || "no stderr"}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      reason: "json_parse_error",
      message: "agent-mail response is not valid JSON",
      rawStdout: result.stdout.slice(0, 200),
    };
  }

  const rpcError = (parsed as any)?.error;
  if (rpcError) {
    return {
      ok: false,
      reason: "rpc_error",
      message: rpcError.message ?? JSON.stringify(rpcError),
    };
  }

  const data = (parsed as any)?.result?.structuredContent
    ?? (parsed as any)?.result
    ?? null;
  return { ok: true, data };
}
```

**Callers that need updating** — adopt a helper to preserve backward compatibility:

```typescript
/**
 * Unwrap AgentMailRPCResult to the previous `any | null` shape.
 * Use in existing callers that don't yet handle failure branches.
 * New code should use agentMailRPC directly and handle the union.
 */
function unwrapRPC(result: AgentMailRPCResult): unknown {
  if (!result.ok) {
    log.warn("agent-mail RPC failed", { reason: result.reason, message: result.message });
    return null;
  }
  return result.data;
}
```

Callers like `ensureAgentMailProject`, `reserveFileReservations` etc. can be migrated incrementally: wrap with `unwrapRPC` first, then migrate to full union handling over time.

**Why this improves ergonomics:**
- TypeScript narrows failure paths with `if (!result.ok)` — no silent nulls.
- `reason` gives operators a machine-readable failure taxonomy without parsing error strings.
- Backward-compat `unwrapRPC` wrapper means existing callers need only a one-line change.
- `healthCheck()` can now properly distinguish "server down" from "server returned unexpected data".

**Implementation order:** Second (after version fix, since it doesn't depend on it).

---

### 3.3 Profiler — Replace `process.stderr.write` with `createLogger`

**File:** `mcp-server/src/profiler.ts` (lines 26-31)

**Current state:**
```typescript
for (const [i, label] of (["fileTree", "commits", "todos", "keyFiles"] as const).entries()) {
  if (results[i].status === "rejected") {
    process.stderr.write(
      `[profiler] ${label} collector failed: ${(results[i] as PromiseRejectedResult).reason}\n`
    );
  }
}
```

This raw `process.stderr.write` produces an unstructured string line — inconsistent with every other module which uses `createLogger`.

**Change:**
```typescript
import { createLogger } from './logger.js';
const log = createLogger('profiler');

// In profileRepo, replace the stderr.write loop:
for (const [i, label] of (["fileTree", "commits", "todos", "keyFiles"] as const).entries()) {
  if (results[i].status === "rejected") {
    log.warn("collector failed", {
      collector: label,
      reason: String((results[i] as PromiseRejectedResult).reason),
    });
  }
}
```

**Why this improves ergonomics:**
- Consistent JSON lines on stderr — operators can grep/parse without special-casing `profiler.ts`.
- `ORCH_LOG_LEVEL` filtering applies (set to `error` to silence non-critical warnings).
- Field names (`collector`, `reason`) are greppable without parsing free-form strings.

**Implementation order:** Third (trivial, independent).

**Line numbers:**
- `profiler.ts` lines 1-2: add `import { createLogger } from './logger.js'; const log = createLogger('profiler');`
- `profiler.ts` lines 26-31: replace `process.stderr.write` block with `log.warn(...)` call

---

### 3.4 `tools/profile.ts` — Remove Duplicate `buildRepoProfile`

**File:** `mcp-server/src/tools/profile.ts` (lines 92-229)

**Current state:**
`buildRepoProfile` in `profile.ts` (138 lines) reimplements `profileRepo` from `profiler.ts`. They have overlapping logic for git log parsing, file extension detection, key file reading, CI detection, and TODO scanning. The implementations diverge subtly (different git log format strings, different find depth limits, different key file lists).

**Change — migrate `profile.ts` to use `profileRepo` from `profiler.ts`:**

```typescript
// In tools/profile.ts, replace buildRepoProfile call:
import { profileRepo } from '../profiler.js';

// In runProfile:
const profile = await profileRepo(exec, cwd);

// Remove buildRepoProfile function entirely (lines 92-229)
// Remove tryParse helper if only used by buildRepoProfile
```

**Incremental migration note:** If `buildRepoProfile` has behavior that `profileRepo` lacks (e.g., scanning CLAUDE.md or AGENTS.md as key files), add those as additional paths in `collectKeyFiles` within `profiler.ts` rather than maintaining two functions. The `profiler.ts` version is more complete (uses `collectBestPracticesGuides`, has more detectors).

**Why this improves ergonomics:**
- One `profileRepo` to maintain. Bug fixes in one place benefit both callers.
- `profile.ts` shrinks by ~140 lines — easier to read and reason about.
- `profileRepo` already accepts `AbortSignal` for cancellation — a capability the duplicate lacks.

**Implementation order:** Fourth (after verifying `profileRepo` handles all needed key files).

**Risk mitigation:** Before deleting `buildRepoProfile`, diff the two implementations and document any behavioral gaps as tasks in `profiler.ts`. Run full test suite before and after.

---

### 3.5 Dispatch — Remove `args as any` in `server.ts`

**File:** `mcp-server/src/server.ts` (lines 213-226)

**Current state:**
```typescript
case "flywheel_profile":
  return await runProfile(ctx, args as any);
case "flywheel_discover":
  return await runDiscover(ctx, args as any);
// ...
```

The `args as any` casts bypass TypeScript's argument checking for all tool handlers. A typo in a tool handler's argument type is invisible to the compiler.

**Change — create a thin typed dispatcher:**

Each tool's `Args` type is already defined locally (e.g., `ProfileArgs` in `profile.ts`). Export them and use them in the dispatcher:

```typescript
// In each tool file, export the Args type:
// profile.ts: export interface ProfileArgs { cwd: string; goal?: string; }
// discover.ts: export interface DiscoverArgs { cwd: string; ideas: CandidateIdea[]; }
// etc.

// In server.ts, validate and narrow:
import type { ProfileArgs } from './tools/profile.js';
// ...

case "flywheel_profile":
  return await runProfile(ctx, args as ProfileArgs);
```

This is a lighter-weight fix than full runtime validation. It removes the `as any` escape hatch while keeping compile-time checking. For full runtime safety, a future plan could add Zod or TypeBox parsing (the TypeBox dependency is already installed).

**Why this improves ergonomics:**
- Compiler catches mismatched argument shapes when tool handler signatures change.
- Type narrowing is visible in IDEs — contributors get autocomplete on `args`.
- `as ProfileArgs` is still a cast, but it's a _typed_ cast — easier to audit than `as any`.

**Implementation order:** Fifth (after exporting Args types from each tool file).

---

### 3.6 Testing — Add Tests for `agent-mail.ts` and `profiler.ts`

**Files to create:**
- `mcp-server/src/__tests__/agent-mail.test.ts`
- `mcp-server/src/__tests__/profiler.test.ts`

#### `agent-mail.test.ts` — Testing the RPC Result Union

Once the discriminated union from §3.2 is in place, the test surface becomes clear:

```typescript
// mcp-server/src/__tests__/agent-mail.test.ts
import { describe, it, expect } from 'vitest';
import { agentMailRPC, unwrapRPC } from '../agent-mail.js';
import { createMockExec } from './helpers/mocks.js';

describe('agentMailRPC', () => {
  it('returns ok:true with data when curl succeeds', async () => {
    const exec = createMockExec([{
      cmd: 'curl',
      args: [...],
      result: { code: 0, stdout: JSON.stringify({ result: { structuredContent: { status: 'ok' } } }), stderr: '' }
    }]);
    const result = await agentMailRPC(exec, 'health_check', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as any).status).toBe('ok');
  });

  it('returns ok:false reason:unreachable when curl exits non-zero', async () => {
    const exec = createMockExec([{
      cmd: 'curl', args: [...],
      result: { code: 7, stdout: '', stderr: 'connection refused' }
    }]);
    const result = await agentMailRPC(exec, 'health_check', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreachable');
  });

  it('returns ok:false reason:json_parse_error when stdout is not JSON', async () => {
    const exec = createMockExec([{
      cmd: 'curl', args: [...],
      result: { code: 0, stdout: 'not json', stderr: '' }
    }]);
    const result = await agentMailRPC(exec, 'health_check', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('json_parse_error');
  });

  it('returns ok:false reason:rpc_error when response has error field', async () => {
    const exec = createMockExec([{
      cmd: 'curl', args: [...],
      result: { code: 0, stdout: JSON.stringify({ error: { message: 'tool not found' } }), stderr: '' }
    }]);
    const result = await agentMailRPC(exec, 'bad_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rpc_error');
  });
});

describe('healthCheck', () => {
  it('returns status object on healthy response', async () => { ... });
  it('returns null when RPC fails', async () => { ... });
});
```

**Test pattern guidance:**
- Use `createMockExec` from `helpers/mocks.ts` — already handles curl calls since exec is typed as `ExecFn`.
- Test each `reason` variant independently. The union forces exhaustive coverage.
- `healthCheck` and `fetchInbox` are the highest-value integration points to test next.

#### `profiler.test.ts` — Testing Collectors in Isolation

```typescript
// mcp-server/src/__tests__/profiler.test.ts
import { describe, it, expect } from 'vitest';
import { profileRepo, createEmptyRepoProfile, formatBestPracticesGuides } from '../profiler.js';
import { createMockExec } from './helpers/mocks.js';

// Minimal mock for a TypeScript project
function tsProjectExec() { return createMockExec([
  { cmd: 'find', args: ['.','-maxdepth','4',...], result: { code: 0, stdout: './src/index.ts\n./package.json\n', stderr: '' }},
  { cmd: 'git', args: ['log','--oneline',...], result: { code: 0, stdout: 'abc1234\x00feat: init\x002024-01-01\x00Alice\n', stderr: '' }},
  { cmd: 'grep', args: ['-rn',...], result: { code: 1, stdout: '', stderr: '' }},
  { cmd: 'head', args: ['-c','4096','package.json'], result: { code: 0, stdout: '{"name":"test","devDependencies":{"vitest":"^2"}}', stderr: '' }},
  // other head calls return code 1
]); }

describe('profileRepo', () => {
  it('detects TypeScript from .ts extensions', async () => {
    const profile = await profileRepo(tsProjectExec(), '/fake');
    expect(profile.languages).toContain('TypeScript');
  });

  it('sets hasTests when vitest found in package.json', async () => {
    const profile = await profileRepo(tsProjectExec(), '/fake');
    expect(profile.hasTests).toBe(true);
  });

  it('returns partial results when a collector fails (not throws)', async () => {
    // exec throws for git log — profileRepo must not throw
    const badExec = async (cmd: string) => {
      if (cmd === 'git') throw new Error('git not found');
      return { code: 0, stdout: '', stderr: '' };
    };
    const profile = await profileRepo(badExec as any, '/fake');
    expect(profile.recentCommits).toEqual([]);
  });

  it('sets name from directory when no cwd arg', async () => {
    const profile = await profileRepo(tsProjectExec(), '/projects/my-tool');
    expect(profile.name).toBe('my-tool');
  });
});

describe('createEmptyRepoProfile', () => {
  it('returns a valid RepoProfile with correct name', () => {
    const p = createEmptyRepoProfile('/projects/my-app');
    expect(p.name).toBe('my-app');
    expect(p.languages).toEqual([]);
  });
});

describe('formatBestPracticesGuides', () => {
  it('returns empty string when no guides', () => {
    expect(formatBestPracticesGuides([])).toBe('');
  });

  it('includes guide name in output', () => {
    const out = formatBestPracticesGuides([{ name: 'BEST_PRACTICES.md', content: 'Do X.' }]);
    expect(out).toContain('BEST_PRACTICES.md');
    expect(out).toContain('Do X.');
  });
});
```

**Why these tests are valuable:**
- `profileRepo` uses `Promise.allSettled` internally — the partial-failure path is worth testing.
- `createEmptyRepoProfile` is a pure function — cheapest possible test.
- `formatBestPracticesGuides` is a pure function — test boundary conditions (empty, single, truncation).

---

## 4. Implementation Order

This sequence minimizes disruption — each step is independently safe to merge:

| Step | Task | File(s) | Risk | Depends on |
|------|------|---------|------|------------|
| 1 | Add `version.ts`, update `server.ts` + `checkpoint.ts` | `version.ts`, `server.ts`, `checkpoint.ts` | Low | — |
| 2 | Update `checkpoint.test.ts` call sites | `checkpoint.test.ts` | Low | Step 1 |
| 3 | Add `AgentMailRPCResult` union to `agent-mail.ts` | `agent-mail.ts` | Medium | — |
| 4 | Add `unwrapRPC` wrapper, migrate existing callers | `agent-mail.ts` | Low | Step 3 |
| 5 | Replace `process.stderr.write` with `log.warn` in `profiler.ts` | `profiler.ts` | Low | — |
| 6 | Add `profiler.test.ts` | `__tests__/profiler.test.ts` | Low | Step 5 |
| 7 | Add `agent-mail.test.ts` | `__tests__/agent-mail.test.ts` | Low | Step 3 |
| 8 | Export `Args` types from each tool file | tool files | Low | — |
| 9 | Update `server.ts` dispatch to use typed casts | `server.ts` | Low | Step 8 |
| 10 | Migrate `profile.ts` to use `profileRepo` | `tools/profile.ts`, `profiler.ts` | Medium | Step 6 |

Steps 1, 3, 5, and 8 are fully independent and can be parallelized.
Step 10 is highest-risk — run full test suite before and after.

---

## 5. Exact File Locations and Line Numbers

### `mcp-server/src/server.ts`
- Line 18: `version: "2.0.0"` → `version: ORCHESTRATOR_VERSION` (add import from `./version.js`)
- Lines 213-226: each `args as any` → `args as ProfileArgs`, `args as DiscoverArgs`, etc.

### `mcp-server/src/agent-mail.ts`
- Lines 47-70: replace `agentMailRPC` function signature and body with discriminated-union version
- After line 70: add `unwrapRPC` helper
- All callers in same file: wrap return values with `unwrapRPC(...)` to preserve existing behavior

### `mcp-server/src/profiler.ts`
- Lines 1-2: add `import { createLogger } from './logger.js'; const log = createLogger('profiler');`
- Lines 26-31: replace `process.stderr.write` block with `log.warn('collector failed', { collector: label, reason: ... })`

### `mcp-server/src/checkpoint.ts`
- Line 139: remove `flywheelVersion: string` parameter
- Line 150: replace `flywheelVersion` usage with `ORCHESTRATOR_VERSION`
- Add import: `import { ORCHESTRATOR_VERSION } from './version.js';`

### `mcp-server/src/tools/profile.ts`
- Lines 92-229: replace `buildRepoProfile` function with `import { profileRepo } from '../profiler.js';` and a direct call
- Line 231-233: remove `tryParse` if unused

### New file: `mcp-server/src/version.ts`
- Full content: read `package.json` via `createRequire`, export `ORCHESTRATOR_VERSION`

### New files: tests
- `mcp-server/src/__tests__/agent-mail.test.ts` — test RPC result union variants
- `mcp-server/src/__tests__/profiler.test.ts` — test profileRepo + pure helpers

---

## 6. Acceptance Criteria

### Version management
- [ ] `server.ts` `version` field reads from `package.json` at startup, not a hardcoded string
- [ ] `writeCheckpoint` no longer takes an `flywheelVersion` string parameter
- [ ] Changing `package.json` version is the only step needed to update all version references

### Agent Mail RPC
- [ ] `agentMailRPC` return type is `Promise<AgentMailRPCResult>` (not `Promise<any>`)
- [ ] Three failure reasons are distinguishable: `unreachable`, `json_parse_error`, `rpc_error`
- [ ] Existing callers continue to work via `unwrapRPC` wrapper
- [ ] `healthCheck` returns `null` (not throws) when server is unreachable
- [ ] `agent-mail.test.ts` covers all four result variants with passing tests

### Profiler logging
- [ ] No `process.stderr.write` calls remain in `profiler.ts`
- [ ] Failed collector warnings appear as structured JSON on stderr
- [ ] `profiler.test.ts` exists with at least 5 passing tests

### Dispatch typing
- [ ] No `as any` casts remain in `server.ts` dispatch block
- [ ] `Args` interfaces are exported from all tool files

### Deduplication
- [ ] `buildRepoProfile` in `tools/profile.ts` is removed
- [ ] `runProfile` uses `profileRepo` from `profiler.ts` directly
- [ ] All existing `profile.test.ts` tests continue to pass

### Build
- [ ] `cd mcp-server && npm run build` exits 0 after all changes
- [ ] `cd mcp-server && npm test` exits 0 with no regressions

---

## 7. Style Notes for Implementors

Follow the patterns already established in this codebase:

- **ESM imports require `.js` extensions**: `import { createLogger } from './logger.js'` — not `'./logger'`.
- **No `console.log`/`console.error`**: Use `createLogger` and write to stderr via the structured logger.
- **No custom Error subclasses**: `throw new Error(message)` is the idiom throughout.
- **`any` is an escape hatch, not a type**: Use it only where TypeScript cannot infer, and prefer `unknown` + narrowing.
- **Helper functions over nested try/catch**: The `checkpoint.ts` and existing tool tests establish this as the preferred pattern.
- **Test structure**: `describe` at file level, `it` with a behavior description. Use `helpers/mocks.ts` utilities — don't inline mock implementations in tests.
- **`afterEach` cleanup for temp dirs**: Follow the checkpoint test pattern (`mkdtempSync` + `rmSync` in `afterEach`).
