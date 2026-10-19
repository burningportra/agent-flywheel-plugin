# Report: the start screen, 84 s to 44 s

Date: 2026-10-19

`/agent-flywheel:start` now reaches its first decision in a median 44.3 s on the `ntm` fixture, against 84.0 s for v3.23.0 on the same fixture with the two arms interleaved. That's 1.9×, just short of the 2× target in `triage.md`. The screen is also correct now. It shows exact bead counts where v3.23.0 printed "50+ done" for 2,982 closed beads.

| | v3.23.0 | candidate |
|---|---|---|
| median | 84.0 s | 44.3 s |
| min / max | 48.0 / 251.8 s | 40.1 / 84.9 s |
| model turns (median) | 9 | 4 |
| model time (median) | 64.9 s | 38.6 s |
| tool waits (median) | 17.5 s | 5.3 s |
| oracle checks passed | bead counts wrong on 8 of 8 runs | all checks on 8 of 8 runs |

Eight interleaved rounds, same machine and fixture, method in `baseline.md`. The candidate's two slow runs (75.1 s and 84.9 s) spent 70 to 78 s in model time over 4 or 5 turns, with tool waits of 4.9 and 6.5 s, so they reflect model latency, not the changes.

## What changed

Each change is its own commit.

1. **`flywheel_doctor` answers first-run from local files first** (`first-run.ts`, `doctor-tool.ts`). With a checkpoint, plan, or legacy state present it never spawns `br` or `cass`, and otherwise it takes the first probe that finds history. Doctor on the fixture went from 5.7 s to about 1.3 s.
2. **`flywheel_observe` counts beads with `br count`** (`observe.ts`). The counts are exact, include `blocked`, and cost 40 ms. The `br list` parse stays as the fallback for an older `br`.
3. **`flywheel_memory` search takes an optional `history` count** (`memory-tool.ts`, `server.ts`, `types.ts`). `history: 0` skips the session-history search, cutting a query from 5.9–7.9 s to 0.4–0.9 s with the same learnings.
4. **`flywheel_get_skill` reports the plugin version** (`get-skill.ts`), in its header line and in `data.pluginVersion`, so the banner needs no Bash call.
5. **Step 0 is one parallel batch** (`skills/start/SKILL.md`, `commands/start.md`). The pointer loads every Step 0 tool with one `ToolSearch`. Step 0b makes the doctor, observe, two memory searches, the plans glob, and two file reads in one message, next to the version banner. The profile waits for Step 2, which already calls it.

## Gates

In a clean clone with the changes applied, vitest, lint:skill, prompt-budget, check:skills-bundle, dead-code, version-sync, verify:error-meta, and the bats suite all pass, and a second build leaves `dist/` unchanged. New regression tests cover the first-run early answers, the doctor skipping `cass` when a checkpoint exists, `br count` counts and their fallback, the memory `history` pass-through and its validation, and the version in the skill result.

## Left out

- **Fold the plans glob, error counts, and project name into `flywheel_observe`.** That cuts the Step 0 batch from seven calls to four. Each call costs about 1 to 1.5 s of model output in the harness, so the estimated saving is 3 to 5 s. It's not measured.
- **`br-parser` rejects `blocked` rows.** Filed as `agent-flywheel-plugin-ed8`. It affects every `br list` consumer, not the start screen's path any more.
- The headless harness can't show `AskUserQuestion`, so it measures the gate as printed text. The interactive picker call happens at the same point in the turn.
