# Robustness Plan: Reliability Sweep — 2026-04-09

**Perspective:** Robustness — failure modes, graceful degradation, abort/cancellation, checkpoint integrity, schema validation, version drift.

**Agent:** RusticFalcon (claude-sonnet-4-6)

**Date:** 2026-04-09

**Builds on:** `docs/plans/2026-04-08-robustness.md` (scan.ts double-fault + AGENTS.md gaps)

---

## Executive Summary

After reading the full source tree, seven robustness gaps remain unaddressed. They are ordered by severity. Each section names exact files, line numbers, the failure scenario, and the recommended fix.

---

## Gap 1 — Agent Mail Down: Silent Null Returns in `agent-mail.ts`

### Location
`mcp-server/src/agent-mail.ts` — `agentMailRPC()` lines 47–70

### Current behavior
`agentMailRPC()` wraps every curl call. On any of these conditions it silently returns `null`:
- Agent Mail server is not running (curl exits non-zero, stdout is empty)
- Server returns a non-200 HTTP response
- Response body is not valid JSON
- `curl` binary is missing from PATH

All callers (`reserveFileReservations`, `checkFileReservations`, `sendMessage`, `fetchInbox`, etc.) receive `null` and silently do nothing. There is no caller-level distinction between "server down" and "operation succeeded with empty result".

### Failure scenarios
| Scenario | Current outcome |
|---|---|
| Agent Mail server not started | All reservation calls return null — no files reserved, no conflict detection |
| Network timeout (curl --max-time 5) | Same as above — silent null |
| curl not on PATH | spawn error thrown inside makeExec, which becomes a reject; agentMailRPC catch returns null |
| Server returns 500 | curl exits 0 (HTTP body present), JSON.parse succeeds but `result` is null → null returned |

### Proposed fix

**File:** `mcp-server/src/agent-mail.ts`, lines 47–70

1. Add a typed result discriminant: `AgentMailRPCResult = { ok: true; data: unknown } | { ok: false; error: string; code: "down" | "timeout" | "parse_error" | "rpc_error" }`.
2. Inspect `result.code` from exec — non-zero means curl failure (server down or timeout). Return `{ ok: false, error: ..., code: "down" }`.
3. Inspect the parsed JSON for `jsonrpc error` fields before returning `result`.
4. Add a module-level `agentMailAvailable` boolean cache (5-second TTL) populated by `healthCheck()`. All callers check this before issuing RPCs. If `false`, log a single warn and return the typed not-ok result.

**Fallback behavior:** All callers that previously treated null as "ok, skip" must now explicitly check `result.ok` and either surface a user-visible warning or degrade gracefully with a log line. File reservation conflicts must not silently be skipped — they should warn the user that conflict detection is unavailable.

**Example skeleton:**
```typescript
// agent-mail.ts ~line 47
export type AgentMailRPCResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: "down" | "timeout" | "parse_error" | "rpc_error" };

export async function agentMailRPC<T = unknown>(
  exec: ExecFn,
  toolName: string,
  args: Record<string, unknown>
): Promise<AgentMailRPCResult<T>> {
  const result = await exec("curl", [...], { timeout: 8000 }).catch((e) => ({
    code: 1, stdout: "", stderr: String(e),
  }));
  if (result.code !== 0) {
    log.warn("agent-mail unreachable", { tool: toolName, stderr: result.stderr });
    return { ok: false, error: result.stderr, code: "down" };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.error) return { ok: false, error: parsed.error.message, code: "rpc_error" };
    return { ok: true, data: parsed?.result?.structuredContent ?? parsed?.result ?? null };
  } catch (e) {
    return { ok: false, error: String(e), code: "parse_error" };
  }
}
```

**Lines to modify:** `agent-mail.ts` lines 47–70, 75–99, and all callers that destructure the return value.

---

## Gap 2 — `any` Cast Leak in `server.ts` Tool Dispatch

### Location
`mcp-server/src/server.ts` lines 192–239

### Current behavior
```typescript
const { name, arguments: args } = request.params;
const cwd = (args as any)?.cwd as string;
// ...
case "orch_profile": return await runProfile(ctx, args as any);
```
Every tool handler receives `args as any`. If a caller omits a required field (e.g., passes `goal` but not `cwd`), the cast hides the type error and propagates `undefined` deep into tool implementations where it crashes with an unhelpful error.

### Failure scenarios
| Scenario | Current outcome |
|---|---|
| MCP client passes `arguments: {}` (no cwd) | cwd is undefined, caught at line 194, good |
| MCP client passes `arguments: { cwd: 123 }` (wrong type) | makeExec(123) — spawn with numeric cwd, OS error deep in child_process |
| `orch_discover` called with `ideas: "not-an-array"` | runDiscover receives string for ideas, crashes with unhelpful TypeError |
| `orch_plan` called with `planFile: 42` | Passed as-is to fs.readFileSync — crash deep in plan.ts |

### Proposed fix

**File:** `mcp-server/src/server.ts` lines 192–210

Add a lightweight runtime validator at the dispatch layer (no external library needed — the input schema is already defined in `TOOLS`). Write a `validateArgs(toolName: string, args: unknown): { valid: boolean; errors: string[] }` function that checks required fields and primitive types using the `TOOLS` schema definitions.

```typescript
// server.ts ~line 193 — before makeExec
const validationErrors = validateToolArgs(name, args);
if (validationErrors.length > 0) {
  return {
    content: [{ type: "text", text: `Invalid arguments for ${name}: ${validationErrors.join("; ")}` }],
    isError: true,
  };
}
```

The validator does not need to be exhaustive. Checking `required` fields and that `cwd` is a non-empty string catches 90% of bugs.

**Files to modify:** `mcp-server/src/server.ts` lines 190–210 (add validator before switch), add `mcp-server/src/tool-validator.ts` (new file, ~60 lines).

---

## Gap 3 — Abort Signal Not Propagated in `profiler.ts`

### Location
`mcp-server/src/profiler.ts` — `profileRepo()` lines 8–70, all collector functions

### Current behavior
`profileRepo(exec, cwd, signal?)` accepts an `AbortSignal` parameter but **never passes it** to any collector or to `exec`. The signal is accepted but ignored. If the caller (e.g., an HTTP request handler) aborts, the 4 parallel shell commands continue running to completion or their individual timeouts.

### Failure scenarios
| Scenario | Current outcome |
|---|---|
| MCP client disconnects mid-profile | find/git/grep processes keep running for up to 10s each |
| User cancels a slow scan | No cancellation, leaked child processes |
| Tool timeout at higher level | profiler.ts doesn't know — keeps running |

### Proposed fix

**File:** `mcp-server/src/profiler.ts` lines 74–95 (`collectFileTree`), 97–121 (`collectCommits`), 123–167 (`collectTodos`), 169–201 (`collectKeyFiles`)

1. Pass `signal` to each `exec()` call via opts.
2. In `exec.ts`, wire `signal` to `child.kill()` via `signal.addEventListener("abort", ...)`.

**`exec.ts` change (~line 7–27):**
```typescript
export function makeExec(defaultCwd?: string): ExecFn {
  return (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? defaultCwd, shell: false, stdio: ['ignore','pipe','pipe'] });
    // ... existing stdout/stderr handlers ...
    
    // Abort signal support
    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error(`Aborted: ${cmd} ${args.join(' ')}`));
    };
    if (opts.signal) {
      if (opts.signal.aborted) { child.kill('SIGTERM'); reject(new Error('Already aborted')); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
```

**`ExecFn` type change (`exec.ts` line 3–8):**
```typescript
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; signal?: AbortSignal }
) => Promise<{ code: number; stdout: string; stderr: string }>;
```

**Files to modify:**
- `mcp-server/src/exec.ts` lines 3–27 (add `signal` to opts, wire to child.kill)
- `mcp-server/src/profiler.ts` lines 74–248 (thread signal through all collector calls)

---

## Gap 4 — Version Hardcoding Drift Between `state.ts` and `package.json`

### Location
- `mcp-server/src/state.ts` line 6: `const VERSION = '2.0.0';`
- `mcp-server/package.json` line 4: `"version": "2.3.0"`

### Current behavior
The version embedded in every checkpoint envelope (`orchestratorVersion: "2.0.0"`) is **hardcoded** and lags behind the actual package version by 3 minor versions. When `validateCheckpoint` reads a checkpoint, it stores this version but has no logic to act on version mismatches.

### Failure scenarios
| Scenario | Current outcome |
|---|---|
| Checkpoint written at v2.0.0, read at v2.3.0 | No warning — silently treats old checkpoint as current |
| Breaking state schema change between versions | Old checkpoint loaded with wrong shape, tools fail unpredictably |
| Developer bumps package.json but forgets state.ts | Version drift widens silently |

### Proposed fix

**File:** `mcp-server/src/state.ts`

Replace the hardcoded `VERSION` constant with a dynamic import from `package.json`:
```typescript
// state.ts
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };
```

Or, since this is ESM with `"type": "module"`, use a JSON import assertion (Node 22 supports this):
```typescript
import pkgJson from '../package.json' with { type: 'json' };
const VERSION = pkgJson.version;
```

**File:** `mcp-server/src/checkpoint.ts` lines 79–129 (`validateCheckpoint`)

Add a version mismatch warning (not hard rejection, to avoid breaking old checkpoints):
```typescript
// After orchestratorVersion check, add:
if (e.orchestratorVersion !== currentVersion) {
  // return as a warning, not a failure — caller decides whether to reject
  // This requires passing currentVersion into validateCheckpoint, or returning warnings alongside ValidationResult
}
```

Change `ValidationResult` to include an optional `warnings: string[]` alongside `{ valid: true }`.

**Files to modify:**
- `mcp-server/src/state.ts` line 6 (dynamic VERSION from package.json)
- `mcp-server/src/checkpoint.ts` lines 71–73 (`ValidationResult` type) and lines 100–105 (add version warning logic)

---

## Gap 5 — Checkpoint Write-Lock: No Protection Against Concurrent Writes

### Location
`mcp-server/src/checkpoint.ts` lines 138–170 (`writeCheckpoint`)

### Current behavior
`writeCheckpoint` uses `writeFileSync(tmp) → renameSync(tmp → main)`. The atomic rename is correct for single-writer scenarios. However, if two MCP tool calls are issued concurrently (e.g., two rapid back-to-back calls to `orch_profile` on the same `cwd`), both may enter `writeCheckpoint` simultaneously. The race condition:

1. Call A writes tmp
2. Call B writes tmp (overwrites A's tmp)
3. Call A renames tmp → main (now has B's content under A's write)
4. Call B renames tmp → main (file already gone — ENOENT on rename → caught, returns false)

The last winner's state survives, but Call A's rename actually installs B's content (wrong state for A), and Call B's rename fails silently.

### Failure scenarios
| Scenario | Current outcome |
|---|---|
| Two parallel tool calls on same cwd | One checkpoint silently lost; no error surfaced to caller |
| Fast sequential calls (within same event loop tick) | Same race — unlikely in practice but possible under load |

### Proposed fix

**File:** `mcp-server/src/checkpoint.ts` lines 138–170

Use a per-`cwd` write mutex (simple in-process Map of Promises):

```typescript
// checkpoint.ts — add near top
const writeLocks = new Map<string, Promise<boolean>>();

export function writeCheckpoint(cwd: string, state: OrchestratorState, orchestratorVersion: string): Promise<boolean> {
  const prev = writeLocks.get(cwd) ?? Promise.resolve(true);
  const next = prev.then(() => writeCheckpointInner(cwd, state, orchestratorVersion));
  writeLocks.set(cwd, next.catch(() => true)); // don't let a failed write block the lock forever
  return next;
}

function writeCheckpointInner(cwd: string, state: OrchestratorState, orchestratorVersion: string): boolean {
  // ... existing implementation ...
}
```

This change also requires making `writeCheckpoint` return `Promise<boolean>` and updating callers in `state.ts` (`saveState`).

**Files to modify:**
- `mcp-server/src/checkpoint.ts` lines 138–170 (add lock, convert to async)
- `mcp-server/src/state.ts` line 17 (`saveState` — await the promise)
- `mcp-server/src/server.ts` line 207 (`saveState` call in ctx — needs await)

---

## Gap 6 — `agentMailRPC` Leaks Shell Injection via `amHelperScript`

### Location
`mcp-server/src/agent-mail.ts` lines 526–604 (`amHelperScript`)

### Current behavior
`amHelperScript(cwd, threadId)` does partial escaping:
```typescript
const safeCwd = cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const safeThread = threadId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
```
This escapes backslashes and double quotes but **does not escape**:
- Backticks (`` ` ``) — command substitution in bash
- `$(...)` — command substitution
- Newlines — break the heredoc/string
- Single quotes inside single-quoted curl `-d` bodies

If `cwd` contains a backtick or `$()` sequence (e.g., a project cloned to `` /tmp/`whoami`/project ``), the generated shell script will execute arbitrary commands when sourced by a sub-agent.

### Failure scenarios
| Scenario | Current outcome |
|---|---|
| cwd path contains backtick | Shell injection in generated helper script |
| threadId from untrusted source contains `$(...)` | RCE when script is sourced |

### Proposed fix

**File:** `mcp-server/src/agent-mail.ts` lines 526–530

Use a single-quote wrapping strategy for shell variable assignment (single-quoted strings in bash cannot be broken by `$`, backtick, or `\` — only `'` itself needs escaping):
```typescript
function shellSingleQuote(s: string): string {
  // Replace every single quote with: end-single-quote, escaped-single-quote, restart-single-quote
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Then in amHelperScript:
return `
AM_URL=${shellSingleQuote(AGENT_MAIL_URL)}
AM_PROJECT=${shellSingleQuote(cwd)}
AM_THREAD=${shellSingleQuote(threadId)}
...`.trim();
```

Remove the current `safeCwd`/`safeThread` escaping and replace with `shellSingleQuote`.

**Files to modify:** `mcp-server/src/agent-mail.ts` lines 526–540 (escape helper + variable assignment lines)

---

## Gap 7 — Logger `resolveMinLevel` Called on Every Write (Micro-Perf + Env Mutation Risk)

### Location
`mcp-server/src/logger.ts` lines 12–16 (`resolveMinLevel`) and line 23 (`writeLog`)

### Current behavior
```typescript
function resolveMinLevel(): number {
  const env = (process.env.ORCH_LOG_LEVEL ?? "warn").toLowerCase() as Level;
  const idx = LEVELS.indexOf(env);
  return idx >= 0 ? idx : 2;
}
// Called on every writeLog invocation
```
`process.env` is read on every single log call. While this is not a crash risk, it has two robustness implications:

1. **Env mutation after startup** — if something changes `process.env.ORCH_LOG_LEVEL` mid-run (e.g., a test that forgets to restore it), log level silently changes, making debugging harder.
2. **Invalid level value** — if `ORCH_LOG_LEVEL=TRACE` (typo or misconfiguration), it falls back to `warn` with no warning to the user. The server starts silently ignoring debug and info logs with no indication that the env var is wrong.

### Proposed fix

**File:** `mcp-server/src/logger.ts`

1. Cache the minimum level at module load time (not on every call):
```typescript
// Computed once at startup
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

2. Replace the `resolveMinLevel()` call in `writeLog` with the cached `MIN_LEVEL`.

**Files to modify:** `mcp-server/src/logger.ts` lines 12–24 (replace resolveMinLevel with cached constant + startup warning).

---

## Implementation Order

| Priority | Gap | Effort | Risk of not fixing |
|---|---|---|---|
| 1 | Gap 1 — Agent Mail down → silent null | Medium | High — reservation conflicts invisible |
| 2 | Gap 6 — Shell injection in amHelperScript | Low | Critical (security) |
| 3 | Gap 3 — Abort signal not propagated | Medium | Medium — leaked processes |
| 4 | Gap 4 — Version drift (state.ts vs package.json) | Low | Medium — stale checkpoints loaded silently |
| 5 | Gap 2 — `any` cast leak in server.ts dispatch | Medium | Medium — bad args crash deep in tools |
| 6 | Gap 5 — Concurrent checkpoint write race | Low | Low (unlikely in practice) |
| 7 | Gap 7 — Logger resolveMinLevel per-call | Trivial | Low (micro) |

---

## Test Coverage Gaps

The existing test suite (`mcp-server/src/__tests__/`) has good checkpoint.test.ts coverage but is missing:

| Missing test | File to create | What to cover |
|---|---|---|
| `agent-mail-rpc.test.ts` | `src/__tests__/agent-mail-rpc.test.ts` | agentMailRPC when curl exits non-zero, when JSON is malformed, when server returns RPC error |
| `exec-abort.test.ts` | `src/__tests__/exec-abort.test.ts` | makeExec with AbortSignal — already-aborted signal, mid-flight abort |
| `tool-validator.test.ts` | `src/__tests__/tool-validator.test.ts` | validateToolArgs: missing cwd, wrong type for cwd, invalid ideas array |
| `state-version.test.ts` | `src/__tests__/state-version.test.ts` | VERSION matches package.json; checkpoint written with correct version |
| `amHelperScript-injection.test.ts` | `src/__tests__/amHelperScript-injection.test.ts` | Paths with backticks/single-quotes/dollar-signs are safe in generated script |

---

## Files Touched (Summary)

| File | Lines affected | Reason |
|---|---|---|
| `mcp-server/src/exec.ts` | 3–27 | Add AbortSignal to ExecFn + wire to child.kill |
| `mcp-server/src/profiler.ts` | 74–248 (all collectors) | Thread signal through to exec calls |
| `mcp-server/src/agent-mail.ts` | 47–70, 75–99, 526–540 | Typed RPC result + shell injection fix |
| `mcp-server/src/state.ts` | 6, 17 | Dynamic VERSION + await saveState |
| `mcp-server/src/checkpoint.ts` | 71–73, 100–105, 138–170 | Version warning in ValidationResult + write lock |
| `mcp-server/src/server.ts` | 190–210 | Add validateToolArgs call before dispatch |
| `mcp-server/src/logger.ts` | 12–24 | Cached MIN_LEVEL + startup warning |
| `mcp-server/src/tool-validator.ts` | NEW (~60 lines) | Runtime arg validation against TOOLS schema |

---

## Non-Goals (Explicitly Out of Scope)

- Changing the MCP wire protocol or adding new tools
- Modifying the checkpoint schema version (backwards-compatible changes only)
- Rewriting agent-mail.ts to use native fetch instead of curl (would remove curl dependency but is a larger refactor)
- Adding distributed locking for multi-process scenarios (the write mutex only covers in-process concurrency)
