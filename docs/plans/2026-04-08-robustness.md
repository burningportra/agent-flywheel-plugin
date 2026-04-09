# Robustness Plan: Error Recovery in scan.ts + Create AGENTS.md

**Perspective:** Robustness -- fault tolerance, worst-case analysis, defensive programming, resilience, graceful degradation.

**Date:** 2026-04-08

---

## 1. Problem Statement

### scan.ts: Fragile Error Recovery

`mcp-server/src/scan.ts` is the entry point for repository scanning. It drives two providers -- `cccScanProvider` (external CLI-based) and `builtinScanProvider` (shell commands via `profiler.ts`). The current error recovery has a **critical structural flaw**: the top-level `scanRepo()` function catches `cccScanProvider` failures and falls back to the builtin profiler, but if the **fallback itself also fails**, the error propagates unhandled and crashes the caller with no useful diagnostic.

Additionally, `profiler.ts` (which `builtinScanProvider` delegates to) runs 4+ shell commands in parallel via `Promise.all`. If **any** of those commands fails, the entire profile is lost -- even if the other 3 commands succeeded. There is no partial-result recovery.

### AGENTS.md: Missing Coordination Contract

No `AGENTS.md` exists at the project root. The orchestrator spawns multiple parallel agents (implementation agents, review agents, planning agents) but has no machine-readable contract for how those agents should behave, what files they may modify, what conventions they must follow, or how to handle failures. Without this, agents may:
- Write to the same files concurrently (even with agent-mail file reservations, agents must know to request them)
- Ignore review gates
- Produce inconsistently shaped outputs
- Fail silently without reporting to agent-mail

---

## 2. Failure Mode Analysis: scan.ts

### FM-1: Double fault -- ccc fails, then builtin profiler also fails
- **Trigger:** git not initialized + filesystem permission error, or `find` not available on PATH.
- **Current behavior:** `scanRepo()` catches ccc error, calls `profileRepo()` in the catch block. If `profileRepo()` also throws, the error propagates as an unhandled rejection to the MCP tool caller.
- **Impact:** The entire orchestrate workflow halts at step 1. User sees a raw stack trace with no actionable guidance.
- **Severity:** **Critical.** This is the most dangerous failure mode because the fallback path has no fallback of its own.
- **Detection difficulty without fix:** **Hard.** Only surfaces on machines where both `ccc` and basic shell tools are broken -- rare but catastrophic when it happens (e.g., Docker containers with minimal tooling, Windows WSL with broken PATH).

### FM-2: `collectFileTree` timeout on very large repositories
- **Trigger:** Repository with 100K+ files, or NFS-mounted filesystem with high latency.
- **Current behavior:** `find` command has a 10-second timeout (exec.ts:19-22). On timeout, `makeExec` kills the child and rejects with a timeout Error. Since `collectFileTree` doesn't catch this, and it runs inside `Promise.all` in `profileRepo`, the **entire profile fails** -- all 4 parallel collectors are lost.
- **Impact:** Lost commits, todos, and keyFiles data that completed successfully before the timeout.
- **Severity:** **High.** Large monorepos are a common deployment target.
- **Detection difficulty without fix:** **Medium.** The timeout error message from exec.ts is clear ("Timed out after 10000ms: find ..."), but the loss of partial results is invisible.

### FM-3: `collectCommits` fails on non-git directory
- **Trigger:** Running scan on a directory that is not a git repository (e.g., a tarball extraction, or a freshly created project before `git init`).
- **Current behavior:** `collectCommits` returns `[]` when git log exits non-zero (line 89). This is **well-handled** -- it degrades gracefully.
- **But:** `collectFileTree` uses `find` (not git), so it works. `collectTodos` uses `grep` (not git), so it works. `collectKeyFiles` uses `head` (not git), so it works. The profiler correctly survives non-git directories for everything except commits.
- **Severity:** **Low.** Already handled correctly.

### FM-4: `collectKeyFiles` reads binary files
- **Trigger:** A file named `Makefile` or `Dockerfile` that is actually a binary blob (unlikely but possible in adversarial repos, or a symlink to a binary).
- **Current behavior:** `head -c 4096` reads raw bytes. Binary content becomes garbage in `keyFiles` strings, which propagates into framework/language detection and eventually into LLM prompts.
- **Impact:** Garbled prompt content, incorrect framework detection, wasted tokens.
- **Severity:** **Low.** Unlikely in practice. `head -c 4096` on a binary produces non-UTF8 bytes that won't match framework detection strings, so the functional impact is just wasted space.

### FM-5: `collectTodos` matches in node_modules on non-standard directory layouts
- **Trigger:** Repository with symlinked `node_modules` pointing to a shared cache, or a monorepo where `node_modules` is at a non-standard path.
- **Current behavior:** `grep --exclude-dir=node_modules` only excludes the literal directory name. Symlinks or renamed module directories (e.g., `.pnpm`) are not excluded.
- **Impact:** Hundreds of TODO matches from third-party code, saturating the 50-item limit with irrelevant results.
- **Severity:** **Low-medium.** Annoying but not crash-inducing. The `.slice(0, 50)` limit caps the damage.

### FM-6: Symlink cycles cause `find` to hang
- **Trigger:** A symlink cycle (e.g., `a -> b -> a`) in the repo.
- **Current behavior:** `find` with no `-L` flag follows physical directory structure, not symlinks. So by default, `find .` does NOT follow symlinks -- this is **safe by default**.
- **Severity:** **None.** `find` without `-L` is inherently safe against symlink cycles.

### FM-7: `ensureCccReady` runs `ccc init -f` which modifies the working directory
- **Trigger:** First scan on a repo that hasn't been ccc-initialized.
- **Current behavior:** `ccc init -f` creates a `.ccc/` directory (or similar) in the working directory. This is a **side effect** of scanning.
- **Impact:** Unexpected new directory in the repo. If the user has `.gitignore` rules, it may or may not be tracked. If concurrent scans run, `ccc init -f` may race.
- **Severity:** **Medium.** Side effects during a read-only scan operation are a design smell. The `-f` flag is force-init which could overwrite existing ccc state.

### FM-8: AbortSignal is accepted but never used
- **Trigger:** Caller passes an `AbortSignal` to `scanRepo()` to support cancellation.
- **Current behavior:** The `signal` parameter is threaded through to `profileRepo()` and `ensureCccReady()`, but **none of the exec calls actually use it**. The `makeExec` function in exec.ts does not accept or wire up AbortSignal to the child process.
- **Impact:** Scans cannot be cancelled. If a user navigates away or the MCP client times out, shell commands continue running in the background.
- **Severity:** **Medium.** Resource leak on abandoned scans. Not a correctness issue but a resource management gap.

### FM-9: `parseCccSearchResults` fails silently on unexpected output format
- **Trigger:** ccc CLI changes its output format (version upgrade, different locale).
- **Current behavior:** The regex `split(/--- Result \d+ \(score: .*?\) ---/)` may not match, producing a single block with the entire output. The `File: ` line finder defaults to `"File: unknown"`. The result is a single search result with location "unknown" and the entire output as a snippet (truncated to 280 chars).
- **Impact:** Degraded but non-crashing behavior. The ccc analysis will contain garbage but the scan will complete.
- **Severity:** **Low-medium.** Silent data quality degradation.

### FM-10: Promise.all in profiler means one failure kills all parallel results
- **Trigger:** Any one of `collectFileTree`, `collectCommits`, `collectTodos`, or `collectKeyFiles` throws.
- **Current behavior:** `Promise.all` rejects with the first error. All successful results from sibling promises are discarded.
- **Impact:** A timeout in `collectFileTree` (FM-2) causes loss of commit history, todos, and key files even though those completed successfully.
- **Severity:** **High.** This is the second most impactful structural issue after FM-1.

---

## 3. Failure Mode Analysis: AGENTS.md

### FM-A1: Agent writes to unreserved file
- **Trigger:** Implementation agent modifies a file without requesting a file reservation through agent-mail.
- **Current behavior:** No enforcement mechanism. Agent-mail file reservations are advisory unless a pre-commit hook is installed.
- **Impact:** Concurrent writes, merge conflicts, lost work.
- **Severity:** **High** in swarm mode with parallel agents.

### FM-A2: Agent ignores review gates
- **Trigger:** Agent completes implementation but doesn't report completion via agent-mail, or marks work done without running tests.
- **Current behavior:** The orchestrator's review step expects beads to be marked as ready-for-review via `br`. If an agent skips this, the bead sits in limbo.
- **Impact:** Stalled workflow, beads stuck in implementation state forever.
- **Severity:** **Medium.**

### FM-A3: Agent produces output in wrong format
- **Trigger:** Agent writes a bead description without the required `### Files:` section or acceptance criteria.
- **Current behavior:** `validateBeads()` in beads.ts catches some format issues, but only after the bead is created.
- **Impact:** Late detection of format errors wastes a full implementation cycle.
- **Severity:** **Medium.**

### FM-A4: Agent doesn't follow AGENTS.md because it doesn't know it exists
- **Trigger:** AGENTS.md is created but the agent's system prompt doesn't reference it.
- **Current behavior:** N/A (AGENTS.md doesn't exist yet). When created, it needs to be injected into agent prompts or placed where Claude Code automatically reads it.
- **Impact:** AGENTS.md becomes dead documentation.
- **Severity:** **High** -- the whole point of AGENTS.md is moot if agents don't read it.

---

## 4. Implementation Plan

### T1: Add emergency fallback profile in scanRepo() [CRITICAL]
**File:** `mcp-server/src/scan.ts`
**depends_on:** []

Wrap the fallback `profileRepo()` call inside its own try-catch. If both ccc AND the builtin profiler fail, return a **minimal emergency ScanResult** with an empty profile instead of crashing.

```typescript
export async function scanRepo(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<ScanResult> {
  // Try ccc provider first
  try {
    return await cccScanProvider.scan(exec, cwd, signal);
  } catch (cccError) {
    // ccc failed — try builtin fallback
    try {
      const profile = await profileRepo(exec, cwd, signal);
      return createFallbackScanResult(profile, "ccc", toScanErrorInfo(cccError));
    } catch (builtinError) {
      // Double fault: both providers failed
      // Return emergency minimal result instead of crashing
      return createEmergencyFallbackResult(cwd, cccError, builtinError);
    }
  }
}
```

Add `createEmergencyFallbackResult()`:

```typescript
function createEmergencyFallbackResult(
  cwd: string,
  primaryError: unknown,
  fallbackError: unknown
): ScanResult {
  const name = cwd.split("/").pop() ?? "unknown";
  const emptyProfile: RepoProfile = {
    name,
    languages: [],
    frameworks: [],
    structure: "",
    entrypoints: [],
    recentCommits: [],
    hasTests: false,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };
  return {
    source: "builtin",
    provider: "emergency-fallback",
    profile: emptyProfile,
    codebaseAnalysis: createEmptyCodebaseAnalysis(),
    sourceMetadata: {
      label: "Emergency fallback (both providers failed)",
      warnings: [
        `Primary (ccc) error: ${toScanErrorInfo(primaryError).message}`,
        `Fallback (builtin) error: ${toScanErrorInfo(fallbackError).message}`,
      ],
    },
    fallback: {
      used: true,
      from: "ccc",
      to: "builtin",
      reason: "Double fault: both ccc and builtin profiler failed",
      error: {
        message: `ccc: ${toScanErrorInfo(primaryError).message}; builtin: ${toScanErrorInfo(fallbackError).message}`,
        recoverable: false,
      },
    },
  };
}
```

**Acceptance criteria:**
- [ ] When both ccc and profiler throw, `scanRepo()` returns a valid `ScanResult` (never throws)
- [ ] The returned result has `fallback.error.recoverable === false` to signal degraded state
- [ ] `sourceMetadata.warnings` contains both error messages for diagnostics
- [ ] TypeScript compiles with no errors

**Hardest to detect without fix:** This bug only manifests when TWO things fail simultaneously. In normal development only one fails at a time, so the fallback path appears to work. The double-fault path is never tested.

---

### T2: Replace Promise.all with Promise.allSettled in profileRepo() [HIGH]
**File:** `mcp-server/src/profiler.ts`
**depends_on:** []

Change the parallel collector invocation from `Promise.all` to `Promise.allSettled` so that individual collector failures don't discard successful results.

```typescript
export async function profileRepo(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<RepoProfile> {
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

  // Log collector failures but continue with partial data
  for (const [i, label] of ["fileTree", "commits", "todos", "keyFiles"].entries()) {
    if (results[i].status === "rejected") {
      console.warn(
        `[profiler] ${label} collector failed: ${(results[i] as PromiseRejectedResult).reason}`
      );
    }
  }

  // If ALL collectors failed, throw so the caller's fallback logic can kick in
  if (results.every((r) => r.status === "rejected")) {
    throw new Error(
      "All profile collectors failed: " +
        results
          .map((r, i) =>
            r.status === "rejected"
              ? `${["fileTree", "commits", "todos", "keyFiles"][i]}: ${r.reason}`
              : ""
          )
          .filter(Boolean)
          .join("; ")
    );
  }

  const bestPracticesGuides = await collectBestPracticesGuides(exec, cwd, fileTree, signal);

  // ... rest of profile construction unchanged, using the extracted values
```

**Acceptance criteria:**
- [ ] If `collectFileTree` times out, commits/todos/keyFiles are still returned in the profile
- [ ] If ALL 4 collectors fail, `profileRepo` throws an aggregate error (triggering T1 emergency fallback)
- [ ] Warning messages are logged for each failed collector with the specific error
- [ ] `collectBestPracticesGuides` receives an empty string for `fileTree` if that collector failed (safe: produces no directory candidates)
- [ ] TypeScript compiles with no errors

**Hardest to detect without fix:** Partial data loss is completely invisible. The scan "succeeds" but the profile is missing data. The downstream LLM gets a less informed prompt, produces worse plans, but nobody knows why.

---

### T3: Wire AbortSignal through exec calls
**File:** `mcp-server/src/exec.ts`
**depends_on:** []

Extend `makeExec` to accept and honor an `AbortSignal` so that scans can be cancelled.

```typescript
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; signal?: AbortSignal }
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function makeExec(defaultCwd?: string): ExecFn {
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeout) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Timed out after ${opts.timeout}ms: ${cmd} ${args.join(" ")}`));
        }, opts.timeout);
      }

      // Abort signal support
      if (opts.signal) {
        if (opts.signal.aborted) {
          child.kill("SIGTERM");
          reject(new Error(`Aborted: ${cmd} ${args.join(" ")}`));
          return;
        }
        const onAbort = () => {
          child.kill("SIGTERM");
          if (timer) clearTimeout(timer);
          reject(new Error(`Aborted: ${cmd} ${args.join(" ")}`));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
      }

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
}
```

Then update `profiler.ts` and `scan.ts` to pass `signal` through to each exec call (currently `signal` is accepted but never forwarded).

**Acceptance criteria:**
- [ ] Calling `scanRepo(exec, cwd, abortController.signal)` and then `abortController.abort()` kills running child processes
- [ ] Already-aborted signals cause immediate rejection without spawning
- [ ] Abort listener is cleaned up on normal process completion (no memory leak)
- [ ] Existing timeout behavior is preserved (timeout and abort are independent)
- [ ] TypeScript compiles with no errors

---

### T4: Add stdout size guard to exec
**File:** `mcp-server/src/exec.ts`
**depends_on:** []

Cap stdout/stderr accumulation at a reasonable limit (e.g., 10MB) to prevent memory exhaustion on very large repositories where `find` or `grep` produces enormous output.

```typescript
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

// Inside the exec function:
child.stdout?.on("data", (d: Buffer) => {
  if (stdout.length < MAX_OUTPUT_BYTES) {
    stdout += d.toString();
  }
});
child.stderr?.on("data", (d: Buffer) => {
  if (stderr.length < MAX_OUTPUT_BYTES) {
    stderr += d.toString();
  }
});
```

**Acceptance criteria:**
- [ ] A command producing >10MB stdout returns a truncated result (first 10MB) without crashing
- [ ] stderr is independently capped
- [ ] No behavior change for normal-sized outputs
- [ ] TypeScript compiles with no errors

---

### T5: Add structured error categories to ScanErrorInfo
**File:** `mcp-server/src/types.ts`, `mcp-server/src/scan.ts`
**depends_on:** []

Extend `ScanErrorInfo` with an error `code` classification so downstream consumers can make programmatic decisions:

```typescript
export type ScanErrorCode =
  | "TIMEOUT"
  | "COMMAND_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_A_GIT_REPO"
  | "ABORT"
  | "DOUBLE_FAULT"
  | "UNKNOWN";
```

Update `toScanErrorInfo` to classify common errors:

```typescript
function toScanErrorInfo(error: unknown): ScanErrorInfo {
  if (error instanceof Error) {
    const msg = error.message;
    let code: ScanErrorCode = "UNKNOWN";
    if (/timed out/i.test(msg)) code = "TIMEOUT";
    else if (/ENOENT/i.test(msg) || /not found/i.test(msg)) code = "COMMAND_NOT_FOUND";
    else if (/EACCES/i.test(msg) || /permission denied/i.test(msg)) code = "PERMISSION_DENIED";
    else if (/not a git repository/i.test(msg)) code = "NOT_A_GIT_REPO";
    else if (/abort/i.test(msg)) code = "ABORT";

    return { code, message: msg, recoverable: code !== "PERMISSION_DENIED" };
  }
  return { code: "UNKNOWN", message: String(error), recoverable: true };
}
```

**Acceptance criteria:**
- [ ] Timeout errors produce `code: "TIMEOUT"`
- [ ] ENOENT errors produce `code: "COMMAND_NOT_FOUND"`
- [ ] Permission errors produce `code: "PERMISSION_DENIED"` with `recoverable: false`
- [ ] `ScanErrorCode` type is exported from types.ts
- [ ] Existing callers that read `error.message` are unaffected (additive change)
- [ ] TypeScript compiles with no errors

---

### T6: Create AGENTS.md
**File:** `/Volumes/1tb/Projects/claude-orchestrator/AGENTS.md`
**depends_on:** []

Create an `AGENTS.md` at the project root that serves as the coordination contract for all agents spawned by the orchestrator. The file must be:

1. **Self-enforcing**: Placed at project root where Claude Code's agent framework automatically loads it. No opt-in required.
2. **Machine-readable**: Uses structured sections with clear heading hierarchy so agents can parse relevant sections.
3. **Failure-aware**: Includes explicit failure reporting requirements.

Content structure:

```markdown
# AGENTS.md -- Agent Coordination Contract

## Applicability
This file applies to ALL agents spawned by claude-orchestrator, including:
- Implementation agents (swarm workers in worktrees)
- Review agents (5 parallel reviewers per bead)
- Planning agents (correctness, ergonomics, robustness perspectives)
- Audit agents (bugs, security, tests, dead code)

## File Ownership Protocol
1. Before modifying any file, request a file reservation via agent-mail.
2. Never modify files outside your reservation. If you need to, send a message
   to the team lead requesting expanded scope.
3. Release reservations when your task is complete.
4. If a reservation is denied (conflict), report the conflict to the team lead
   and wait for resolution. Do NOT proceed without the reservation.

## Output Format Requirements
All bead descriptions MUST include:
- A `### Files:` section listing all files to be modified
- At least 3 acceptance criteria as `- [ ]` checkboxes
- A `Why this bead exists:` explanation

## Failure Reporting
When you encounter an error that prevents task completion:
1. Send an agent-mail message to the team lead with subject `[error] <bead-id>`
2. Include: error message, what you tried, what files you were working on
3. Do NOT silently skip the task or mark it as complete
4. Do NOT retry more than twice without reporting

## Testing Requirements
- Run the project's test suite before marking work complete
- If tests fail, fix them or report the failure -- never skip tests
- For TypeScript projects: `npm run build` must pass (zero type errors)

## Git Conventions
- Work only in your assigned worktree (never on main/master directly)
- Commit messages: `<type>(<scope>): <description>` (conventional commits)
- Do not force-push or rewrite history
- Do not modify files outside your bead's scope

## Coordination
- Check agent-mail inbox at the start of your task for updates or cancellations
- Report progress via agent-mail at meaningful milestones (not every small step)
- If your task depends on another bead, verify that bead is complete before starting

## What To Do If You Don't Understand This File
If any instruction in this file is ambiguous:
1. Default to the most conservative interpretation
2. Ask the team lead via agent-mail before proceeding
3. Never assume silence means approval
```

**Robustness considerations for AGENTS.md itself:**
- **Self-enforcement:** Claude Code loads `AGENTS.md` from the project root automatically. Agents don't need to be told to read it.
- **What if agents ignore it:** The pre-commit guard from agent-mail (`install_precommit_guard`) can enforce file reservations at the git level. AGENTS.md provides the "why" and conventions; the pre-commit hook provides mechanical enforcement.
- **What if AGENTS.md is deleted:** The orchestrator commands (`.md` files in `commands/`) should reference AGENTS.md expectations inline as a backup. But since AGENTS.md is tracked in git, deletion requires a deliberate commit.
- **Versioning:** AGENTS.md should be version-controlled and reviewed like code. Breaking changes to agent conventions should be treated as breaking changes to the orchestrator.

**Acceptance criteria:**
- [ ] AGENTS.md exists at project root
- [ ] File is valid Markdown with no broken links
- [ ] All sections use heading hierarchy (H1 > H2) for parseability
- [ ] Failure reporting section is explicit about what constitutes a reportable failure
- [ ] File ownership section references agent-mail by name
- [ ] Testing requirements are language-agnostic with TypeScript as a specific example
- [ ] Claude Code agents automatically see this file (verify by checking agent system prompt injection)

---

### T7: Add scan.ts integration test for double-fault scenario
**File:** `mcp-server/src/__tests__/scan.test.ts` (new file)
**depends_on:** [T1, T2]

Write a test that verifies the emergency fallback path:

```typescript
import { scanRepo, createEmptyCodebaseAnalysis } from "../scan.js";
import type { ExecFn } from "../exec.js";

test("scanRepo returns emergency fallback when both providers fail", async () => {
  // Mock exec that fails for all commands
  const failExec: ExecFn = async () => {
    throw new Error("command not found");
  };

  const result = await scanRepo(failExec, "/nonexistent");

  expect(result.provider).toBe("emergency-fallback");
  expect(result.fallback?.used).toBe(true);
  expect(result.fallback?.error?.recoverable).toBe(false);
  expect(result.sourceMetadata?.warnings?.length).toBeGreaterThanOrEqual(2);
  expect(result.profile.name).toBe("nonexistent");
  expect(result.profile.languages).toEqual([]);
});

test("profileRepo returns partial results when one collector fails", async () => {
  // Mock exec where find times out but git/grep/head work
  const partialExec: ExecFn = async (cmd, args) => {
    if (cmd === "find") throw new Error("Timed out after 10000ms");
    if (cmd === "git") return { code: 0, stdout: "abc1234\0msg\02026-01-01\0author\n", stderr: "" };
    if (cmd === "grep") return { code: 1, stdout: "", stderr: "" }; // no matches
    if (cmd === "head") return { code: 1, stdout: "", stderr: "" }; // no key files
    return { code: 0, stdout: "", stderr: "" };
  };

  const { profileRepo } = await import("../profiler.js");
  const profile = await profileRepo(partialExec, "/test");

  expect(profile.structure).toBe(""); // fileTree failed
  expect(profile.recentCommits.length).toBeGreaterThanOrEqual(0); // commits may have succeeded
});
```

**Acceptance criteria:**
- [ ] Test passes with `npm test`
- [ ] Double-fault scenario is covered
- [ ] Partial-result scenario is covered
- [ ] No mocking of internal functions -- only the `exec` boundary is mocked

---

### T8: Add timeout escalation for ccc index
**File:** `mcp-server/src/scan.ts`
**depends_on:** []

The `ccc index` command has a 120-second timeout (line 170). On large repos this may not be enough, but we can't just increase it indefinitely. Add a warning when the timeout is approaching:

```typescript
async function ensureCccReady(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<void> {
  // ... existing version check and status check ...

  const indexStart = Date.now();
  const index = await exec("ccc", ["index"], {
    cwd,
    timeout: 120000,
  });
  const indexDuration = Date.now() - indexStart;

  if (index.code !== 0) {
    throw new Error(index.stderr.trim() || index.stdout.trim() || "ccc index failed");
  }

  // Warn if indexing took over 60s -- may timeout on next run if repo grows
  if (indexDuration > 60000) {
    console.warn(
      `[scan] ccc index took ${Math.round(indexDuration / 1000)}s -- ` +
      `approaching 120s timeout. Consider running 'ccc index' manually for large repos.`
    );
  }
}
```

**Acceptance criteria:**
- [ ] Warning emitted when ccc index takes >60s
- [ ] No behavior change when ccc index completes quickly
- [ ] Warning message includes duration and actionable guidance
- [ ] TypeScript compiles with no errors

---

## 5. Dependency Graph

```
T1 (emergency fallback in scanRepo)
  depends_on: []

T2 (Promise.allSettled in profileRepo)
  depends_on: []

T3 (AbortSignal wiring in exec.ts)
  depends_on: []

T4 (stdout size guard in exec.ts)
  depends_on: []

T5 (structured error codes)
  depends_on: []

T6 (create AGENTS.md)
  depends_on: []

T7 (integration tests)
  depends_on: [T1, T2]

T8 (timeout escalation warning)
  depends_on: []
```

### Parallelization

- **Wave 1 (all independent):** T1, T2, T3, T4, T5, T6, T8
- **Wave 2 (depends on T1 + T2):** T7

### Build verification

After all tasks: `cd mcp-server && npm run build` must succeed with zero TypeScript errors. If a test framework exists: `npm test` must pass.

---

## 6. Priority Order (by impact / detection difficulty)

| Rank | Task | Severity | Why hard to detect without fix |
|------|------|----------|-------------------------------|
| 1 | T1 | Critical | Double-fault only happens when TWO things fail -- never tested in isolation |
| 2 | T2 | High | Partial data loss is invisible; scan "succeeds" with silently degraded quality |
| 3 | T6 | High | Agent misbehavior looks like bugs, not coordination failures |
| 4 | T3 | Medium | Resource leak from uncancellable scans only visible under load |
| 5 | T5 | Medium | Without error codes, retries and diagnostics are string-matching hacks |
| 6 | T4 | Medium | OOM from large repos is rare but catastrophic when it hits |
| 7 | T7 | Medium | Tests ensure the fixes stay fixed across refactors |
| 8 | T8 | Low | Timeout warnings prevent future outages from repo growth |

---

## 7. What This Plan Does NOT Cover (Non-Goals)

- Rewriting the ccc CLI integration (that's a separate effort)
- Adding retry logic with exponential backoff (premature; the fallback chain is sufficient)
- Caching scan results across runs (optimization, not robustness)
- Windows/non-POSIX compatibility (the tool set assumes POSIX `find`/`grep`/`head`)
- Rate-limiting or throttling concurrent scans (single-scan model is fine for now)
