---
description: Run a state-aware /dueling-idea-wizards duel. Routes artifacts into the flywheel pipeline (discovery, plan, review) based on current phase.
argument-hint: "[--mode=ideas|architecture|security|ux|performance|reliability|innovation] [--top=N] [--rounds=N] [--expand] [--beads] [--focus=<topic>]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-duel" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:flywheel-duel` name as `skills/flywheel-duel/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model.

# `/agent-flywheel:flywheel-duel` — thin pointer to the canonical skill

Run a flywheel-aware dueling-idea-wizards duel: $ARGUMENTS

The underlying `/dueling-idea-wizards` orchestrates an ntm-powered swarm (Claude Code + Codex + Gemini-CLI, whichever are healthy) through a 5-phase pipeline: independent ideation → cross-scoring (0-1000) → reveal → optional rebuttal/steelman/blindspot → synthesis. This wrapper pre-flights ntm + agent availability, picks a default `--mode` from `.pi-flywheel/checkpoint.json`, invokes the underlying skill, routes the artifacts (`DUELING_WIZARDS_REPORT.md` + `WIZARD_*.md`) into the right `docs/` subfolder, and chains into the next flywheel tool (`flywheel_discover` / `flywheel_approve_beads` / per-bead review).

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:flywheel-duel" })
   ```

   Then follow the returned `body` with `$ARGUMENTS` as the skill's input. The skill drives pre-flight, mode auto-detect, and artifact routing.

2. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/flywheel-duel/SKILL.md` directly — degraded path, run `/agent-flywheel:flywheel-doctor` to triage.
