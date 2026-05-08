---
entry_id: "b-mox2w97q-8273qv"
problem_type: "external_api_concept_port"
component: "outcome-grading"
tags: ["managed-agents-port", "deep-plan-swarm", "coordinator-serial", "rubric-grader", "iteration-loop", "v3.13.0"]
applies_when: "porting a hosted-API concept (e.g. Anthropic Managed Agents define_outcome) into the flywheel as a local-only feature without adopting the API itself"
created_at: 2026-05-08
---

# Outcome Grading: Concepts-Only Port of Managed Agents API

> Released as v3.13.0 (commit `66fedf0`). 20 beads, 25 commits, ~3000 LOC, 55min single-implementer wall-clock.

## Problem

Anthropic's Managed Agents API ships a `define_outcome` event with rubric-based grading and an iteration loop. The flywheel already had analogues for everything (goal selection, plan, beads, review, convergence) **except** a structured per-criterion verdict from a strictly-decorrelated grader. We wanted the conceptual win without adopting the MA API as substrate (auth incompatibility with Claude Max ChatGPT-account; separate billing).

## Solution

**Port the concepts locally, not the API.** Three architectural decisions made the port viable:

1. **Whole-cycle scope** (not per-bead, not per-wave). One rubric per `flywheel_select` call, one grader call at wrap-up. Avoids rubric-volume burnout and clean separation from existing per-bead `flywheel_verify_beads` and per-wave `flywheel_advance_wave`.

2. **Decorrelation via process + model + context boundaries.** Codex (different vendor) primary; fresh-CC subagent fallback. Grader receives ONLY rubric frontmatter + git diff range + test output — no impl conversation history. Doctor-gated by `codex_cli` and `codex_config_compat` checks.

3. **Iteration loop bounded by `state.maxOutcomeIterations` (default 3, [1,5])** with hard server-side coercion: at iteration ≥ cap, `verdict.status` is force-coerced from `needs_revision` to `max_iterations_reached` BEFORE returning to the operator. Coercion is invariant — operator can't accidentally bypass.

## Artifacts

- **Spec**: `docs/superpowers/specs/2026-05-08-outcome-grading-design.md` (post-brainstorm 5-question pressure-test)
- **Plans**: `docs/plans/2026-05-08-outcome-grading-{correctness,ergonomics,robustness,synthesized}.md` (deep-plan swarm + Best-of-All-Worlds synthesis, 901-line synth plan)
- **Module**: `mcp-server/src/outcome-grading.ts` (~480 LOC) — `RubricSchemaV1`, `GraderVerdictSchemaV1`, `synthesizeRubric()`, `gradeOutcome()`
- **Atomic write**: `mcp-server/src/atomic-write.ts` (~50 LOC) — `writeAtomic()` via mkdir+writeFile-tmp+rename
- **MCP tools**: `flywheel_synthesize_rubric` + `flywheel_grade_outcome` (both registered in `server.ts`)
- **Doctor check**: `outcome_rubric_validity` (green/yellow/red on rubric.md presence + parse + criteria-count)
- **State**: 6 additive fields on `FlywheelState` — `outcomeRubricPath`, `outcomeGradingSkipped`, `outcomeGradingHistory` (capped at 5 cycles), `maxOutcomeIterations`, `cycleStartSha`, `cycleEndTestOutput`
- **Skill wiring**: `_planning.md` Step 5.6 (rubric gate) + `_wrapup.md` Step 9.5 (verdict surface)
- **Errors**: 8 new structured codes (`rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`, `grader_unavailable`, `cycle_start_sha_unset`, `outcome_iteration_capped`, `concurrent_grade`)
- **Action**: `flywheel_approve_beads(action: "remediate")` — one bead per failing criterion when operator picks Iterate

## Patterns worth replicating

### Concepts-only adoption pattern

When porting external API concepts:

1. **Map the analogues first.** Build a table of `their_concept → your_existing_concept`. Anything with `(no analogue)` is the integration target. Skip the rest.
2. **Whole-cycle scope by default.** Per-X scopes (per-bead, per-wave, per-N) compound rubric-authoring burden. Start at the coarsest scope; tighter scopes are followups when telemetry shows them needed.
3. **Decorrelation matters at GRADE time, not SYNTH time.** Synthesizer can be the same model as orchestrator (it's a reading task). Grader MUST be a different process with no impl-conversation context.
4. **Server-side invariants survive operator gymnastics.** Iteration-cap coercion at the server level (not the skill level) means the operator can't accidentally surface an Iterate option past the cap.

### Deep-plan swarm + Best-of-All-Worlds synthesis (when justified)

For high-stakes architectural cycles where ripple effects matter:

1. Three perspectives in parallel: **correctness** (Claude/Opus — schema versioning, invariants), **ergonomics** (Codex — UX, verbatim copy), **robustness** (Gemini — failure modes, fallback chains). Different models surface different concerns.
2. Synthesizer reads all three, **explicitly acknowledges what each plan does better**, blends strongest ideas, surfaces tensions where they fundamentally disagree.
3. Tensions become Step 5.55 alignment-check questions for the operator. Synthesizer proposes a recommendation per tension; operator confirms or overrides.
4. **~30min wall-clock for the deep-plan phase.** Worth it when downstream ripples are 5-10x of plan-time savings.

### Coordinator-serial impl when hotspot matrix flags contention

When `flywheel_approve_beads(action: "start")` returns `recommendation: "coordinator-serial"` AND there are real shared-write hotspots:

1. Spawn ONE NTM cc pane (single Claude/Opus 1M-ctx pane via `--cc=1`).
2. Comprehensive prompt with: bead list in dep order, per-bead protocol (read plan section → reserve files → implement → test → typecheck → UBS → completion-report.json → commit → close → release reservations → send delivery notice).
3. Tend with `/loop` — orchestrator polls inbox + bead status + pane tail every ~25-30min (cache-warm window aware).
4. **Don't run impl inline in the orchestrator** — context bloat from 20 bead implementations would overwhelm the main conversation.

## Gotchas (preventable in next cycle)

### `codex_config_compat` doctor flag is load-bearing pre-spawn

`~/.codex/config.toml` setting `model = "gpt-5.5"` works for `codex exec` but rejected by codex-companion app-server on ChatGPT-account auth. Manifests as: spawned cod pane fails immediately with `'gpt-5.5-xhigh' model is not supported when using Codex with a ChatGPT account`.

**Fix**: `sed -i.bak -E 's/^([[:space:]]*model[[:space:]]*=)/# \1/' ~/.codex/config.toml` + restart the cod pane via `ntm --robot-restart-pane=$SESSION --panes=N`.

**Prevention**: pre-spawn check — if `doctor.codex_config_compat` is yellow AND a cod pane will be spawned, surface a one-question gate before the swarm starts.

### NTM `--robot-send` flag syntax differs from `ntm send`

The planning skill's example `ntm --robot-send=$SESSION --panes=1 --type=cc --msg="..."` is wrong. Actual syntax:

- `--panes=N` (plural, comma-separated) for index targeting — `--pane=N` (singular) is silently ignored and broadcasts to all
- `--type=` filtering doesn't exist on `--robot-send` (only on `ntm send`); use `--cc`/`--cod`/`--gmi` flags on `ntm send` for type filtering, or use `--panes=` indices on `--robot-send`
- When `--panes` is omitted entirely, the message broadcasts to ALL agent panes — likely not what you want for per-perspective dispatch

Test once with a small message before sending the full prompt: `ntm --robot-send=$SESSION --panes=N --msg="ping"` — verify `successful: ["N"]` returned, not `["0", "1", "2"]`.

### `cycleStartSha` bootstrap gap

Features that capture state at session-boundary points (`flywheel_select`, `flywheel_plan`) only kick in starting from the **next** cycle after they ship. This cycle's `flywheel_select` was called BEFORE T13 (cycleStartSha capture) was implemented, so `state.cycleStartSha` was undefined for the wrap-up. `flywheel_memory(operation: "draft_postmortem")` returned `postmortem_empty_session` warning + empty body.

**Workaround**: hand-write the post-mortem for cycles that ship session-boundary capture. The auto-tool will work for the next cycle.

### `mark_message_read()` integer validation rejects integer inputs

Bug in agent-mail server-side validation: passing `message_id: 757` (integer) returns `expected type integer, got string`. Workaround: skip clearing stale inbox messages; filter by sender_id or timestamp at query time instead. Worth filing an upstream issue.

### `br list` default view excludes closed beads

`br list` (no flags) shows only open + in_progress beads. Tend cycles checking impl progress must use `br list --status closed --json` to see the cycle's actual completion count. Prior bead-status assertions like "0 closed despite 9 commits" caused false-alarm tend cycles.

## Verification evidence

- `tsc` clean
- `1785/1785` vitest tests pass + 1 pre-existing skip in `profiler.test.ts`
- `npm run lint` clean
- 25 commits in linear stack, no merge artifacts
- All 20 beads have `.pi-flywheel/completion/<bead-id>.json` written
- Doctor green on every check except pre-existing `codex_config_compat` (now resolved by sed fix)

## Related CASS entry

`b-mox2w97q-8273qv` — full session post-mortem with what worked / failed / decisions / patterns.

---

_See also: `docs/plans/2026-05-08-outcome-grading-synthesized.md` for the load-bearing 901-line implementation plan, `docs/superpowers/specs/2026-05-08-outcome-grading-design.md` for the architectural design._
