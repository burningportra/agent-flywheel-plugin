# Ergonomics Plan: Error Recovery in scan.ts + AGENTS.md

**Date:** 2026-04-08
**Perspective:** Ergonomics — developer experience, readability, minimal cognitive load, consistent patterns, great DX for contributors and sub-agents alike.

---

## 1. Problem Statement

Two distinct ergonomic gaps exist in the codebase:

### 1.1 scan.ts — Error Recovery UX

`mcp-server/src/scan.ts` has one top-level try/catch in `scanRepo()` (line 85–91) that handles the full ccc provider failure by falling back to the built-in profiler. But the internal functions `ensureCccReady()` and `collectCccCodebaseAnalysis()` throw raw `Error` objects, and the per-query `Promise.all` in `collectCccCodebaseAnalysis()` (line 183) is all-or-nothing: if any single `ccc search` call fails, the entire codebase analysis is lost, including results from queries that already succeeded.

**Ergonomic problems:**

1. **All-or-nothing query fan-out**: A single failed query aborts all three searches. Callers receive the full built-in fallback instead of partial ccc results — a jarring outcome that discards useful signal.
2. **Error surfacing is invisible to callers**: `toScanErrorInfo()` only marks every error as `recoverable: true` regardless of the actual error shape. There is no way to distinguish "ccc not installed" from "one search query timed out."
3. **stderr vs stdout discipline missing**: None of the error paths log diagnostics to stderr. When ccc fails silently, operators have no audit trail.
4. **Helper functions throw, but throw context is lost**: `ensureCccReady()` builds errors from raw `stderr.trim() || stdout.trim() || "fallback string"` — valid but inconsistent with TypeScript idioms for structured errors. A reader must trace through 4 conditional branches to understand the failure taxonomy.

### 1.2 AGENTS.md — Missing Entirely

`/Volumes/1tb/Projects/agent-flywheel/AGENTS.md` does not exist. Sub-agents spawned by the agent-flywheel bootstrap from skills and commands, but have no single canonical file that answers:

- How is this project built?
- What commands are safe to run?
- What are the key constraints (file paths, state machine rules, coordination rules)?
- What does a good agent contribution look like?

The absence of AGENTS.md increases sub-agent cognitive load and causes agents to re-derive project conventions from README.md and scattered command files on every session.

---

## 2. Ergonomic Design Principles Applied

The changes below are guided by four ergonomic principles:

1. **Prefer partial success over total failure**: When work can proceed with degraded results, surface what succeeded alongside what failed rather than aborting everything.
2. **Errors should be informative at the call site, not just at the throw site**: Callers should not need to re-read internals to understand what went wrong.
3. **Log to stderr, return to callers**: Diagnostic output (scan failures, fallback decisions) goes to stderr. Structured data (ScanResult) is returned to callers. Never mix them.
4. **AGENTS.md is a cognitive load document**: Every line in AGENTS.md should reduce the number of files a sub-agent must read before starting work. If the information is already in README.md, link rather than duplicate.

---

## 3. scan.ts Changes

### 3.1 Partial Results for `collectCccCodebaseAnalysis`

Replace the all-or-nothing `Promise.all` in `collectCccCodebaseAnalysis` with a per-query settled fan-out. Each query runs independently. Failed queries contribute a fallback `ScanRecommendation` with a `detail` that names the failure, rather than aborting the whole analysis.

**Pattern (ergonomic):**

```typescript
const settled = await Promise.allSettled(
  CCC_SCAN_QUERIES.map((entry) => runCccQuery(exec, cwd, entry))
);

const recommendations: ScanRecommendation[] = settled.map((result, i) => {
  const entry = CCC_SCAN_QUERIES[i];
  if (result.status === "fulfilled") {
    return buildRecommendation(entry, result.value);
  }
  process.stderr.write(`[scan] ccc query "${entry.id}" failed: ${result.reason}\n`);
  return buildFailedRecommendation(entry, result.reason);
});
```

**Why this pattern over alternatives:**
- `Promise.allSettled` is the standard JS idiom for fan-out with partial failure — readers recognize it immediately.
- Extracting `runCccQuery` and `buildRecommendation` into named helpers keeps the fan-out loop readable at a glance. No nested try/catch in the map callback.
- `process.stderr.write` (not `console.error`) is consistent with Node.js MCP server conventions — structured JSON on stdout, diagnostics on stderr.

### 3.2 Named Helper: `runCccQuery`

Extract the per-query exec + parse logic into a small named function:

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

**Ergonomic benefit**: The error message in `runCccQuery` encodes the query ID and exit code — enough to diagnose any failure without reading the exec internals. The throw is intentional (callers use `allSettled`).

### 3.3 Structured Error Recovery Helpers

Replace the flat `toScanErrorInfo` function with a small set of typed helpers:

```typescript
function toScanErrorInfo(error: unknown, context?: string): ScanErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: context ? `${context}: ${message}` : message,
    recoverable: true,
  };
}

function logScanWarning(message: string): void {
  process.stderr.write(`[scan] warning: ${message}\n`);
}
```

**Why not a class**: The `ScanErrorInfo` interface is already defined in `types.ts`. A helper function that wraps it is sufficient and keeps the call site one line.

**Context parameter**: Callers pass a short context string (`"ensureCccReady"`, `"collectCccCodebaseAnalysis"`) so errors logged to stderr name their origin without requiring a stack trace.

### 3.4 `ensureCccReady` — Flatten Error Branches

The current `ensureCccReady` has four nested conditional branches (version check → status check → maybe init → index). The ergonomic issue is that readers must trace all branches to understand what can go wrong.

Refactor into a sequential flat style with early returns and named steps:

```typescript
async function ensureCccReady(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<void> {
  await requireCccBinary(exec, cwd);
  await ensureCccIndexed(exec, cwd);
}

async function requireCccBinary(exec: ExecFn, cwd: string): Promise<void> {
  const result = await exec("ccc", ["--help"], { cwd, timeout: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "ccc binary not found or not executable");
  }
}

async function ensureCccIndexed(exec: ExecFn, cwd: string): Promise<void> {
  const status = await exec("ccc", ["status"], { cwd, timeout: 10000 });
  const output = `${status.stdout}\n${status.stderr}`;

  if (status.code !== 0 && /Not in an initialized project directory/i.test(output)) {
    await initCcc(exec, cwd);
  } else if (status.code !== 0) {
    throw new Error(status.stderr.trim() || status.stdout.trim() || "ccc status failed");
  }

  const index = await exec("ccc", ["index"], { cwd, timeout: 120000 });
  if (index.code !== 0) {
    throw new Error(index.stderr.trim() || index.stdout.trim() || "ccc index failed");
  }
}

async function initCcc(exec: ExecFn, cwd: string): Promise<void> {
  const result = await exec("ccc", ["init", "-f"], { cwd, timeout: 10000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "ccc init failed");
  }
}
```

**Ergonomic benefit**: Each helper has a single, named responsibility. The failure mode of each step is obvious from its name. Reading `ensureCccReady` tells you the two-step sequence; reading `requireCccBinary` tells you the binary check; no need to read both at once.

### 3.5 `scanRepo` — Emit Fallback Warning to stderr

When the ccc provider fails and the built-in fallback is used, log a diagnostic to stderr so operators can see why:

```typescript
export async function scanRepo(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<ScanResult> {
  try {
    return await cccScanProvider.scan(exec, cwd, signal);
  } catch (error) {
    const errorInfo = toScanErrorInfo(error, "ccc provider");
    logScanWarning(`fell back to builtin provider — ${errorInfo.message}`);
    const profile = await profileRepo(exec, cwd, signal);
    return createFallbackScanResult(profile, "ccc", errorInfo);
  }
}
```

---

## 4. AGENTS.md

### 4.1 What Makes a Great AGENTS.md

An effective AGENTS.md for a multi-agent agent-flywheel project answers exactly these questions for a sub-agent bootstrapping a new session:

1. **What is this project?** (1–2 sentences, not duplicating README)
2. **How do I build it?** (exact commands, no ambiguity)
3. **How do I run it in dev mode?**
4. **What paths matter?** (where to find state, skills, commands)
5. **What must I never do?** (constraints that prevent data loss or broken state)
6. **How do I coordinate with other agents?** (agent-mail bootstrap pattern)
7. **What does a good contribution look like?** (code style, test requirements)

**What NOT to include in AGENTS.md:**
- Architecture prose that duplicates README.md
- Long explanations of why things are designed as they are (that's for docs/)
- Per-command reference tables (already in README.md)
- Installation instructions (not relevant to sub-agents working within the repo)

### 4.2 AGENTS.md Structure

```
# AGENTS.md

## Project Overview
## Build
## Dev
## Key File Paths
## Hard Constraints
## Agent Coordination
## Code Conventions
```

**Tone:** Imperative, direct. Write as instructions to the sub-agent, not as documentation for a human reader. "Run `npm run build`" not "The build step compiles TypeScript using `npm run build`."

### 4.3 AGENTS.md Content Design

**Project Overview** (3 sentences max):
- What the agent-flywheel does
- What MCP server does
- Where the entry point is

**Build:**
```
cd mcp-server && npm install && npm run build
```
No alternatives, no notes about optional steps.

**Dev:**
```
cd mcp-server && npm run dev   # TypeScript watch mode
```

**Key File Paths:**
Only paths a sub-agent would need to find things, not an architecture diagram:
- `mcp-server/src/` — TypeScript source (the thing you'll edit most)
- `.pi-flywheel/checkpoint.json` — live session state (read-only unless you are the state owner)
- `skills/` — skill `.md` files injected into agent system prompts
- `docs/plans/` — plan artifacts from deep-plan sessions

**Hard Constraints:**
This section is the most valuable part of AGENTS.md. Include:
1. Never write directly to `.pi-flywheel/checkpoint.json` — use `orch_*` MCP tools.
2. Never run `ccc init` in the project root unless `ccc status` returns "Not in an initialized project directory."
3. Do not `rm -rf` worktrees — use `flywheel-cleanup` skill.
4. Always log diagnostics to stderr, never stdout, in MCP server code.
5. All `exec` calls must pass a `timeout` — no open-ended shell commands.

**Agent Coordination:**
Brief bootstrap pattern for agent-mail, referencing the `macro_start_session` tool.

**Code Conventions:**
- TypeScript strict mode, ESM modules (`.js` imports required in TS source)
- No `console.log` in MCP server — `process.stderr.write` only
- Errors throw `new Error(message)` — no custom error classes
- Async functions are preferred over callbacks
- Helper functions over nested try/catch

---

## 5. Implementation Tasks

### T1 — Extract `runCccQuery` helper in scan.ts

**File:** `mcp-server/src/scan.ts`
**What:** Extract the per-query exec+parse logic from the `Promise.all` in `collectCccCodebaseAnalysis` into a standalone `runCccQuery(exec, cwd, entry)` function. Function throws a descriptive `Error` on non-zero exit code.
**Acceptance criteria:**
- [ ] `runCccQuery` is a named function at module scope (not inline in a callback)
- [ ] Error message includes entry.id and exit code
- [ ] No behavior change for the happy path (successful queries produce same output)
- [ ] TypeScript build passes: `cd mcp-server && npm run build`

`depends_on: []`

---

### T2 — Replace `Promise.all` with `Promise.allSettled` in `collectCccCodebaseAnalysis`

**File:** `mcp-server/src/scan.ts`
**What:** Replace `Promise.all(CCC_SCAN_QUERIES.map(...))` with `Promise.allSettled(CCC_SCAN_QUERIES.map((entry) => runCccQuery(exec, cwd, entry)))`. For rejected results, emit a `process.stderr.write` diagnostic and produce a fallback `ScanRecommendation` with a `detail` that names the failure.
**Acceptance criteria:**
- [ ] A single failed query no longer aborts the other queries
- [ ] Failed queries produce a `ScanRecommendation` with `priority: "medium"` and `detail` naming the failure
- [ ] Successful queries produce the same recommendation shape as before
- [ ] Fallback recommendations are included in the returned `ScanCodebaseAnalysis`
- [ ] `process.stderr.write` logs the query ID and error message for failed queries
- [ ] TypeScript build passes

`depends_on: [T1]`

---

### T3 — Add `logScanWarning` helper + context to `toScanErrorInfo`

**File:** `mcp-server/src/scan.ts`
**What:** Add `logScanWarning(message: string): void` that writes `[scan] warning: ${message}\n` to `process.stderr`. Update `toScanErrorInfo` to accept an optional `context?: string` parameter prepended to the error message. Update `scanRepo` to call `logScanWarning` when falling back.
**Acceptance criteria:**
- [ ] `logScanWarning` is used in `scanRepo` catch block
- [ ] `toScanErrorInfo` context parameter is used where the caller knows the failing step
- [ ] No `console.error` or `console.warn` calls introduced
- [ ] TypeScript build passes

`depends_on: []`

---

### T4 — Flatten `ensureCccReady` into named sub-helpers

**File:** `mcp-server/src/scan.ts`
**What:** Refactor `ensureCccReady` into three named helpers: `requireCccBinary`, `ensureCccIndexed`, `initCcc`. `ensureCccReady` becomes a two-line sequencer calling the first two. Behavior must be identical to current implementation.
**Acceptance criteria:**
- [ ] `ensureCccReady` body is 2–3 lines (calls to named helpers only)
- [ ] `requireCccBinary` handles the `--help` check
- [ ] `ensureCccIndexed` handles `status` + optional `init` + `index`
- [ ] `initCcc` handles the `init -f` step
- [ ] All error messages preserved (same strings as before or improved — not reduced in clarity)
- [ ] TypeScript build passes

`depends_on: []`

---

### T5 — Create AGENTS.md at repo root

**File:** `/Volumes/1tb/Projects/agent-flywheel/AGENTS.md`
**What:** Create the AGENTS.md file following the structure in section 4.2 above. Content must be accurate to the current codebase (verified against `package.json`, `README.md`, and `mcp-server/src/`).
**Acceptance criteria:**
- [ ] File exists at repo root: `AGENTS.md`
- [ ] Contains all 7 sections: Project Overview, Build, Dev, Key File Paths, Hard Constraints, Agent Coordination, Code Conventions
- [ ] Build command is exact and runnable: `cd mcp-server && npm install && npm run build`
- [ ] Hard Constraints section lists at least 5 specific constraints
- [ ] Agent Coordination section describes `macro_start_session` bootstrap
- [ ] No content duplicated verbatim from README.md (link instead)
- [ ] Total length: 80–150 lines (short enough to be read in full, complete enough to be useful)

`depends_on: []`

---

### T6 — Build verification

**File:** N/A
**What:** Run `cd mcp-server && npm run build` and confirm zero TypeScript errors across all scan.ts changes.
**Acceptance criteria:**
- [ ] `npm run build` exits 0
- [ ] No new TypeScript errors introduced
- [ ] No regressions in other files that import from `scan.ts` (the public API surface — `scanRepo`, `createBuiltinScanResult`, `createFallbackScanResult`, `createEmptyCodebaseAnalysis` — is unchanged)

`depends_on: [T1, T2, T3, T4]`

---

## 6. Dependency Graph

```
T1  Extract runCccQuery helper              depends_on: []
T2  Switch to Promise.allSettled            depends_on: [T1]
T3  Add logScanWarning + context param      depends_on: []
T4  Flatten ensureCccReady                  depends_on: []
T5  Create AGENTS.md                        depends_on: []
T6  Build verification                      depends_on: [T1, T2, T3, T4]
```

**Parallelization notes:**
- T1, T3, T4, T5 are all independent and can run in parallel.
- T2 depends on T1 (it calls `runCccQuery`).
- T6 gates the implementation — run it only after T1–T4 are committed.
- T5 (AGENTS.md) is fully independent and can run any time.

**Critical path:** T1 → T2 → T6 (3 hops)

---

## 7. Style Consistency with Existing Codebase

### Observations from scan.ts and profiler.ts

- **Named module-level helpers** are already the pattern in `profiler.ts` (`collectFileTree`, `collectCommits`, etc.). The `ensureCccReady` refactor follows this established idiom.
- **Early return on error** is used throughout `profiler.ts` (`if (result.code !== 0) return []`). The helpers in T4 use the same pattern.
- **No custom Error subclasses** — `new Error(message)` throughout. Maintain this.
- **No logging anywhere in the existing codebase** — the stderr logging introduced in T2 and T3 is new, but warranted for fallback visibility. Use `process.stderr.write` to avoid importing a logger.
- **`signal?: AbortSignal` parameter** is threaded through but not acted on yet (passed to `exec` but exec doesn't use it). Keep the parameter for future use; do not add abort checks in this plan.
- **TypeScript ESM imports** use `.js` extensions on local imports (`"./types.js"`, `"./exec.js"`). All new helpers in scan.ts must follow this.

### AGENTS.md Tone

Match the imperative, minimal-prose tone of existing `.md` files in `skills/` and `commands/`. Not academic, not chatty. Instructions for a fast reader.

---

## 8. Acceptance Criteria (Overall)

- [ ] `scanRepo()` falls back gracefully when ccc is unavailable, with a stderr warning
- [ ] A single failed `ccc search` query does not abort the other queries
- [ ] Failed queries produce a descriptive fallback `ScanRecommendation` rather than an empty analysis
- [ ] `ensureCccReady` is decomposed into three named helpers with single responsibilities
- [ ] All diagnostic output goes to `process.stderr`, never `process.stdout`
- [ ] `AGENTS.md` exists at repo root with all 7 required sections
- [ ] `npm run build` passes with zero errors after all scan.ts changes
- [ ] Public API surface of `scan.ts` is unchanged (no signature changes to exported functions)
