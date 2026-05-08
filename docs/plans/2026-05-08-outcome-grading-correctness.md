# Outcome Grading — Correctness Plan

- **Date:** 2026-05-08
- **Perspective:** correctness
- **Author:** NobleMountain (Agent Mail)
- **Spec:** docs/superpowers/specs/2026-05-08-outcome-grading-design.md
- **Brainstorm:** docs/brainstorms/outcome-grading-2026-05-08.md

## Goal

Implement the rubric + decorrelated grader + iteration loop locally, in a way where every invariant holds across crash, restart, schema evolution, and partial-failure paths. Schemas are versioned `version: 1` additive-forever (mirroring `CompletionReportSchemaV1` and `ConvergenceStateSchema`); every input/output boundary is Zod-parsed; every new failure mode has a tagged `FlywheelErrorCode` with a contract-conformant `hint`; the iteration cap is enforced as a hard coercion that cannot be bypassed by a misbehaving grader; and additive state fields keep existing v3.11.x / v3.12.x checkpoints loadable without migration code.

## Prior Session Context

CASS query for `rubric grader iteration verify_beads convergence flywheel_review schema versioning Zod additive` exceeded the inline-context budget (98K chars / 767 lines, see `tool-results/...flywheel_memory-1778245917134.txt`). Top correctness-relevant patterns surfaced from the spec, brainstorm, and read-through of `completion-report.ts` / `convergence.ts` / `errors.ts`:

1. **`version: z.literal(1)` + additive-forever** — both `CompletionReportSchemaV1` (completion-report.ts:96) and `ConvergenceStateSchema` (convergence.ts:97) treat the schema as a closed contract. New fields ship `.optional()` only; v2 ships as a sibling (`SchemaV2`) plus a discriminated-union reader. Never mutate V1 in place.
2. **`SCORE_VERSION` / algorithm-version pinning** — `convergence.ts:30` uses a separate constant for gating-behavior changes so consumers can detect mismatches without re-interpreting old states under new rules. We need the same separation for `RUBRIC_SYNTH_VERSION` and `GRADER_VERDICT_VERSION`.
3. **Hint rubric (`docs/plans/2026-04-18-structured-error-contracts-synthesized.md` §6 / §4)** — ≤140 chars, capitalized first letter, ends with `.`, actionable next step, no echo of the code name. CI-enforced via `error-contract.test.ts`.
4. **`makeFlywheelErrorResult` is the tool boundary** (errors.ts:303) — top-level handlers `return makeFlywheelErrorResult(...)`; nested helpers throw `FlywheelError` and let it bubble. Hint defaults from `DEFAULT_HINTS` (errors.ts:106) so even a bare `throwFlywheelError({code,message})` is rubric-compliant.
5. **Stage-1 attestation gate is the precedent for "warn-only by default"** (verify-beads.ts:154; AGENTS.md §"Completion Evidence Attestation"). `flywheel_advance_wave` flips to hard-block on `FW_ATTESTATION_REQUIRED=1`. We mirror this: `outcome_rubric_validity` and `outcome_grading_history_validity` doctor checks ship green-on-absent, only escalate on parse failure.

## Resolved decisions

### OQ-A: capture `cycleStartSha` at `flywheel_select`

**Decision.** Capture in `flywheel_select` handler at goal-set time, not at `flywheel_plan` registration.

**Rationale.** Three correctness reasons:

1. `flywheel_select` is the only transition that is unambiguously *before* any work this cycle could have created. `flywheel_plan` runs after discovery may have written to disk (`docs/discovery/*.md`, brainstorms); using its tick as the start would cause those artifacts to be invisible to the grader.
2. `flywheel_select` is called exactly once per cycle (it transitions phase to `planning`); `flywheel_plan` can be called many times in `mode=duel`, `mode=deep`, retry paths, and the picked-up-plan menu. Capturing once-and-only-once is structurally easier at `select`.
3. Recovery is cheaper at the earlier point — if `select` is bypassed (resumed session), the checkpoint already has `gitHead` from `flywheel_observe`'s state snapshot.

**Recovery ladder for missing `cycleStartSha`** (in `flywheel_grade_outcome`):

```
state.cycleStartSha
  ?? checkpoint.gitHead
  ?? exec("git rev-parse HEAD~50").stdout.trim()
```

If the third fallback fires, log a `cycle_start_sha_unset` warn-level event and tag the verdict envelope with `details.cycleStartShaSource: "fallback_HEAD~50"` so downstream consumers know the diff was bounded heuristically. **Never** silently default to `HEAD` (would produce an empty diff and a falsely `satisfied` verdict).

### OQ-B: Skip-rubric is one-cycle (NOT sticky)

**Decision.** `Skip rubric` at the plan-approve gate sets `state.outcomeGradingSkipped = true` for the current cycle only. The flag is cleared by `flywheel_select` at the next cycle start (same place `cycleStartSha` is reset).

**Rationale.**

1. Sticky preferences in CASS create a hidden control surface that drifts from operator intent — surprising the operator three cycles later "why is rubric not running?". One-cycle is the least-surprising default.
2. Wrap-up's grader short-circuit reads `state.outcomeGradingSkipped`; cycle reset is one-line and atomic (`state.outcomeGradingSkipped = undefined`) so we cannot accidentally leak a skip past its cycle.
3. CASS-sticky behavior is strictly additive — it can land in a follow-up cycle reading the per-cycle telemetry (R4) once we have data on how often Skip is picked.

**Telemetry hook (deferred to v1.1).** `flywheel_memory(operation: "save", type: "session-learning")` records each Skip with `{ cycle: planSlug, reason: "operator-skipped-at-plan-approve" }`. v2 reads back the last N to detect the "always skipped" pattern.

## Phased task breakdown

Every task declares `depends_on:` per CLAUDE.md. T1–T4 are foundation; T5–T9 are MCP wiring; T10–T13 are skill+doctor wiring; T14–T17 are tests; T18–T19 are docs/release.

### Foundation

- **T1** — Add new structured error codes to `mcp-server/src/errors.ts`.  `depends_on: []`
  - Append to `FLYWHEEL_ERROR_CODES`: `rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`, `grader_unavailable`, `cycle_start_sha_unset`, `outcome_iteration_capped`.
  - Add a `DEFAULT_HINTS` entry per code (≤140 chars, capitalized, ends with period; no code-name echo). Examples:
    - `rubric_synth_invalid`: `Synthesizer returned non-conforming YAML — re-run with force=true, or hand-edit .pi-flywheel/plans/<slug>/rubric.md and set source=user.`
    - `rubric_missing`: `No rubric found for the active plan — run flywheel_synthesize_rubric, or pick Skip rubric at the plan-approve gate.`
    - `grader_timeout`: `Grader exceeded FW_GRADER_TIMEOUT_MS — raise the budget, retry, or fall back to a smaller diff via artifactRefs.modifiedFilePaths.`
    - `verdict_invalid`: `Grader stdout did not parse against GraderVerdictSchemaV1 — one auto-retry has already fired; inspect the raw payload at debug log level.`
    - `grader_unavailable`: `Neither codex_cli nor a fresh-context Agent fallback is healthy — run /flywheel-doctor and remediate codex_cli or claude_cli.`
    - `cycle_start_sha_unset`: `cycleStartSha was not captured at flywheel_select — using checkpoint.gitHead or HEAD~50 fallback; commit a baseline to fix.`
    - `outcome_iteration_capped`: `maxOutcomeIterations reached — accept the verdict, abort the cycle, or raise FW_MAX_OUTCOME_ITERATIONS (bounded [1,5]) before the next cycle.`
  - Add a `DEFAULT_RETRYABLE` entry per code: `rubric_synth_invalid:false`, `rubric_missing:false`, `grader_timeout:true`, `verdict_invalid:false`, `grader_unavailable:false`, `cycle_start_sha_unset:false`, `outcome_iteration_capped:false`.
  - **Acceptance:** `error-contract.test.ts` passes with the 7 new entries; no regression on existing 33 codes.

- **T2** — New module `mcp-server/src/outcome-grading.ts` with schemas + version pins. `depends_on: [T1]`
  - Constants: `export const RUBRIC_SCHEMA_VERSION = 1 as const;` and `export const GRADER_VERDICT_SCHEMA_VERSION = 1 as const;` (mirrors `SCORE_VERSION` from convergence.ts:30 — separates schema-shape version from algorithm-behavior version).
  - `RubricSchemaV1` exactly per spec lines 54–66, plus an `engine: z.string().optional()` field (records the synth-model id for future telemetry; optional so absence on read is fine).
  - `PerCriterionVerdictSchema` per spec lines 69–74.
  - `GraderVerdictSchemaV1` per spec lines 76–85, plus `details: z.record(z.string(), z.unknown()).optional()` so the cycleStartSha-fallback breadcrumb can be attached without bumping the schema.
  - **Schema-evolution exemplar** (in module header comment): show the 3-line v2 ladder pattern — `RubricSchemaV2`, `RubricSchema = z.discriminatedUnion('version', [RubricSchemaV1, RubricSchemaV2])`, plus a `readRubric()` helper that feeds the union and returns a tagged result. v1 readers continue to call `.parse(RubricSchemaV1)` and ignore unknown fields. **No code in T2 actually adds v2** — the comment is the contract.
  - `parseRubricFrontmatter(raw: string): { rubric: Rubric, body: string }` — splits on `---\n…\n---\n`, parses the YAML, runs `RubricSchemaV1.parse`. Throws `FlywheelError({code:'rubric_synth_invalid', cause:…})` with sanitized cause on parse failure.
  - **Acceptance:** Schema round-trip test (parse → JSON.stringify → parse → deepEqual) passes; `engine` and `details` fields tolerate omission and arbitrary string values.

- **T3** — Atomic file-write helper for rubric + verdict files. `depends_on: [T2]`
  - Add `writeAtomic(filePath, content)` to `outcome-grading.ts` (or co-locate as `mcp-server/src/atomic-write.ts` if reused later): `mkdir(dir, recursive:true)` → `writeFile(filePath + ".tmp", content)` → `rename(tmp, filePath)`. Rename is atomic on POSIX; the grader reading mid-write either sees the old file or the new file, never a half-file.
  - `writeRubricFile(cwd, rubric, body)` and `writeVerdictFile(cwd, planSlug, iteration, verdict)` go through `writeAtomic`.
  - Note: `completion-report.ts:291`'s `writeCompletionReport` uses naive `writeFile`. We do **not** retrofit that here — different call pattern (single writer, no concurrent reader). Document the decision in a comment so a future reviewer doesn't think it's an oversight.
  - **Acceptance:** Crash-mid-write test using `vi.mock('node:fs/promises', …)` to throw between tmp-write and rename; assert no `rubric.md` exists (only the orphan `.tmp` does), and the next call recovers cleanly.

- **T4** — Additive state fields on `FlywheelState` (`mcp-server/src/types.ts:395`). `depends_on: [T1]`
  - All optional except `maxOutcomeIterations` (which has a default of 3 set in `flywheel_select` if unset on a resumed checkpoint):
    ```ts
    outcomeRubricPath?: string;
    outcomeGradingSkipped?: boolean;
    outcomeGradingHistory?: Array<{
      iteration: number;
      verdict: GraderVerdict;
      timestamp: string;
    }>;
    maxOutcomeIterations?: number;       // bounded [1, 5]; default 3 applied at read
    cycleStartSha?: string;
    cycleEndTestOutput?: string;         // capped 10K chars at write
    ```
  - **Migration safety.** `mcp-server/src/state.ts` and `session-state.ts` parse the checkpoint with a permissive Zod schema (`.passthrough()`); since every new field is `.optional()`, existing `.pi-flywheel/checkpoint.json` files written by v3.11.x and v3.12.x load unchanged. Add a checkpoint-migration test loading a fixture from `mcp-server/src/__tests__/fixtures/checkpoint-v3.12.json` (no rubric fields) and asserting load succeeds with all new fields `=== undefined`.
  - **Acceptance:** Existing `state.test.ts` / `session-state.test.ts` pass with no diff; new migration test passes; `maxOutcomeIterations` clamping enforces `[1, 5]` on every read.

### MCP wiring

- **T5** — Implement `synthesizeRubric()` in `outcome-grading.ts`. `depends_on: [T2, T3]`
  - **Idempotency.** Compute `planContentSha = sha256(readFile(planPath))`. If `rubric.md` already exists and its frontmatter `source !== 'user'` and a sidecar `.pi-flywheel/plans/<slug>/.rubric.lock` records the same `planContentSha`, return the cached `{rubricPath, rubric, source: 'cached'}` result without re-spawning the synthesizer. `force=true` overrides and re-synthesizes regardless of lock match.
  - The `source: 'user'` guard prevents auto-overwrite of operator-edited rubrics. Operator intent always wins.
  - Synthesizer subagent prompt is built from a template literal (no string injection from plan content into command-args; the plan body is passed as the *user message* of the Agent call, never concatenated into the prompt path).
  - Parse failure → `throwFlywheelError({code:'rubric_synth_invalid', cause:sanitizedZodIssues})`.
  - **Acceptance:** Two synth calls with identical plan content produce identical rubric (deepEqual). Same with `force=true` blows the cache. Edited rubric (frontmatter `source: user`) is never overwritten.

- **T6** — Implement `gradeOutcome()` in `outcome-grading.ts`. `depends_on: [T2, T3, T4]`
  - **Skip short-circuit.** If `state.outcomeGradingSkipped === true`: return sentinel `{ status: 'skipped', reason: 'operator-skipped-at-plan-approve', iteration: 0 }`. This is **not** a `GraderVerdict` — caller must branch on `'skipped' in result`. Document at the call site.
  - **Idempotency on iteration files.** Before spawning the grader, compute `iteration = state.outcomeGradingHistory?.length ?? 0 + 1`. If `iteration-<N>.json` already exists on disk: refuse with `FlywheelError({code:'verdict_invalid', message:'iteration-N.json already exists', hint:'Pass force=true to re-grade, or delete the existing file.'})`. With `force=true`, overwrite and bump the in-memory state to match.
  - **Cycle-start fallback.** Apply the OQ-A ladder. If fallback fires, log `cycle_start_sha_unset` and tag `verdict.details.cycleStartShaSource`.
  - **Grader process boundary.** `codex exec --model "$FW_GRADER_MODEL" --json` with `timeout: FW_GRADER_TIMEOUT_MS ?? 120_000`, `signal` propagated. Fallback: fresh `Agent({subagent_type: 'general-purpose', prompt: <decorrelated-preamble + rubric + diff>})`. Both pass through the existing `ExecFn` contract (`exec.ts`).
  - **Verdict parse.** `GraderVerdictSchemaV1.parse(JSON.parse(stdout))`. On JSON parse failure or schema failure, **one auto-retry** with a re-prompt that includes the parse error. On second failure → `verdict_invalid`. (No third retry — the grader is broken; surface to operator.)
  - **Iteration cap coercion (load-bearing).** After parse, before write:
    ```ts
    if (verdict.iteration >= maxOutcomeIterations
        && verdict.status === 'needs_revision') {
      verdict.status = 'max_iterations_reached';
    }
    ```
    This is a hard coercion — the grader cannot return `needs_revision` past the cap, even if the LLM ignored the prompt's stop-condition.
  - **Atomic write + state append.** `writeVerdictFile(...)` (T3) → push to `state.outcomeGradingHistory` → `saveState(state)`. Order matters: file lands first so a crash between write and saveState leaves a recoverable on-disk record.
  - **Acceptance:** All 4 verdict statuses round-trip; iteration cap coercion test passes (grader returns `needs_revision` at iter=3 → result has `status='max_iterations_reached'`); pre-existing iteration file → refuses without `force=true`.

- **T7** — Tool wrapper `mcp-server/src/tools/synthesize-rubric.ts`. `depends_on: [T5]`
  - `runSynthesizeRubric(ctx, args)` — input shape parsed via `SynthesizeRubricArgsSchema` Zod; calls `synthesizeRubric()`; returns `makeOkToolResult` envelope on success, `makeFlywheelErrorResult` on caught FlywheelError.
  - **Acceptance:** Tool returns valid `version: 1` envelope; `force` flag round-trips.

- **T8** — Tool wrapper `mcp-server/src/tools/grade-outcome.ts`. `depends_on: [T6]`
  - Same envelope contract as T7; resolves slug from `state.outcomeRubricPath` if omitted; surfaces `skipped` sentinel as a `kind: 'grading_skipped'` data block (not an error).
  - **Acceptance:** Returns `kind: 'grader_verdict' | 'grading_skipped' | 'grading_capped'` discriminator; envelope is `version: 1`.

- **T9** — Register both tools in `mcp-server/src/server.ts`. `depends_on: [T7, T8]`
  - Add to the tool registry between `flywheel_review` and `flywheel_select` (alphabetical-ish, matching existing convention).
  - Update the AGENTS.md "MCP tools quick reference" table in T18.
  - **Acceptance:** Server starts; both tools appear in `flywheel_doctor`'s `mcp_connectivity` inventory.

### Skill + doctor wiring

- **T10** — Plan-approve hook in `skills/start/_planning.md` Step 5.6. `depends_on: [T7]`
  - Call `flywheel_synthesize_rubric` after the plan-ready gate; surface `AskUserQuestion` with options `[Approve / Edit inline / Regenerate / Skip rubric]` per spec line 184.
  - On `Skip rubric`: set `state.outcomeGradingSkipped = true` (for this cycle only — clear at next `flywheel_select`).
  - **Acceptance:** `npm run lint:skill` passes; UNIVERSAL RULE 1 (`AskUserQuestion`) honored.

- **T11** — Wrap-up hook in `skills/start/_wrapup.md` Step 9.5. `depends_on: [T8]`
  - Call `flywheel_grade_outcome` before commit-review; branch on `verdict.status` per spec lines 224–242.
  - Iterate path → call `flywheel_approve_beads(action: 'remediate')` with the parsed-gaps payload (parse via Zod at the boundary; reject if `gaps[]` is empty for a non-`met` criterion).
  - **Acceptance:** All branches covered; `iteration < maxOutcomeIterations` AND `status === 'needs_revision'` is the **only** branch that surfaces the `Iterate` option; `max_iterations_reached` drops it.

- **T12** — Add `outcome_rubric_validity` doctor check in `mcp-server/src/tools/doctor.ts`. `depends_on: [T2]`
  - Per spec lines 259–262: green if rubric parses, yellow if file missing or YAML malformed, red only if frontmatter parses but `criteria.length === 0`. Hint text per the §6 rubric.
  - **Acceptance:** Round-trip test (write rubric → run doctor → green; corrupt rubric → yellow; criteria=[] → red).

- **T13** — `cycleStartSha` capture in `flywheel_select`. `depends_on: [T4]`
  - At goal-set time: `state.cycleStartSha = await exec('git', ['rev-parse', 'HEAD']).stdout.trim()`. Also clear `state.outcomeGradingSkipped`, `state.outcomeRubricPath`, `state.outcomeGradingHistory` so a new cycle starts clean.
  - On `git rev-parse` failure (detached HEAD, no commits yet): leave `cycleStartSha` undefined and let the OQ-A fallback ladder fire at grade time.
  - **Acceptance:** Existing `flywheel_select` tests pass; new test asserts `cycleStartSha` is captured and old cycle state is reset.

### Tests

- **T14** — Unit test `mcp-server/src/__tests__/outcome-grading.test.ts`. `depends_on: [T2, T3, T6]`
  - Schema round-trips (Rubric, GraderVerdict, both 4 statuses).
  - Iteration cap coercion (grader returns `needs_revision` at `iteration === maxOutcomeIterations` → coerced).
  - Idempotent synth (same plan → same rubric; `force=true` re-synths).
  - Operator-edited rubric (`source: 'user'`) is never overwritten.
  - Atomic write crash-recovery (mock fs throw between tmp + rename).
  - Existing `iteration-N.json` refuses without `force=true`.
  - cycleStartSha fallback ladder (all three paths).

- **T15** — Tool-wrapper tests `synthesize-rubric.test.ts` + `grade-outcome.test.ts`. `depends_on: [T7, T8]`
  - Each error code has at least one test asserting (a) the code is set in the envelope, (b) the hint matches `DEFAULT_HINTS[code]` when call site doesn't override, (c) `retryable` matches `DEFAULT_RETRYABLE[code]`.
  - Skip-sentinel return shape.
  - `version: 1` envelope on every result path (success + error + skipped + capped).

- **T16** — Doctor check test `doctor-outcome-rubric-validity.test.ts`. `depends_on: [T12]`
  - Green / yellow / red round-trip per T12 acceptance.

- **T17** — Migration test `mcp-server/src/__tests__/fixtures/checkpoint-v3.12.json` + loader. `depends_on: [T4]`
  - Asserts loading a checkpoint with no outcome-grading fields succeeds and all new fields are `=== undefined`.

### Docs / release

- **T18** — Update `AGENTS.md`. `depends_on: [T9, T10, T11, T12, T13]`
  - New "Outcome Grading" section under Phase 12 (or its own phase 13).
  - Add `flywheel_synthesize_rubric` and `flywheel_grade_outcome` to the MCP tools quick-reference table.
  - Document the OQ-A capture point + OQ-B one-cycle stickiness in plain English.
  - Document `FW_GRADER_TIMEOUT_MS`, `FW_GRADER_MODEL`, `FW_MAX_OUTCOME_ITERATIONS` env knobs.

- **T19** — `CHANGELOG.md` entry for v3.13.0 + `mcp-server/package.json` version bump. `depends_on: [T18]`

## Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | A future schema change accidentally mutates `RubricSchemaV1` (e.g. tightens a `min(10)` to `min(20)`) and breaks existing rubric files. | Module header comment freezes V1; `outcome-grading.test.ts` includes a corpus of fixture rubric files that must continue to parse. New constraints land as `RubricSchemaV2` only. |
| R2 | Grader returns `needs_revision` past the iteration cap because an LLM misread the prompt's stop-condition. | Hard coercion in T6 — `verdict.status` is overwritten to `max_iterations_reached` before the verdict file is written; the wrap-up branch never sees the original `needs_revision` past the cap. Tested directly. |
| R3 | A crash mid-`writeFile` of `rubric.md` leaves a half-file the grader then reads. | T3 atomic write helper (`writeAtomic`) — POSIX rename is atomic; the grader sees old or new, never half. Test uses mocked fs to verify recovery. |
| R4 | Existing v3.11.x / v3.12.x checkpoints fail to load after this lands because schema validation rejects unknown-field-shape. | All new fields `.optional()`; loader uses `.passthrough()`; T17 fixture-based migration test gates the change. |
| R5 | `cycleStartSha` is missing for a session resumed from before this lands, and the grader operates against an empty diff (false `satisfied`). | Three-tier fallback (T6) with a tag in `verdict.details.cycleStartShaSource`. Never default to `HEAD` (would produce empty diff). `cycle_start_sha_unset` warn surfaces in `flywheel_observe`. |
| R6 | An operator hand-edits `rubric.md` but `flywheel_synthesize_rubric` is called again (e.g. by a slash command) and overwrites the edits. | Idempotency cache keyed on `planContentSha`; **plus** `source: 'user'` guard — auto-synth never overwrites a `source: user` rubric, only `force=true` from a tool call does. |
| R7 | Two grader processes race on the same `iteration-N.json` due to a double-trigger of Step 9.5. | T6 refuses if file exists without `force=true`. Per-cwd file-reservation via `reserveOrFail(.pi-flywheel/plans/<slug>/grading/, exclusive)` is a defense-in-depth follow-up but not load-bearing for v1. |
| R8 | Synthesizer YAML output contains a path-traversal payload in `evidenceHint` that leaks outside cwd when read. | `evidenceHint` is `z.string().optional()` — never `read()`d, only displayed. Document explicitly in module comment. The grader prompt does not exec `evidenceHint` content. |
| R9 | Grader hits `exec_timeout` and the wrap-up phase hangs awaiting verdict. | `FW_GRADER_TIMEOUT_MS` (default 120_000) + `signal` propagation per AGENTS.md hard constraint #8. Timeout returns `grader_timeout` (retryable=true); operator decides to retry or skip. |
| R10 | Schema version drift — a downstream tool reads `iteration-N.json` assuming v1 but a future v2 file is on disk. | Reader pattern (documented in T2 module comment) is a discriminated union on `version`; v1 readers `.parse(GraderVerdictSchemaV1)` and reject v2 with a clear error rather than silently misinterpreting. |

## File-level changes

| Path | Kind | Est. LOC | Notes |
|---|---|---|---|
| `mcp-server/src/outcome-grading.ts` | new | ~430 | Schemas + atomic write + synth + grade + helpers |
| `mcp-server/src/tools/synthesize-rubric.ts` | new | ~90 | Tool wrapper |
| `mcp-server/src/tools/grade-outcome.ts` | new | ~140 | Tool wrapper |
| `mcp-server/src/__tests__/outcome-grading.test.ts` | new | ~320 | Schema + iteration-cap + atomic + idempotency |
| `mcp-server/src/__tests__/synthesize-rubric.test.ts` | new | ~120 | Tool envelope + error codes |
| `mcp-server/src/__tests__/grade-outcome.test.ts` | new | ~180 | Tool envelope + skip + cap + fallback |
| `mcp-server/src/__tests__/doctor-outcome-rubric-validity.test.ts` | new | ~80 | Doctor round-trip |
| `mcp-server/src/__tests__/fixtures/checkpoint-v3.12.json` | new | ~30 | Migration fixture |
| `mcp-server/src/errors.ts` | edit | +~50 | 7 new codes + DEFAULT_HINTS + DEFAULT_RETRYABLE |
| `mcp-server/src/types.ts` | edit | +~10 | FlywheelState additive fields |
| `mcp-server/src/state.ts` | edit | +~5 | Permissive load (already passthrough) — confirm no diff |
| `mcp-server/src/session-state.ts` | edit | +~5 | Same |
| `mcp-server/src/server.ts` | edit | +~20 | Register 2 tools |
| `mcp-server/src/tools/doctor.ts` | edit | +~70 | `outcome_rubric_validity` check |
| `mcp-server/src/tools/select.ts` | edit | +~25 | cycleStartSha capture + cycle-state reset |
| `skills/start/_planning.md` | edit | +~40 | Step 5.6 routing |
| `skills/start/_wrapup.md` | edit | +~70 | Step 9.5 routing + iterate/accept/abort menu |
| `AGENTS.md` | edit | +~80 | Outcome Grading section + quick-ref + env knobs |
| `CHANGELOG.md` | edit | +~25 | v3.13.0 entry |
| `mcp-server/package.json` | edit | 1 | Version bump |

## Testing strategy (correctness-emphasis)

1. **Schema round-trips** — every Zod schema (`RubricSchemaV1`, `PerCriterionVerdictSchema`, `GraderVerdictSchemaV1`) parsed → serialized → parsed → deep-equal. All 4 verdict statuses + Skip sentinel.
2. **Idempotency** — `synthesizeRubric` with same plan content produces same rubric; `force=true` re-synths; operator-edited rubric never auto-overwritten.
3. **Atomic-write crash recovery** — mock `fs/promises.rename` to throw; assert `rubric.md` does not exist (only orphan `.tmp`) and the next call recovers cleanly.
4. **Iteration cap coercion** — grader returns `{status:'needs_revision', iteration:3}` with `maxOutcomeIterations=3` → result has `status='max_iterations_reached'`. Verified at the unit level so a misbehaving grader cannot bypass it.
5. **Migration safety** — fixture checkpoint from v3.12.x loads with all new fields `=== undefined`; `maxOutcomeIterations` reads as default `3`.
6. **Error code coverage** — every new code has a test asserting `data.error.code === <code>`, `data.error.hint === DEFAULT_HINTS[code]` when call site doesn't override, `data.error.retryable === DEFAULT_RETRYABLE[code]`. CI gate from `error-contract.test.ts` ensures hint rubric (≤140 chars, capitalized, ends with `.`) holds.
7. **CycleStartSha fallback ladder** — three integration tests covering (a) state-set, (b) state-unset / checkpoint-set, (c) both unset → `HEAD~50` fallback with `details.cycleStartShaSource` breadcrumb.
8. **Doctor round-trip** — green / yellow / red severity for valid / malformed / empty-criteria rubric.
9. **Existing test suites** — `flywheel_review`, `flywheel_verify_beads`, `flywheel_advance_wave`, `flywheel_convergence`, `flywheel_doctor` all unchanged — explicit assertion no diff in their test files.

## Open questions for the synthesizer

- **OQ-C.** Should the grader's `details` object (carrying `cycleStartShaSource`) be Zod-typed as `z.record(z.string(), z.unknown())` (current proposal) or a discriminated union of known breadcrumb shapes? Loose-record is forward-compatible but loses static analysis. **Recommendation: loose-record for v1**, tighten when a second breadcrumb lands.
- **OQ-D.** Should `flywheel_grade_outcome` accept an explicit `iteration` arg for replay/debugging, or always derive from state? **Recommendation: always derive** — explicit iteration is a footgun that lets a caller skip the cap. Add a `force=true` knob for re-grading the same iteration if needed.
- **OQ-E.** When the synthesizer runs in `mode=duel` (two cross-scoring agents), do we synthesize one rubric per agent or one consensus rubric? **Recommendation: one consensus rubric** — the rubric is whole-cycle; per-agent rubrics conflate generator decorrelation with verdict decorrelation.
- **OQ-F.** Should `cycleEndTestOutput` be captured by the wrap-up test-runner hook into state, or read on-the-fly by `gradeOutcome`? **Recommendation: state** — keeps the grader pure (no side-effect exec); clearer audit trail; capped at 10K chars at write time.

End of plan.
