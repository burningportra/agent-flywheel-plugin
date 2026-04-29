---
description: One-shot diagnostic of every flywheel dependency. Reports MCP connectivity, Agent Mail, br/bv/ntm/cm, node, git, dist drift, orphaned worktrees, and checkpoint validity with a single glyph per line.
---

**See also (triage chain):** `flywheel-doctor` is the **first** step — a read-only snapshot, always safe. If doctor reports problems, run `/flywheel-setup` next to apply fixes (install missing tools, register MCP, configure hooks). Run `/flywheel-healthcheck` periodically for a deeper codebase + bead-graph audit — not for setup problems.

Invoke the `flywheel-doctor` skill. $ARGUMENTS

Use the `Skill` tool to run the skill: `Skill(skill_name: "agent-flywheel:flywheel-doctor")`.

The skill calls the `flywheel_doctor` MCP tool against the current working directory, renders the `DoctorReport` envelope as an `[OK]` / `[WARN]` / `[FAIL]` checklist, and prints the one-line remediation for each failing check.

Run this before `/start` on a fresh clone, after `/flywheel-cleanup`, as a CI gate, or whenever toolchain drift is suspected. Doctor is read-only — it never mutates checkpoint state.

## Duel-readiness

`/flywheel-duel` and the duel rows in start's Discover/Plan/Review menus need ntm + ≥2 healthy CLIs. The doctor's existing checks already cover this together:

- `ntm_binary` — ntm CLI present and runnable.
- `claude_cli` / `codex_cli` / `gemini_cli` — per-CLI installation + auth state.
- `swarm_model_ratio` — synthesis check reporting the achievable cc:cod:gmi ratio.

If any two of `{claude_cli, codex_cli, gemini_cli}` are green AND `ntm_binary` is green, duels can run. If only one is green, the duel skill aborts in Phase 1 detection — fall back to single-agent paths (`/idea-wizard`, `mode=deep`, 5-agent fresh-eyes) until the other CLIs are healthy.
