# agent-flywheel v3.4.0 — Correctness-Focused Implementation Plan

**Author:** FuchsiaPuma (correctness perspective planner)
**Date:** 2026-04-21
**Coordinator:** LilacRidge
**Target release:** v3.4.0 — observability & reliability bundle
**Plan posture:** soundness > speed. Contracts first, behavior second. A wrong
bead graph costs 5× a wrong plan; wrong code costs 25×. We front-load invariants
and types so impl waves cannot silently corrupt session state.

---

## 1. Goal statement

Ship five accretive subsystems behind one release that closes the loop on
v3.3.0's structured-error investment and hardens the onboard / wrap-up edges:

1. `flywheel_doctor` — one-shot dependency & liveness diagnostic.
2. Shared-write hotspot report — wave-level file-contention matrix feeding
   coordinator-serial vs swarm recommendation at Step 6 launch gate.
3. Post-mortem CASS auto-draft — wrap-up-time synthesized session-learnings
   markdown, reviewed by the user before commit.
4. Bead-template library — populate the `bead-templates.ts` stub with seven
   reusable templates and wire them through `deep-plan` synthesis → `br create`.
5. Error-code telemetry — session-end aggregator over `FlywheelErrorCode`
   occurrences; persisted to CASS; surfaced in Step 10 narrative.

Each subsystem must be independently revertable (atomic beads) and must not
weaken any v3.3.0 contract (no silent catches, no error-code regressions,
no un-Zod'd tool boundaries).

---

## 2. Scope / non-goals

### In scope

- New MCP tool: `flywheel_doctor` with Zod-schema'd args/output.
- Extensions to `plan-simulation.ts` for hotspot matrix (pure function layer,
  no I/O changes).
- New public functions in `episodic-memory.ts` for post-mortem draft generation.
- Populate `bead-templates.ts` with seven templates + wire expansion path.
- New `telemetry.ts` module + hook points in `errors.ts` / `exec.ts`.
- Five new `FlywheelErrorCode` entries (§3.1).
- New slash command `/flywheel-doctor` + SKILL.md sub-file.
- Test coverage: unit + smoke + regression for each subsystem.
- `dist/` rebuild, SKILL.md lint baseline refresh if manifest changes.

### Out of scope (explicit non-goals)

- Changing the phase-graph transition rules (Steps 0 → 10) beyond two additive
  hooks (doctor at Step 0e, telemetry + post-mortem at Step 10).
- Replacing `cm` (CASS) with any alternative memory backend.
- Cross-session telemetry aggregation beyond the 10-session rollup already
  called out in subsystem 5. Time-series DBs are a v3.5.x concern.
- Any change to the `ntm` swarm launcher, Agent Mail protocol, or `br` CLI.
- Healing stale checkpoints. Post-mortem must *refuse* to run on a corrupt
  checkpoint rather than paper over it.
- Fixing the unrelated `flywheel_review` already-closed-bead parse bug.
  Flagged in §11 as a candidate fix-up bead if capacity permits; otherwise
  deferred to v3.4.1.

---

## 3. Global cross-cutting contracts

### 3.1 New `FlywheelErrorCode` entries

These are appended to the `FLYWHEEL_ERROR_CODES` `as const` tuple in
`mcp-server/src/errors.ts`. Order matters for stable Zod enum indexing; new
codes append to the end. Each entry must also land an entry in
`DEFAULT_RETRYABLE`. See §4.*.* per-subsystem mapping.

| Code                          | Retryable | Used by          |
|-------------------------------|-----------|------------------|
| `doctor_check_failed`         | false     | subsystem 1      |
| `hotspot_parse_failure`       | false     | subsystem 2      |
| `postmortem_empty_session`    | false     | subsystem 3      |
| `postmortem_checkpoint_stale` | false     | subsystem 3      |
| `template_not_found`          | false     | subsystem 4      |
| `template_placeholder_missing`| false     | subsystem 4      |
| `telemetry_store_failed`      | true      | subsystem 5      |

Rationale for non-retryable defaults: most of these indicate a missing
input (no checkpoint, wrong template id, missing placeholder) where retrying
the same call cannot succeed. `telemetry_store_failed` is retryable because
it wraps a `cm add` which may recover on transient filesystem/lock errors.

SKILL.md branches in `skills/start/SKILL.md` and sub-files MUST be updated
to switch on `result.data?.error?.code` for every new code. The SKILL.md
linter rule `errorCodeReferences` will fail CI otherwise. Baseline bump
lands with bead F1 (§10), not with per-subsystem beads.

### 3.2 Shared type surfaces

All new boundary types live in `mcp-server/src/types.ts`. Each has a Zod
schema in the owning module and is re-exported from `types.ts` for
consumer typings. Pattern matches v3.3.0 `FlywheelToolErrorSchema`.

```ts
// Subsystem 1 — Doctor
export type DoctorCheckStatus = 'green' | 'yellow' | 'red';

export interface DoctorCheck {
  name: string;              // e.g. 'br-cli', 'agent-mail', 'cm'
  status: DoctorCheckStatus;
  latencyMs?: number;
  detail?: string;           // human-readable
  remediation?: string;      // actionable hint
  code?: FlywheelErrorCode;  // if status !== 'green'
}

export interface DoctorReport {
  version: string;           // doctor report schema version, e.g. "1"
  timestamp: string;         // ISO 8601
  overall: DoctorCheckStatus;// max(red, yellow, green) aggregation
  checks: DoctorCheck[];
  elapsedMs: number;
}

// Subsystem 2 — Hotspot matrix
export interface HotspotEntry {
  file: string;
  beadIds: string[];         // beads that touch this file in this wave
  writeCount: number;        // >= beadIds.length; one bead can mention twice
  severity: 'low' | 'medium' | 'high';
}

export interface HotspotMatrix {
  waveIndex: number;         // 0-based
  beadCount: number;
  entries: HotspotEntry[];   // sorted descending by writeCount
  maxContention: number;     // max writeCount across entries; 0 if empty
  recommendedMode: 'swarm' | 'coordinator-serial';
  rationale: string;         // one-line explanation of recommendation
}

// Subsystem 3 — Post-mortem
export interface PostmortemDraft {
  sessionId: string;
  generatedAt: string;       // ISO 8601
  summary: string;           // 1–3 sentence narrative
  beadsCompleted: string[];  // br ids
  commitsLanded: string[];   // short shas
  errorCodesEncountered: Array<{ code: FlywheelErrorCode; count: number }>;
  agentMailHighlights: string[]; // subject lines from inbox
  draftMarkdown: string;     // exactly what the user will review
  warnings: string[];        // non-fatal issues discovered while drafting
}

// Subsystem 4 — Bead templates (extend existing stub types)
export interface BeadTemplatePlaceholder {
  name: string;              // must match /^[a-zA-Z][a-zA-Z0-9_]*$/
  description: string;
  example: string;
  required: boolean;
  default?: string;          // used iff !required
}

export interface BeadTemplate {
  id: string;                // kebab-case, matches /^[a-z][a-z0-9-]*$/
  summary: string;
  descriptionTemplate: string;
  placeholders: BeadTemplatePlaceholder[];
  acceptanceCriteria: string[];
  filePatterns: string[];
  dependencyHints: string;
  testStrategy: string;      // NEW in v3.4.0; required, non-empty
  examples: Array<{ description: string }>;
}

export interface ExpandTemplateResult {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  warnings: string[];        // e.g. placeholder defaults applied
}

// Subsystem 5 — Telemetry
export interface ErrorCodeCounter {
  code: FlywheelErrorCode;
  count: number;
  lastContext?: {
    tool?: FlywheelToolName;
    phase?: FlywheelPhase;
    beadId?: string;
    timestamp: string;
  };
}

export interface ErrorCodeTelemetry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  counters: ErrorCodeCounter[];     // sorted desc by count
  topN: ErrorCodeCounter[];         // first 5 of counters
  totalErrors: number;
}
```

### 3.3 Zod schemas at tool boundaries

Every new interface above has a parallel Zod schema in its owning module:

- `DoctorReportSchema` in `tools/doctor.ts`
- `HotspotMatrixSchema` in `plan-simulation.ts`
- `PostmortemDraftSchema` in `episodic-memory.ts`
- `BeadTemplateSchema`, `ExpandTemplateResultSchema` in `bead-templates.ts`
- `ErrorCodeTelemetrySchema` in `telemetry.ts`

**Invariant G-1 (contract validation):** Every tool output that crosses the
MCP boundary must `schema.parse()` before being returned. Violation throws
`internal_error` — we surface the schema mismatch instead of returning
malformed data. Matches v3.3.0's `FlywheelToolErrorSchema` usage.

**Invariant G-2 (no silent catches):** Any new `catch {}` without at least
`log.warn` + `classifyExecError` + a structured return is a review-blocking
defect. Keep the v3.3.0 stance.

**Invariant G-3 (one error code per failure path):** Each failure branch
uses exactly one code from the new tuple. No synthetic union codes; no
fallthrough to `internal_error` when a specific code exists.

### 3.4 Checkpoint schema changes

`mcp-server/src/checkpoint.ts` gains two OPTIONAL fields on `CheckpointData`:

```ts
errorCodeCounters?: Record<FlywheelErrorCode, number>;
telemetrySessionStartIso?: string;
```

Both are `?`-optional for backward compatibility with on-disk checkpoints
written by v3.3.0. Reader must treat `undefined` as "telemetry not yet
started" and initialize lazily.

**Invariant G-4 (atomic checkpoint writes):** Telemetry MUST persist via
`saveState()` from `state.ts` (which already uses `checkpoint.ts`'s atomic
tmp-file + rename). No separate sidecar file. This means every increment
goes through the same per-bead mutex that v3.3.0 added.

**Invariant G-5 (monotonic counters):** `errorCodeCounters[code]` is
monotonically non-decreasing within a single session. Restarts read the
existing value from checkpoint and continue counting. A new session
(detected by checkpoint absence or `sessionId` change) resets to zero.

---

## 4. Per-subsystem architecture

### 4.1 Subsystem 1 — `flywheel_doctor`

**Location:**
- `mcp-server/src/tools/doctor.ts` (runner + `DoctorReportSchema`)
- `mcp-server/src/server.ts` (tool registration)
- `skills/flywheel-doctor/SKILL.md` (new sub-skill)
- `commands/flywheel-doctor.md` (new slash command)

**What it checks (canonical list, in this order):**

1. `br --version` — beads CLI present, version ≥ known-good.
2. `bv --version` — beads viewer.
3. `ntm --version` — tmux multiplexer.
4. `cm --version` — CASS memory.
5. `node --version` — runtime ≥ 20.
6. `git --version` + `git rev-parse --git-dir`.
7. Agent Mail liveness — `health_check` MCP call with 5s timeout.
8. `dist/` drift — compare `dist/server.js` mtime vs `src/**/*.ts`
   newest mtime; yellow if src is newer than dist.
9. Orphaned worktrees — `git worktree list --porcelain` parse, flag any
   `.claude/worktrees/*` entries older than 24h with no active session.
10. `.pi-flywheel/checkpoint.json` sanity — exists? parses? schema valid?
11. MCP connectivity — check all `mcp__plugin_agent-flywheel_*` tool
    availability via introspection (tool listing is read-only).

**Invariants:**

- **D-1 (read-only):** `flywheel_doctor` must NEVER mutate session state.
  No `saveState` call. No checkpoint writes. No `cm add`. Explicit guard:
  `ctx.state` is read but never passed to a mutator. Violation caught by
  unit test `doctor.test.ts` that spies on `saveState` and asserts zero
  calls.
- **D-2 (timeout-bounded):** Each individual check runs under a 5s timeout
  (10s for MCP probes). Whole report completes under 30s wall-clock even
  on slowest check path. Implemented via `Promise.allSettled` — checks
  run in parallel where safe, serial only where a check depends on a
  prior check's output (none currently).
- **D-3 (idempotent):** Running doctor twice back-to-back must produce
  structurally identical reports (timestamps and latencies aside). No
  hidden state leaks between calls.
- **D-4 (offline-safe):** Doctor must not require network beyond Agent
  Mail health_check. No `npm view`, no GitHub calls.
- **D-5 (aggregation):** `overall = red` if any check is red; else
  `yellow` if any yellow; else `green`. Pure function, unit-tested.
- **D-6 (remediation completeness):** Every non-green check MUST populate
  `remediation` with a concrete next step. Test: `doctor.test.ts` asserts
  `checks.filter(c => c.status !== 'green' && !c.remediation).length === 0`.

**Error codes used:**

- `cli_not_available` — existing, for missing `br`/`bv`/`ntm`/`cm`/`node`.
- `agent_mail_unreachable` — existing, for Agent Mail probe failure.
- `doctor_check_failed` — NEW, wrapper for unexpected check internal error.
- `parse_failure` — existing, for malformed `checkpoint.json`.

**State impacts:** none. Phase unchanged. Doctor is a peripheral tool.

**Edge cases (must not force a rewrite if discovered late):**

- E-1.1: Doctor runs while another flywheel session holds the per-bead
  mutex. Solution: doctor does not acquire the mutex; it reads `state`
  via a non-blocking load. Document the brief race: the report may show
  "in progress" beads that finished milliseconds ago. Acceptable, since
  D-1 guarantees no writes.
- E-1.2: `dist/` does not exist at all (fresh clone). Classify as yellow
  with remediation "run `cd mcp-server && npm run build`".
- E-1.3: `.pi-flywheel/checkpoint.json` exists but is empty (0 bytes).
  Classify as yellow with remediation "remove checkpoint to start fresh".
- E-1.4: `git worktree list --porcelain` output contains a worktree at a
  path that no longer exists on disk. Flag as yellow + remediation "run
  `/flywheel-cleanup`".
- E-1.5: Agent Mail MCP server returns `{format: 'toon'}` wrapper —
  doctor must tolerate both JSON and TOON response shapes. Wrap probe
  in a try/catch that treats any valid response as green, regardless of
  payload format.
- E-1.6: `ntm` panes referenced by integer, not name. Doctor only probes
  the binary; it does NOT try to `ntm send --pane=X`. Avoids CASS note
  about `--gmi` pane failure on systems without Gemini CLI.
- E-1.7: Concurrent doctor runs. Two terminals each call `/flywheel-doctor`
  at the same time. Must not corrupt anything (D-1). Integration test
  runs two parallel `runDoctor()` calls and asserts both produce valid
  reports.

**Testing:**

- Unit: `doctor.test.ts` — mock each check function, verify aggregation,
  verify D-1 (no saveState), D-3 (idempotency), D-5 (aggregation logic),
  D-6 (remediation presence).
- Smoke: `doctor.smoke.test.ts` — runs real doctor against current repo.
  Expect green on `br`, `node`, `git`. Tolerate yellow on `cm`/`ntm`/`bv`
  depending on CI env (gate behind `process.env.CI`).
- Regression: `doctor.regression.test.ts` — for each of E-1.1 … E-1.7,
  mock the trigger condition and assert the expected status/remediation.

### 4.2 Subsystem 2 — Shared-write hotspot matrix

**Location:** `mcp-server/src/plan-simulation.ts` (pure extension).

**Public API additions:**

```ts
export function computeHotspotMatrix(
  beads: SimulatedBead[],
  waveIndex: number,
): HotspotMatrix;

export function recommendExecutionMode(
  matrix: HotspotMatrix,
): 'swarm' | 'coordinator-serial';
```

**Algorithm:**

1. For each bead in the wave, extract file paths via the existing
   `extractArtifacts(b)` helper. Already present in `beads.ts`.
2. Build a `Map<string, string[]>` of file → bead-ids.
3. Retain only files with ≥ 2 bead-ids (multi-bead contention).
4. Compute `writeCount = beadIds.length` per entry. (v3.4.0 simplifies;
   v3.5.x may weight mentions per-body.)
5. Classify severity: `low` = 2, `medium` = 3, `high` ≥ 4.
6. `maxContention = max(writeCount)` across entries; 0 if empty.
7. Recommendation rule:
   - `recommendedMode = 'coordinator-serial'` iff `maxContention >= 2`.
   - Else `'swarm'`.

**Invariants:**

- **H-1 (mode correctness):** Matrix NEVER recommends `'swarm'` when
  `maxContention >= 2`. Unit-tested exhaustively. This is the core
  correctness guarantee — anything weaker regresses on the lessons from
  topstepx-gateway and deep-plan `plan.ts/approve.ts` (CASS memory).
- **H-2 (determinism):** Output is deterministic given inputs. Entries
  sorted descending by `writeCount`, ties broken by file path asc.
- **H-3 (empty-plan safety):** `computeHotspotMatrix([], 0)` returns
  `{ waveIndex: 0, beadCount: 0, entries: [], maxContention: 0,
  recommendedMode: 'swarm', rationale: 'no beads in wave' }`. Tested.
- **H-4 (single-bead wave):** A wave with one bead trivially has no
  contention; `recommendedMode = 'swarm'` by H-1 (but will also be
  trivially serial at runtime). Coordinator gate logic treats single-bead
  waves as "either mode OK"; the matrix only speaks to contention risk.
- **H-5 (rationale completeness):** `rationale` always non-empty; for
  `coordinator-serial` it names the top-contended file; for `swarm` it
  says "no shared-write contention detected".
- **H-6 (approve-output integration):** `flywheel_approve_beads` payload
  schema gains an optional `hotspotMatrices: HotspotMatrix[]` field,
  one entry per wave in the bead graph. Must validate via Zod before
  return.

**Error codes used:**

- `hotspot_parse_failure` — NEW, if a bead body cannot be parsed for
  file paths. Propagates from `extractArtifacts` failures. In practice
  this should never fire because `extractArtifacts` is forgiving; the
  code exists so we never silently swallow a parse anomaly.

**State impacts:**

- `flywheel_approve_beads` output payload gains `hotspotMatrices`.
  `skills/start/_beads.md` Step 6 launch gate prompt must branch on the
  matrix to suggest swarm vs coordinator-serial to the user.

**Edge cases:**

- E-2.1: Plan with zero beads. Covered by H-3.
- E-2.2: Bead body mentions a file via relative path (`./src/foo.ts`) vs
  absolute (`/Users/.../src/foo.ts`) vs module-style (`src/foo.ts`).
  Normalizer in step 1 collapses all three to repo-relative. Tested.
- E-2.3: Bead body mentions a file inside a fenced code block AND in
  prose. Count as one mention per bead (dedup per-bead before counting).
- E-2.4: File path contains a `#` anchor or `:` line number
  (`src/foo.ts:42`). Strip anchors before aggregation.
- E-2.5: Cross-wave contention (bead in wave 1 and bead in wave 2 both
  touch `foo.ts`). Matrix is per-wave; cross-wave contention is a
  non-issue for execution mode selection since waves run sequentially.
  Out of scope; documented.
- E-2.6: Synthetic files like `(new file)` placeholders. Filter out any
  path that doesn't match `/\.\w+$/`. Tested.

**Testing:**

- Unit: `plan-simulation.hotspot.test.ts` — 12 cases covering H-1…H-6
  and E-2.1…E-2.6. Include a fuzz-style test: generate random bead
  sets, assert H-1 always holds.
- Smoke: `plan-simulation.smoke.test.ts` — feed a realistic 8-bead
  plan (e.g. a prior v3.3.0 wave), expect `coordinator-serial` if
  `errors.ts` appears in ≥ 2 beads.
- Regression: `plan-simulation.regression.test.ts` — reproduce the
  topstepx-gateway `mod.rs` scenario: three beads all touch
  `mod.rs`. Matrix MUST recommend coordinator-serial with
  `maxContention = 3`. This is the bug CASS already warned us about.

### 4.3 Subsystem 3 — Post-mortem CASS auto-draft

**Location:** `mcp-server/src/episodic-memory.ts` (new functions at end).

**Public API additions:**

```ts
export function generatePostmortemDraft(
  opts: {
    exec: ExecFn;
    cwd: string;
    state: CheckpointData;
    agentMailInbox: Array<{ subject: string; from: string; ts: string }>;
    errorCodeTelemetry: ErrorCodeTelemetry;
  }
): Promise<PostmortemDraft>;

export function formatPostmortemMarkdown(draft: PostmortemDraft): string;
```

**Inputs (mechanically gathered, never prompted):**

1. `state: CheckpointData` — from in-memory `ctx.state`. Contains phase,
   bead list, session start.
2. `git log <sessionStartSha>..HEAD --oneline` — synthetic sessionStart
   persisted in checkpoint at Step 0e; fallback to 24h window if missing.
3. `fetch_inbox` from Agent Mail MCP — latest 20 messages.
4. `errorCodeTelemetry` — from subsystem 5, inline.

**Output shape:** `PostmortemDraft` (see §3.2). `draftMarkdown` follows the
same five-block pattern bead templates use, so it round-trips through
`cm add` cleanly:

```
# Session Learnings — <sessionId>

## What we shipped
- {commit summary per landed commit}

## What went wrong
- {top error codes, with code + count + last context}

## Coordinator decisions
- {Agent Mail subjects that match /\[deep-plan\]|swarm|review/i}

## Tags
session-learnings, <projectSlug>, v3.4.0
```

**Invariants:**

- **P-1 (never auto-commits):** Post-mortem produces a DRAFT. The user
  must review and invoke `flywheel_memory` with `operation=store` to
  persist. The tool MUST NOT call `cm add` internally. This is the
  trust boundary.
- **P-2 (refuses stale checkpoint):** If `checkpoint.json` is older than
  the most recent commit on HEAD, OR if `state.sessionId` is absent, OR
  if `state.phase === 'init'` with no beads, return
  `postmortem_checkpoint_stale` or `postmortem_empty_session` — do not
  fabricate a draft from thin air.
- **P-3 (no PII leak):** Draft MUST not include raw environment variables
  or file paths outside the repo. Implemented via a
  `sanitizeDraftMarkdown` step that filters `/Users/.+?/…` paths down to
  repo-relative form.
- **P-4 (deterministic ordering):** Commits listed in chronological order
  (oldest → newest); error codes listed descending by count; inbox
  highlights sorted by timestamp ascending. Tested.
- **P-5 (survives MCP unavailability):** If Agent Mail MCP is unreachable
  during draft generation, the `agentMailHighlights` array is empty and
  a warning is pushed to `warnings` — the draft still renders.
- **P-6 (bounded length):** `draftMarkdown` truncated at 8 KB to fit in
  CASS comfortably. Truncation marked with `... <truncated>`.

**Error codes used:**

- `postmortem_empty_session` — NEW.
- `postmortem_checkpoint_stale` — NEW.
- `agent_mail_unreachable` — existing, for inbox fetch failures.
- `internal_error` — for `git log` parse failures, with cause.

**State impacts:** checkpoint gains no new fields for post-mortem itself
(the draft is ephemeral). Step 10 in `skills/start/_wrapup.md` must
call `generatePostmortemDraft` and render to user, then await user
decision before invoking `flywheel_memory`.

**Edge cases:**

- E-3.1: Session crashed mid-wave; checkpoint has in-progress beads but
  no commits. P-2 fires → `postmortem_empty_session`.
- E-3.2: Git HEAD is detached. `git log` still works from HEAD; no special
  handling.
- E-3.3: Agent Mail inbox has 0 messages. `agentMailHighlights = []`,
  section omitted from markdown.
- E-3.4: Telemetry `totalErrors === 0`. "What went wrong" section
  replaced with "Clean session — no structured errors recorded."
- E-3.5: Checkpoint `sessionStartIso` is newer than HEAD commit time
  (clock skew, rebase). Log warning, use the git log range anyway.
- E-3.6: `cm --version` fails when user invokes memory store downstream.
  That is subsystem 5/memory-tool's concern, not subsystem 3; doctor
  (subsystem 1) also catches this.
- E-3.7: User rejects the draft. Step 10 gracefully exits without
  committing. No state mutation on rejection.

**Testing:**

- Unit: `episodic-memory.postmortem.test.ts` — 10 cases covering P-1…P-6
  and E-3.1…E-3.7. Mock `exec` (git log), mock Agent Mail inbox.
- Smoke: run against the current repo's checkpoint; assert draft is
  non-empty, < 8 KB, schema-valid.
- Regression: E-3.1 scenario. Historically a crashed session would leave
  us with no wrap-up narrative; this asserts we refuse gracefully.

### 4.4 Subsystem 4 — Bead-template library

**Location:**
- `mcp-server/src/bead-templates.ts` — populate seven templates + expansion.
- `mcp-server/src/deep-plan.ts` — add template-aware synthesis prompt.
- `mcp-server/src/tools/approve.ts` — invoke expansion at `br create` time.
- `mcp-server/src/types.ts` — export `BeadTemplate`, `ExpandTemplateResult`.

**The seven templates:**

| id                               | when to use                                      |
|----------------------------------|--------------------------------------------------|
| `test-coverage`                  | add tests for existing code                      |
| `doc-update`                     | update README / skill / docs                     |
| `refactor-carve`                 | extract helper, split file, no behavior change   |
| `foundation-with-fresh-eyes-gate`| shared contract bead with mandatory review gate  |
| `inter-wave-fixup`               | carry-over cleanup between waves                 |
| `new-mcp-tool`                   | scaffold a new `mcp-server/src/tools/X.ts`       |
| `new-skill`                      | scaffold a new `skills/<name>/SKILL.md`          |

**Public API (matches existing stub shape):**

```ts
export function listBeadTemplates(): BeadTemplate[];
export function getTemplateById(id: string): BeadTemplate | undefined;
export function formatTemplatesForPrompt(): string;
export function expandTemplate(
  id: string,
  placeholders: Record<string, string>,
): ExpandTemplateResult;
```

**Invariants:**

- **T-1 (schema integrity):** All templates pass `BeadTemplateSchema`
  parse at module load. Integrity warnings already surface via
  `TEMPLATE_INTEGRITY_WARNINGS` — v3.4.0 elevates any non-empty array
  to a hard failure in `npm test` via `beforeAll` assertion.
- **T-2 (placeholder safety):** `expandTemplate` rejects values matching
  `/[\r\0]/` or longer than 2000 chars (existing stub already has these
  constants). Missing required placeholder with no default →
  `template_placeholder_missing`.
- **T-3 (unknown id):** `expandTemplate('unknown')` →
  `template_not_found`. Never returns a partial template.
- **T-4 (idempotent expansion):** Given the same id + same placeholder
  map, expansion output is byte-identical. Important because
  `br create --description "..."` is not idempotent downstream, but we
  want deterministic upstream output.
- **T-5 (five-block pattern):** Every template's `descriptionTemplate`
  preserves the five-block layout (lead sentence / Why / Acceptance /
  Files / blank). The linter already validates this for existing
  templates; new ones must conform. Tested via regex on `### Files:`
  and `- [ ]` counts.
- **T-6 (testStrategy non-empty):** New required field on every template.
  If empty, integrity check fails at module load.
- **T-7 (deep-plan emits template reference):** Synthesizer prompt in
  `deep-plan.ts` is extended with the `formatTemplatesForPrompt()`
  output so the final-plan JSON may include `template: "<id>"` per bead.
  `approve.ts` detects this field and calls `expandTemplate` before
  invoking `br create`. If the plan references an unknown template,
  coordinator aborts with `template_not_found` BEFORE any bead is
  created (atomic). Matches v3.3.0's fail-closed stance.

**Error codes used:**

- `template_not_found` — NEW.
- `template_placeholder_missing` — NEW.
- `parse_failure` — existing, for malformed plan JSON from deep-plan.

**State impacts:** none in checkpoint. deep-plan's plan JSON gains an
optional `template?: string` and `templatePlaceholders?: Record<string,
string>` per bead, but the plan on disk is transient — it gets
translated to beads and then the plan file is kept as an artifact but
not re-read.

**Edge cases:**

- E-4.1: Deep-plan synthesizer references a template that exists in
  main but not in the user's branch. Impossible in practice (templates
  are compiled in), but test covers the case by mocking a missing id.
- E-4.2: Placeholder value is an empty string. Treat as "missing" per
  T-2 (hard reject) — empty strings are rarely intentional.
- E-4.3: Placeholder value is multiline markdown. Accept as long as it
  doesn't contain `\r` or `\0`. Bead descriptions are markdown anyway.
- E-4.4: Template has `{{nested {{placeholder}}}}`. Regex in stub
  (`/{{\s*([a-zA-Z0-9_]+)\s*}}/g`) does not support nesting. Document
  as unsupported; expansion leaves outer braces alone.
- E-4.5: `foundation-with-fresh-eyes-gate` template used twice in one
  plan. Not a technical problem — each bead gets its own id — but
  coordinator SHOULD warn, since one foundation bead per wave is the
  established pattern from CASS.
- E-4.6: Placeholder map has extra keys not referenced by the template.
  Warn (surfaced in `ExpandTemplateResult.warnings`) but do not reject.

**Testing:**

- Unit: `bead-templates.test.ts` — 20+ cases covering T-1…T-7, each
  template's integrity, each edge case, roundtrip `list → get →
  expand`.
- Integration: `deep-plan-template.test.ts` — mock synthesizer output
  referencing `foundation-with-fresh-eyes-gate`, verify `approve.ts`
  call chain produces expected `br create` args.
- Regression: E-4.1 — mock missing template id; assert entire
  `br create` wave is skipped (no partial creation).

### 4.5 Subsystem 5 — Error-code telemetry

**Location:** `mcp-server/src/telemetry.ts` (new module).

**Public API:**

```ts
export function initTelemetry(state: CheckpointData): void;
export function recordErrorCode(
  state: CheckpointData,
  code: FlywheelErrorCode,
  context?: { tool?: FlywheelToolName; phase?: FlywheelPhase; beadId?: string }
): void;
export function snapshotTelemetry(
  state: CheckpointData
): ErrorCodeTelemetry;
export function aggregateRecentSessions(
  exec: ExecFn,
  cwd: string,
  limit: number, // e.g. 10
): Promise<ErrorCodeCounter[]>;
```

**Hook points:**

- `errors.ts` — `makeFlywheelErrorResult()` calls `recordErrorCode`
  after constructing the result. ONE call site, ensures every structured
  error is counted regardless of which tool raised it.
- `server.ts` — top-level tool handler wraps runner in try/catch; on
  `FlywheelError` throw, also call `recordErrorCode` before returning
  the structured payload.
- `Step 10 (/flywheel-stop and wrap-up)` — call `snapshotTelemetry` +
  `aggregateRecentSessions`, pass to post-mortem (subsystem 3) and
  render "top 5 error codes across last 10 sessions" in the narrative.

**Persistence:** Each `recordErrorCode` call mutates `state.errorCode
Counters[code]++` and calls `saveState(state)` which atomically persists
via `checkpoint.ts`.

**Invariants:**

- **Tel-1 (atomic):** Counters persist only via `saveState`. Never a
  sidecar file. See G-4.
- **Tel-2 (monotonic within session):** See G-5. Tested by repeatedly
  recording the same code and asserting the count strictly increases.
- **Tel-3 (no counter for "success"):** Only `FlywheelErrorCode`
  occurrences count. Successful tool returns never increment anything.
- **Tel-4 (unknown code rejection):** `recordErrorCode(state,
  'not_a_real_code' as any)` must fail fast at Zod validation. No
  silent ignore.
- **Tel-5 (snapshot purity):** `snapshotTelemetry` is a pure read. It
  MUST NOT mutate state or write checkpoint. Tested.
- **Tel-6 (cross-session aggregation):** `aggregateRecentSessions` queries
  CASS via `cm search "tag:error-telemetry"` for the last `limit`
  entries and parses them into counters. Tolerates missing/stale
  entries. Returns empty array if `cm` unavailable — never throws.
- **Tel-7 (crashed session resilience):** If the process crashes
  mid-write, the atomic rename in `checkpoint.ts` ensures either the
  old counter state or the new state persists — never a half-written
  JSON. Leverages existing infrastructure.
- **Tel-8 (sessionId stable):** Telemetry sessionId is the same as
  `state.sessionId` (whatever v3.3.0 / prior uses). If absent,
  `initTelemetry` assigns `randomUUID()` and persists it.

**Error codes used:**

- `telemetry_store_failed` — NEW, retryable, for CASS persistence
  failure during end-of-session rollup (NOT for in-session increments;
  those go through saveState which uses `internal_error`).

**State impacts:**

- `CheckpointData.errorCodeCounters?: Record<FlywheelErrorCode, number>`.
- `CheckpointData.telemetrySessionStartIso?: string`.
- `skills/start/_wrapup.md` Step 10 — new block: "Error-code summary
  (this session)" + "Across last 10 sessions". Linter manifest updated.

**Edge cases:**

- E-5.1: Very large counter (session runs for hours, records 10k
  increments). Numbers fit in JS `number` safely up to 2^53; no risk.
- E-5.2: Counter race — tool A and tool B both hit an error
  simultaneously on different beads. Already solved: per-bead mutex
  from v3.3.0 serializes their respective saveState calls; telemetry
  piggybacks. Non-bead-scoped tools (doctor, plan, etc.) use a
  single process-wide mutex section around `recordErrorCode`.
  Implementation: lazy `Mutex.get('__telemetry__')`.
- E-5.3: Checkpoint was written by v3.3.0 (no `errorCodeCounters`
  field). `initTelemetry` detects undefined, initializes to `{}`,
  saves. Non-breaking.
- E-5.4: `cm search` returns results that don't parse as
  `ErrorCodeTelemetry`. Skip that result, log warning, continue
  aggregation. Never crashes the wrap-up.
- E-5.5: Clock skew between sessions. `startedAt`/`endedAt` use local
  clock; aggregation sorts by `endedAt`. Acceptable variance for a
  diagnostic feature.
- E-5.6: User invokes `/flywheel-stop` during a swarm. Each swarm agent
  has its own CWD and own checkpoint (worktree isolation). Wrap-up
  aggregates the coordinator's checkpoint only; swarm agent
  checkpoints merge via the existing "tender" mechanism pre-wrap-up.
  Document this; do not try to boil the ocean in v3.4.0.
- E-5.7: `cm add` fails during end-of-session persist. Retry once
  (telemetry_store_failed is retryable); on second failure, surface to
  user and skip — do NOT block `/flywheel-stop`.

**Testing:**

- Unit: `telemetry.test.ts` — 15 cases covering Tel-1…Tel-8 and
  E-5.1…E-5.7. Use `vi.useFakeTimers()` for timestamps.
- Smoke: wrap an entire fake session (init → record 5 codes →
  snapshot → persist → reload from checkpoint → snapshot again),
  assert counters survive a save/load round-trip.
- Regression: simulated crash mid-increment. Write a partial JSON via
  test hook, reload, assert last-good state is read. This is the
  atomic-write invariant empirically validated.

---

## 5. State-machine / phase-graph impact

Summary of changes to `skills/start/SKILL.md` and sub-files:

| Phase / Step          | Change                                              |
|-----------------------|-----------------------------------------------------|
| Step 0e (onboard)     | Call `flywheel_doctor` before prompting user.       |
| Step 6 (launch gate)  | Read `hotspotMatrices` from approve payload; branch |
|                       | on recommendedMode to suggest swarm vs coord-serial.|
| Foundation-bead gate  | Any bead with `template: foundation-with-fresh-eyes-gate` |
|                       | forces a fresh-eyes review checkpoint after impl.   |
| Step 10 (wrap-up)     | Call telemetry snapshot + aggregate-recent; then    |
|                       | generate post-mortem draft; render; await user      |
|                       | decision to commit via `flywheel_memory`.           |

No new phases. No phase removed. The `CheckpointData.phase` enum does
NOT gain new values.

---

## 6. Foundation-first bead ordering (critical)

Every subsystem is split into at least two beads: a foundation bead
(types + Zod schemas + error codes, zero behavior change) and one or
more impl beads. This matches the lesson from v3.3.0 (and the 19-site
regression pre-Wave 2).

### 6.1 Why foundation beads first

If impl beads merge before contracts stabilize, each impl site hardcodes
an ad-hoc shape, and a single contract revision in a later wave causes
N-site regressions. By landing all types + error codes + Zod schemas
first, impl beads in parallel wave compile against the same surface.

### 6.2 Fresh-eyes review gate

After the foundation bead (F1) lands and before Wave 2 launches, run a
parallel review dispatch (≈ 5 reviewers, 3 minutes). Each reviewer reads
F1 diff cold and reports concerns. The coordinator gates Wave 2 on
consensus. This is the procedural mechanism from CASS that caught the
19-call-site bug in v3.3.0.

---

## 7. Bead sketch (proposed dependency graph)

**Legend:** `[F]` = foundation, `[I]` = impl, `[D]` = docs/review/polish.

### Wave 0 — Foundation (serial, single bead, one reviewer dispatch)

1. **[F] F1 — shared contracts** (`types.ts`, `errors.ts`, checkpoint
   schema bump) — adds 7 new `FlywheelErrorCode` entries, 5 new type
   surfaces, 2 new optional `CheckpointData` fields. Pure additive; no
   runtime behavior change. Baseline lint bump.
   - Depends on: none
   - Files: `mcp-server/src/errors.ts`,
     `mcp-server/src/types.ts`,
     `mcp-server/src/checkpoint.ts`,
     `mcp-server/src/__tests__/errors.schema.test.ts` (new),
     `mcp-server/.lintskill-baseline.json`
   - Gate: **fresh-eyes review (5 reviewers, parallel)** before Wave 1.

### Wave 1 — Hotspot + templates (parallel, low shared-write)

2. **[I] I2 — hotspot matrix**
   (`plan-simulation.ts`, `__tests__/plan-simulation.hotspot.test.ts`)
   - Depends on: F1 (uses `HotspotMatrix` type, `hotspot_parse_failure`).
   - Mode recommended: **swarm** (single-file edit, no contention).

3. **[I] I3 — bead templates populate**
   (`bead-templates.ts`, `__tests__/bead-templates.test.ts`)
   - Depends on: F1.
   - Mode recommended: **swarm**.

### Wave 2 — Doctor + telemetry (mixed contention)

4. **[I] I4 — flywheel_doctor tool**
   (`tools/doctor.ts`, `server.ts` registration, `__tests__/doctor.*.test.ts`)
   - Depends on: F1.
   - Touches `server.ts`. Potentially shared with I5 (telemetry also
     edits `server.ts` handler wrapper).

5. **[I] I5 — telemetry module + hooks**
   (`telemetry.ts`, `errors.ts` call-site, `server.ts` handler wrap)
   - Depends on: F1.
   - **Hotspot with I4**: both touch `server.ts`. Matrix will recommend
     coordinator-serial for this wave. Expected and correct.

### Wave 3 — Integration (sequential, touches approve + deep-plan + wrapup)

6. **[I] I6 — template expansion in approve + deep-plan synthesizer**
   (`tools/approve.ts`, `deep-plan.ts`)
   - Depends on: I3.

7. **[I] I7 — post-mortem draft generator**
   (`episodic-memory.ts`, `__tests__/episodic-memory.postmortem.test.ts`)
   - Depends on: F1, I5 (uses `ErrorCodeTelemetry`).

### Wave 4 — Skill + command wiring

8. **[D] D8 — doctor SKILL + slash command**
   (`skills/flywheel-doctor/SKILL.md`, `commands/flywheel-doctor.md`)
   - Depends on: I4.

9. **[D] D9 — start SKILL updates for Step 0e, Step 6, Step 10**
   (`skills/start/SKILL.md`,
   `skills/start/_beads.md`,
   `skills/start/_wrapup.md`)
   - Depends on: I4, I6, I7, I5.

10. **[D] D10 — lint:skill baseline refresh + manifest update**
    - Depends on: D8, D9.

### Wave 5 — Verification + release

11. **[D] D11 — dist rebuild + CI green-check**
    - Depends on: all above.

12. **[D] D12 — release notes + version bump to 3.4.0**
    (`mcp-server/package.json`, `CHANGELOG.md` if present)
    - Depends on: D11.

### Dependency edges to encode via `br dep add`

```
F1 → I2, I3, I4, I5, I7
I3 → I6
I5 → I7
I4 → D8, D9
I6 → D9
I7 → D9
D8 → D10
D9 → D10
D10 → D11
D11 → D12
```

### Hotspot pre-declaration per wave

- Wave 0: single bead, no hotspot.
- Wave 1: I2 / I3 touch disjoint files → swarm OK.
- Wave 2: I4 / I5 both touch `server.ts` → **coordinator-serial**.
- Wave 3: I6 / I7 disjoint → swarm OK.
- Wave 4: D8 / D9 disjoint → swarm OK (D10 depends on both, serializes
  naturally).

---

## 8. Testing strategy summary

| Subsystem | Unit | Smoke | Regression (predicted bug) |
|-----------|------|-------|----------------------------|
| 1 Doctor  | 15+  | 1     | concurrent doctor (E-1.1)  |
| 2 Hotspot | 12+  | 1     | mod.rs-style 3-way write   |
| 3 Postmortem | 10+ | 1  | crashed mid-wave (E-3.1)   |
| 4 Templates | 20+ | 1    | missing template id (E-4.1) |
| 5 Telemetry | 15+ | 1    | partial-write crash (E-5.7) |

All new tests live under `mcp-server/src/__tests__/`. Patterns:

- `vi.mock('child_process')` for `execFileSync` in episodic-memory.
- `vi.spyOn(process.stderr, 'write')` for logger assertions.
- `vi.useFakeTimers()` for deterministic `timestamp`/`elapsedMs`.
- `vi.importActual` for partial module mocks where state.ts is real.

Invariant assertions: each invariant label (D-1, H-1, …) maps to at
least one test. A coverage-of-invariants matrix lives at the top of
each test file so the reviewer can verify completeness without reading
the impl.

---

## 9. Verification block — how we know v3.4.0 is done

A release candidate is shippable iff ALL of:

1. `cd mcp-server && npm test` — all tests pass. New test count
   increases by ≥ 70 (sum of per-subsystem counts above).
2. `cd mcp-server && npm run build` — clean compile, no TS errors.
   `dist/` diff committed.
3. CI `dist-drift` job — green.
4. `cd mcp-server && npm run lint:skill` — 0 errors, baseline matches.
   Any intentional baseline bump is isolated to D10.
5. `TEMPLATE_INTEGRITY_WARNINGS.length === 0` at module load (asserted
   by test, and at CI).
6. Manual smoke:
   a. `/flywheel-doctor` returns a green report on a clean checkout.
   b. A planned wave with `errors.ts` in 2+ beads surfaces
      `recommendedMode: coordinator-serial` in approve output.
   c. `/flywheel-stop` generates a postmortem draft, shows top error
      codes, and waits for user approval before `cm add`.
   d. A plan referencing `foundation-with-fresh-eyes-gate` template
      expands at `br create` time with all placeholders filled.
7. No new `catch {}` without structured propagation (grep audit in PR
   review, automated via a `no-silent-catch` lint rule if time permits;
   else manual review).
8. `flywheel_memory` with `operation=store` receives a valid postmortem
   payload on at least one end-to-end dry run.
9. All seven new error codes appear in at least one SKILL.md branch
   (SKILL.md linter's `errorCodeReferences` rule enforces).
10. Version bumped to `3.4.0` in `mcp-server/package.json`; git tag
    deferred to coordinator.

---

## 10. Risk register + mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| F1 contract changes mid-wave | forces N-site rewrites | Fresh-eyes gate after F1 |
| Doctor mutates state accidentally | corrupt checkpoint | D-1 + saveState spy test |
| Hotspot matrix recommends swarm incorrectly | repeat of mod.rs regression | H-1 exhaustively tested |
| Postmortem commits without review | untrusted CASS entries | P-1 hard boundary |
| Template placeholder injection | prompt injection in bead descriptions | T-2 char-class reject |
| Telemetry counter race | off-by-one counts | per-key mutex (E-5.2) |
| Dist drift on merge | CI failure | D11 final rebuild step |

---

## 11. Open items (flagged, not planned for v3.4.0)

- **`flywheel_review` errors on already-closed beads.** Known issue
  from CASS. If a Wave 3 capacity exists, insert a fix-up bead
  `I7.5 — parse already_closed code in review tool` that returns the
  existing `already_closed` code instead of `parse_failure`. Otherwise
  defer to v3.4.1.
- **Auto-registration of new MCP tools in plugin descriptor.** Doctor
  needs to appear in the `mcp__plugin_agent-flywheel_agent-flywheel__*`
  namespace. Confirm the plugin manifest step is part of I4 or D10.
- **Cross-session telemetry storage format.** We chose CASS-via-tag
  for simplicity. Consider upgrading to a JSONL sidecar in v3.5.x if
  aggregation latency exceeds 2s per wrap-up.

---

## 12. Summary for coordinator

- **12 beads, 5 waves.** F1 is the single foundation; fresh-eyes gate
  after F1.
- **Hotspot pre-declares wave 2 as coordinator-serial** (both beads
  touch `server.ts`).
- **All 7 new error codes, 5 new types, 2 checkpoint-schema fields
  land in F1.** Nothing in impl waves touches contracts.
- **No phase-graph changes; only additive hook points** at Steps 0e, 6,
  10 + foundation-bead review gate.
- **Verification = 10 concrete gates.** Everything automatable in CI is
  automated; the residue is a 4-point manual smoke.

*End of plan — FuchsiaPuma, 2026-04-21.*
