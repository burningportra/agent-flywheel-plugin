# Behavior oracle: the start screen

Date: 2026-10-19

A faster start screen counts only when it shows the operator the same things. Two layers check that.

## Contract tests

These run in `npm test` and pin the parts of the start screen that live in code or skill text:

- `src/__tests__/preflight-yellow.test.ts` covers the doctor fields Step 0 consumes, the banner-before-work rule, and yellow and red surfacing.
- `src/__tests__/skills/start/menu-options.test.ts` and `goal-framing-grill.test.ts` cover the three menu variants, their options, the swarm mix, and the Step 0e routing.
- `src/__tests__/lint/live-flywheel.test.ts` and `npm run lint:skill` cover the skill's AskUserQuestion call sites, placeholders, and tone ratchet.
- `src/__tests__/first-run.test.ts` and `tools/doctor.register.test.ts` cover `data.firstRun` for every signal, including the new early answers.
- `src/__tests__/tools/observe.test.ts` covers the bead counts the banner now reads, from `br count` and from the `br list` fallback.
- `src/__tests__/tools/get-skill.test.ts` covers the plugin version the banner now reads from the skill load.

## End-to-end check on real state

`tools/check-menu.py` reads every run the benchmark records (`tools/bench-start.py`, see `baseline.md`) and checks that the screen it produced shows what the fixture's state requires. The fixture is a clone of the operator's `ntm` repo with its 2,998 real beads and its checkpoint pinned before each run. Every run must show:

| Check | Expected on the fixture |
|---|---|
| version | `AGENT-FLYWHEEL v3.x.y` |
| project, branch and SHA | `Project: ntm`, `main @ a4c1265` |
| bead counts | 7 open, 2 in progress, 7 blocked, 2,982 closed |
| doctor | `Doctor: yellow`, the `Doctor flagged` rows, and the pre-flight issues |

The doctor sets a pre-flight banner on this fixture, so the first decision is the pre-flight gate, and a run that stops there must show its three options (Run setup now, Continue with degraded, Show me what's degraded). A run that goes on to the main menu must also show the active-session variant (`'Add Muse Code…' @ discovering`) with Auto-swarm and Resume session, the `cc:pi 2:4` mix from `DOCTOR_REPORT.swarm.label`, and the empty recent-plans block.

The v3.23.0 baseline printed "50+ done" for 2,982 closed beads on all 8 runs and miscounted open or blocked beads on 3 of 8, because `br list --json` drops closed beads and `br list --all --json` stops at 50 rows. The candidate passed every check on all 8 runs.
