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

## Round 2

Round 2 (`agent-flywheel-plugin-lnr`) brought the start screen from a 45.25 s median (`f9b0e5f`) down to 32.00 s (`9db9519`) and 36.15 s (`4236e36`, after restoring three verbatim first-sentence CASS learnings), over 2.3× faster than the 84.0 s v3.23.0 baseline.

### Noise floor

A 4-round interleaved baseline-versus-baseline run (`f9b0e5f` vs `f9b0e5f`) measured a 5.75 s gap between identical arms (`noise-a` p50 47.75 s, min/max 43.4–58.5 s; `noise-b` p50 42.00 s, min/max 41.0–55.3 s; combined 8-run p50 44.40 s). In two of `noise-a`'s four runs (runs 1 and 3), the model checked `ls .../package.json` in turn 3 and spent a fifth turn calling `Read` on `package.json`. Because the 4-round noise gap exceeded 5 s, main lever comparisons used 12 interleaved rounds and evaluated p90, min–max spread, and turn counts alongside p50.

| Arm / step | Rounds | Median (p50) | p90 | Min / max | Model p50 | Tool wait p50 | Turns (p50) | Oracle |
|---|---|---|---|---|---|---|---|---|
| v3.23.0 baseline | 8 | 84.00 s | — | 48.0 / 251.8 s | 64.90 s | 17.50 s | 9.0 | 0/8 (bead counts wrong) |
| Round 1 (`f9b0e5f` in Lever 1 A/B) | 12 | 45.25 s | 77.66 s | 38.3 / 81.8 s | 40.30 s | 4.50 s | 4.0 (1×5) | 11/12 (run 1 missed blocked/closed) |
| Lever 1 (`9fe37fe` / `f62197d`) | 12 | 42.40 s | 69.50 s | 34.8 / 69.8 s | 37.75 s | 3.50 s | 4.0 (12/12) | 12/12 |
| Lever 2 baseline (`f62197d` in Lever 2 A/B) | 12 | 46.00 s | 60.05 s | 33.3 / 60.5 s | 42.45 s | 3.25 s | 4.0 | 12/12 |
| Lever 2 (`f8eff20` / `9db9519`) | 12 | 32.00 s | 48.98 s | 28.1 / 49.4 s | 28.95 s | 2.95 s | 4.0 | 12/12 |
| Learnings follow-up baseline (`9db9519`) | 8 | 33.80 s | 39.68 s | 29.8 / 39.4 s | 30.20 s | 3.15 s | 4.0 | 8/8 |
| Learnings follow-up (`2ecd0eb` / `4236e36`) | 8 | 36.15 s | 44.28 s | 31.2 / 44.1 s | 32.35 s | 3.05 s | 4.0 | 8/8 |

### Kept commits

1. **Fold `projectName`, `recentPlans`, and `topErrorCodes` into `flywheel_observe`** (`9fe37fe`, dist `f62197d`). `flywheel_observe` now reads `<cwd>/package.json` (falling back to the directory name), the three newest `docs/plans/*.md` paths sorted by `mtimeMs` descending, and the top three nonzero error codes from `.pi-flywheel/error-counts.json`. Step 0b drops its `Bash`/`Read`/`Glob` calls unless `flywheel_observe` errors, cutting the batch from 5–7 tool calls to 4 MCP calls. Across 12 interleaved rounds (`base-h2` vs `cand-h2`), p50 moved from 45.25 s to 42.40 s (-2.85 s). A 2.85 s median shift is smaller than the 5.75 s 4-round noise gap, so the median alone does not prove the change, but four signals support keeping it:
   - every candidate run took 4 turns with zero `Bash`/`Read` detours (baseline run 2 took 5 turns),
   - median tool wait fell from 4.50 s to 3.50 s,
   - p90 fell from 77.66 s to 69.50 s, and max from 81.8 s to 69.8 s,
   - oracle pass rate improved from 11/12 (baseline run 1 dropped the `blocked` and `closed` counts) to 12/12.
2. **Tighten Step 0c rendering and stop at the pre-flight gate before Step 0d** (`f8eff20`, dist `9db9519`). Step 0c instructs the model to emit only the defined banner blocks without extra "Active session:" or "Checkpoint note:" paragraphs, to print a non-null `PREFLIGHT_BANNER` verbatim and stop at the pre-flight gate before rendering the 0d menu, and to keep each learning to one line. Across 12 interleaved rounds (`base-h1` vs `cand-h1`), p50 fell from 46.00 s to 32.00 s (-14.00 s), p90 from 60.05 s to 48.98 s (-11.07 s), min/max from 33.3–60.5 s to 28.1–49.4 s, model time p50 from 42.45 s to 28.95 s (-13.50 s), and final-turn streaming p50 from 4.15 s to 1.75 s, with 12/12 oracle passes on both arms. Only 2 of the 12 `base-h1` runs printed the 0d menu ahead of the gate, so nearly all of the 14.0 s gain comes from the shorter text (~630 fewer characters on every run: median 3,043 → 2,412 chars). Because every run on this fixture now stops at the pre-flight gate, the end-to-end oracle (`check-menu.py`) no longer covers the 0d main menu; only the vitest menu tests in `mcp-server/src/__tests__/skills/start/` cover it.
3. **Require three CASS learnings when available and quote first sentences verbatim** (`2ecd0eb`, dist `4236e36`). In `cand-h1`, "up to three" let some runs drop to two learnings, and paraphrasing stripped concrete detail (such as missing provider, boot wiring, and SSE path). Step 0c now requires three learnings when three are available and quotes each learning's first sentence verbatim from memory instead of rewriting it. Across 8 interleaved rounds (`base-h1b` vs `cand-h1b`), p50 was 36.15 s vs 33.80 s (+2.35 s, within the 5.75 s noise floor), oracle passed 8/8 on both arms, and all 8 candidate runs rendered three verbatim first-sentence learnings.

### Built but unmeasured (saved as patch)

- **Hypothesis 3: `withStartState` opt-in on `flywheel_get_skill`** (`docs/speedup/start-screen/round2-h3-with-start-state.patch`, follow-up bead `agent-flywheel-plugin-d7o`). Adds `withStartState?: boolean` to `flywheel_get_skill` so `commands/start.md` can preload `doctor`, `observe`, and both `history: 0` `flywheel_memory` searches in parallel during the Turn 2 skill fetch, eliminating Turn 3. Built and verified against unit tests (`11/11` in `get-skill.test.ts`, plus `pointer-command-guard`, `lint:skill`, `prompt-budget`, `check:skills-bundle`, and `dead-code`), but the 12-round A/B benchmark could not run because `claude -p` hit the account weekly usage limit (`HTTP 429 usage_limit_reached`, resets Oct 21 at 10pm America/New_York). Per protocol, the unmeasured change was not committed to `mcp-server/src/`; its diff is saved at `docs/speedup/start-screen/round2-h3-with-start-state.patch` and tracked in `agent-flywheel-plugin-d7o`.
- **Hypothesis 4: `ToolSearch` deferral.** Claude Code's session initialization defers MCP tool schemas above its client-side threshold and requires `ToolSearch` before invoking deferred tools; `.claude-plugin/plugin.json` has no manifest option to bypass tool deferral from the plugin side.

