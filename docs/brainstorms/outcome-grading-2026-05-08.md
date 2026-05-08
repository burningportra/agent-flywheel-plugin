# Brainstorm — Outcome Grading (Managed Agents API integration)

**Date:** 2026-05-08
**Goal slug:** outcome-grading
**Source:** Prior `/brainstorming` session (5-question pressure-test); skips Phase 0.5 dialogue per skip-heuristic (USER_INPUT >100 chars + detailed framing)
**Canonical artifact:** [docs/superpowers/specs/2026-05-08-outcome-grading-design.md](../superpowers/specs/2026-05-08-outcome-grading-design.md) — read this first

## Framing synthesis

Borrow the Managed Agents API's `define_outcome` rubric + decorrelated grader + iteration-loop pattern *as a local concept*, without adopting the MA API itself. Synthesize a **cycle-level rubric** at plan-approve time, grade the cycle outcome with a **strictly-decorrelated grader** (codex primary, fresh-CC fallback) at wrap-up, and surface the verdict via `AskUserQuestion` with a **hard 3-iteration cap**. Complements (does NOT replace) `flywheel_verify_beads`, `flywheel_advance_wave`, `flywheel_convergence`, and `flywheel_review` — they continue unchanged.

**Why now:** the flywheel already has every analogue *except* a structured per-criterion verdict from a strictly-decorrelated grader. This cycle ships exactly that gap.

## Scope floor (smallest version)

Ship in v1:
1. New module `mcp-server/src/outcome-grading.ts` with `RubricSchemaV1` + `GraderVerdictSchemaV1` Zod schemas + `synthesizeRubric()` + `gradeOutcome()` async functions.
2. Two new MCP tools: `flywheel_synthesize_rubric` (called from `_planning.md` Step 5.6) and `flywheel_grade_outcome` (called from `_wrapup.md` Step 9.5).
3. State additions: `outcomeRubricPath?`, `outcomeGradingSkipped?`, `outcomeGradingHistory?`, `maxOutcomeIterations` (default 3, bounded [1,5]), `cycleStartSha?`, `cycleEndTestOutput?`.
4. Decorrelation: codex primary via `codex exec --model gpt-5.5 --json`, fresh `Agent()` fallback with explicit empty-context preamble.
5. Doctor check: `outcome_rubric_validity` (green/yellow/red per parse status).
6. Skill wiring: `_planning.md` Step 5.6 (Approve/Edit/Regenerate/Skip) + `_wrapup.md` Step 9.5 (Iterate/Accept anyway/Abort).
7. Tests: schema round-trips, real plan synthesis, mocked artifact grading, iteration-cap coercion, doctor round-trip.
8. Docs: AGENTS.md "Outcome Grading" section + CHANGELOG entry.

## 10x ceiling (future direction — explicitly deferred from v1)

- Per-bead rubrics + per-wave rubrics (ship after v1 telemetry shows where rubrics are most-load-bearing).
- Managed-agents API adapter behind `FW_GRADER=managed-agents` flag (only when there's demand and account-compat surface justifies the work).
- Cross-cycle telemetry: `verdict.status` distribution over last 10 cycles in `flywheel_doctor` (deferred; v1 ships per-cycle CASS entries only).
- Streaming verdict events (`span.outcome_evaluation_*` analogue).
- Files API equivalent for artifact upload.

## Adjacent asks (NOT folded in this cycle)

- Reality-check / convergence-score correlation telemetry — interesting but not load-bearing for v1.
- Refining the existing 5-axis ideation rubric (`ideation-funnel.ts:214`) — separate work, separate cycle.
- Updating `completion-report.ts` schema to include rubric criterion IDs — could happen later if per-bead rubrics ever ship.

## Resolved decisions (from /brainstorming Q1–Q5 + spec self-review R1–R4)

| ID | Decision |
|---|---|
| Q1 | **Concepts only** (local), no MA API dependency |
| Q2 | **Whole-cycle outcome** (not per-bead, not per-wave) |
| Q3 | **Auto-synthesized at plan-approve** (Step 5.6), operator can Approve/Edit/Regenerate/Skip |
| Q4 | **Codex primary, fresh CC fallback** (different vendor + family > different family > same family with empty context) |
| Q5 | **Surface verdict via AskUserQuestion + max 3 iterations** (matches MA default; respects UNIVERSAL RULE 1) |
| R1 | Rubric criterion limits Zod-enforced: min 3, max 15 |
| R2 | "Skip rubric" semantics: `state.outcomeGradingSkipped = true`; grade tool returns sentinel `{ status: 'skipped', reason: 'operator-skipped-at-plan-approve' }` |
| R3 | Grader receives `artifactRefs.testOutput` (truncated at 10K chars) in v1 — testable criteria need test evidence |
| R4 | Cross-cycle telemetry deferred to follow-up cycle; v1 ships per-cycle CASS entries only |

## Genuinely open questions for plan stage

- **OQ-A.** Where does `cycleStartSha` get captured? `flywheel_select` vs `flywheel_plan` registration. Pick one in the plan.
- **OQ-B.** Skip-rubric stickiness: one-cycle decision (next cycle re-prompts) vs sticky preference in CASS. Default to one-cycle; flag for plan-stage decision.

## Planner instructions

Planner agents: **read [docs/superpowers/specs/2026-05-08-outcome-grading-design.md](../superpowers/specs/2026-05-08-outcome-grading-design.md) FIRST** — it is the authoritative design. This brainstorm document only summarizes the framing.

Anchor the plan's scope to the **Smallest shippable v1** list (8 items above). Reserve the 10x ceiling as a "future direction" appendix; do NOT pull any of those items into v1. The two genuinely open questions (OQ-A, OQ-B) must be resolved inline in the plan before bead creation.

Decorrelation is the load-bearing conceptual win — the plan must specify how the grader process boundary, model boundary, and context boundary are enforced. Do not let cost optimizations leak into the grader-spawn path; correlation defeats the entire mechanism.

Per CLAUDE.md global instructions: include a dependency graph with explicit `depends_on: []` task IDs.
