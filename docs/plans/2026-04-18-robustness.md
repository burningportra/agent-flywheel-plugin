# Robustness Plan: Structured Error Contract — agent-flywheel-plugin
**Date:** 2026-04-18  
**Perspective:** Worst-case failures  
**Scope:** All 8 `flywheel_*` MCP tools + supporting modules  
**Companion plans:** 2026-04-18-correctness.md, 2026-04-18-ergonomics.md

---

## 1. Failure-Mode Catalog

### Proposed Error Code Enum

```typescript
export const FlywheelErrorCode = {
  // Input / prerequisite
  MISSING_PREREQUISITE:    'missing_prerequisite',   // no profile, no goal, no plan
  INVALID_INPUT:           'invalid_input',           // empty goal, bad args
  NOT_FOUND:               'not_found',               // planFile missing, bead missing

  // CLI layer
  CLI_FAILURE:             'cli_failure',             // br/bv/git/cm non-zero exit
  CLI_TIMEOUT:             'cli_timeout',             // exec() timer fired
  CLI_ABORTED:             'cli_aborted',             // AbortSignal fired
  CLI_UNAVAILABLE:         'cli_unavailable',         // which fails (br not installed)

  // Parsing
  PARSE_FAILURE:           'parse_failure',           // JSON.parse on br show output
  SCHEMA_DRIFT:            'schema_drift',            // checkpoint schemaVersion mismatch

  // State integrity
  CHECKPOINT_CORRUPT:      'checkpoint_corrupt',      // hash mismatch or bad JSON
  PARTIAL_STATE:           'partial_state',           // throw during phase transition
  CONCURRENT_WRITE:        'concurrent_write',        // writeLock race (should not surface)

  // Bead lifecycle
  ALREADY_CLOSED:          'already_closed',          // skip on a closed bead
  BEAD_CYCLE:              'bead_cycle',              // dep cycle blocks progress
  EMPTY_PLAN:              'empty_plan',              // "(No planner outputs provided.)" shape

  // External services
  AGENT_MAIL_UNREACHABLE:  'agent_mail_unreachable',  // curl to agent-mail server fails
  GIT_DIRTY:               'git_dirty',               // uncommitted state before transition

  // Orchestration
  DEEP_PLAN_ALL_FAILED:    'deep_plan_all_failed',    // all parallel planners timed out
  RETRY_STORM:             'retry_storm',             // resilientExec exceeded maxRetries

  // Internal
  INTERNAL_ERROR:          'internal_error',          // unexpected throw not matching above
} as const;
```

### Worst-case scenarios per high-risk code

#### `CLI_TIMEOUT` (exec.ts:23-27)
- **Scenario A:** `br list --json` hangs indefinitely in a large monorepo. The tool call blocks MCP stdio, causing MCP client heartbeat to expire. From the user's perspective the entire Claude session hangs.
- **Scenario B:** `claude --print` (deep-plan) times out after 420 s. `Promise.all` in `runDeepPlanAgents` still awaits all 4 agents. If 3 agents time out, the 4th returning successfully still blocks for the full window.
- **Scenario C:** The timeout fires (`child.kill('SIGTERM')`) but the process ignores SIGTERM and continues running. The Promise resolves to `reject(new Error(...))` but the zombie process continues writing to stdout, potentially corrupting subsequent reads.
- **Contract:** All `CLI_TIMEOUT` errors must carry `{ cmd, args, elapsedMs, timeout }`. The response `isError: true` with code `cli_timeout`. Outer callers must not retry automatically without exponential backoff cap.

#### `CHECKPOINT_CORRUPT` (checkpoint.ts:228-230, 284-292)
- **Scenario A:** Power loss between `writeFileSync(tmpFile)` and `renameSync(tmpFile, mainFile)` (checkpoint.ts:173). On HFS+/APFS `renameSync` is atomic at the VFS level; however on NFS mounts it is not. The `.tmp` file is left; `cleanupOrphanedTmp` deletes it on next read — so the checkpoint is silently gone and the session restarts from `idle`. No error is surfaced to the user.
- **Scenario B:** Two processes share the same `cwd` (e.g., two worktrees pointing at the same `.pi-flywheel` dir). The `writeLocks` map is **per-process** (module-level `Map`). Both processes race on `renameSync`. The loser's rename fails silently (caught by the `try/catch` at line 176) and returns `false`, which is ignored by `saveState` (state.ts:16-17).
- **Scenario C:** `checkpoint.json` is valid JSON but `stateHash` was computed with a different field ordering (e.g., a future code change reorders fields in `FlywheelState`). `JSON.stringify(state)` is sensitive to key insertion order. The hash will mismatch and the checkpoint is quarantined, silently resetting session state.
- **Contract:** `CHECKPOINT_CORRUPT` must be logged with `log.warn` (already done at checkpoint.ts:238) plus a structured tag `{ code: 'checkpoint_corrupt', reason }`. `saveState` must check the boolean return and log `warn` with `{ code: 'partial_state' }` when `false`.

#### `DEEP_PLAN_ALL_FAILED` (deep-plan.ts:147-155)
- **Scenario A:** All 4 parallel planners time out. `filterViableResults` returns `[]`. `runDeepPlanAgents` returns `[]` (an empty array). The synthesis agent calling `flywheel_plan` with `planContent=""` triggers the `"(No planner outputs provided.)"` guard (plan.ts:111), throwing `Error("Deep plan failed...")`. But because the synthesis agent itself constructs `planContent` by concatenating the agents' file outputs, an empty string bypasses the guard cleanly — the guard only catches the literal sentinel.
- **Scenario B:** One planner returns a non-empty string `"(AGENT RETURNED EMPTY — exclude from synthesis)"` (deep-plan.ts:114). `filterViableResults` (line 163-165) excludes it via the `startsWith("(AGENT")` check. But the synthesis agent reading the `.md` files directly does not apply this filter — it may read a sentinel file and include it verbatim in `planContent`, circumventing the guard.
- **Scenario C:** `DEEP_PLAN_TIMEOUT_MS` env var is set to `0` by mistake. `Number("0") === 0`, and `setTimeout(cb, 0)` fires immediately, killing every child process before output is read.
- **Contract:** `DEEP_PLAN_ALL_FAILED` must be a hard error surfaced to the LLM — not a degraded empty result. The `filterViableResults` guard must also be applied when the synthesis agent calls back with `planContent` (see Section 8).

#### `EMPTY_PLAN` (plan.ts:111)
- **Scenario A:** `planContent` contains `"(No planner outputs provided.)"` as a substring within a larger valid plan. The `includes` check fires falsely and throws when the plan is actually partially valid.
- **Scenario B:** `planContent` is an empty string `""`. The `includes` check does not catch this — `"".includes("(No planner outputs provided.)")` is `false`. The plan is written as an empty `.md` file (plan.ts:117). Subsequently, `flywheel_approve_beads` reads 0 lines (approve.ts:305) and shows `getSizeAssessment` returning `'too_short'` — a soft warning, not a hard error.
- **Scenario C:** `planContent` is only whitespace. `args.planContent.trim()` on line 110 is `""`, so the `planContent` branch is skipped entirely. The tool falls through to standard-mode prompt generation, which sets `state.planDocument` to a path that doesn't exist yet. `flywheel_approve_beads` then returns `not_found`.
- **Contract:** The guard must check `!args.planContent.trim()` (empty/whitespace → `INVALID_INPUT`) **before** checking for the specific sentinel string. The sentinel check should use exact equality `=== "(No planner outputs provided.)"` not `includes`.

---

## 2. State Invariants

### Critical checkpoint fields

The following `FlywheelState` fields must satisfy these invariants **atomically** (they must never be inconsistent with each other after a successful `saveState`):

| Field pair | Invariant | Risk if violated |
|---|---|---|
| `phase` + `selectedGoal` | If `phase ∈ {planning, awaiting_plan_approval, creating_beads, awaiting_bead_approval, implementing, reviewing, iterating}` then `selectedGoal` must be non-empty string | `flywheel_plan` throws `MISSING_PREREQUISITE` on replay; `flywheel_select` succeeds but future tools fail silently |
| `phase` + `planDocument` | If `phase === 'awaiting_plan_approval'` then `planDocument` must be a non-empty string | `flywheel_approve_beads` in plan mode fails with `not_found` on a path that was never set |
| `phase` + `activeBeadIds` | If `phase ∈ {implementing, reviewing}` then `activeBeadIds` must be a non-empty array | `flywheel_review` returns "no bead to review" with no error code |
| `beadResults[id].status` + bead CLI state | When `beadResults[id].status === 'success'`, the `br show id` should return `status: 'closed'` | Desync causes double-work; handled by the preflight in review.ts:125 but not logged |
| `polishRound` + `polishChanges.length` | `polishRound === polishChanges.length` (each round pushes one entry) | Convergence score is computed incorrectly; `computeConvergenceScore` receives mismatched arrays |

### Guard strategy audit

`writeCheckpoint` (checkpoint.ts:150-180) uses:
1. `writeFileSync(tmpFile)` — writes to `.json.tmp`
2. `renameSync(tmpFile, mainFile)` — atomic on APFS/ext4

This is correct **within a single process**. Two failure modes the current code does **not** handle:

**Gap A — return value of `saveState` is ignored:**
`saveState` in state.ts:16-17 `await`s `writeCheckpoint` but discards the `boolean` return value. If the write fails silently, state is not persisted, but the phase transition already happened in memory. The tool then returns success to the LLM while the on-disk state is stale.

**Recommended guard:**
```typescript
export async function saveState(cwd: string, state: FlywheelState): Promise<boolean> {
  const ok = await writeCheckpoint(cwd, state);
  if (!ok) log.warn('saveState failed — checkpoint not persisted', { phase: state.phase });
  return ok;
}
```
Tool handlers should check the return and include `checkpointPersisted: false` in structured output warnings.

**Gap B — partial phase transition on throw:**
In `profile.ts:60-66`, state mutations happen **before** `saveState`:
```typescript
state.repoProfile = profile;         // line 61
state.coordinationBackend = ...;     // line 62
state.coordinationStrategy = ...;    // line 63
state.coordinationMode ??= ...;      // line 64
if (args.goal) state.selectedGoal = ...; // line 65
state.phase = 'discovering';         // line 66
saveState(state);                    // line 67 — async, not awaited with error handling
```
If `saveState` fails (e.g., disk full), `state.phase` is `'discovering'` in memory but the checkpoint still says `'profiling'`. On the next tool call, `loadState` returns the old checkpoint. The session is effectively reset mid-transition.

**Recommended guard:** Apply a copy-on-write pattern — build a new state object, validate it, then pass to `saveState`. If `saveState` returns `false`, return a warning in structured output but do not revert the in-memory state (the tool call still succeeded for this invocation).

---

## 3. Concurrent Invocation Safety

### Current state

`writeLocks` in checkpoint.ts:142 is a per-process `Map<string, Promise<boolean>>`. It serializes writes to the same `cwd` within one Node.js process. This correctly handles concurrent MCP tool calls (all MCP tools run in the same server process).

### Gap: flywheel_review called twice concurrently on the same bead

Consider two Claude turns both calling `flywheel_review` with `beadId="br-5"` and `action="looks-good"`:

1. Turn A: `br show br-5` → `in_progress`
2. Turn B: `br show br-5` → `in_progress` (interleaved before A's update)
3. Turn A: `br update br-5 --status closed` → OK
4. Turn A: `state.beadResults['br-5'] = { status: 'success' }` → saveState
5. Turn B: `br update br-5 --status closed` → OK (br CLI is idempotent here)
6. Turn B: `state.beadResults['br-5'] = { status: 'success' }` → saveState (overwrites A's save)

**Effect:** Both turns succeed and both call `nextBeadOrGates`. Two concurrent calls to `br update <next-bead> --status in_progress` are fired. `state.currentBeadId` is set twice, possibly to different beads. `polishChanges` and `beadReviewPassCounts` are mutated in both turns from the same base state and both saved — the second save wins, dropping the first's changes.

**Proposed mutex:**
Introduce a per-bead operation lock using a `Set<string>` of in-flight bead IDs:

```typescript
// tools/review.ts — module level
const _beadOpInFlight = new Set<string>();

export async function runReview(...) {
  if (_beadOpInFlight.has(beadId)) {
    return errorResult(state.phase, 'concurrent_write',
      `Bead ${beadId} is already being processed — retry after the current operation completes.`,
      { beadId });
  }
  _beadOpInFlight.add(beadId);
  try {
    // ... existing logic
  } finally {
    _beadOpInFlight.delete(beadId);
  }
}
```

This is a single-process guard. For multi-process scenarios, Agent Mail file reservations should be used (already available in the platform).

### Gap: flywheel_approve_beads action="start" concurrent race

`handleStart` in approve.ts:427-600 reads `br ready --json`, then loops `br update <id> --status in_progress` for each ready bead. If called concurrently, both calls read the same ready list and both mark the same beads `in_progress`, resulting in duplicate agent spawns.

Same lock pattern applies — the `action="start"` path should be mutex-protected.

---

## 4. Rollback Paths

### Tools requiring undo-on-failure wrappers

| Tool | Mutation | Failure mode | Rollback needed |
|---|---|---|---|
| `flywheel_profile` | `state.phase = 'discovering'` | saveState fails | No — in-memory state is correct; operator can re-call |
| `flywheel_discover` | writes artifact to `tmpdir` | write fails | No — tmpdir write is best-effort (discover.ts:67-71) |
| `flywheel_select` | `state.phase = 'planning'` | saveState fails | No — re-call is idempotent |
| `flywheel_plan` | writes `.md` to `docs/plans/` | write fails → `state.planDocument` points to missing file | **Yes** — `state.planDocument` must not be set if the file was not written |
| `flywheel_approve_beads` action="start" | `br update <id> --status in_progress` for multiple beads | partial: some beads updated, some not | **Yes** — on any update failure, roll back already-updated beads to `open` |
| `flywheel_review` action="looks-good" | `br update <id> --status closed` then `saveState` | `saveState` fails after br update | **Yes** — bead is closed in CLI but not in checkpoint; desync. Log `PARTIAL_STATE`. |
| `flywheel_verify_beads` | `br update <id> --status closed` for stragglers | partial: some closed, others not | **Partial** — already tracked in `errors` map; caller can retry |

### Design: `flywheel_plan` rollback

```typescript
// plan.ts — before writing to disk
const planFilePath = join(planDir, filename);
let writeOk = false;
try {
  writeFileSync(planFilePath, args.planContent, 'utf8');
  writeOk = true;
} catch (writeErr) {
  return errorResult('planning', 'cli_failure',
    `Failed to write plan file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
    { planFilePath });
}
// Only set state.planDocument if write succeeded
state.planDocument = relativePath;
state.phase = 'awaiting_plan_approval';
saveState(state);
```

### Design: `flywheel_approve_beads` action="start" partial rollback

```typescript
const updated: string[] = [];
for (const bead of ready) {
  const r = await exec('br', ['update', bead.id, '--status', 'in_progress'], { cwd, timeout: 5000 });
  if (r.code === 0) {
    updated.push(bead.id);
  } else {
    // Rollback already-updated beads
    for (const rollbackId of updated) {
      await exec('br', ['update', rollbackId, '--status', 'open'], { cwd, timeout: 5000 });
    }
    return makeApproveError(`Failed to mark bead ${bead.id} in_progress: ${r.stderr}`, ...);
  }
}
```

---

## 5. Timeout + Signal Propagation Audit

### `exec()` call sites missing `signal`

The `ExecFn` type (exec.ts:4) accepts optional `signal?: AbortSignal`. Tool-layer calls that supply `timeout` but no `signal` cannot be cancelled by an upstream AbortController. This matters for the MCP server's request cancellation path (if the MCP client cancels a slow tool call, the subprocess lives on).

**Catalog of sites missing `signal`** (all have `timeout` but no `signal`):

| File | Line | Command | Timeout |
|---|---|---|---|
| `tools/profile.ts` | 50 | `br --version` | 5000 |
| `tools/profile.ts` | 84 | `br list --json` | 10000 |
| `tools/approve.ts` | 158 | `br list --json` | 10000 |
| `tools/approve.ts` | 448 | `br ready --json` | 10000 |
| `tools/approve.ts` | 489 | `br update <id> --status in_progress` | 5000 (loop) |
| `tools/review.ts` | 97 | `br show <id> --json` | 8000 |
| `tools/review.ts` | 164 | `br update <id> --status deferred` | 5000 |
| `tools/review.ts` | 180 | `br update <id> --status closed` | 5000 |
| `tools/review.ts` | 195 | `br list --json` (parent auto-close) | 8000 |
| `tools/review.ts` | 202 | `br update <parent> --status closed` | 5000 |
| `tools/review.ts` | 362 | `br ready --json` | 8000 |
| `tools/review.ts` | 405 | `br update <next> --status in_progress` | 5000 |
| `tools/review.ts` | 436 | `br update <id> --status in_progress` (loop) | 5000 |
| `tools/verify-beads.ts` | 65–69 | `git log --grep` | 5000 |
| `tools/verify-beads.ts` | 74–78 | `br update <id> --status closed` | 5000 |
| `tools/memory-tool.ts` | 15 | `cm --version` | 5000 |
| `tools/memory-tool.ts` | 36 | `cm add` | 10000 |
| `tools/memory-tool.ts` | 52 | `cm ls` | 10000 |
| `tools/memory-tool.ts` | 74 | `cm context --json` | 10000 |

**Total: 19 call sites missing `signal` propagation.**

Note: `deep-plan.ts:102` already passes `signal` correctly. `bead-review.ts:74` passes no signal but uses 120 s timeout — highest risk of orphan subprocess.

### Recommended fix

Thread an `AbortSignal` through `ToolContext` and pass it to all `exec()` calls:

```typescript
// types.ts
export interface ToolContext {
  exec: ExecFn;
  cwd: string;
  state: FlywheelState;
  saveState: (s: FlywheelState) => void;
  clearState: () => void;
  signal?: AbortSignal;  // ADD THIS
}
```

All 19 sites become: `{ cwd, timeout: N, signal: ctx.signal }`. The MCP server binds a per-request AbortController and passes `controller.signal`.

---

## 6. Observability Requirements

### Every error log line must contain

Every call to `log.warn` or `log.error` on an error path must include a structured object with **all** of the following fields:

```typescript
{
  code: FlywheelErrorCode,   // machine-readable; enables log queries
  tool: string,              // 'flywheel_profile' | 'flywheel_plan' | ...
  phase: FlywheelPhase,      // current state.phase at time of error
  cwd: string,               // which project was affected
  elapsed?: number,          // ms since tool invocation start (if available)
  cmd?: string,              // CLI command that failed (for CLI_* codes)
  exitCode?: number,         // br/git exit code
  detail?: string,           // human-readable cause
}
```

**Why each field is required:**
- `code`: Without it, log aggregation cannot count error rates per code
- `tool`: Narrows which tool handler is responsible
- `phase`: Required to reproduce state machine position during post-mortems
- `cwd`: Multiple simultaneous flywheel sessions in different repos share the same MCP server process; `cwd` disambiguates
- `elapsed`: Identifies slow paths and timeout thresholds that need tuning
- `cmd`: Required to reproduce CLI failures in isolation
- `exitCode`: Distinguishes permission errors (1) from crashes (139) from missing binary (127)

### Current gaps

1. `checkpoint.ts:177` — `log.warn("checkpoint write failed", { err: ... })` — missing `code`, `tool`, `phase`, `cwd`, `elapsed`
2. `beads.ts:549` — bare `catch { /* Non-fatal */ }` (orphan detection fallback) — completely silent; an operator cannot know this path was taken
3. `tools/review.ts:206` — `catch { /* parse failure ok */ }` — br list JSON parse failure in parent auto-close path is silent
4. `tools/review.ts:368` — `catch { ready = []; }` — br ready parse failure is silent; `ready` becomes empty and the tool advances to "all done" incorrectly
5. `feedback.ts:96` — `catch { return []; }` — feedback loading failure is silent; CASS memory context will be silently missing

### MCP stdio corruption check (AGENTS.md compliance)

Grep result: **zero `console.log` calls** in `mcp-server/src` (only one match in review.ts:473 is inside a string literal used as a gate check text, not an actual `console.log` call). All stderr writes use `process.stderr.write()` which is compliant with AGENTS.md.

However, `deep-plan.ts` uses `process.stderr.write(...)` at lines 36, 74, 122, 149, 152 for non-fatal warnings. These are correct (stderr does not corrupt MCP stdio) but they bypass the structured logger. They should be replaced with `log.warn(...)` calls so they appear in structured log output with the required fields above.

---

## 7. Test Coverage Plan

### Error codes not currently exercised by tests

The following fault-injection tests are missing. All use `vi.mock` + error throw pattern.

| Error Code | Fault to inject | Test file | Currently tested? |
|---|---|---|---|
| `CLI_TIMEOUT` | `exec` mock throws `Error('Timed out after 420000ms')` | `tools/plan.test.ts` | No |
| `CLI_TIMEOUT` | `exec` mock throws timeout in `runReview` at `br show` | `tools/review.test.ts` | No |
| `CHECKPOINT_CORRUPT` | Write a file with hash mismatch and confirm `.corrupt` promotion | `checkpoint.test.ts` | Yes (hash mismatch test, line 176) |
| `PARTIAL_STATE` | `saveState` returns `false` (mock writeCheckpoint to fail) | `tools/profile.test.ts` | No |
| `PARTIAL_STATE` | `writeFileSync` throws during plan.ts write | `tools/plan.test.ts` | No |
| `EMPTY_PLAN` | `planContent = ""` | `tools/plan.test.ts` | No |
| `EMPTY_PLAN` | `planContent = "   "` (whitespace only) | `tools/plan.test.ts` | No |
| `DEEP_PLAN_ALL_FAILED` | All `exec("claude")` calls return code 1 | `deep-plan.test.ts` | Partial (filterViableResults tested; tool-level not tested) |
| `CONCURRENT_WRITE` | Two concurrent `writeCheckpoint` to same cwd | `checkpoint.test.ts` | Yes (5-way concurrent write, line 335) |
| `CONCURRENT_WRITE` | Two concurrent `runReview` for same beadId | `tools/review.test.ts` | No |
| `ALREADY_CLOSED` | `br show` returns `closed`, action=`skip` | `tools/review.test.ts` | Yes (line 549) |
| `SCHEMA_DRIFT` | Checkpoint with old `orchestratorVersion` field (v2.x migration) | `checkpoint.test.ts` | Partial (version mismatch tested, but not `orchestratorVersion` field) |
| `CLI_UNAVAILABLE` | `br --version` exits 127 | `tools/profile.test.ts` | Not specifically (`hasBeads=false` is tested implicitly) |
| `AGENT_MAIL_UNREACHABLE` | `exec("curl")` throws | `agent-mail.test.ts` | Partial |
| `BEAD_CYCLE` | `bvInsights` returns cycles | `beads.test.ts` | Need to check |
| `PARSE_FAILURE` | `br list --json` returns malformed JSON in `runApprove` | `tools/approve.test.ts` | Yes (line 94-100 approx.) |

### Fault-injection template

```typescript
it('returns cli_timeout error when br show times out', async () => {
  const { ctx } = makeCtx({}, []);
  vi.spyOn(ctx, 'exec').mockRejectedValueOnce(
    new Error('Timed out after 8000ms: br show br-5 --json')
  );

  const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'br-5', action: 'looks-good' });

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: 'error',
    data: { kind: 'error', error: { code: 'cli_timeout' } },
  });
});
```

Note: Currently `exec` throws only on `child.on('error')`, not on timeout (timeout rejects the Promise from `exec.ts:26`). Tool handlers that `await exec(...)` without a `try/catch` will propagate unhandled rejections up to the MCP server's top-level handler, which returns a generic `500`-style response with no structured error code. All tool handlers need a top-level `try/catch` wrapping the `await exec()` chain.

---

## 8. Silent-Failure Guardrails

### The "No planner outputs" bug shape (commit 40be5db)

The root cause was: a function returned a value that *looked* valid but was semantically empty. Three structural patterns let it through:

**Pattern A — No pre-condition assertion on synthesized content**
```typescript
// What existed:
state.planDocument = relativePath;
saveState(state);
// What was missing:
assert(args.planContent.trim().length > 50, 'planContent too short to be a real plan');
```

**Pattern B — Sentinel strings masquerading as content**
The plan content was `"(No planner outputs provided.)"` — a non-empty string that `typeof planContent === 'string' && planContent.length > 0` passes. The contract violation was: **the precondition check was on the wrong property** (non-emptiness vs. non-sentinel-ness vs. minimum substance).

**Pattern C — No output contract on `runDeepPlanAgents`**
`runDeepPlanAgents` returned a typed `DeepPlanResult[]` but with no invariant that the array had at least one viable result. Callers assumed non-empty array = success.

### Invariant assertions to add

```typescript
// deep-plan.ts — after filterViableResults
function assertViableResults(results: DeepPlanResult[], allCount: number): void {
  if (results.length === 0) {
    throw Object.assign(
      new Error(`DEEP_PLAN_ALL_FAILED: 0/${allCount} planners produced viable output`),
      { code: 'deep_plan_all_failed', allCount }
    );
  }
}

// plan.ts — before saving planContent
function assertPlanContentSubstance(content: string): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw Object.assign(
      new Error('EMPTY_PLAN: planContent is empty or whitespace'),
      { code: 'empty_plan' }
    );
  }
  if (trimmed === '(No planner outputs provided.)') {
    throw Object.assign(
      new Error('EMPTY_PLAN: planContent is the failure sentinel, not a real plan'),
      { code: 'empty_plan' }
    );
  }
  if (trimmed.startsWith('(AGENT')) {
    throw Object.assign(
      new Error(`EMPTY_PLAN: planContent is an agent failure sentinel: ${trimmed.slice(0, 80)}`),
      { code: 'empty_plan' }
    );
  }
  if (trimmed.split('\n').length < 10) {
    throw Object.assign(
      new Error(`EMPTY_PLAN: planContent has only ${trimmed.split('\n').length} lines — too short to be a real plan`),
      { code: 'empty_plan' }
    );
  }
}
```

### Three types of silent failure and their violated contracts

**Type 1 — Empty result treated as success** (the original bug)
- Violated contract: "A plan document written to disk must contain actionable implementation content"
- Detection: `planContent.trim().length === 0` OR line count < 10

**Type 2 — Sentinel string treated as content**
- Violated contract: "planContent must not be a known failure indicator string"
- Detection: `planContent.startsWith('(AGENT')` OR exact sentinel match
- The current guard (plan.ts:111) catches the exact sentinel but not the `startsWith` variants written by `deep-plan.ts:114` and `deep-plan.ts:137`

**Type 3 — Missing checkpoint write treated as successful state transition**
- Violated contract: "A phase transition is only complete when the new state is durably persisted"
- Detection: `saveState` return value is `false`
- Currently: `saveState` return value is discarded at all 30+ call sites

---

## 9. Migration Safety

### Can this land without a v4.0 breaking change?

Yes. The proposed changes are backward-compatible in the following staged rollout:

**Stage 1 — Non-breaking: observability + guards (no API changes)**
- Add `FlywheelErrorCode` enum (additive to existing error code strings)
- Add `assertPlanContentSubstance` and `assertViableResults` guards
- Fix `saveState` to return `boolean` and log on `false` (callers can ignore the return)
- Add `code` field to all `log.warn` calls
- Replace `process.stderr.write` in deep-plan.ts with `log.warn`
- No schema changes, no tool input/output shape changes

**Stage 2 — Non-breaking: signal propagation**
- Add optional `signal?: AbortSignal` to `ToolContext`
- All tool handlers pass it through — callers that don't provide it get `undefined` (no change in behavior)
- 19 exec sites updated to pass `signal: ctx.signal ?? undefined`

**Stage 3 — Non-breaking: concurrency guards**
- Add `_beadOpInFlight` set to review.ts and approve.ts
- Returns new error code `concurrent_write` — this IS a new code but not a breaking change (additional error case)
- `orch_*` alias consumers: the aliases in `mcp__plugin_agent-flywheel_agent-flywheel__orch_*` call the same underlying handlers; all changes propagate automatically

**Stage 4 — Non-breaking: rollback wrappers**
- `flywheel_plan` write-then-set pattern (plan.ts:113-121)
- `flywheel_approve_beads` start partial rollback (approve.ts:488-490)
- These change error behavior on failure paths only, not success paths

### `orch_*` alias consumers

The `orch_*` tools (e.g., `orch_plan`, `orch_review`) are aliases registered in the MCP server manifest pointing to the same handler functions as `flywheel_*`. Any error contract change in `flywheel_*` is automatically inherited by `orch_*` aliases. No separate migration is needed.

### Schema drift note

The current `validateCheckpoint` (checkpoint.ts:103) already handles the v2.x migration via:
```typescript
const version = (e as any).flywheelVersion ?? (e as any).orchestratorVersion;
```
The proposed contract adds only warning-level output for version mismatches, not rejection. A checkpoint written by v3.2.1 will load in v3.2.2 with a warning. A checkpoint written by v4.x (if schemaVersion bumps to 2) will be quarantined (checkpoint.ts:88-90) — this is correct behavior and requires no additional migration logic.

---

## Appendix: Summary Counts

- **`exec()` call sites missing `signal`:** 19 (all in tool layer; deep-plan.ts is already correct)
- **`catch` blocks that silently swallow errors without any log:** 8
  - `beads.ts:549` — orphan detection (`// Non-fatal`)
  - `beads.ts:627` — template hygiene scan (`// Non-fatal`)
  - `tools/review.ts:206` — parent auto-close br list parse (`/* parse failure ok */`)
  - `tools/review.ts:368` — br ready parse fallback (`ready = []`)
  - `feedback.ts:96` — feedback file loading (`return []`)
  - `feedback.ts:306` — feedback write (`/* best-effort */`)
  - `tools/discover.ts:71` — artifact write (`/* best-effort */`)
  - `checkpoint.ts:290-292` — double-nested silent delete on moveToCorrupt failure (`// Give up silently`)
- **`console.log` occurrences in mcp-server/src:** 0 (compliant with AGENTS.md)
- **Proposed new error codes:** 16 (see enum in Section 1)
- **Test gaps (missing error-path coverage):** 11 specific fault-injection tests
