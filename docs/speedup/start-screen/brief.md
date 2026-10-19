# Speedup brief: the `/agent-flywheel:start` start screen

Date: 2026-10-19

## Target

The time from typing `/agent-flywheel:start` to the first decision the operator can answer, which is the main menu `AskUserQuestion` (or the pre-flight gate when doctor reports blockers). Entry points:

- `commands/start.md`, which tells the model to fetch the skill with `flywheel_get_skill`.
- `skills/start/SKILL.md` Step 0 (0a version, 0.banner, 0b state detection, 0c welcome banner, 0d menu).
- The MCP tools Step 0 calls: `flywheel_get_skill`, `flywheel_doctor` (`mcp-server/src/tools/doctor-tool.ts`, `doctor.ts`, `first-run.ts`), `flywheel_profile`, and `flywheel_memory` search.

## KPI

Median seconds from the slash command to the first menu, for a fresh Claude Code process (cold MCP server) in a real repo with flywheel state. Baseline and target are in `baseline.md` and `triage.md`.

## Traffic constraint

No live service. The start screen ships to plugin users through a release, so a release is the cutover, and the existing test, lint, and prompt-budget gates are the rollback guard. Phases 6 and 7 of the speedup track (parallel run, canary) don't apply.

## API surface to preserve

- What the operator sees: the version banner, project, branch and short SHA, bead counts, doctor status with every yellow and red check, the pre-flight gate when `preflightBanner` is set, CASS learnings when available, and the main menu variant for the detected state with its options and routing.
- `flywheel_doctor`'s result contract: `data.report`, `data.preflightBanner`, `data.firstRun`, and `data.report.swarm`.
- The skill lint, `menu-options` tests, and prompt budget for `skills/start/SKILL.md`.

## Real-data source

- 111 measured `/start` runs from Claude Code transcripts under `~/.claude/projects`, including the operator's real runs in `cheen-os` (71.7 s, v3.20.1) and `ntm` (117.5 s, v3.23.0).
- A fixture clone of `/Volumes/1tb/Projects/ntm` with its beads (7 open, 7 blocked, 2 in progress) and `.pi-flywheel/` checkpoint and profile cache, driven headless through `claude -p --input-format stream-json --output-format stream-json --permission-prompts host`.
