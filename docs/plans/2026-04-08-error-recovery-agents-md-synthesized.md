# Plan: Error Recovery in scan.ts + AGENTS.md

## Goal

Make `scanRepo()` and `profileRepo()` resilient to partial and total failures of their underlying shell commands and CLI tools, so the orchestrator workflow never crashes at step 1. Additionally, create `AGENTS.md` at the project root to give sub-agents canonical project guidance.

**Key invariant after this plan:** `scanRepo()` always returns a valid `ScanResult` -- it never throws.

## Constraints

- MCP server uses stdio for JSON-RPC -- **never use `console.log`** (use `process.stderr.write` for diagnostics)
- `dist/` is compiled output -- only edit `src/` files, then rebuild with `cd mcp-server && npm run build`
- TypeScript strict mode, `module: "NodeNext"` -- use `.js` extensions in relative imports
- No new dependencies
- No changes to the public API surface of `scan.ts` or `profiler.ts` (exported function signatures unchanged)

## Dependency Graph

```
T1 (profileRepo allSettled)     depends_on: []
T2 (ccc query allSettled)       depends_on: []
T3 (scanRepo double-fault)     depends_on: [T1]
T4 (AGENTS.md)                  depends_on: []
T5 (build verification)         depends_on: [T1, T2, T3, T4]
```

Parallelization: T1, T2, T4 run in parallel. T3 waits for T1 (imports `createEmptyRepoProfile`). T5 runs last.

```
    ┌──── T1 ───┐
    │            ▼
────┤        ── T3 ──┐
    │                 │
    ├──── T2 ────────►├──── T5
    │                 │
    └──── T4 ────────►┘
```

## Beads

### T1: Replace `Promise.all` with `Promise.allSettled` in `profileRepo` + add `createEmptyRepoProfile`

**depends_on:** []
**effort:** medium
**files:** `mcp-server/src/profiler.ts`

**what:** Make `profileRepo` resilient so individual collector failures (timeout, spawn error, permission denied) don't discard results from sibling collectors that succeeded.

**why:** `profileRepo` (line 13) uses `Promise.all` over 4 parallel collectors. If any single collector throws (e.g., `find` times out on a large repo), the entire profile is lost -- including commits, todos, and keyFiles that completed successfully. This is the second most impactful structural issue in scan.ts.

**how:**

1. Replace `Promise.all` at line 13 with `Promise.allSettled`:
   ```typescript
   const results = await Promise.allSettled([
     collectFileTree(exec, cwd, signal),
     collectCommits(exec, cwd, signal),
     collectTodos(exec, cwd, signal),
     collectKeyFiles(exec, cwd, signal),
   ]);

   const fileTree = results[0].status === "fulfilled" ? results[0].value : "";
   const commits = results[1].status === "fulfilled" ? results[1].value : [];
   const todos = results[2].status === "fulfilled" ? results[2].value : [];
   const keyFiles = results[3].status === "fulfilled" ? results[3].value : {};

   // Log failures to stderr (never stdout -- MCP stdio constraint)
   for (const [i, label] of ["fileTree", "commits", "todos", "keyFiles"].entries()) {
     if (results[i].status === "rejected") {
       process.stderr.write(
         `[profiler] ${label} collector failed: ${(results[i] as PromiseRejectedResult).reason}\n`
       );
     }
   }
   ```

2. Wrap `collectBestPracticesGuides` call (line 20) in try/catch since it depends on `fileTree`:
   ```typescript
   let bestPracticesGuides: Array<{ name: string; content: string }> = [];
   try {
     bestPracticesGuides = await collectBestPracticesGuides(exec, cwd, fileTree, signal);
   } catch {
     // Best practices collection is non-critical
   }
   ```

3. Add exported `createEmptyRepoProfile` function at end of file (needed by T3):
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

**correctness notes:**
- The return type `Promise<RepoProfile>` is unchanged. Empty defaults satisfy every field of the `RepoProfile` interface.
- `collectCommits` already handles `result.code !== 0` by returning `[]` (line 89), but exec itself can throw on spawn failure or timeout. `allSettled` catches that.
- `collectFileTree` returns `result.stdout.trim()` without checking exit code -- partial output from `find` is actually useful. Only spawn/timeout errors propagate, which `allSettled` catches.
- When `fileTree` defaults to `""`, downstream detection (languages, frameworks, entrypoints) returns empty arrays -- valid `RepoProfile` fields.
- Diagnostic logging uses `process.stderr.write` (not `console.error` or `console.warn`) to avoid any stdout pollution.

**acceptance_criteria:**
- `profileRepo` never throws, always returns a valid `RepoProfile`
- If `find` times out, profile still contains commits, todos, and keyFiles from successful collectors
- If `git log` fails, profile still contains fileTree, todos, and keyFiles
- If ALL 4 collectors fail, profile has empty defaults (but doesn't throw)
- `createEmptyRepoProfile` is exported and satisfies the `RepoProfile` interface
- No `console.log`, `console.error`, or `console.warn` statements added -- only `process.stderr.write`
- TypeScript compilation passes with zero errors

---

### T2: Replace `Promise.all` with `Promise.allSettled` in `collectCccCodebaseAnalysis`

**depends_on:** []
**effort:** medium
**files:** `mcp-server/src/scan.ts`

**what:** Make `collectCccCodebaseAnalysis` resilient to individual ccc query failures. Extract a `runCccQuery` helper for readability. If ALL queries fail, throw to trigger the builtin fallback in `scanRepo`.

**why:** `collectCccCodebaseAnalysis` (line 183) uses `Promise.all` over `CCC_SCAN_QUERIES`. A single query failure (timeout, ccc bug) aborts all queries, discarding results from queries that already succeeded.

**how:**

1. Extract `runCccQuery` helper (for readability and descriptive error messages):
   ```typescript
   async function runCccQuery(
     exec: ExecFn,
     cwd: string,
     entry: (typeof CCC_SCAN_QUERIES)[number]
   ): Promise<Array<{ location: string; snippet: string }>> {
     const result = await exec(
       "ccc",
       ["search", "--limit", "3", ...entry.query.split(" ")],
       { cwd, timeout: 30000 }
     );
     if (result.code !== 0) {
       throw new Error(
         `ccc search "${entry.id}" exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`
       );
     }
     return parseCccSearchResults(result.stdout);
   }
   ```

2. Replace `Promise.all` at line 183 with `Promise.allSettled`:
   ```typescript
   const settled = await Promise.allSettled(
     CCC_SCAN_QUERIES.map((entry) => runCccQuery(exec, cwd, entry))
   );
   ```

3. Build searches from fulfilled results, log failures to stderr:
   ```typescript
   type CccSearchEntry = {
     id: string;
     title: string;
     query: string;
     results: Array<{ location: string; snippet: string }>;
   };

   const searches: CccSearchEntry[] = [];
   for (let i = 0; i < settled.length; i++) {
     const result = settled[i];
     const entry = CCC_SCAN_QUERIES[i];
     if (result.status === "fulfilled") {
       searches.push({ ...entry, results: result.value });
     } else {
       process.stderr.write(
         `[scan] ccc query "${entry.id}" failed: ${result.reason}\n`
       );
     }
   }
   ```

4. If ALL queries fail, throw so the outer `scanRepo` catch triggers the builtin fallback:
   ```typescript
   if (searches.length === 0 && settled.length > 0) {
     const firstRejected = settled.find(
       (r): r is PromiseRejectedResult => r.status === "rejected"
     );
     throw new Error(firstRejected?.reason?.message ?? "All ccc search queries failed");
   }
   ```

5. The rest of the function (recommendations, structuralInsights, qualitySignals) uses `searches` as before -- `searches.length` now reflects actual successes.

**correctness notes:**
- If 2 of 3 queries succeed, the analysis contains 2 recommendations + insights. Partial is better than nothing.
- If ALL queries fail, we throw to trigger the builtin fallback -- returning an empty analysis from ccc would mask a broken ccc installation.
- The `summary` string already uses `searches.length`, so it naturally reflects actual successes.
- The `query_count` quality signal uses `searches.length`, correctly reporting actual successes.

**acceptance_criteria:**
- If 1 of 3 ccc search queries fails, `collectCccCodebaseAnalysis` returns results from the 2 successful queries
- If all 3 queries fail, the function throws (triggering the builtin fallback in `scanRepo`)
- Failed queries are logged to stderr with their query ID and error message
- `summary` and `query_count` reflect the actual number of successful queries (not hardcoded 3)
- No `console.log` statements added
- TypeScript compilation passes with zero errors

---

### T3: Guard the fallback path in `scanRepo` (double-fault protection)

**depends_on:** [T1]
**effort:** low
**files:** `mcp-server/src/scan.ts`

**what:** Wrap the fallback `profileRepo()` call in `scanRepo`'s catch block with its own try/catch. If both ccc AND the builtin profiler fail, return a minimal emergency `ScanResult` with an empty profile instead of propagating an unrecoverable exception.

**why:** This is the most dangerous failure mode in scan.ts. The current catch block in `scanRepo` (line 87-90) calls `profileRepo` without any guard. If `profileRepo` also throws (e.g., Docker container with minimal tooling where `find`, `git`, AND `grep` all fail), the entire orchestrate workflow halts with a raw stack trace. After T1, `profileRepo` should rarely throw, but defense-in-depth requires a safety net.

**how:**

1. Import `createEmptyRepoProfile` from profiler.ts (added in T1).

2. Replace the catch block in `scanRepo`:
   ```typescript
   export async function scanRepo(
     exec: ExecFn,
     cwd: string,
     signal?: AbortSignal
   ): Promise<ScanResult> {
     try {
       return await cccScanProvider.scan(exec, cwd, signal);
     } catch (error) {
       const errorInfo = toScanErrorInfo(error);
       process.stderr.write(
         `[scan] ccc provider failed, falling back to builtin: ${errorInfo.message}\n`
       );
       try {
         const profile = await profileRepo(exec, cwd, signal);
         return createFallbackScanResult(profile, "ccc", errorInfo);
       } catch (fallbackError) {
         // Double fault: both providers failed. Return emergency minimal result.
         process.stderr.write(
           `[scan] builtin profiler also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`
         );
         const emptyProfile = createEmptyRepoProfile(cwd);
         const result = createFallbackScanResult(emptyProfile, "ccc", errorInfo);
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

**correctness notes:**
- `scanRepo` now NEVER throws. The return type `Promise<ScanResult>` is always satisfied.
- The original ccc error is preserved in `fallback.error`. The profiler error is appended to `sourceMetadata.warnings`. Both errors are fully visible -- no information loss.
- `createEmptyRepoProfile(cwd)` derives `name` from `cwd` (not hardcoded).
- `createFallbackScanResult` is reused (not a new function) -- the emergency result has the same shape as a normal fallback, just with an empty profile and an extra warning.
- All diagnostic output goes to `process.stderr.write`.

**acceptance_criteria:**
- `scanRepo` never throws under any circumstances
- If both ccc and profiler fail, a valid `ScanResult` is returned with `fallback.used === true`
- `sourceMetadata.warnings` contains both the ccc error and the profiler error
- `emptyProfile.name` is derived from `cwd`
- No new exported functions added to scan.ts (reuses existing `createFallbackScanResult`)
- TypeScript compilation passes with zero errors

---

### T4: Create AGENTS.md

**depends_on:** []
**effort:** low
**files:** `AGENTS.md` (new file at project root)

**what:** Create `AGENTS.md` with sub-agent guidance covering build commands, constraints, file paths, coordination, and code conventions. Claude Code automatically loads `AGENTS.md` from the project root -- no opt-in required.

**why:** Sub-agents spawned by the orchestrator currently re-derive project conventions from README.md and scattered command files every session. A canonical `AGENTS.md` reduces cognitive load and prevents common mistakes (e.g., using `console.log` in MCP server code, editing `dist/` directly).

**how:** Create the file with the following content:

```markdown
# AGENTS.md

Guidance for sub-agents working in this repository.

## Project Overview

claude-orchestrator is an MCP server that drives a multi-phase development workflow: scan, discover, plan, implement, review. The MCP server runs over stdio (JSON-RPC) from `mcp-server/src/server.ts`.

## Build

```bash
cd mcp-server && npm run build
```

Compiles TypeScript from `mcp-server/src/` to `mcp-server/dist/`.

## Hard Constraints

1. **No `console.log` in MCP server code.** The server uses stdin/stdout for JSON-RPC. Any stdout write corrupts the communication channel. Use `process.stderr.write()` for diagnostics.
2. **Never edit `mcp-server/dist/`.** It is compiled output. Edit sources in `mcp-server/src/` and rebuild.
3. **TypeScript strict mode.** `tsconfig.json` enables `strict: true`. All code must pass strict type checking.
4. **NodeNext module resolution.** Use `.js` extensions in all relative imports (e.g., `import { foo } from "./bar.js"`), even when the source file is `.ts`.
5. **ESM only.** `"type": "module"` in `package.json`. No CommonJS `require()`.
6. **Never write directly to `.pi-orchestrator/checkpoint.json`.** Use `orch_*` MCP tools for state management.
7. **All `exec` calls must include a `timeout`.** No open-ended shell commands.

## Key File Paths

- `mcp-server/src/` -- TypeScript source (edit here)
- `mcp-server/dist/` -- compiled output (never edit)
- `.pi-orchestrator/` -- runtime state directory
- `skills/` -- skill `.md` files injected into agent system prompts
- `commands/*.md` -- natural language orchestrator commands
- `docs/plans/` -- plan artifacts from deep-plan sessions

## Available CLI Tools

- **`br`** -- bead tracker CLI: create, list, update status, approve beads.
- **`bv`** -- bead visualizer: renders bead status dashboards, dependency graphs.
- **`ccc`** -- optional codebase indexing/search tool. Not required; the system falls back gracefully if unavailable.

## Agent Coordination

- Bootstrap your agent-mail session with `macro_start_session` at the start of each task.
- Before modifying any file, request a file reservation via agent-mail.
- Report errors to the team lead via agent-mail with subject `[error] <context>`. Do not silently skip tasks.
- Check your agent-mail inbox at task start for updates or cancellations.

## Code Conventions

- Named exports only (no default exports).
- Types live in `mcp-server/src/types.ts`. Import with `import type { ... }`.
- `ExecFn` type (`mcp-server/src/exec.ts`) wraps all shell command execution.
- Errors throw `new Error(message)` -- no custom error classes.
- Use `Promise.allSettled` for parallel operations where partial results are acceptable.
- Async functions preferred over callbacks.

## Testing

No test suite is configured yet. Verify changes by running the build: `cd mcp-server && npm run build`.
```

**correctness notes:**
- Every stated fact is verifiable from the current codebase:
  - `strict: true` -- `tsconfig.json`
  - `module: "NodeNext"` -- `tsconfig.json`
  - `"type": "module"` -- `package.json`
  - `outDir: "./dist"` -- `tsconfig.json`
  - stdio communication -- `server.ts` / README.md
  - `.js` extensions in imports -- `scan.ts` lines 1-2
  - No test suite -- no test script in `package.json`
  - Build command -- `package.json` "build": "tsc"
- Claude Code agents automatically see `AGENTS.md` at project root.

**acceptance_criteria:**
- `AGENTS.md` exists at project root
- Contains correct build command (`cd mcp-server && npm run build`)
- Documents the stdio/console.log constraint
- Documents NodeNext `.js` import extension requirement
- Documents that `dist/` is generated (never edit)
- Documents available CLI tools (br, bv, ccc)
- Documents agent-mail coordination pattern
- All stated facts match current codebase state

---

### T5: Build Verification

**depends_on:** [T1, T2, T3, T4]
**effort:** low
**files:** N/A

**what:** Run `cd mcp-server && npm run build` and confirm zero TypeScript compilation errors after all code changes.

**why:** TypeScript strict mode and `Promise.allSettled` type narrowing require exact types. This gate catches any type errors before the plan is considered complete.

**how:**
1. Run `cd mcp-server && npm run build`
2. Confirm exit code 0
3. Verify no regressions in files that import from `scan.ts` or `profiler.ts`

**acceptance_criteria:**
- `npm run build` exits with code 0
- No new TypeScript errors introduced
- No regressions in other files that import from `scan.ts` or `profiler.ts`

---

## Risk Analysis

### Risk 1: `Promise.allSettled` changes observable behavior of `profileRepo` callers
**Severity:** Medium
**Analysis:** Two callers of `profileRepo`: (1) `builtinScanProvider.scan` wraps the result -- partial profile is strictly better than no profile. (2) `cccScanProvider.scan` runs `profileRepo` alongside ccc queries in `Promise.all` -- if `profileRepo` doesn't throw, the `Promise.all` only fails on ccc issues, which is correct.
**Verdict:** Behavioral change is strictly positive.

### Risk 2: Empty profile misleads downstream planning
**Severity:** Low
**Mitigation:** `ScanResult` carries `fallback.used === true` and `sourceMetadata.warnings`. Downstream consumers can check these signals. An empty profile is strictly better than no scan result at all.

### Risk 3: TypeScript type narrowing with `Promise.allSettled`
**Severity:** Low
**Mitigation:** Plan specifies exact type guard patterns. T5 build verification catches any type errors.

### Risk 4: `process.stderr.write` is new to the codebase
**Severity:** Low
**Analysis:** The existing codebase has zero logging. Adding stderr diagnostics is warranted for fallback visibility. `process.stderr.write` is the correct choice for an MCP server (not `console.error` which also writes to stderr but adds formatting that may not be desired, and definitely not `console.warn` which on some Node.js configurations can write to stdout).

## What This Plan Does NOT Cover (Non-Goals)

- Wiring AbortSignal through exec calls (separate concern, no bug fix)
- Stdout size cap in exec (optimization, not error recovery)
- Structured error codes in ScanErrorInfo (additive enhancement, not needed for error recovery)
- Refactoring `ensureCccReady` into sub-helpers (ergonomic improvement, no bug fix)
- Integration tests (no test framework configured yet)
- Retry logic with exponential backoff (premature; the fallback chain is sufficient)
- Windows/non-POSIX compatibility

## Summary of All Changes

| File | Change | Scope |
|---|---|---|
| `mcp-server/src/profiler.ts` | `Promise.all` -> `Promise.allSettled` + default extraction; wrap `collectBestPracticesGuides` in try/catch; add `createEmptyRepoProfile` export; stderr logging for failed collectors | ~40 lines changed |
| `mcp-server/src/scan.ts` | Extract `runCccQuery` helper; `Promise.all` -> `Promise.allSettled` in `collectCccCodebaseAnalysis`; nested try/catch in `scanRepo` catch block; import `createEmptyRepoProfile`; stderr logging | ~50 lines changed |
| `AGENTS.md` | New file | ~80 lines |

**Total scope:** ~90 lines changed across 2 existing files + 1 new file.
