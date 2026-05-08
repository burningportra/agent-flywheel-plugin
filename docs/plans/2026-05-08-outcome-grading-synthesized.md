# Outcome Grading — Synthesized Implementation Plan

- **Date:** 2026-05-08
- **Author:** Synthesizer (Best-of-All-Worlds blend)
- **Source plans:**
  - `docs/plans/2026-05-08-outcome-grading-correctness.md` — NobleMountain (Claude/cc) — 259 lines, schema versioning + Zod gates + idempotency + atomic writes
  - `docs/plans/2026-05-08-outcome-grading-ergonomics.md` — BronzeLotus (Codex/cod) — 526 lines, operator UX + verbatim copy + edit recovery loop
  - `docs/plans/2026-05-08-outcome-grading-robustness.md` — BronzeLotus (Gemini-Flash/gmi) — 111 lines, fallback chain + truncation + failure mode catalog
- **Spec:** `docs/superpowers/specs/2026-05-08-outcome-grading-design.md`
- **Brainstorm:** `docs/brainstorms/outcome-grading-2026-05-08.md`

---

## Goal

Borrow the Anthropic Managed Agents `define_outcome` rubric + decorrelated grader + iteration-loop pattern as a **local concept only** (no MA API dependency). Author a whole-cycle rubric at plan-approve time (operator can Approve / Edit inline / Regenerate / Skip), grade the cycle outcome at wrap-up via a strictly-decorrelated grader (codex primary, fresh-context Claude fallback), and surface a per-criterion verdict via `AskUserQuestion` with a hard 3-iteration cap. Every input/output boundary is Zod-parsed, every failure mode has a tagged `FlywheelErrorCode` with a contract-conformant hint, the grader survives crashes/timeouts/malformed JSON, and the operator-facing seams (banner, gates, doctor, remediation beads) are explicit and testable.

---

## Per-plan honest acknowledgments

### Correctness (NobleMountain) — what it does best

1. **Schema-evolution discipline** (lines 76–83): Module-header v2 ladder pattern (`RubricSchemaV2` + `z.discriminatedUnion('version', …)` + `readRubric()` helper) that nobody else captures. This is the single highest-leverage future-proofing decision in the doc set.
2. **Idempotency on rubric synthesis** (T5, lines 110–115): `planContentSha = sha256(readFile(planPath))` + `.rubric.lock` sidecar prevents auto-overwrite of operator-edited rubrics. Ergonomics has the `source: edited` guard but doesn't pin it to plan-content hash; correctness adds the deeper invariant.
3. **Idempotency on iteration files** (T6, line 119): Refuse to overwrite `iteration-N.json` without explicit `force=true`. Robustness mentions disk-full but misses the double-trigger race; ergonomics is silent. This is a real footgun.
4. **Iteration-cap coercion as a load-bearing invariant** (T6, lines 124–130): Hard server-side coercion `if (iteration >= cap && status === 'needs_revision') status = 'max_iterations_reached'`. Treats the LLM as adversarial — a misbehaving grader cannot bypass the cap. Robustness implies it; correctness makes it provably enforced.
5. **`cycle_start_sha_unset` recovery ladder** (lines 37–43): Three-tier `state → checkpoint.gitHead → HEAD~50`, with the explicit "**never** silently default to `HEAD`" rule and `details.cycleStartShaSource` breadcrumb. The other two plans wave at this; only correctness names the trap (false `satisfied` from empty diff).
6. **Migration-safety fixture** (T17, lines 187–188): Concrete `checkpoint-v3.12.json` fixture + loader test that gates the change. Forces the additive contract to be tested, not just asserted.
7. **`error-contract.test.ts` integration** (T1 acceptance, line 74): Plugs every new error code into the existing CI-enforced hint rubric (≤140 chars, capitalized, ends with `.`). Mechanically prevents hint regressions.

**Unique insights correctness contributes:**
- Separation of `RUBRIC_SCHEMA_VERSION` (shape) from a future `GRADER_BEHAVIOR_VERSION` (algorithm), mirroring `convergence.ts:30`'s `SCORE_VERSION` precedent.
- `evidenceHint` path-traversal threat model (R8) — never read, only displayed.
- Open question OQ-D: explicit `iteration` arg as a footgun that lets callers skip the cap; recommendation: always derive from state, use `force=true` for replay.

### Ergonomics (BronzeLotus / Codex) — what it does best

1. **Verbatim copy section** (lines 280–526): Every `AskUserQuestion`, banner line, doctor hint, edit-failure recovery prompt, timeout surface, and remediation bead template written in final form. This is the single most operator-load-bearing artifact in the doc set; the other two plans paraphrase or hand-wave.
2. **Edit-failure recovery loop** (E2 + verbatim §"Edit Parse Failure", lines 332–340): When operator-edited rubric breaks Zod parse, surface `Re-edit / Regenerate from scratch / Abort` — never silently overwrite. Captures a real UX trap that both other plans miss entirely.
3. **One-click Skip lives inside Create-beads sub-flow** (line 38): Keeps the existing four-option Plan-ready menu unchanged and pushes Skip into the rubric gate. Reduces user-visible menu surface vs. correctness's Approve/Edit/Regenerate/Skip-at-top approach.
4. **Banner state matrix** (lines 343–384): Seven distinct banner states (no rubric, valid no grade, needs_revision, satisfied, max_iter, failed, skipped) with exact strings. The other plans say "show last grade"; ergonomics shows what the line literally is.
5. **Verdict-table render** (lines 426–435): Markdown table of `criterion | status | gap (truncated 120 chars)` printed before the verdict question. Robustness emphasizes truncation correctness; ergonomics owns the operator-visible result of that truncation.
6. **Codex-fallback notice as user-visible** (E3 + line 439): "Grader notice: Codex unavailable (`<doctor status>`); used a fresh Claude grader instead." Robustness has the fallback logic; ergonomics surfaces it so operators don't over-trust a weakened decorrelation.
7. **Remediation bead consolidation rule** (E8, lines 175–190): One bead per criterion (not one per gap), with all gaps folded into the bead's acceptance criteria. Concrete title format and body template prevent Iterate from creating 4× the noise.
8. **Skip-recommendation telemetry** (line 33): After 3 consecutive skips, surface "Skip rubric" as Recommended next time — but **never** silently skip. Threads the needle between zero-friction and silent-degradation.

**Unique insights ergonomics contributes:**
- Open question on `flywheel_approve_beads(action: "remediate")` not being in AGENTS.md quick reference — needs synthesis decision (add the action vs. use existing `br` helpers).
- Suggestion that the verdict-table render is a server-side helper (not skill-text only) for consistency.
- "Edit inline" is a structured `AskUserQuestion` follow-up with intents (Tighten / Add / Remove / Custom) plus Other text — never `$EDITOR`.

### Robustness (BronzeLotus / Gemini-Flash) — what it does best

1. **Failure mode catalog as a table** (lines 102–111): Seven concrete trigger → detection → recovery → surface rows. Codex-times-out, CC-fallback-times-out, prose-leakage, diff-overflow, test-output-overflow, process-crash, disk-full. The other two plans bury these in risk registers; robustness gives a single canonical reference.
2. **Diff truncation policy** (T2.2, lines 43–46): 30K char cap with explicit "first 15K + last 15K + file list + `git diff --stat`" marker, preventing context overflow and hallucination on truncated input. Plus ranked priority (npm test > lint > typecheck within 10K test-output budget).
3. **SIGTERM → SIGKILL escalation** (T1.2, line 28): 5-second SIGTERM grace period before SIGKILL. Subprocess-zombie defense neither other plan addresses.
4. **Disk-full graceful degrade** (T1.1 risk register, line 74): Return verdict in-memory tagged `persistence: "failed"` even if `iteration-N.json` write fails. Operator still sees the grade.
5. **JSON recovery preamble** (T1.3, line 33): Exact re-prompt text "Your previous output was not valid JSON. Return ONLY the GraderVerdictSchemaV1 JSON object. Do not include prose." This is the literal string to use; correctness mentions retry but doesn't write the prompt.
6. **Concurrent grade lock** (T3.2, line 53): In-memory mutex per plan slug → `concurrent_write` error for racing callers. Defense-in-depth on top of correctness's iteration-file-exists check.
7. **Context-budget prioritization** (lines 70 + 99): Dynamic budget when total prompt > limit: Rubric > Diff Stat > Diff Body (truncated) > Test Output. Explicit ranking nobody else gives.

**Unique insights robustness contributes:**
- Stronger `cycleStartSha` fallback ladder including `git log -n 1 --before="<checkpoint.timestamp>" --format="%H"` as a second-tier resolution.
- Fresh-CC fallback preamble: "You are a blind auditor." — a tighter decorrelation prompt than the spec's hint.
- The grader prompt should explicitly note when truncation occurred (so verdict.explanation can flag truncation as a confidence-reducer).

---

## Major decisions adopted

For each load-bearing call, here is the decision + which plan I took it from + 1-sentence rationale.

| # | Decision | Adopted from | Rationale |
|---|---|---|---|
| D1 | Capture `cycleStartSha` at `flywheel_select` (NOT `flywheel_plan`) | Correctness (lines 27–34) + Robustness (T2.1) | Two of three planners agree; correctness's reasoning (once-and-only-once + before-discovery + cheaper recovery) outweighs ergonomics's "graded changes since plan registration" framing. Surface as **Unresolved Tension #1** since ergonomics genuinely disagreed. |
| D2 | Skip-rubric is one-cycle (NOT sticky) | All three plans agree | Unanimous. Cleared at next `flywheel_select`. Telemetry hook deferred; ergonomics's "after 3 consecutive skips, surface Skip as Recommended" added as a v1.1 follow-up. |
| D3 | Schema versioning: `version: z.literal(1)` + additive-forever + v2 ladder pattern documented in module header | Correctness (T2) | No-brainer; matches existing `CompletionReportSchemaV1` / `ConvergenceStateSchema` precedent. Add `engine?` and `details?` fields now so future telemetry doesn't force a v2 bump. |
| D4 | Atomic file writes via `writeFile + rename` | Correctness (T3) + Robustness (T3.1) | Both planners surfaced this; correctness has the test pattern (mock `fs.rename` to throw), robustness has the policy. Co-locate as `mcp-server/src/atomic-write.ts` for future reuse. |
| D5 | `flywheel_approve_beads(action: "remediate")` action | Ergonomics open question + spec line 244 | Spec mentions it as existing surface but ergonomics correctly notes it's not in AGENTS.md quick ref. **Decision:** add the `remediate` action to `flywheel_approve_beads` as part of T11 (one-line additive change), document in T18. Surface as **Unresolved Tension #4** if operator wants to defer. |
| D6 | Idempotency: `planContentSha`-keyed cache for synth + `iteration-N.json` exists guard for grade | Correctness (T5, T6) | Closes two real footguns (re-synth overwrite, double-trigger race) ergonomics and robustness both miss. `force=true` overrides both. |
| D7 | Iteration-cap coercion as server-side hard rewrite | Correctness (T6 lines 124–130) | Treat the LLM as adversarial; never trust grader self-reported `status` past the cap. |
| D8 | Grader fallback: `codex exec --model "$FW_GRADER_MODEL" --json` primary → fresh `Agent()` subagent fallback with explicit "blind auditor" preamble | Robustness (T1.1) + spec | Robustness has the cleanest spawn logic; preamble line ("You are a blind auditor; you have not seen the impl conversation") borrowed verbatim. |
| D9 | Diff truncation at 30K + test output at 10K + dynamic budget priority Rubric > Diff Stat > Diff Body > Test Output | Robustness (T2.2 + line 70) | Only plan that names the policy concretely. |
| D10 | SIGTERM (5s grace) → SIGKILL escalation on timeout | Robustness (T1.2) | Standard hygiene; subprocess-zombie defense. |
| D11 | One auto-retry on JSON-parse / Zod failure with verbatim re-prompt | Robustness (T1.3) + Correctness (T6) | Correctness names the budget (one retry, not three); robustness names the prompt text. Blend. |
| D12 | Disk-full graceful degrade: return verdict in-memory with `persistence: "failed"` tag | Robustness (R risk row + failure catalog) | Operator-friendly; verdict still useful for in-session decision even if persisted artifact missing. |
| D13 | In-memory mutex (per planSlug) for parallel `flywheel_grade_outcome` | Robustness (T3.2) | Defense-in-depth on top of D6's file-exists guard. |
| D14 | Operator gate copy: ergonomics's verbatim text adopted wholesale | Ergonomics (lines 280–526) | Final-form copy beats paraphrase; this is what the operator literally sees. |
| D15 | Edit-failure recovery loop: structured `AskUserQuestion` with `Re-edit / Regenerate from scratch / Abort` | Ergonomics (E2 + lines 332–340) | Captures a UX trap correctness and robustness miss entirely. |
| D16 | Banner: 7-state matrix with verbatim strings | Ergonomics (lines 343–384) | Final-form copy. |
| D17 | Verdict-table render as server-side helper (called from `_wrapup.md` skill text) | Ergonomics open question + my call | Server helper for table consistency; skill owns surrounding copy. |
| D18 | Codex-fallback notice surfaced verbatim in verdict surface | Ergonomics (line 439) | Prevents over-trust in weakened decorrelation; operator-visible. |
| D19 | One remediation bead per unmet/partial criterion (gaps folded into acceptance criteria) | Ergonomics (E8) | Prevents 4× bead inflation when one criterion has 4 gaps. |
| D20 | Doctor `outcome_rubric_validity`: green / yellow (file missing or malformed) / red (criteria empty) | All three plans agree | Severity ladder + verbatim hints from ergonomics §"Doctor Hints". |
| D21 | New error codes (7): `rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`, `grader_unavailable`, `cycle_start_sha_unset`, `outcome_iteration_capped` + `concurrent_grade` | Correctness (T1) + my add of `concurrent_grade` from D13 | Correctness's 7 + 1 from robustness's mutex requirement. All wired into `DEFAULT_HINTS` + `DEFAULT_RETRYABLE`. |
| D22 | Synthesizer subagent uses **same model as orchestrator** (decorrelation matters at grade time, not synth time) | Spec (line 179) | Reading-task only; correlation harmless here. |
| D23 | Grader prompt construction: rubric frontmatter + `git log <range> --oneline` + `git diff <range> --stat` + diff body (≤30K, truncated middle) + test output (≤10K) + explicit "blind auditor" preamble + truncation flag in prompt | Blend of all three | Robustness owns the size policy, correctness owns the artifact list, ergonomics owns the user-visible disclosure. |
| D24 | `outcomeGradingHistory` stored in state as full verdict array (not just status counts) for replay/audit | Correctness (T4) | Enables future cross-cycle telemetry without schema migration. |
| D25 | `OQ-C` resolution: `details: z.record(z.string(), z.unknown())` loose record, tightened in v2 when 2nd breadcrumb lands | Correctness OQ-C recommendation | Forward-compatible; current load is just `cycleStartShaSource`. |

---

## Unresolved tensions

These are disagreements I could not blend into a single answer. Surface as qualifying questions at the alignment check (Step 5.55).

**Tension #1 — `cycleStartSha` capture point.** Correctness + Robustness say `flywheel_select`; Ergonomics says `flywheel_plan` registration ("graded changes since plan registration" is a clearer mental model for the operator). I chose `flywheel_select` (D1) on correctness arguments, but the ergonomic framing is real. **Question for operator:** "Should the grader's `cycleStartSha` be captured at `flywheel_select` (covers discovery + brainstorm artifacts; once-and-only-once; recommended) or `flywheel_plan` (covers plan-execution only; clearer mental model for 'graded since plan')?"

**Tension #2 — Plan-approve menu shape.** Spec + Correctness put Approve / Edit / Regenerate / Skip as a top-level four-option `AskUserQuestion` after `flywheel_synthesize_rubric` returns. Ergonomics keeps the existing Plan-ready menu unchanged and pushes Skip *inside* the Create-beads → rubric-gate sub-flow. Ergonomics's framing is gentler on operator menu fatigue but adds a layer of indirection. I chose ergonomics's shape (D14, D15). **Question for operator:** "Should the rubric gate live as a separate step inside Create-beads (recommended; preserves existing Plan-ready menu) or replace the Plan-ready menu's Create-beads option with the four rubric-action labels directly?"

**Tension #3 — `flywheel_approve_beads(action: "remediate")` introduction.** Spec assumes it exists; AGENTS.md quick ref doesn't list it; ergonomics flags this as a gap. **Question for operator:** "Add the `remediate` action to `flywheel_approve_beads` now (in this cycle, recommended) or defer remediation-bead creation to a separate `flywheel_create_remediation_beads` tool / use existing `br` helpers directly from skill text?"

**Tension #4 — Iteration-state separation.** Correctness wants `outcomeGradingHistory[]` to store full verdicts; ergonomics's banner needs only the latest summary; robustness is silent. Storing full verdicts (D24) costs ~5KB per iteration × 3 iterations × N cycles = unbounded growth. **Question for operator:** "Cap `outcomeGradingHistory` at last 5 cycles (recommended; prevents checkpoint bloat) or store unbounded for full audit trail?"

---

## Phased task breakdown

Every task declares `depends_on:` per CLAUDE.md global rule. Dependency graph:

```
T1 ─┬─ T2 ─┬─ T3 ─┬─ T5 ─┬─ T7 ─┬─ T9 ─┬─ T10 ─┐
    │      │      │      │      │      │       ├─ T18 ─ T19
    │      │      │      │      │      ├─ T11 ─┤
    │      │      │      │      │      │       │
    │      │      │      ├─ T6 ─┤       ├─ T13 ─┤
    │      ├─ T4 ─┤      │      │       │       │
    │      │      │      │      ├─ T8 ──┤       │
    │      │      │      │      │       │       │
    │      │      │      │      ├─ T12 ─┘       │
    │      │      │      │      │               │
    │      │      │      └─ T14 (depends T2,T3,T6) │
    │      │      │                              │
    │      │      └─ T15 (depends T7,T8) ────────┤
    │      │                                     │
    │      └─ T16 (depends T12) ─────────────────┤
    │                                            │
    └─ T17 (depends T4) ─────────────────────────┘
```

Phase ordering: **T1–T4 foundation** → **T5–T9 server logic + tools** → **T10–T13 skill + doctor wiring** → **T14–T17 tests** → **T18–T19 docs/release**.

### Phase A — Foundation

**T1 — New structured error codes.** `depends_on: []`
- File: `mcp-server/src/errors.ts`
- Append to `FLYWHEEL_ERROR_CODES`: `rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`, `grader_unavailable`, `cycle_start_sha_unset`, `outcome_iteration_capped`, `concurrent_grade`.
- Add `DEFAULT_HINTS` entry per code (≤140 chars, capitalized, ends with period, no code-name echo). Use the strings in §"Verbatim UI copy".
- Add `DEFAULT_RETRYABLE` entry per code: `grader_timeout:true`, all others `:false`.
- **Acceptance:** `error-contract.test.ts` passes with the 8 new entries; CI hint-rubric assertions hold.

**T2 — New module `outcome-grading.ts` with schemas.** `depends_on: [T1]`
- File: `mcp-server/src/outcome-grading.ts` (~480 LOC)
- Constants: `RUBRIC_SCHEMA_VERSION = 1 as const`, `GRADER_VERDICT_SCHEMA_VERSION = 1 as const`.
- Module header comment: document the v2 ladder pattern (`RubricSchemaV2` + `z.discriminatedUnion('version', …)` + `readRubric()` helper). No v2 code yet — comment is the contract.
- `RubricSchemaV1` (Zod): `version: z.literal(1)`, `source: z.enum(['auto','user','edited'])`, `generatedAt: z.string().datetime()`, `planSlug`, `goal`, `criteria: z.array(...).min(3).max(15)`, `engine: z.string().optional()`.
- Each criterion: `id` (regex `^c\d+$`), `description: z.string().min(10)`, `weight: z.number().min(0).max(1).optional()`, `evidenceHint: z.string().optional()`.
- `PerCriterionVerdictSchema`: `criterionId`, `status: z.enum(['met','unmet','partial'])`, `evidence: z.string()`, `gaps: z.array(z.string())`.
- `GraderVerdictSchemaV1`: `version: z.literal(1)`, `status: z.enum(['satisfied','needs_revision','max_iterations_reached','failed'])`, `iteration: z.number().int().min(1)`, `perCriterion`, `explanation`, `modelUsed: z.enum(['codex','claude'])`, `durationMs`, `timestamp`, `details: z.record(z.string(), z.unknown()).optional()`, `persistence: z.enum(['ok','failed']).optional()`.
- `parseRubricFrontmatter(raw: string)`: split on `---\n…\n---\n`, parse YAML, validate with `RubricSchemaV1`. Throws `FlywheelError({code:'rubric_synth_invalid'})` with sanitized cause on parse failure.
- Export types: `Rubric`, `GraderVerdict`, `PerCriterionVerdict`.
- Document `evidenceHint` threat model (path-traversal): never read, only displayed.
- **Acceptance:** Schema round-trip tests (parse → JSON.stringify → parse → deepEqual); `engine` and `details` tolerate omission and arbitrary string values.

**T3 — Atomic file-write helper.** `depends_on: [T2]`
- File: `mcp-server/src/atomic-write.ts` (new, ~50 LOC) — co-located for future reuse.
- Export `writeAtomic(filePath, content)`: `mkdir(dir, recursive:true)` → `writeFile(tmp = filePath + '.tmp', content)` → `rename(tmp, filePath)`.
- Document: rename is atomic on POSIX; reader sees old or new, never half-file. `completion-report.ts:291`'s naive `writeFile` is **not** retrofitted (different call pattern, no concurrent reader).
- Helper functions in `outcome-grading.ts`: `writeRubricFile(cwd, rubric, body)` and `writeVerdictFile(cwd, planSlug, iteration, verdict)` go through `writeAtomic`.
- **Acceptance:** Crash-mid-write test using `vi.mock('node:fs/promises')` to throw between tmp-write and rename; assert no `rubric.md` exists (only orphan `.tmp`); next call recovers cleanly.

**T4 — Additive state fields on `FlywheelState`.** `depends_on: [T1]`
- File: `mcp-server/src/types.ts` (around line 395)
- Additive fields (all optional except clamping defaults):
  ```ts
  outcomeRubricPath?: string;
  outcomeGradingSkipped?: boolean;
  outcomeGradingHistory?: Array<{
    iteration: number;
    verdict: GraderVerdict;
    timestamp: string;
  }>;                                  // capped at 5 cycles (Tension #4)
  maxOutcomeIterations?: number;       // bounded [1, 5]; default 3 at read
  cycleStartSha?: string;
  cycleEndTestOutput?: string;         // capped 10K chars at write
  ```
- `state.ts` / `session-state.ts` already use `.passthrough()`; confirm checkpoints from v3.11.x and v3.12.x load with all new fields `=== undefined`.
- `getMaxOutcomeIterations(state)` helper: returns `Math.min(5, Math.max(1, state.maxOutcomeIterations ?? 3))`.
- **Acceptance:** Existing state tests pass with no diff; new migration test (T17) passes; clamp enforces `[1, 5]`.

### Phase B — Server logic + tools

**T5 — Implement `synthesizeRubric()`.** `depends_on: [T2, T3]`
- In `outcome-grading.ts`.
- Compute `planContentSha = sha256(readFile(planPath))`. If `rubric.md` exists, frontmatter `source !== 'edited' && source !== 'user'`, and sidecar `.pi-flywheel/plans/<slug>/.rubric.lock` records the same `planContentSha` → return cached `{rubricPath, rubric, source: 'cached'}` without re-spawning synthesizer. `force=true` overrides.
- **`source: 'edited' || 'user'` guard:** auto-synth never overwrites operator edits. Only an explicit `force=true` from the Regenerate path overwrites.
- Spawn synthesizer subagent via `Agent()` (same model as orchestrator — D22) with prompt template (literal, no string injection from plan content into command-args; plan body is the *user message*, not concatenated into prompt path):
  > "Read this plan and produce a rubric of 5–10 criteria. Each criterion must be (a) testable, (b) directly attributable to a file or behavior change, (c) <140 chars in description. Output ONLY YAML frontmatter matching this Zod schema: {schema dump}. Examples of bad criteria: 'code is good', 'tests pass'. Examples of good: 'mcp-server/src/outcome-grading.ts exports RubricSchemaV1 and parses round-trips'."
- Parse output, validate with `RubricSchemaV1`. On parse failure → `throwFlywheelError({code:'rubric_synth_invalid', cause: sanitizedZodIssues})`.
- Edit-action variant (`action: 'edit'`): apply edit-intent to current rubric, set `source: 'edited'`, validate, atomic-write. On Zod failure → return structured error WITHOUT overwriting (D15).
- Validate-action variant: parse current `rubric.md`, return criteria count + source + warnings; no write.
- Regenerate-action variant: explicit override; ignores `source: edited` guard.
- Atomic-write `rubric.md` via `writeRubricFile`; update `.rubric.lock` with new `planContentSha`.
- Set `state.outcomeRubricPath`.
- **Acceptance:** Two synth calls with identical plan content produce identical rubric (deepEqual); `force=true` blows cache; `source: edited` is never overwritten by default; broken edit returns structured error without overwriting file.

**T6 — Implement `gradeOutcome()`.** `depends_on: [T2, T3, T4]`
- In `outcome-grading.ts`.
- **In-memory mutex per planSlug** (D13): `const graderLocks = new Map<string, Promise<...>>()`. If a grade call arrives while another is in flight for the same slug → throw `concurrent_grade`.
- **Skip short-circuit:** if `state.outcomeGradingSkipped === true` → return sentinel `{ status: 'skipped', reason: 'operator-skipped-at-plan-approve', iteration: 0 }`. NOT a `GraderVerdict` (caller branches on `'skipped' in result`).
- **Iteration-file-exists guard** (D6): compute `iteration = (state.outcomeGradingHistory?.length ?? 0) + 1`. If `iteration-<N>.json` exists → throw `verdict_invalid` with hint "Pass force=true to re-grade, or delete the existing file." `force=true` overrides.
- **`cycleStartSha` recovery ladder** (D1, robustness's tighter version):
  ```
  state.cycleStartSha
    ?? checkpoint.gitHead
    ?? exec("git log -n 1 --before=<checkpoint.timestamp> --format=%H").stdout.trim()
    ?? exec("git rev-parse HEAD~50").stdout.trim()
  ```
  If 3rd or 4th tier fires → log `cycle_start_sha_unset` warn-level event, tag `verdict.details.cycleStartShaSource: 'fallback_<tier>'`. **Never** default to `HEAD` (false `satisfied` from empty diff).
- **Build grader prompt** (D23, dynamic budget D9 from robustness):
  - Always: rubric frontmatter (~2K) + `git log <range> --oneline` (~1K) + `git diff <range> --stat` (~2K).
  - Diff body: include if total prompt + diff < context limit. If total diff > 30K chars → truncate to "first 15K + last 15K + `[TRUNCATED: 30K limit; full file list below]`".
  - Test output: include if budget allows; cap at 10K chars (truncate end). Priority: `npm test` > `lint` > `typecheck`.
  - Explicit "blind auditor" preamble (verbatim from D8 + robustness): "You are a blind auditor. You have not seen the implementation conversation. You see only the rubric, the git diff range, and the test output. Return ONLY a JSON object matching GraderVerdictSchemaV1. Do not include prose. If the diff was truncated, note it in `explanation`."
- **Grader spawn** (D8, T1.1 from robustness):
  1. Check doctor `codex_cli` health.
  2. If green → `codex exec --model "${FW_GRADER_MODEL ?? 'gpt-5.5'}" --json` with `timeout: FW_GRADER_TIMEOUT_MS ?? 120_000` and propagated `AbortSignal`.
  3. If non-zero exit / timeout / non-JSON / doctor not green → fallback: `Agent({subagent_type: 'general-purpose', prompt: <preamble + rubric + diff>})`.
  4. Record `modelUsed: 'codex' | 'claude'` in verdict.
  5. **SIGTERM/SIGKILL escalation** (D10): if codex hangs past timeout, send SIGTERM, wait 5s, SIGKILL. AbortSignal cancels immediately.
- **Verdict parse** (D11): `GraderVerdictSchemaV1.parse(JSON.parse(stdout))`. On failure: try regex-extract a JSON object from prose first (`/\{[\s\S]*\}/`); if that fails → one auto-retry with verbatim re-prompt: "Your previous output was not valid JSON. Return ONLY the GraderVerdictSchemaV1 JSON object. Do not include prose." On second failure → `verdict_invalid`.
- **Iteration-cap coercion** (D7, load-bearing):
  ```ts
  const cap = getMaxOutcomeIterations(state);
  if (verdict.iteration >= cap && verdict.status === 'needs_revision') {
    verdict.status = 'max_iterations_reached';
  }
  ```
- **Atomic write + state append** (D4, D12): `writeVerdictFile(...)` → push to `state.outcomeGradingHistory` (capped at last 5 cycles via FIFO eviction, Tension #4) → `saveState(state)`. **Order matters:** file lands first; crash between write and saveState leaves recoverable on-disk record.
- **Disk-full graceful degrade** (D12): if `writeVerdictFile` throws `ENOSPC` / `EROFS` → continue with `verdict.persistence = 'failed'`, return verdict in-memory, log warning.
- Release in-memory mutex in `finally` block.
- **Acceptance:** All 4 verdict statuses round-trip; iteration cap coercion test (grader returns `needs_revision` at iter=3 → result has `status='max_iterations_reached'`); existing `iteration-N.json` refuses without `force=true`; concurrent calls return `concurrent_grade` for the second; SIGKILL fires after SIGTERM grace; disk-full returns verdict with `persistence: 'failed'`.

**T7 — Tool wrapper `flywheel_synthesize_rubric`.** `depends_on: [T5]`
- File: `mcp-server/src/tools/synthesize-rubric.ts` (~110 LOC)
- Args (Zod): `{ cwd, planSlug?, planPath?, action?: z.enum(['synthesize','validate','edit','regenerate']).default('synthesize'), editIntent?: { kind: 'tighten'|'add'|'remove'|'custom', text: string }, force?: boolean }`.
- Calls `synthesizeRubric()`; returns `makeOkToolResult({ rubricPath, rubric, source, kind: 'rubric_synthesized' | 'rubric_preserved' | 'rubric_edited' })` envelope on success; `makeFlywheelErrorResult` on caught FlywheelError.
- **Acceptance:** Tool returns valid `version: 1` envelope; all action variants round-trip; `force` flag overrides cache; preserve-edited path returns `kind: 'rubric_preserved'`.

**T8 — Tool wrapper `flywheel_grade_outcome`.** `depends_on: [T6]`
- File: `mcp-server/src/tools/grade-outcome.ts` (~150 LOC)
- Args (Zod): `{ cwd, planSlug?, force?: boolean }`. Slug derived from `state.outcomeRubricPath` if omitted.
- Discriminator on result: `kind: 'grader_verdict' | 'grading_skipped' | 'grading_capped' | 'grading_timeout' | 'grading_persistence_failed'`.
- Surfaces skip sentinel as `kind: 'grading_skipped'` (data block, not error).
- Surfaces timeout as `kind: 'grading_timeout'` with `error.code: 'grader_timeout'` AND `data.retryable: true`.
- Surfaces disk-full degrade as `kind: 'grading_persistence_failed'` (verdict still returned).
- **Acceptance:** Returns `version: 1` envelope on every result path; all discriminators tested.

**T9 — Register both tools in `server.ts`.** `depends_on: [T7, T8]`
- File: `mcp-server/src/server.ts`
- Add to tool registry alphabetically (between `flywheel_review` and `flywheel_select`).
- Update `flywheel_doctor`'s `mcp_connectivity` inventory to expect 2 new tools.
- **Acceptance:** Server starts; both tools appear in doctor inventory.

### Phase C — Skill + doctor wiring

**T10 — Plan-approve hook in `_planning.md` Step 5.6.** `depends_on: [T7]`
- File: `skills/start/_planning.md`
- After plan-ready gate's "Create beads" branch fires:
  1. Call `flywheel_synthesize_rubric` (default action: synthesize).
  2. Print rubric preview (verbatim §"Rubric Preview"): `Outcome rubric drafted at <rubric-path> with <N> criteria. Source: <auto|edited|user>.`
  3. Surface `AskUserQuestion` (verbatim §"Rubric Gate"): Approve / Edit inline / Regenerate / Skip rubric.
  4. On Edit inline: surface follow-up `AskUserQuestion` (verbatim §"Edit Inline Follow-Up"): Tighten / Add / Remove / Custom + Other text.
  5. Apply edit via `flywheel_synthesize_rubric(action: 'edit', editIntent: ...)`. On Zod-parse failure → recovery `AskUserQuestion` (verbatim §"Edit Parse Failure"): Re-edit / Regenerate from scratch / Abort.
  6. On Skip: set `state.outcomeGradingSkipped = true` (cleared at next `flywheel_select`).
  7. On Regenerate: `flywheel_synthesize_rubric(action: 'regenerate', force: true)`.
- Existing Plan-ready menu (Create beads / Refine plan / Review plan / Start over) unchanged (D14, Tension #2).
- **Acceptance:** `npm run lint:skill` passes; UNIVERSAL RULE 1 (`AskUserQuestion`) honored on every branch; no prose-only "ask the user" decision points.

**T11 — Wrap-up hook in `_wrapup.md` Step 9.5.** `depends_on: [T8, D5 spawn-task]`
- File: `skills/start/_wrapup.md`
- Before commit-review:
  1. Call `flywheel_grade_outcome`.
  2. If `kind: 'grading_skipped'`: print verbatim §"Skipped notice", continue to existing wrap-up question.
  3. If `kind: 'grader_verdict'`:
     - Render verdict-table (D17, server-side helper `renderVerdictTable(verdict)` in `outcome-grading.ts`): markdown table of `criterion | status | gap` (only unmet/partial rows; gap truncated to 120 chars).
     - Print verdict surface (verbatim §"Step 9.5 Verdict Surface"): grade line + grader line + verdict file path + table.
     - If `modelUsed: 'claude'`: print Codex-fallback notice (verbatim §"Fallback notice", D18).
     - Branch on `verdict.status`:
       - `satisfied` → continue to existing wrap-up question.
       - `needs_revision` AND `iteration < cap`: surface `AskUserQuestion` (verbatim §"Question for needs_revision"): Iterate / Accept anyway / Abort.
       - `needs_revision` AND `iteration >= cap` (should never reach via D7 coercion, defensive): surface `max_iterations_reached` branch.
       - `max_iterations_reached`: surface `AskUserQuestion` (verbatim §"Question for max_iterations_reached"): Accept anyway / Abort (no Iterate).
       - `failed`: print `verdict.explanation`, surface Abort with hint to edit `rubric.md`.
  4. If `kind: 'grading_timeout'`: surface `AskUserQuestion` (verbatim §"Timeout Surface"): Retry grading / Accept without grade / Abort.
  5. If `kind: 'grading_persistence_failed'`: print verdict in-line, warn "verdict not persisted to disk", continue with verdict-aware branches above.
  6. On Iterate (D5, D19): for each `verdict.perCriterion.filter(c => c.status !== 'met')`, call `flywheel_approve_beads(action: 'remediate', criterion: c)` to create one bead per criterion using verbatim §"Remediation Bead Template". Increment `state.iterationRound`. Route back to Step 6.
- **Acceptance:** `npm run lint:skill` passes; all 5 verdict-status branches + 3 result-kind branches covered; Iterate option only surfaced when `iteration < cap` AND `needs_revision`; remediation creates 1 bead per failing criterion (gaps folded into acceptance criteria, not 1 bead per gap).

**T12 — Doctor `outcome_rubric_validity` check.** `depends_on: [T2]`
- File: `mcp-server/src/tools/doctor.ts`
- Add to `DOCTOR_CHECK_NAMES` and `runDoctorChecks`.
- Logic:
  - No active plan / no `state.outcomeRubricPath` → green with message `no active rubric - outcome grading not applicable`.
  - `rubric.md` parses, criteria.length > 0 → green with message `outcome rubric valid (<N> criteria, source <auto|edited|user>)`.
  - File missing → yellow with message `outcome rubric path is set but the file is missing: <path>` + hint (verbatim §"Doctor Hints").
  - Frontmatter Zod fails → yellow with message `outcome rubric invalid: <short parse error>` + same hint.
  - Frontmatter parses but criteria.length === 0 → red with message `outcome rubric has zero criteria` + hint.
- All hints from verbatim §"Doctor Hints" (≤140 chars, capitalized, ends with `.`, actionable).
- **Acceptance:** Round-trip test (write rubric → run doctor → green; corrupt rubric → yellow; criteria=[] → red). CI hint-quality assertions pass.

**T13 — `cycleStartSha` capture + cycle-state reset in `flywheel_select`.** `depends_on: [T4]`
- File: `mcp-server/src/tools/select.ts`
- At goal-set time (after phase transitions to `planning`):
  ```ts
  state.cycleStartSha = (await exec('git', ['rev-parse', 'HEAD']).stdout.trim()) || undefined;
  state.outcomeGradingSkipped = undefined;
  state.outcomeRubricPath = undefined;
  state.outcomeGradingHistory = undefined;  // OR: append-only with last-5 FIFO if Tension #4 resolves to "keep history"
  ```
- On `git rev-parse` failure (detached HEAD, no commits, dirty): leave `cycleStartSha` undefined, let the recovery ladder fire at grade time. Log warn-level `cycle_start_sha_unset` if entire ladder eventually fires.
- **Acceptance:** Existing `flywheel_select` tests pass; new test asserts `cycleStartSha` captured and old cycle-state reset.

### Phase D — Tests

**T14 — Unit tests `outcome-grading.test.ts`.** `depends_on: [T2, T3, T6]`
- File: `mcp-server/src/__tests__/outcome-grading.test.ts` (~360 LOC)
- Test cases:
  1. Schema round-trips (`Rubric` + `GraderVerdict`, all 4 statuses + skip sentinel).
  2. Iteration cap coercion: grader returns `{status:'needs_revision', iteration:3}` with `cap=3` → result `status='max_iterations_reached'`.
  3. Idempotent synth: same plan content → same rubric (deepEqual). `force=true` re-synths.
  4. Operator-edited rubric (`source: 'edited'`) never overwritten by default-action synth.
  5. Atomic write crash-recovery: mock `fs.rename` to throw; assert no `rubric.md` exists (orphan `.tmp` only); next call recovers.
  6. Existing `iteration-N.json` refuses without `force=true`.
  7. `cycleStartSha` 4-tier fallback ladder (state-set / checkpoint-set / git-log-by-time / `HEAD~50`) — each tier triggers correct breadcrumb tag.
  8. Diff truncation at 30K + truncation marker present.
  9. Test-output truncation at 10K.
  10. Concurrent mutex: 2 parallel `gradeOutcome` calls → second returns `concurrent_grade`.
  11. SIGTERM/SIGKILL escalation: mock hung process → SIGTERM → 5s wait → SIGKILL.
  12. Prose-leakage recovery: regex extracts JSON from `Here is your verdict: {...}`; if extraction fails, retry once with verbatim re-prompt.
  13. Disk-full degrade: mock ENOSPC → verdict returned with `persistence: 'failed'`.

**T15 — Tool-wrapper tests.** `depends_on: [T7, T8]`
- Files: `mcp-server/src/__tests__/synthesize-rubric.test.ts` (~140 LOC), `grade-outcome.test.ts` (~220 LOC).
- Each new error code has at least one test asserting:
  - `data.error.code === <code>`.
  - `data.error.hint === DEFAULT_HINTS[code]` when call site doesn't override.
  - `data.error.retryable === DEFAULT_RETRYABLE[code]`.
- Skip sentinel return shape (`kind: 'grading_skipped'`).
- `version: 1` envelope on every result path (success + error + skipped + capped + timeout + persistence_failed).
- All `action` variants of `synthesize-rubric` round-trip.
- Edit-failure recovery: malformed edit → returns structured error WITHOUT overwriting file.

**T16 — Doctor check test.** `depends_on: [T12]`
- File: `mcp-server/src/__tests__/doctor-outcome-rubric-validity.test.ts` (~100 LOC)
- Green / yellow (file missing) / yellow (parse fail) / red (criteria empty) round-trip.
- Hint exact-match assertions against `DEFAULT_HINTS` and verbatim §"Doctor Hints".

**T17 — Migration safety test.** `depends_on: [T4]`
- File: `mcp-server/src/__tests__/fixtures/checkpoint-v3.12.json` + loader test in existing `state.test.ts` or new `migration.test.ts`.
- Load checkpoint with no outcome-grading fields; assert load succeeds; all new fields `=== undefined`; `getMaxOutcomeIterations` returns default `3`.

### Phase E — Docs / release

**T18 — Update `AGENTS.md`.** `depends_on: [T9, T10, T11, T12, T13]`
- File: `AGENTS.md`
- New "Outcome Grading" section under Phase 12 (or its own Phase 13).
- Add `flywheel_synthesize_rubric` and `flywheel_grade_outcome` to the MCP tools quick-reference table.
- If D5 resolves to "add `remediate` action": document `flywheel_approve_beads(action: 'remediate')` in the same table.
- Document `cycleStartSha` capture point (`flywheel_select`, OQ-A resolution).
- Document `Skip rubric` semantics (one-cycle, OQ-B resolution).
- Document env knobs: `FW_GRADER_TIMEOUT_MS` (default 120000), `FW_GRADER_MODEL` (default `gpt-5.5`), `FW_MAX_OUTCOME_ITERATIONS` (default 3, bounded [1,5]).
- Distinguish `flywheel_review` (per-bead reviewer) from cycle-level outcome grading.

**T19 — `CHANGELOG.md` + version bump.** `depends_on: [T18]`
- File: `CHANGELOG.md`, `mcp-server/package.json`
- Entry for v3.13.0:
  - feat: outcome grading — whole-cycle rubric + decorrelated grader + iteration loop.
  - feat: `flywheel_synthesize_rubric` and `flywheel_grade_outcome` MCP tools.
  - feat: doctor check `outcome_rubric_validity`.
  - feat: 8 new structured error codes.
  - chore: additive state fields with v3.12.x checkpoint compatibility.

---

## Per-task acceptance criteria

| Task | "Done" looks like | Test/file reference |
|---|---|---|
| T1 | 8 new codes in `FLYWHEEL_ERROR_CODES`, all with hint+retryable defaults; `error-contract.test.ts` green. | `errors.ts`, `error-contract.test.ts` |
| T2 | `RubricSchemaV1` + `GraderVerdictSchemaV1` parse-round-trip tests green; module-header v2 ladder comment present. | `outcome-grading.ts`, `outcome-grading.test.ts` cases 1 |
| T3 | Crash-mid-write test green; `writeAtomic` exported and used by both `writeRubricFile` + `writeVerdictFile`. | `atomic-write.ts`, `outcome-grading.test.ts` case 5 |
| T4 | Migration fixture loads with `=== undefined` for new fields; `getMaxOutcomeIterations` clamps to [1,5]. | `types.ts`, T17 fixture |
| T5 | Idempotent synth + force-override + edit-preserve all round-trip. | `outcome-grading.test.ts` cases 3, 4 |
| T6 | All 4 verdict statuses + skip sentinel + iteration-cap coercion + concurrent mutex + SIGKILL + JSON recovery + disk-full degrade all tested. | `outcome-grading.test.ts` cases 2, 6–13 |
| T7 | All `action` variants + `force` flag round-trip; `version: 1` envelope on every path. | `synthesize-rubric.test.ts` |
| T8 | All 5 `kind` discriminators round-trip; error codes match defaults; envelope `version: 1`. | `grade-outcome.test.ts` |
| T9 | Server starts; both tools in doctor inventory. | `server.ts`, `flywheel_doctor` integration test |
| T10 | `npm run lint:skill` green; all 4 rubric-gate options + edit-inline follow-up + parse-failure recovery wired. | `_planning.md`, lint output |
| T11 | All 5 verdict-status branches + 3 result-kind branches covered; Iterate gated on `iteration < cap`; remediation 1-bead-per-criterion. | `_wrapup.md`, lint output |
| T12 | Green/yellow/red round-trip; hints match verbatim section. | `doctor.ts`, `doctor-outcome-rubric-validity.test.ts` |
| T13 | New `flywheel_select` test asserts `cycleStartSha` set + old state reset. | `select.ts`, existing `select.test.ts` |
| T14 | All 13 unit cases green. | `outcome-grading.test.ts` |
| T15 | All error codes + skip + cap + timeout + envelope assertions green. | `synthesize-rubric.test.ts`, `grade-outcome.test.ts` |
| T16 | Green/yellow/red + hint-exact assertions green. | `doctor-outcome-rubric-validity.test.ts` |
| T17 | v3.12.x checkpoint loads; all new fields undefined; clamp default 3. | `fixtures/checkpoint-v3.12.json`, `migration.test.ts` |
| T18 | AGENTS.md "Outcome Grading" section present; quick ref updated; env knobs + OQ resolutions documented. | `AGENTS.md` |
| T19 | CHANGELOG entry + version bump to v3.13.0. | `CHANGELOG.md`, `mcp-server/package.json` |

---

## File-level changes table

| Path | Kind | Est. LOC | Notes |
|---|---|---|---|
| `mcp-server/src/outcome-grading.ts` | new | ~480 | Schemas + synth + grade + helpers + verdict-table render + mutex |
| `mcp-server/src/atomic-write.ts` | new | ~50 | `writeAtomic` for rubric.md + iteration-N.json |
| `mcp-server/src/tools/synthesize-rubric.ts` | new | ~110 | MCP wrapper, all `action` variants |
| `mcp-server/src/tools/grade-outcome.ts` | new | ~150 | MCP wrapper with 5 result kinds |
| `mcp-server/src/__tests__/outcome-grading.test.ts` | new | ~360 | 13 test cases |
| `mcp-server/src/__tests__/synthesize-rubric.test.ts` | new | ~140 | Tool envelope + all action variants |
| `mcp-server/src/__tests__/grade-outcome.test.ts` | new | ~220 | Tool envelope + all 5 kinds + error codes |
| `mcp-server/src/__tests__/doctor-outcome-rubric-validity.test.ts` | new | ~100 | Green/yellow/red + hints |
| `mcp-server/src/__tests__/migration.test.ts` | new | ~50 | v3.12.x checkpoint load |
| `mcp-server/src/__tests__/fixtures/checkpoint-v3.12.json` | new | ~40 | Migration fixture |
| `mcp-server/src/errors.ts` | edit | +~60 | 8 new codes + DEFAULT_HINTS + DEFAULT_RETRYABLE |
| `mcp-server/src/types.ts` | edit | +~15 | FlywheelState additive fields + helper |
| `mcp-server/src/state.ts` | edit | +~5 | Confirm passthrough load (no diff expected) |
| `mcp-server/src/session-state.ts` | edit | +~5 | Same |
| `mcp-server/src/server.ts` | edit | +~25 | Register 2 tools (3 if D5 → add `remediate`) |
| `mcp-server/src/tools/doctor.ts` | edit | +~80 | `outcome_rubric_validity` check |
| `mcp-server/src/tools/select.ts` | edit | +~30 | `cycleStartSha` capture + cycle-state reset |
| `mcp-server/src/tools/approve-beads.ts` | edit | +~40 | (Conditional D5) `remediate` action |
| `skills/start/_planning.md` | edit | +~50 | Step 5.6 routing + edit-inline + parse-failure recovery |
| `skills/start/_wrapup.md` | edit | +~90 | Step 9.5 routing + verdict-table + iterate/accept/abort + timeout |
| `skills/start/SKILL.md` | edit | +~25 | Step 0c banner extension (7-state matrix) |
| `AGENTS.md` | edit | +~100 | Outcome Grading section + quick-ref + env knobs |
| `CHANGELOG.md` | edit | +~30 | v3.13.0 entry |
| `mcp-server/package.json` | edit | 1 | Version bump |

**Total new LOC:** ~1700 (3 source ~370 LOC each + 6 test files ~870 LOC + ~10 edits ~530 LOC).

---

## Risk register

| # | Risk | Source | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | A future schema change accidentally mutates `RubricSchemaV1` and breaks existing rubric files. | Correctness R1 | Low | Module-header v2 ladder comment freezes V1; corpus of fixture rubric files in `outcome-grading.test.ts` must continue parsing; new constraints land as `RubricSchemaV2` only. |
| R2 | Grader returns `needs_revision` past the iteration cap because LLM ignores stop condition. | Correctness R2 | Medium | Hard server-side coercion in T6 — `verdict.status` overwritten to `max_iterations_reached` before write; tested directly. |
| R3 | Crash mid-`writeFile` of `rubric.md` leaves a half-file the grader reads. | Correctness R3 + Robustness T3.1 | Medium | T3 atomic write helper; POSIX rename atomic; mocked-fs test verifies recovery. |
| R4 | Existing v3.11.x / v3.12.x checkpoints fail to load after this lands. | Correctness R4 | Low | All new fields `.optional()`; `state.ts` already uses `.passthrough()`; T17 fixture-based migration test gates the change. |
| R5 | `cycleStartSha` missing for resumed pre-v3.13.0 sessions → empty diff → false `satisfied` verdict. | Correctness R5 + Robustness T2.1 | Medium | 4-tier fallback ladder with `details.cycleStartShaSource` breadcrumb. **Never** default to `HEAD`. `cycle_start_sha_unset` warn surfaces in `flywheel_observe`. |
| R6 | Operator hand-edits `rubric.md`; auto-synth overwrites edits. | Correctness R6 + Ergonomics | Medium | `planContentSha`-keyed cache + `source: 'edited' || 'user'` guard. Only `force=true` (Regenerate) overwrites. |
| R7 | Two grader processes race on same `iteration-N.json`. | Correctness R7 + Robustness T3.2 | Low | In-memory mutex per planSlug → `concurrent_grade`. File-exists guard as second line of defense. |
| R8 | `evidenceHint` contains path-traversal payload that leaks outside cwd. | Correctness R8 | Very low | `evidenceHint` is `z.string().optional()` — never read, only displayed. Documented in module comment. Grader prompt does not exec hint content. |
| R9 | Grader hits `exec_timeout` and wrap-up phase hangs. | Correctness R9 + Robustness T1.2 | Medium | `FW_GRADER_TIMEOUT_MS` (default 120s) + `AbortSignal` propagation + SIGTERM/SIGKILL escalation. Surface as `grader_timeout` (retryable=true). Operator chooses Retry / Accept / Abort. |
| R10 | Schema-version drift — downstream tool reads `iteration-N.json` assuming v1 but v2 file present. | Correctness R10 | Low | Discriminated-union reader pattern documented in T2 module comment; v1 readers reject v2 with clear error. |
| R11 | Grader hallucinates on truncated diff (sees only first 15K + last 15K). | Robustness Risk #1 | High | Truncation marker present in prompt; full file list + `git diff --stat` always included; grader explicitly asked to flag truncation in `verdict.explanation`. |
| R12 | Context-window overflow (rubric + diff + tests > limit). | Robustness Risk #2 | Medium | Dynamic budget priority: Rubric > Diff Stat > Diff Body (truncated) > Test Output. |
| R13 | State/git drift mid-grade (HEAD moves during 120s grade). | Robustness Risk #3 | Low | Grader receives SHAs, verdict is pinned to the SHAs captured at tool-start. |
| R14 | Disk full / EROFS on verdict write. | Robustness Risk #4 | Low | Return verdict in-memory tagged `persistence: 'failed'`; warn operator. |
| R15 | Weak decorrelation in fresh-CC fallback (still Claude family). | Robustness Risk #5 | Low | "Blind auditor" preamble + empty-context guarantee + visible fallback notice in verdict surface (operator can re-grade with codex when restored). |
| R16 | Subprocess zombie on hung grader. | Robustness Risk #6 | Medium | SIGKILL after 5s SIGTERM grace. |
| R17 | Operator skips rubric every cycle, defeating the gate. | Spec Risk + Ergonomics | Medium | One-cycle skip (no sticky default); CASS learning records consecutive skips; after 3 → "Skip" surfaces as Recommended (but never silently). |
| R18 | Grader "prose leakage" — JSON wrapped in commentary. | Robustness | Medium | `--json` flag for codex + Zod safeParse + regex JSON extraction + one auto-retry with verbatim "JSON only" re-prompt. |
| R19 | Edit-inline path produces malformed YAML and operator can't recover. | Ergonomics + my add | Medium | Edit-failure recovery loop: `Re-edit / Regenerate from scratch / Abort` AskUserQuestion. **Never** silently overwrite. |
| R20 | Iterate creates 4× bead inflation when one criterion has 4 gaps. | Ergonomics E8 | Low | One bead per criterion; gaps folded into acceptance criteria. |
| R21 | `outcomeGradingHistory` grows unbounded across cycles, bloating checkpoint. | My add (Tension #4) | Low | FIFO cap at last 5 cycles in `outcomeGradingHistory` (per Tension #4 default). |

---

## Testing strategy

### Unit coverage matrix

| Area | Test file | Cases |
|---|---|---|
| Schema round-trip | `outcome-grading.test.ts` | Rubric (auto/edited/user); GraderVerdict (4 statuses + skip sentinel); details + persistence optional fields |
| Idempotency | `outcome-grading.test.ts` | Same plan content → same rubric; `force=true` re-synths; `source: 'edited'` preserved |
| Atomic write | `outcome-grading.test.ts` | Mocked fs.rename throw → no `rubric.md`, only orphan `.tmp`; recovery on next call |
| Iteration cap | `outcome-grading.test.ts` | grader returns `needs_revision` at iter=3, cap=3 → result `max_iterations_reached` |
| Cycle-start fallback | `outcome-grading.test.ts` | All 4 tiers (state-set / checkpoint-set / git-log-by-time / `HEAD~50`); never defaults to `HEAD` |
| Concurrent mutex | `outcome-grading.test.ts` | `Promise.all([gradeOutcome(slug), gradeOutcome(slug)])` → second returns `concurrent_grade` |
| SIGTERM/SIGKILL | `outcome-grading.test.ts` | Mock hung process; SIGTERM → 5s wait → SIGKILL |
| Truncation | `outcome-grading.test.ts` | 100K diff → 15K start + 15K end + marker; 50K test output → 10K + truncation |
| JSON recovery | `outcome-grading.test.ts` | Prose-wrapped JSON → regex extraction; pure-prose → re-prompt → second pure-prose → `verdict_invalid` |
| Disk-full degrade | `outcome-grading.test.ts` | Mock ENOSPC → verdict returned with `persistence: 'failed'` |
| Tool envelopes | `synthesize-rubric.test.ts`, `grade-outcome.test.ts` | All `action` variants + 5 `kind` discriminators + `version: 1` envelope on every path |
| Error codes | `synthesize-rubric.test.ts`, `grade-outcome.test.ts` | Each new code has code+hint+retryable assertion against `DEFAULT_HINTS` / `DEFAULT_RETRYABLE` |
| Doctor | `doctor-outcome-rubric-validity.test.ts` | Green / yellow (missing) / yellow (parse fail) / red (criteria=[]) + hint exact-match |
| Migration | `migration.test.ts` | v3.12.x checkpoint loads; all new fields undefined; `maxOutcomeIterations` defaults to 3 |

### Integration coverage

- **End-to-end planning** → `_planning.md` Step 5.6 routing covers Approve / Edit / Regenerate / Skip + edit-failure recovery (skill-test harness).
- **End-to-end wrap-up** → `_wrapup.md` Step 9.5 covers all 5 verdict-status branches + 3 result-kind branches (skill-test harness).
- **Doctor connectivity** → `flywheel_doctor` lists both new tools after T9.
- **Banner rendering** → 7 states from §"Banner Lines" round-trip in Step 0c rendering test.
- **Existing tests unchanged** → assert no diff in `flywheel_review`, `flywheel_verify_beads`, `flywheel_advance_wave`, `flywheel_convergence` test files.

### Out of scope for v1

- Live codex grader test (requires real `codex_cli` in CI; mocked process spawn sufficient).
- Cross-cycle correlation between `verdict.status` and `flywheel_convergence.score` (deferred per spec R4).
- Per-bead / per-wave rubrics (deferred per Brainstorm Q2).

---

## Resolved decisions

### OQ-A — `cycleStartSha` capture point

**Decision:** Capture in `flywheel_select` handler at goal-set time.

**Rationale:** Adopted from Correctness (T2.1, lines 27–34) and Robustness (T2.1) — 2 of 3 planners agree. Three correctness reasons outweigh ergonomics's "graded changes since plan registration" framing:

1. `flywheel_select` is unambiguously *before* any work this cycle could have created. `flywheel_plan` runs after discovery may have written to disk (`docs/discovery/*.md`, brainstorms); using its tick as start would make those artifacts invisible to the grader.
2. `flywheel_select` is called exactly once per cycle (transitions phase to `planning`); `flywheel_plan` can be called many times in `mode=duel`, retry paths, picked-up-plan menu. Once-and-only-once is structurally easier at `select`.
3. Recovery is cheaper at the earlier point — if `select` is bypassed (resumed session), checkpoint already has `gitHead` from `flywheel_observe`'s state snapshot.

**Recovery ladder** (in `flywheel_grade_outcome`, expanded with robustness's tier-3):

```
state.cycleStartSha
  ?? checkpoint.gitHead
  ?? exec("git log -n 1 --before=<checkpoint.timestamp> --format=%H").stdout.trim()
  ?? exec("git rev-parse HEAD~50").stdout.trim()
```

Tag the verdict with `details.cycleStartShaSource: 'state' | 'checkpoint' | 'git_log_before' | 'fallback_HEAD~50'` so consumers know the diff was bounded heuristically. **Never** silently default to `HEAD` (would produce empty diff and falsely `satisfied` verdict).

This decision **may change** based on Tension #1 — if the operator prefers the `flywheel_plan` framing, T13 swaps modules but the recovery ladder is unchanged.

### OQ-B — Skip-rubric stickiness

**Decision:** One-cycle skip; flag cleared at next `flywheel_select`.

**Rationale:** All three planners agree. The flag (`state.outcomeGradingSkipped`) is set by the rubric-gate's "Skip rubric" option and cleared in T13 alongside the other cycle-state resets.

CASS sticky behavior is strictly additive; can land in v1.1 follow-up reading per-cycle telemetry once we have data on how often Skip is picked. Ergonomics's added rule: after 3 consecutive skips, surface "Skip rubric" as Recommended next time — but **never silently skip** (R17 mitigation).

### OQ-C — `details` shape

**Decision:** `details: z.record(z.string(), z.unknown())` loose record.

**Rationale:** Adopted from Correctness OQ-C recommendation. Forward-compatible; current load is just `cycleStartShaSource`. Tighten to discriminated union when 2nd breadcrumb lands.

### OQ-D — Explicit `iteration` arg

**Decision:** Always derive `iteration` from `state.outcomeGradingHistory.length + 1`. No explicit `iteration` arg.

**Rationale:** Adopted from Correctness OQ-D. Explicit `iteration` is a footgun that lets a caller skip the cap. `force=true` is the escape hatch for re-grading the same iteration (with file-exists guard override).

### OQ-E — Duel-mode rubric

**Decision:** One consensus rubric per cycle (not per-agent in duel mode).

**Rationale:** Adopted from Correctness OQ-E. Rubric is whole-cycle; per-agent rubrics conflate generator decorrelation with verdict decorrelation.

### OQ-F — `cycleEndTestOutput` capture

**Decision:** Captured into state by the wrap-up test-runner hook (not read on-the-fly by `gradeOutcome`).

**Rationale:** Adopted from Correctness OQ-F. Keeps grader pure (no side-effect exec), clearer audit trail, capped at 10K chars at write time.

---

## Failure mode catalog

Ported from Robustness's catalog (lines 102–111), augmented with Correctness's idempotency edge cases and Ergonomics's UX recovery paths.

| Trigger | Detection | Recovery | Operator-visible surface |
|---|---|---|---|
| Codex `exec` times out | `exec` catches `Timed out` | Kill codex (SIGTERM 5s → SIGKILL); fallback to fresh-CC subagent | Log + `Grader notice: Codex unavailable; used a fresh Claude grader instead.` |
| Fresh-CC fallback times out | `exec` catches `Timed out` | Terminate; return `grader_timeout` (retryable=true) | `AskUserQuestion`: Retry grading / Accept without grade / Abort (verbatim §"Timeout Surface") |
| Grader returns prose | Zod parse fail; regex JSON extraction also fails | Retry once with verbatim "JSON only" re-prompt | If still fails → `verdict_invalid` error code + hint to inspect debug log |
| Diff > 30K chars | `unifiedDiff.length > 30000` | Truncate middle (15K start + 15K end + marker) | `verdict.explanation` flags truncation (R11 mitigation) |
| Test output > 10K | `testOutput.length > 10000` | Truncate end | `verdict.explanation` flags truncation |
| Process crash (SIGSEGV / non-timeout exit) | `res.code !== 0` | Fallback to fresh-CC immediately | "Primary grader process crashed; falling back to fresh Claude grader." |
| Disk full / EROFS on verdict write | `fs.writeFile` throws ENOSPC/EROFS | Return verdict in-memory with `persistence: 'failed'` tag | "Warning: Verdict generated but could not be persisted to disk: `<path>`." |
| `iteration-N.json` already exists | `fs.access` succeeds before write | Refuse with `verdict_invalid` unless `force=true` | Hint: "Pass force=true to re-grade, or delete the existing file." |
| Concurrent grade for same plan | In-memory mutex hit | Refuse with `concurrent_grade` | Hint: "Another grader is in flight for this plan; wait for it to complete." |
| `cycleStartSha` unset across full ladder | All 4 tiers return null | Tag `details.cycleStartShaSource: 'fallback_HEAD~50'` + warn `cycle_start_sha_unset` | Doctor surfaces `cycle_start_sha_unset` warn; verdict still produced (with caveat) |
| Operator-edited rubric fails Zod parse | `parseRubricFrontmatter` throws | Do NOT overwrite file; surface recovery `AskUserQuestion` | `Re-edit / Regenerate from scratch / Abort` (verbatim §"Edit Parse Failure") |
| Auto-synth re-runs after operator edit | `source: 'edited'` detected on read | Return cached `{source: 'cached', kind: 'rubric_preserved'}` without re-spawning synth | Print: `Outcome rubric already edited at <path>; preserving it unless you choose Regenerate.` |
| Synthesizer returns malformed YAML | Zod parse fails | `rubric_synth_invalid` error; one retry with hardened prompt; if still fails → operator surface | Hint: "Synthesizer returned non-conforming YAML — re-run with force=true, or hand-edit `rubric.md` and set `source: user`." |
| Both codex AND fresh-CC unhealthy | Doctor checks both red | `grader_unavailable` error | Hint: "Run /flywheel-doctor and remediate codex_cli or claude_cli." |
| Iteration cap hit with unmet criteria | T6 hard coercion fires | `verdict.status` rewritten to `max_iterations_reached` | `AskUserQuestion`: Accept anyway / Abort (NO Iterate) |

---

## Verbatim UI copy

Final-form strings, not paraphrased. Imported from Ergonomics's verbatim section, refined for this synthesis.

### Step 5.6 — Plan Ready Menu (existing, unchanged)

Question:

`Plan created (<N> lines, at <path>). What next?`

Options:

- `Create beads` — `Synthesize an outcome rubric, approve or edit it, then convert the plan into implementation beads (Recommended).`
- `Refine plan` — `Run a fresh refinement round to deepen the plan.`
- `Review plan` — `Open the plan file for manual review before proceeding.`
- `Start over` — `Discard this plan and pick a different goal.`

### Step 5.6 — Rubric Preview (printed before Rubric Gate)

After `flywheel_synthesize_rubric` returns:

`Outcome rubric drafted at <rubric-path> with <N> criteria. Source: <auto|edited|user>.`

If existing edited rubric is preserved (re-entry path):

`Outcome rubric already edited at <rubric-path>; preserving it unless you choose Regenerate.`

### Step 5.6 — Rubric Gate

Question:

`Outcome rubric ready (<N> criteria, source <auto|edited|user>). What should happen before bead creation?`

Options:

- `Approve rubric` — `Use this rubric for wrap-up grading and continue to Create beads (Recommended).`
- `Edit inline` — `Describe criteria to add, remove, or tighten; I will update rubric.md, validate it, and re-show this gate.`
- `Regenerate` — `Discard the current draft and synthesize a new rubric from the plan.`
- `Skip rubric` — `Skip outcome grading for this cycle only; wrap-up will record grading as skipped.`

### Step 5.6 — Edit Inline Follow-Up

Question:

`What should change in <rubric-path>? Use Other for the exact edit text.`

Options:

- `Tighten criteria` — `Make existing criteria more testable and file/behavior-specific (Recommended).`
- `Add criterion` — `Add one criterion from the Other field, then rebalance if weights exist.`
- `Remove criterion` — `Remove or merge criteria named in Other.`
- `Custom edit` — `Apply the precise edit instructions from Other.`

### Step 5.6 — Edit Parse Failure Recovery

Question:

`The edited rubric did not parse: <short parse error>. How should I recover?`

Options:

- `Re-edit` — `Keep the current file, apply a correction from Other, and validate again (Recommended).`
- `Regenerate from scratch` — `Overwrite the broken rubric with a fresh auto-generated rubric from the plan.`
- `Abort` — `Stop before bead creation so the rubric can be fixed manually.`

### Step 0c — Banner Lines (7-state matrix)

Valid rubric, no grading yet:

```text
 Rubric: 6 criteria
 Last grade: not run
```

Last grade has unmet criteria:

```text
 Rubric: 6 criteria
 Last grade: needs_revision @ iter 1 (3 unmet)
```

Last grade satisfied:

```text
 Rubric: 6 criteria
 Last grade: satisfied @ iter 1 (0 unmet)
```

Max iterations reached:

```text
 Rubric: 6 criteria
 Last grade: max_iterations_reached @ iter 3 (2 unmet)
```

Grading failed:

```text
 Rubric: 6 criteria
 Last grade: failed @ iter 1 (unknown unmet)
```

Rubric skipped this cycle:

```text
 Rubric: skipped for this cycle
 Last grade: skipped
```

No active rubric:

(omit both lines — no behavior change to existing banner)

### Doctor — Hint strings

Green (no action needed):

`No action needed; continue the flywheel.`

Yellow:

`Open the rubric gate and choose Re-edit or Regenerate before creating beads.`

Red:

`Regenerate the rubric now; an empty criteria list cannot grade the cycle.`

### Doctor — Message strings

Green, no active rubric:

`no active rubric - outcome grading not applicable`

Green, valid rubric:

`outcome rubric valid (<N> criteria, source <auto|edited|user>)`

Yellow, missing file:

`outcome rubric path is set but the file is missing: <path>`

Yellow, parse failure:

`outcome rubric invalid: <short parse error>`

Red, empty criteria:

`outcome rubric has zero criteria`

### Step 9.5 — Verdict Surface (needs_revision)

Printed before the question:

```text
Outcome grade: needs_revision @ iter <N>/<max> (<U> unmet, <P> partial)
Grader: <codex|claude> in <durationMs>ms
Verdict file: .pi-flywheel/plans/<slug>/grading/iteration-<N>.json

| Criterion | Status | Gap |
|---|---|---|
| c2 | unmet | <first gap, truncated to 120 chars> |
| c5 | partial | <first gap, truncated to 120 chars> |
```

If fresh-CC fallback was used (D18, mandatory disclosure):

`Grader notice: Codex unavailable (<doctor status>); used a fresh Claude grader instead.`

If diff was truncated:

`Grader notice: cycle diff exceeded 30K chars; grader saw 15K start + 15K end + file list. Verdict confidence may be reduced.`

Question:

`Outcome grading found <U> unmet and <P> partial criteria at iteration <N>/<max>. What next?`

Options:

- `Iterate` — `Create remediation beads from the failing criteria and return to implementation (Recommended).`
- `Accept anyway` — `Continue wrap-up despite the unmet criteria; the verdict remains recorded.`
- `Abort` — `Stop the cycle before commit review or wrap-up.`

### Step 9.5 — Verdict Surface (max_iterations_reached)

Printed before the question:

```text
Outcome grade: max_iterations_reached @ iter <N>/<max> (<U> unmet, <P> partial)
Grader: <codex|claude> in <durationMs>ms
Verdict file: .pi-flywheel/plans/<slug>/grading/iteration-<N>.json

The iteration cap has been reached; no further automatic Iterate option is available.
```

Question:

`Outcome grading still has <U> unmet and <P> partial criteria after <N>/<max> iterations. What next?`

Options:

- `Accept anyway` — `Continue wrap-up with the final failing verdict recorded.`
- `Abort` — `Stop the cycle before commit review or wrap-up.`

### Step 9.5 — Skipped Notice

Printed:

`Outcome grading skipped for this cycle by operator choice at plan approval.`

(No question; flow continues to existing wrap-up question.)

### Step 9.5 — Timeout Surface

Printed:

```text
Outcome grading timed out after <timeoutSeconds>s.
No verdict file was saved.
```

Question:

`Outcome grading timed out before a verdict was saved. What next?`

Options:

- `Retry grading` — `Run the grader again with the same rubric and artifact range (Recommended).`
- `Accept without grade` — `Continue wrap-up and record grading as timed out.`
- `Abort` — `Stop the cycle before commit review or wrap-up.`

### Step 9.5 — Persistence-Failed Surface

Printed:

```text
Warning: Outcome grade computed but could not be persisted to disk.
Reason: <error message, e.g. ENOSPC>
Verdict shown in-line; not saved to .pi-flywheel/plans/<slug>/grading/iteration-<N>.json.
```

(Flow continues with verdict-aware branches above.)

### Remediation Bead Template (E8 from Ergonomics)

Title:

`Outcome remediation <criterionId>: <short criterion description>`

Body:

```markdown
## Source

- Verdict: `.pi-flywheel/plans/<slug>/grading/iteration-<N>.json`
- Criterion: `<criterionId>`
- Status: `<unmet|partial>`

## Rubric criterion

<criterion description>

## Evidence from grader

<evidence>

## Gaps to close

- <gap 1>
- <gap 2>

## Acceptance criteria

- Each listed gap is addressed or explicitly documented as out of scope.
- Relevant tests/build/lint commands pass.
- The next outcome grade marks `<criterionId>` as met, or the remaining gap is justified in the verdict.
```

### Error hints (verbatim, T1)

| Code | Hint |
|---|---|
| `rubric_synth_invalid` | `Synthesizer returned non-conforming YAML — re-run with force=true, or hand-edit .pi-flywheel/plans/<slug>/rubric.md and set source=user.` |
| `rubric_missing` | `No rubric found for the active plan — run flywheel_synthesize_rubric, or pick Skip rubric at the plan-approve gate.` |
| `grader_timeout` | `Grader exceeded FW_GRADER_TIMEOUT_MS — raise the budget, retry, or fall back to a smaller diff via artifactRefs.modifiedFilePaths.` |
| `verdict_invalid` | `Grader stdout did not parse against GraderVerdictSchemaV1 — one auto-retry has already fired; inspect the raw payload at debug log level.` |
| `grader_unavailable` | `Neither codex_cli nor a fresh-context Agent fallback is healthy — run /flywheel-doctor and remediate codex_cli or claude_cli.` |
| `cycle_start_sha_unset` | `cycleStartSha was not captured at flywheel_select — using checkpoint.gitHead or HEAD~50 fallback; commit a baseline to fix.` |
| `outcome_iteration_capped` | `maxOutcomeIterations reached — accept the verdict, abort the cycle, or raise FW_MAX_OUTCOME_ITERATIONS (bounded [1,5]) before the next cycle.` |
| `concurrent_grade` | `Another grader is in flight for this plan — wait for it to complete, or pass force=true to override the in-memory mutex.` |

---

## Future direction (deferred from v1)

Per Brainstorm "10x ceiling" — explicitly NOT in this cycle:

- Per-bead rubrics + per-wave rubrics (ship after v1 telemetry shows where rubrics are most-load-bearing).
- Managed-agents API adapter behind `FW_GRADER=managed-agents` flag (only when account-compat surface justifies the work).
- Cross-cycle telemetry: `verdict.status` distribution over last 10 cycles in `flywheel_doctor`.
- Streaming verdict events (`span.outcome_evaluation_*` analogue).
- Files API equivalent for artifact upload.
- Sticky `Skip rubric` preference in CASS (R17 follow-up).
- Cross-cycle correlation between `verdict.status` and `flywheel_convergence.score`.

---

## End of synthesized plan
