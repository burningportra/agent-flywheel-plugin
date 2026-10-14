# Speedup brief: Bash PreToolUse hook + `flywheel_doctor`

Date: 2026-10-14. Run by WindyBasin via `/agent-flywheel:flywheel-speedup`.

1. **Target.** Two paths in this plugin that every session pays for:
   - The `PreToolUse[Bash]` hook in `hooks/hooks.json`. It runs before every Bash tool call in every Claude Code session that has the plugin enabled.
   - The `flywheel_doctor` MCP tool (`mcp-server/src/tools/doctor.ts`, 23 checks). It runs at `/start`, in `flywheel_observe` (with a reduced budget), in `flywheel_setup`, and on demand.
2. **KPI.**
   - Hook: per-Bash-call overhead p99 below 10 ms (baseline p99 68 ms).
   - Doctor: wall-clock p99 below 500 ms (baseline p99 2.26 s), with identical check results.
3. **Live-traffic constraint.** None. Both paths are local developer tooling, so the cutover is a plugin release, not a traffic ramp. Phase 7's canary therefore collapses to "ship in a patch release; older Claude Code versions keep the current behavior".
4. **API surface to preserve.**
   - The guard's block/allow decision for every command in `opencode/fixtures/hooks/guard-corpus.json`.
   - The doctor's `DoctorReport` shape, check names and order, and the severity and message of each check for the same machine state.
5. **Real-data source.** This machine's real CLIs (cm 0.2.14 with an 810 KB playbook, gemini 0.49.0, ntm, br, bv, am) and this repo's checkout. The guard corpus serves as the command dataset.
