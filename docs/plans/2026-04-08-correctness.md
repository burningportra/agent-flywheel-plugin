# Correctness Plan: Error Recovery in scan.ts + AGENTS.md

**Perspective:** Correctness — technically correct, complete, no silent failures, proper TypeScript types maintained.

---

## 1. Problem Statement

### scan.ts: Missing Error Recovery

`mcp-server/src/scan.ts` contains multiple file-system and CLI operations that can fail at runtime. The top-level `scanRepo()` function (line 80-91) already has a try/catch that falls back from the `ccc` provider to the built-in profiler. However, **within** each provider and the profiler itself, individual operations lack error isolation:

**Unprotected operations in `profiler.ts`:**

| Function | Line | Operation | Failure mode |
|---|---|---|---|
| `collectFileTree` | 56-77 | `exec("find", ...)` | `find` not available on system, permission denied, timeout |
| `collectCommits` | 79-103 | `exec("git", ["log", ...])` | Not a git repo, corrupted repo, timeout |
| `collectTodos` | 105-149 | `exec("grep", ...)` | `grep` not available (e.g., minimal container), timeout |
| `collectKeyFiles` | 151-183 | `exec("head", ...)` per file | Individual file read failures (already try/caught — good) |
| `collectBestPracticesGuides` | 185-229 | `exec("head", ...)` per file | Individual file read failures (already try/caught — good) |
| `profileRepo` | 8-52 | `Promise.all([...])` | **Any single collector failure aborts the entire profile** |

The critical issue is `profileRepo` at line 13: it uses `Promise.all` to run `collectFileTree`, `collectCommits`, `collectTodos`, and `collectKeyFiles` in parallel. If **any one** of these throws, the entire `profileRepo` call fails, and the scan produces nothing — even though the other 3 collectors may have succeeded.

**Unprotected operations in `scan.ts`:**

| Function | Line | Operation | Failure mode |
|---|---|---|---|
| `ensureCccReady` | 138-176 | `exec("ccc", ["--help"])`, `exec("ccc", ["status"])`, etc. | ccc not installed, init fails — **already throws (correct for ccc path)** |
| `collectCccCodebaseAnalysis` | 178-237 | `Promise.all` over `CCC_SCAN_QUERIES` | Single query failure aborts all queries |
| `scanRepo` | 80-91 | Fallback `profileRepo` in catch block | **If the fallback itself throws, the error is unrecoverable** |

**Key correctness concern:** In `scanRepo` (line 86-90), the catch block calls `profileRepo(exec, cwd, signal)`. If this fallback call also throws (e.g., `find` is missing), the entire scan fails with an unhandled exception. There is no "profile of last resort."

### AGENTS.md: Missing Sub-Agent Guidance

No `AGENTS.md` file exists at the project root. Sub-agents spawned by the orchestrator (implementation agents, review agents, audit agents) currently receive no project-level guidance about:
- Build commands
- TypeScript/NodeNext constraints
- Which directories are generated (never edit)
- MCP server stdio constraint (no `console.log` to stdout)
- Available CLI tools (`br`, `bv`)

---

## 2. Implementation Plan

### T1: Make `profileRepo` collectors resilient with `Promise.allSettled`

**File:** `mcp-server/src/profiler.ts`

**What:** Replace `Promise.all` at line 13 with `Promise.allSettled` so individual collector failures don't abort the entire profile. Return partial results with sensible defaults for failed collectors.

**Exact changes:**

1. Change `Promise.all` to `Promise.allSettled` at line 13:
   ```typescript
   const [fileTreeResult, commitsResult, todosResult, keyFilesResult] = await Promise.allSettled([
     collectFileTree(exec, cwd, signal),
     collectCommits(exec, cwd, signal),
     collectTodos(exec, cwd, signal),
     collectKeyFiles(exec, cwd, signal),
   ]);
   ```

2. Extract values with defaults for rejected promises:
   ```typescript
   const fileTree = fileTreeResult.status === "fulfilled" ? fileTreeResult.value : "";
   const commits = commitsResult.status === "fulfilled" ? commitsResult.value : [];
   const todos = todosResult.status === "fulfilled" ? todosResult.value : [];
   const keyFiles = keyFilesResult.status === "fulfilled" ? keyFilesResult.value : {};
   ```

3. Wrap `collectBestPracticesGuides` call (line 20) in try/catch since it depends on `fileTree`:
   ```typescript
   let bestPracticesGuides: Array<{ name: string; content: string }> = [];
   try {
     bestPracticesGuides = await collectBestPracticesGuides(exec, cwd, fileTree, signal);
   } catch {
     // Best practices collection is non-critical
   }
   ```

4. The rest of the function (`extCounts`, `languages`, `frameworks`, etc.) operates on data that now has safe defaults — empty string fileTree means no extensions detected (empty languages array), empty keyFiles means no frameworks detected.

**Correctness constraints:**
- The return type `Promise<RepoProfile>` is unchanged — the function always returns a valid `RepoProfile`, just with potentially empty fields.
- `collectCommits` already handles `result.code !== 0` by returning `[]` (line 89), so it rarely throws. But exec itself can throw on spawn failure or timeout (see `exec.ts` line 20-25: the timeout handler calls `reject()`, and spawn errors call `reject()`).
- `collectTodos` similarly handles `result.code !== 0` (line 131), but can throw on spawn/timeout.
- `collectFileTree` does NOT check `result.code` — it just returns `result.stdout.trim()`. A non-zero exit code gives empty/partial output, which is acceptable. But it can still throw on spawn/timeout.
- `collectKeyFiles` is already wrapped in try/catch per file (line 169-179), so individual file failures are handled. But the outer `Promise.all(reads)` can still propagate unexpected errors.

**What NOT to do:**
- Do NOT add return types or change the `RepoProfile` interface — the partial profile is still a valid `RepoProfile` with all required fields present (just empty).
- Do NOT log errors to console (MCP server uses stdio — any console.log corrupts the JSON-RPC stream).
- Do NOT swallow errors silently without providing defaults — every rejected promise must produce a typed default value.

**Acceptance criteria:**
- `profileRepo` never throws, always returns a valid `RepoProfile`
- If `find` command fails, profile is returned with `structure: ""`, `languages: []`, `hasTests: false`, etc.
- If `git log` fails, profile is returned with `recentCommits: []`
- If `grep` fails, profile is returned with `todos: []`
- TypeScript compilation passes with zero errors
- No `console.log` or `console.error` statements added

`depends_on: []`

---

### T2: Guard the fallback path in `scanRepo`

**File:** `mcp-server/src/scan.ts`

**What:** The catch block in `scanRepo` (line 86-90) calls `profileRepo` which — after T1 — should never throw. But defense-in-depth requires guarding this fallback too. If the fallback `profileRepo` somehow throws, `scanRepo` should return a minimal "empty" scan result rather than propagating an unrecoverable exception.

**Exact changes:**

Wrap the existing catch body in a nested try/catch:

```typescript
export async function scanRepo(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<ScanResult> {
  try {
    return await cccScanProvider.scan(exec, cwd, signal);
  } catch (error) {
    try {
      const profile = await profileRepo(exec, cwd, signal);
      return createFallbackScanResult(profile, "ccc", toScanErrorInfo(error));
    } catch (fallbackError) {
      // Last resort: return an empty profile so the workflow can continue
      const emptyProfile = createEmptyRepoProfile(cwd);
      const result = createFallbackScanResult(emptyProfile, "ccc", toScanErrorInfo(error));
      // Attach the fallback error to warnings
      if (result.sourceMetadata) {
        result.sourceMetadata.warnings = [
          ...(result.sourceMetadata.warnings ?? []),
          `Profiler also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        ];
      }
      return result;
    }
  }
}
```

**New helper function** in `profiler.ts` (exported):

```typescript
export function createEmptyRepoProfile(cwd: string): RepoProfile {
  return {
    name: cwd.split("/").pop() ?? "unknown",
    languages: [],
    frameworks: [],
    structure: "",
    entrypoints: [],
    recentCommits: [],
    hasTests: false,
    testFramework: undefined,
    hasDocs: false,
    hasCI: false,
    ciPlatform: undefined,
    todos: [],
    keyFiles: {},
    readme: undefined,
    packageManager: undefined,
    bestPracticesGuides: [],
  };
}
```

**Correctness constraints:**
- The `createEmptyRepoProfile` must satisfy every field of the `RepoProfile` interface. Cross-reference with `types.ts` — all fields must be present with correct types.
- The nested catch must not re-throw. `scanRepo` must **always** return a `ScanResult`.
- The original `error` from the ccc path is preserved in the fallback info — it's the primary error. The `fallbackError` is appended as a warning, not replacing the original.

**What NOT to do:**
- Do NOT merge the two catch blocks — the outer catch (ccc failure) is structurally different from the inner catch (profiler failure).
- Do NOT return `null` or `undefined` — the return type is `Promise<ScanResult>`, not optional.

**Acceptance criteria:**
- `scanRepo` never throws under any circumstances
- If both ccc and profiler fail, a valid `ScanResult` is returned with `fallback.used === true` and `sourceMetadata.warnings` containing both error messages
- The `emptyProfile.name` is derived from `cwd` (not hardcoded "unknown")
- TypeScript compilation passes with zero errors

`depends_on: [T1]`

---

### T3: Make `collectCccCodebaseAnalysis` resilient to individual query failures

**File:** `mcp-server/src/scan.ts`

**What:** `collectCccCodebaseAnalysis` (line 178-237) uses `Promise.all` over `CCC_SCAN_QUERIES`. A single search query failure aborts all queries. Use `Promise.allSettled` so partial results are returned.

**Exact changes:**

1. Replace `Promise.all` at line 183 with `Promise.allSettled`:
   ```typescript
   const searchResults = await Promise.allSettled(
     CCC_SCAN_QUERIES.map(async (entry) => {
       const result = await exec(
         "ccc",
         ["search", "--limit", "3", ...entry.query.split(" ")],
         { cwd, timeout: 30000 }
       );
       if (result.code !== 0) {
         throw new Error(result.stderr.trim() || result.stdout.trim() || `ccc search failed for ${entry.id}`);
       }
       return {
         ...entry,
         results: parseCccSearchResults(result.stdout),
       };
     })
   );
   ```

2. Filter to fulfilled results only:
   ```typescript
   const searches = searchResults
     .filter((r): r is PromiseFulfilledResult<typeof r extends PromiseFulfilledResult<infer T> ? T : never> => r.status === "fulfilled")
     .map(r => r.value);
   ```

   More concretely, to keep TypeScript happy, extract the mapped type:
   ```typescript
   type CccSearchEntry = {
     id: string;
     title: string;
     query: string;
     results: Array<{ location: string; snippet: string }>;
   };

   const searches: CccSearchEntry[] = searchResults
     .filter((r): r is PromiseFulfilledResult<CccSearchEntry> => r.status === "fulfilled")
     .map(r => r.value);
   ```

3. If ALL searches fail, throw so the outer `scanRepo` catch triggers the builtin fallback:
   ```typescript
   if (searches.length === 0 && searchResults.length > 0) {
     const firstError = searchResults.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
     throw new Error(firstError?.reason?.message ?? "All ccc search queries failed");
   }
   ```

**Correctness constraints:**
- If 2 of 3 queries succeed, the analysis contains 2 recommendations + insights — partial is better than nothing.
- If ALL queries fail, we throw to trigger the builtin fallback — returning an empty analysis from ccc would mask a broken ccc installation.
- The `summary` field must accurately reflect the actual number of successful searches, not `CCC_SCAN_QUERIES.length`.

**Acceptance criteria:**
- If 1 of 3 ccc search queries fails, `collectCccCodebaseAnalysis` returns results from the 2 successful queries
- If all 3 queries fail, the function throws (triggering the builtin fallback in `scanRepo`)
- The `summary` string uses `searches.length` (actual successes), not hardcoded 3
- TypeScript compilation passes with zero errors

`depends_on: []`

---

### T4: Add `collectFileTree` error-code check

**File:** `mcp-server/src/profiler.ts`

**What:** `collectFileTree` (line 56-77) does not check `result.code`. If `find` exits with a non-zero code (e.g., permission denied on some directories but partial output produced), it returns the partial stdout. This is actually correct behavior — partial file trees are useful. However, if `result.code !== 0` AND `result.stdout` is empty, the function should return `""` explicitly rather than returning potentially garbage stderr content (it already only reads stdout, so this is already correct).

Actually, on closer inspection, `collectFileTree` returns `result.stdout.trim()` which is correct: partial stdout from `find` is valuable, and empty stdout on error is just `""`. The only risk is that `exec` itself throws (spawn failure, timeout), which T1 handles via `Promise.allSettled`.

**Revised scope:** No changes needed to `collectFileTree`. Instead, ensure that `collectCommits` and `collectTodos` handle the case where `exec` itself throws (not just non-zero exit code).

Both `collectCommits` (line 89: `if (result.code !== 0) return []`) and `collectTodos` (line 131: `if (result.code !== 0) return []`) only guard against non-zero exit codes. If `exec` throws an Error (timeout, spawn failure), the exception propagates. T1's `Promise.allSettled` in `profileRepo` handles this, so **no per-function try/catch is needed** — the `allSettled` at the caller level is the correct safety net.

**Decision:** T4 is **eliminated** — no code changes needed. The analysis confirms T1 is sufficient.

`depends_on: []` — N/A (no-op)

---

### T5: Create AGENTS.md

**File:** `/Volumes/1tb/Projects/claude-orchestrator/AGENTS.md` (new file)

**What:** Create the `AGENTS.md` file at the project root with sub-agent guidance.

**Exact content:**

```markdown
# AGENTS.md

Guidance for sub-agents working in this repository.

## Build

```bash
cd mcp-server && npm run build
```

This compiles TypeScript sources from `mcp-server/src/` to `mcp-server/dist/`.

## Tests

No test suite configured yet. Verify changes by running the build command above.

## Constraints

- **TypeScript strict mode** — `tsconfig.json` enables `strict: true`. All code must satisfy strict type checking.
- **Module system** — `module: "NodeNext"`, `moduleResolution: "NodeNext"`. Use `.js` extensions in all relative imports (e.g., `import { foo } from "./bar.js"`), even when the source file is `.ts`.
- **ES2022 target** — top-level `await` is not available in module scope within the MCP server entry point. Use async functions.
- **`dist/` is compiled output** — never edit files in `mcp-server/dist/` directly. Edit sources in `mcp-server/src/` and rebuild.
- **MCP server communicates via stdio** — the server uses stdin/stdout for JSON-RPC. **Never use `console.log()` in MCP server code** as it corrupts the communication channel. Use `console.error()` for debug output if needed (it goes to stderr).
- **Package type: ESM** — `"type": "module"` in `package.json`. No CommonJS `require()`.

## Available CLI Tools

- **`br`** — bead tracker CLI. Manages beads (implementation tasks): create, list, update status, approve.
- **`bv`** — bead visualizer CLI. Renders bead status dashboards.
- **`ccc`** — optional codebase indexing/search tool. Not required; the system falls back gracefully if unavailable.

## Project Structure

```
├── commands/*.md          — Natural language orchestrator commands
├── skills/                — Skills injected into agent system prompts
├── hooks/hooks.json       — Session lifecycle hooks
├── mcp-server/src/        — TypeScript MCP server source
│   ├── server.ts          — MCP tool registration
│   ├── state.ts           — OrchestratorState load/save
│   ├── checkpoint.ts      — Atomic disk persistence
│   ├── scan.ts            — Repository scanning (ccc + builtin)
│   ├── profiler.ts        — Repository profiling (git, find, grep)
│   ├── beads.ts           — br CLI wrapper
│   └── tools/             — Individual MCP tool implementations
├── mcp-server/dist/       — Compiled output (do not edit)
└── .pi-orchestrator/      — Runtime state directory
```

## Code Conventions

- No default exports. Use named exports.
- Types are in `mcp-server/src/types.ts`. Import with `import type { ... }`.
- The `ExecFn` type (`mcp-server/src/exec.ts`) wraps shell command execution. All CLI interactions go through `exec`.
- Error handling: functions that call external tools should handle non-zero exit codes. Use `Promise.allSettled` for parallel operations where partial results are acceptable.
```

**Correctness constraints:**
- Every fact stated in AGENTS.md must be verifiable from the current codebase:
  - `strict: true` — confirmed in `tsconfig.json` line 8
  - `module: "NodeNext"` — confirmed in `tsconfig.json` line 4
  - `"type": "module"` — confirmed in `package.json` line 6
  - `dist/` output — confirmed in `tsconfig.json` line 5 (`outDir: "./dist"`)
  - stdio communication — confirmed in README.md architecture section
  - `.js` extensions in imports — confirmed in `scan.ts` lines 1-2 (`from "./exec.js"`, `from "./profiler.js"`)
  - No test suite — confirmed: no test script in `package.json`, no test config files
- Build command `cd mcp-server && npm run build` — confirmed in `package.json` line 8 (`"build": "tsc"`)

**Acceptance criteria:**
- AGENTS.md exists at project root
- Contains correct build command
- Documents the stdio/console.log constraint
- Documents NodeNext import extension requirement
- Documents that dist/ is generated
- Documents available CLI tools (br, bv, ccc)
- All stated facts match current codebase state

`depends_on: []`

---

### T6: Build verification

**File:** N/A

**What:** Run `cd mcp-server && npm run build` and confirm zero TypeScript compilation errors after T1, T2, T3 changes.

**Acceptance criteria:**
- `npm run build` exits with code 0
- No new TypeScript errors introduced

`depends_on: [T1, T2, T3, T5]`

---

## 3. Dependency Graph

```
T1 (profileRepo allSettled)              depends_on: []
T2 (scanRepo fallback guard)            depends_on: [T1]   # imports createEmptyRepoProfile from T1's file
T3 (ccc query allSettled)               depends_on: []
T5 (AGENTS.md)                          depends_on: []
T6 (build verification)                 depends_on: [T1, T2, T3, T5]
```

**Parallelization:** T1, T3, and T5 can execute in parallel. T2 must wait for T1 (it imports the new `createEmptyRepoProfile` function). T6 runs last.

```
         ┌──── T1 ────┐
         │             ▼
    ─────┤         ── T2 ──┐
         │                 │
         ├──── T3 ────────►├──── T6
         │                 │
         └──── T5 ────────►┘
```

## 4. Risk Analysis

### Risk 1: `Promise.allSettled` changes observable behavior of `profileRepo` callers

**Severity:** Medium

**How it goes wrong:** Callers that currently rely on `profileRepo` throwing (to trigger their own fallback logic) would silently receive partial profiles instead.

**Analysis:** There are exactly two callers of `profileRepo`:
1. `builtinScanProvider.scan` (scan.ts:39) — calls `profileRepo` and wraps result in `createBuiltinScanResult`. Currently, if `profileRepo` throws, this provider's `scan` method throws, which is caught by `scanRepo`. After T1, `profileRepo` won't throw, so `builtinScanProvider.scan` always succeeds with a potentially partial profile. This is **better** behavior — a partial profile is more useful than no profile.
2. `cccScanProvider.scan` (scan.ts:57) — calls `profileRepo` in `Promise.all` alongside `collectCccCodebaseAnalysis`. If `profileRepo` doesn't throw, the `Promise.all` only fails on ccc issues, which is the correct behavior.

**Verdict:** The behavioral change is strictly positive. No callers are harmed.

### Risk 2: Empty profile misleads downstream planning

**Severity:** Low

**How it goes wrong:** If all profiler collectors fail and return defaults, the profile has `languages: []`, `frameworks: []`, etc. The discovery/planning phase might generate unhelpful recommendations for an "empty" repo.

**Mitigation:** The `ScanResult` carries `fallback.used === true` and `sourceMetadata.warnings` describing what failed. Downstream consumers can check these signals. The alternative (no scan result at all) is strictly worse.

### Risk 3: TypeScript type narrowing with `Promise.allSettled`

**Severity:** Low

**How it goes wrong:** `Promise.allSettled` returns `PromiseSettledResult<T>[]` which requires type narrowing via `.status === "fulfilled"` checks. TypeScript is strict about this, and incorrect narrowing causes compilation errors.

**Mitigation:** The plan specifies exact type guard patterns. The build verification step (T6) catches any type errors.

### Risk 4: AGENTS.md contains stale information

**Severity:** Low

**How it goes wrong:** Project evolves but AGENTS.md is not updated.

**Mitigation:** AGENTS.md states only structural facts (build commands, file conventions) that change infrequently. The "no test suite" note should be updated when tests are added.

### Risk 5: Nested try/catch in scanRepo reduces debuggability

**Severity:** Low

**How it goes wrong:** Two layers of error handling make it harder to trace which error caused the fallback.

**Mitigation:** The original error is preserved in `fallback.error`, and the profiler error is appended to `sourceMetadata.warnings`. Both errors are fully visible in the `ScanResult` without any information loss.

---

## 5. Summary of All Changes

| File | Change | Lines affected |
|---|---|---|
| `mcp-server/src/profiler.ts` | `Promise.all` → `Promise.allSettled` + default extraction; wrap `collectBestPracticesGuides` in try/catch; add `createEmptyRepoProfile` export | Lines 8-52 (profileRepo body), new function at end |
| `mcp-server/src/scan.ts` | Nested try/catch in `scanRepo` catch block; import `createEmptyRepoProfile` | Lines 80-91, line 2 |
| `mcp-server/src/scan.ts` | `Promise.all` → `Promise.allSettled` in `collectCccCodebaseAnalysis`; filter fulfilled results; throw if all fail | Lines 178-237 |
| `AGENTS.md` | New file | N/A |

**Total scope:** ~80 lines changed across 2 existing files + 1 new file.
