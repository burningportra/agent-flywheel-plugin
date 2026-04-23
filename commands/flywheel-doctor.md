---
description: One-shot diagnostic of every flywheel dependency. Reports MCP connectivity, Agent Mail, br/bv/ntm/cm, node, git, dist drift, orphaned worktrees, and checkpoint validity with a single glyph per line.
---

**See also (triage chain):** `flywheel-doctor` is the **first** step — a read-only snapshot, always safe. If doctor reports problems, run `/flywheel-setup` next to apply fixes (install missing tools, register MCP, configure hooks). Run `/flywheel-healthcheck` periodically for a deeper codebase + bead-graph audit — not for setup problems.

Invoke the `flywheel-doctor` skill. $ARGUMENTS

Use the `Skill` tool to run the skill: `Skill(skill_name: "agent-flywheel:flywheel-doctor")`.

The skill calls the `flywheel_doctor` MCP tool against the current working directory, renders the `DoctorReport` envelope as an `[OK]` / `[WARN]` / `[FAIL]` checklist, and prints the one-line remediation for each failing check.

Run this before `/start` on a fresh clone, after `/flywheel-cleanup`, as a CI gate, or whenever toolchain drift is suspected. Doctor is read-only — it never mutates checkpoint state.
