# Outcome Grading Ergonomics Plan

**Date:** 2026-05-08  
**Perspective:** ergonomics  
**Author:** BronzeLotus

## Goal

Integrate the local outcome-grading concept into the flywheel so the operator gets an obvious quality gate: synthesize a whole-cycle rubric at plan approval, let the operator approve or edit it without leaving the flow, grade the finished cycle with a decorrelated grader, and route any failed criteria into a capped, readable iteration loop. This plan focuses on the operator-facing seams: banner lines, `AskUserQuestion` copy, edit recovery, doctor hints, timeout/fallback notices, and remediation-bead ergonomics.

## Prior Session Context

CASS query: `AskUserQuestion menu UX banner doctor hint operator gate ergonomics`.

- One-screen answerability matters. Prior operator-status work favored one compact surface that answers "what state am I in, what is stale, what is next?" without making the user inspect multiple files.
- Degraded states must never be silent. Prior banner guidance used amber/red/gray status lines and disabled risky write actions when upstream state was degraded.
- Menu friction should be consolidated. Prior feedback explicitly asked for fewer per-bead prompts and clearer labels such as "self review" / "fresh-eyes" instead of cute wording.
- Existing start-flow work already established a pattern: surface important entry points directly, but keep the `AskUserQuestion` choice set to four labels and route extras through printed context.
- Hint quality rubric from the 2026-04-18 ergonomics plan applies here: hints name the failing precondition, give one next action, stay under about 140 chars, and avoid stack traces.

## Resolved Decisions

### OQ-A: `cycleStartSha` Capture

Capture `cycleStartSha` at `flywheel_plan` registration, not `flywheel_select`.

Rationale: from the operator perspective, the grade should cover the execution of the approved plan, not discovery and framing churn. Capturing at plan registration is also easier to explain in the verdict surface: "graded changes since plan registration." Preserve the first value for a plan slug; only reset it on Start over, Scrap, or registering a different plan file.

### OQ-B: Skip-Rubric Stickiness

Use a one-cycle skip. Do not create a sticky CASS preference that silently skips future rubrics.

Rationale: the rubric is a quality gate, and invisible preference memory would feel like magic when a later high-stakes cycle accidentally bypasses grading. To reduce friction, keep Skip one click inside the synthesize -> approve sub-flow and record skip telemetry. If the operator skips 3 consecutive cycles, surface "Skip rubric" as Recommended next time, but still ask.

### Additional UX Decisions

- Step 5.6 keeps its existing four-option Plan ready menu. "Skip rubric" lives inside the Create beads sub-flow after `flywheel_synthesize_rubric` returns.
- "Edit inline" means a follow-up `AskUserQuestion` with structured edit intents plus Other text. The coordinator applies the edit to `rubric.md`, sets `source: edited`, validates, and re-shows the rubric gate.
- Edited rubrics are preserved. `flywheel_synthesize_rubric` must not overwrite a rubric whose frontmatter has `source: edited` unless the caller passes an explicit force/regenerate path selected by the operator.
- If an edited rubric fails Zod/frontmatter parse, recovery is `AskUserQuestion` with Re-edit / Regenerate from scratch / Abort. Do not overwrite the broken file without a user choice.
- Remediation uses one bead per unmet or partial criterion, with all gaps for that criterion folded into that bead's acceptance criteria.

## Phased Task Breakdown

### E1. State and schema ergonomics

`depends_on: []`

Implement the outcome-grading schema/state surfaces needed by the UX:

- Add `RubricSchemaV1`, `GraderVerdictSchemaV1`, and parse/render helpers in `mcp-server/src/outcome-grading.ts`.
- Add optional checkpoint fields: `outcomeRubricPath`, `outcomeGradingSkipped`, `outcomeGradingHistory`, `maxOutcomeIterations`, `cycleStartSha`, `cycleEndTestOutput`.
- Capture `cycleStartSha` when `flywheel_plan` registers a plan and keep it stable for that plan slug.
- Add edited-rubric preservation metadata: `source: edited` is the load-bearing marker; optional `lastValidatedAt` and `lastValidationError` may be added if cheap.

Acceptance criteria:

- Existing checkpoints load without migration failures.
- `source: edited` rubrics parse and are not overwritten by normal synth calls.
- Tests cover missing `cycleStartSha`, existing `cycleStartSha`, and plan re-registration.

### E2. Rubric synthesize and edit workflow

`depends_on: [E1]`

Implement `flywheel_synthesize_rubric` so it supports the operator flow, not just the first generation path:

- Default action: synthesize `rubric.md` with `source: auto`.
- Validate action: parse current `rubric.md` and return criteria count + source + warnings.
- Edit action: apply user edit instructions to the current rubric, set `source: edited`, validate, and return the updated rubric.
- Regenerate action: only overwrite `source: edited` if the operator selected Regenerate from scratch.

Acceptance criteria:

- `Approve -> Create beads` path works with an auto rubric.
- `Edit inline -> apply edit -> Approve` path writes `source: edited`.
- Re-running synth after an edit returns `preserved: true` or equivalent and leaves the file intact.
- Broken edited frontmatter returns structured parse details without overwriting the file.

### E3. Grader verdict workflow

`depends_on: [E1]`

Implement `flywheel_grade_outcome` with operator-visible fallback and timeout metadata:

- Use Codex primary when `codex_cli` is healthy.
- Use fresh-context Claude fallback when Codex is unhealthy, recording `modelUsed: "claude"` and a one-line fallback notice.
- On timeout, return structured `grader_timeout` with no verdict file written.
- Persist `.pi-flywheel/plans/<slug>/grading/iteration-<N>.json`.
- Force `max_iterations_reached` when a needs-revision verdict arrives at the cap.

Acceptance criteria:

- Mocked Codex verdict writes iteration 1 JSON and appends state history.
- Mocked Codex-unhealthy path records the fresh-CC notice.
- Timeout path surfaces retry/accept/abort copy and does not create a partial verdict file.
- Iteration 3 needs-revision verdict is coerced and drops the Iterate option.

### E4. Step 5.6 planning UX

`depends_on: [E2]`

Update `skills/start/_planning.md` Step 5.6:

- Keep the existing Plan ready question unchanged except for describing that Create beads first opens the rubric gate.
- After "Create beads", call `flywheel_synthesize_rubric`.
- Print a compact rubric preview before the approve/edit/regenerate/skip question.
- Implement the Edit inline follow-up and parse-error recovery loop.
- Ensure Skip sets only the current checkpoint's `outcomeGradingSkipped = true`.

Acceptance criteria:

- `npm run lint:skill` accepts the new `AskUserQuestion` blocks.
- Step 5.6 has no prose "ask the user" decision point.
- The operator never has to manually open `$EDITOR` for the basic edit path.
- Out-of-band manual edit remains possible by printing the rubric path in the preview.

### E5. Step 0c banner UX

`depends_on: [E1, E3]`

Update `skills/start/SKILL.md` Step 0c to render outcome-grading state:

- Show rubric criteria count when a valid rubric exists.
- Show "not run" when rubric exists and no grade history exists.
- Show last grade status, iteration, and unmet count when history exists.
- Show skip state when the operator skipped rubric for the cycle.
- Do not show rubric lines when no active plan/rubric/skip state exists.

Acceptance criteria:

- Banner tests cover no rubric, valid rubric no grade, needs revision, satisfied, max iterations, failed, and skipped.
- Banner line copy exactly matches the Verbatim Copy section.
- Invalid rubric does not crash Step 0c; it shows a doctor-driven warning path instead.

### E6. Doctor check UX

`depends_on: [E1]`

Add `outcome_rubric_validity` to `mcp-server/src/tools/doctor.ts` following the existing `convergence_state_validity` pattern:

- Green when no active plan/rubric exists or when the active rubric parses.
- Yellow when rubric path is missing, frontmatter is malformed, or Zod parse fails.
- Red only when frontmatter parses but `criteria` is empty.
- Include exact hint strings from Verbatim Copy.

Acceptance criteria:

- Check name is added to `DOCTOR_CHECK_NAMES` and registered in `runDoctorChecks`.
- Unit tests assert severity, message, and hint for green/yellow/red.
- Each hint is capitalized, actionable, ends with a period, and is under 140 chars.

### E7. Step 9.5 verdict and iteration UX

`depends_on: [E3]`

Update `skills/start/_wrapup.md` Step 9.5 before the existing wrap-up menu:

- Call `flywheel_grade_outcome` unless grading was skipped.
- Render a compact per-criterion table for unmet/partial rows before the question.
- Surface Codex fallback notice and timeout notice exactly.
- Branch to Iterate / Accept anyway / Abort for `needs_revision`.
- Branch to Accept anyway / Abort for `max_iterations_reached`.
- For `satisfied`, continue to the existing wrap-up question.
- For skipped, print the skipped notice and continue to existing wrap-up.

Acceptance criteria:

- Skill lint passes.
- The verdict question never hides the unmet count.
- The full verdict file path is printed for details, so the table can stay compact.
- Timeout path is a separate retry/accept/abort decision, not disguised as `failed`.

### E8. Remediation bead creation

`depends_on: [E3, E7]`

Wire Iterate to remediation bead creation:

- Create one remediation bead per `perCriterion` item whose status is `unmet` or `partial`.
- Bead title format: `Outcome remediation <criterionId>: <short criterion description>`.
- Bead body includes rubric criterion, evidence, all gaps, source verdict file, and acceptance criteria.
- If multiple unmet criteria touch the same file, rely on `flywheel_approve_beads` hotspot/dependency review rather than prompting again.

Acceptance criteria:

- Needs-revision verdict with 3 failing criteria creates 3 remediation beads.
- A criterion with 4 gaps creates 1 bead with 4 acceptance criteria, not 4 beads.
- Created beads include dependency/review hints and route back to Step 6.
- No extra `AskUserQuestion` appears after the operator already selected Iterate.

### E9. Tests and CI coverage

`depends_on: [E1, E2, E3, E4, E5, E6, E7, E8]`

Add ergonomics-focused tests:

- AskUserQuestion option coverage for every new branch.
- Banner rendering edge cases.
- Doctor hint quality assertions.
- Edited-rubric preservation and parse-error recovery.
- Fallback notice and timeout surface.
- Remediation bead generation shape.

Acceptance criteria:

- `cd mcp-server && npm test` passes.
- `cd mcp-server && npm run lint:skill` passes.
- `cd mcp-server && npm run build` refreshes `dist/`.
- No test depends on live Codex or live Claude; grader process is mocked.

### E10. Docs and release integration

`depends_on: [E1, E2, E3, E4, E5, E6, E7, E8, E9]`

Update docs after behavior lands:

- AGENTS.md quick reference and version-sliced section for outcome grading.
- README architecture/tool list if it exists in current release docs.
- CHANGELOG entry for v3.13.0 or the chosen release.
- Add note that the rubric is whole-cycle only and is skipped per-cycle only.

Acceptance criteria:

- New MCP tools appear in AGENTS.md quick reference.
- Outcome grading docs distinguish `flywheel_review` from cycle grading.
- Release docs mention Codex-primary grader and fresh-CC fallback notice.

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Operator repeatedly skips rubric because it feels like extra work. | Outcome grading never builds trust. | Keep skip one-click, record telemetry, recommend Skip after 3 consecutive skips, but never silently skip. |
| Edit inline feels like a fake editor. | Operator loses confidence and edits out-of-band. | Use structured edit intents plus Other text, then show the changed criteria count and source=edited. |
| Edited rubric is overwritten by Regenerate or synth rerun. | User work is lost. | Treat `source: edited` as preserve-by-default; only overwrite through explicit Regenerate from scratch. |
| Verdict table is too verbose. | Operator cannot see the decision. | Show only unmet/partial rows, truncate gaps, and print the verdict JSON path for full detail. |
| Fresh-CC fallback weakens decorrelation but is hidden. | Operator over-trusts the grade. | Always show the fallback notice in the verdict surface. |
| Timeout leaves the operator unsure whether grading happened. | They may accept a partial grade. | Timeout writes no verdict file and shows Retry grading / Accept without grade / Abort. |
| One bead per criterion creates too many beads. | Iteration feels heavy. | Criteria max is 15; consolidate multiple gaps per criterion and let Step 6 refine dependencies. |
| Doctor hint is vague. | Operator cannot recover malformed rubrics. | Hint strings are exact, short, and tested by CI. |
| Skip state is sticky by accident in CASS. | Future cycles silently lose grading. | Do not read CASS to auto-skip; CASS only informs Recommended labeling after repeated skips. |

## File-Level Changes

| File | Change |
|---|---|
| `mcp-server/src/outcome-grading.ts` | Schemas, frontmatter parse/render, synth/edit/grade helpers, verdict table helpers if kept server-side. |
| `mcp-server/src/tools/synthesize-rubric.ts` | MCP wrapper for synthesize, validate, edit, regenerate, preserve edited rubric. |
| `mcp-server/src/tools/grade-outcome.ts` | MCP wrapper for grader process, fallback, timeout, persistence, iteration cap. |
| `mcp-server/src/tools/doctor.ts` | Add `outcome_rubric_validity` check and exact hints. |
| `mcp-server/src/server.ts` | Register `flywheel_synthesize_rubric`, `flywheel_grade_outcome`, and aliases only if required by existing deprecation pattern. |
| `mcp-server/src/types.ts` | Add state/result types and check name type coverage if central types require it. |
| `mcp-server/src/errors.ts` | Add `rubric_synth_invalid`, `rubric_missing`, `rubric_parse_failed`, `grader_timeout`, `verdict_invalid`. |
| `skills/start/SKILL.md` | Step 0c banner lines and skip/grade state rendering rules. |
| `skills/start/_planning.md` | Step 5.6 Create beads -> rubric preview -> approve/edit/regenerate/skip flow. |
| `skills/start/_wrapup.md` | Step 9.5 grading, verdict table, iteration decisions, timeout/fallback surfaces. |
| `mcp-server/src/__tests__/*` | Schema, tool, doctor, skill text, banner, remediation tests. |
| `AGENTS.md` | Outcome Grading quick reference and implementation rules. |
| `CHANGELOG.md` | Release entry. |

## Testing Strategy

- Schema tests: parse/render `rubric.md`, all verdict statuses, edited source, empty criteria red case.
- Tool tests: synthesize, validate, edit, regenerate, preserve edited rubric, missing rubric, malformed rubric.
- Grader tests: mocked Codex success, mocked Codex unhealthy with fresh-CC fallback, timeout, invalid JSON retry, iteration cap coercion.
- Skill tests: `AskUserQuestion` labels/descriptions for Step 5.6 and Step 9.5, no more than four options per question, no prose-only decision wording.
- Banner tests: no rubric, valid rubric no grade, skipped, satisfied, needs revision with unmet count, max iterations, failed.
- Doctor hint CI: exact hints under 140 chars, capitalized first letter, final period, non-empty next action.
- Remediation tests: one bead per unmet/partial criterion, multi-gap consolidation, verdict path included.

## Open Questions for Synthesizer

- Should `flywheel_synthesize_rubric` own edit application, or should there be a separate internal helper but no third MCP tool? My recommendation: one MCP tool with action variants to avoid another user-visible tool.
- The design spec mentions `flywheel_approve_beads(action: "remediate")`, but AGENTS.md quick reference does not list `remediate`. Synthesis must choose whether to add that action or create remediation beads directly with existing `br` helpers.
- Should doctor green rows include hints? Current doctor style usually omits hints on green, but this ergonomics request asks for green/yellow/red hint copy. If code conventions prefer no green hint, use the green copy as the message tail instead.
- Where should the compact verdict table be rendered, server-side helper or skill text? My recommendation: server helper for consistency, skill owns surrounding copy.
- Should repeated skip telemetry be in CASS only, or also in local `.pi-flywheel` telemetry for offline use? My recommendation: local telemetry first, CASS optional.

## Verbatim Copy

### Step 5.6 Plan Ready Menu

Question:

`Plan created (<N> lines, at <path>). What next?`

Options:

- `Create beads` - `Synthesize an outcome rubric, approve or edit it, then convert the plan into implementation beads (Recommended).`
- `Refine plan` - `Run a fresh refinement round to deepen the plan.`
- `Review plan` - `Open the plan file for manual review before proceeding.`
- `Start over` - `Discard this plan and pick a different goal.`

### Rubric Preview

Printed before the rubric gate:

`Outcome rubric drafted at <rubric-path> with <N> criteria. Source: <auto|edited|user>.`

If existing edited rubric is preserved:

`Outcome rubric already edited at <rubric-path>; preserving it unless you choose Regenerate.`

### Rubric Gate

Question:

`Outcome rubric ready (<N> criteria, source <auto|edited|user>). What should happen before bead creation?`

Options:

- `Approve rubric` - `Use this rubric for wrap-up grading and continue to Create beads (Recommended).`
- `Edit inline` - `Describe criteria to add, remove, or tighten; I will update rubric.md, validate it, and re-show this gate.`
- `Regenerate` - `Discard the auto draft and synthesize a new rubric from the plan.`
- `Skip rubric` - `Skip outcome grading for this cycle only; wrap-up will record grading as skipped.`

### Edit Inline Follow-Up

Question:

`What should change in <rubric-path>? Use Other for the exact edit text.`

Options:

- `Tighten criteria` - `Make existing criteria more testable and file/behavior-specific (Recommended).`
- `Add criterion` - `Add one criterion from the Other field, then rebalance if weights exist.`
- `Remove criterion` - `Remove or merge criteria named in Other.`
- `Custom edit` - `Apply the precise edit instructions from Other.`

### Edit Parse Failure

Question:

`The edited rubric did not parse: <short parse error>. How should I recover?`

Options:

- `Re-edit` - `Keep the current file, apply a correction from Other, and validate again (Recommended).`
- `Regenerate from scratch` - `Overwrite the broken rubric with a fresh auto-generated rubric from the plan.`
- `Abort` - `Stop before bead creation so the rubric can be fixed manually.`

### Banner Lines

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

Rubric skipped:

```text
 Rubric: skipped for this cycle
 Last grade: skipped
```

### Doctor Hints

Green:

`No action needed; continue the flywheel.`

Yellow:

`Open the rubric gate and choose Re-edit or Regenerate before creating beads.`

Red:

`Regenerate the rubric now; an empty criteria list cannot grade the cycle.`

### Doctor Messages

Green with no active rubric:

`no active rubric - outcome grading not applicable`

Green with valid rubric:

`outcome rubric valid (<N> criteria, source <auto|edited|user>)`

Yellow missing file:

`outcome rubric path is set but the file is missing: <path>`

Yellow parse failure:

`outcome rubric invalid: <short parse error>`

Red empty criteria:

`outcome rubric has zero criteria`

### Step 9.5 Verdict Surface

Printed before the question for `needs_revision`:

```text
Outcome grade: needs_revision @ iter <N>/<max> (<U> unmet, <P> partial)
Grader: <codex|claude> in <durationMs>ms
Verdict file: .pi-flywheel/plans/<slug>/grading/iteration-<N>.json

| Criterion | Status | Gap |
|---|---|---|
| c2 | unmet | <first gap, truncated to 120 chars> |
| c5 | partial | <first gap, truncated to 120 chars> |
```

Fallback notice:

`Grader notice: Codex unavailable (<doctor status>); used a fresh Claude grader instead.`

Question for `needs_revision`:

`Outcome grading found <U> unmet and <P> partial criteria at iteration <N>/<max>. What next?`

Options:

- `Iterate` - `Create remediation beads from the failing criteria and return to implementation (Recommended).`
- `Accept anyway` - `Continue wrap-up despite the unmet criteria; the verdict remains recorded.`
- `Abort` - `Stop the cycle before commit review or wrap-up.`

Printed before the question for `max_iterations_reached`:

```text
Outcome grade: max_iterations_reached @ iter <N>/<max> (<U> unmet, <P> partial)
Grader: <codex|claude> in <durationMs>ms
Verdict file: .pi-flywheel/plans/<slug>/grading/iteration-<N>.json

The iteration cap has been reached; no further automatic Iterate option is available.
```

Question for `max_iterations_reached`:

`Outcome grading still has <U> unmet and <P> partial criteria after <N>/<max> iterations. What next?`

Options:

- `Accept anyway` - `Continue wrap-up with the final failing verdict recorded.`
- `Abort` - `Stop the cycle before commit review or wrap-up.`

Printed for skipped grading:

`Outcome grading skipped for this cycle by operator choice at plan approval.`

### Timeout Surface

Printed:

```text
Outcome grading timed out after <timeoutSeconds>s.
No verdict file was saved.
```

Question:

`Outcome grading timed out before a verdict was saved. What next?`

Options:

- `Retry grading` - `Run the grader again with the same rubric and artifact range (Recommended).`
- `Accept without grade` - `Continue wrap-up and record grading as timed out.`
- `Abort` - `Stop the cycle before commit review or wrap-up.`

### Remediation Bead Template

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
