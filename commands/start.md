---
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

# `/agent-flywheel:start` — thin pointer to the canonical skill

This slash command delegates to the canonical start-skill at `skills/start/SKILL.md`. Maintaining the menu/routing logic in two places (here + the SKILL) caused drift across v3.5.4 → v3.6.2: edits to SKILL.md (Auto-swarm, Deslop pass, ScheduleWakeup wiring, Stay-in-turn rule) silently failed to reach the slash command. Replaced with a pointer in v3.6.3.

## Instructions

1. Invoke the start skill via the `Skill` tool:

   ```
   Skill(skill: "agent-flywheel:start", args: "$ARGUMENTS")
   ```

   The `$ARGUMENTS` placeholder forwards anything the user typed after `/agent-flywheel:start` (a goal sentence, a path, `--mode single-branch`, etc.) — the skill's `0.preflight` step classifies it.

2. **Do NOT** re-implement the opening ceremony, menus, routing, drift checks, or sub-skill loads inline. The skill file at `skills/start/SKILL.md` (resolved via `$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md` or under `~/.claude/plugins/cache/agent-flywheel/agent-flywheel/<VERSION>/skills/start/SKILL.md`) is the single source of truth and includes:

   - Step 0a–0c: version banner + state detection + welcome banner + doctor smoke check
   - Step 0d: main menu (3 variants based on detected state — `previous-session-exists` / `open-beads-exist` / `fresh-start`). Each menu has 4 options including **Auto-swarm (Recommended)** and **Deslop pass**.
   - Step 0e: routing table for every menu choice plus the work-on-beads bootstrap, drift check, research-repo mode selection, and degraded-mode handling
   - Steps 2–4: profile / discover / select goal
   - Phases referenced via `_planning.md`, `_beads.md`, `_implement.md`, `_review.md`, `_wrapup.md` (loaded on demand per UNIVERSAL RULE 3)
   - Sub-skill files at `skills/start/_inflight_prompt.md` (Auto-swarm body) and `skills/start/_deslop.md` (Deslop pass body) loaded on-demand by Step 0e routing

3. If the `Skill` tool reports the start skill is unavailable, fall back to reading `skills/start/SKILL.md` directly and executing it verbatim — but this is a degraded path that indicates a plugin-install issue (run `/agent-flywheel:flywheel-doctor`).

## Why this is now a thin pointer

Prior to v3.6.3, this file was a verbatim duplicate of `skills/start/SKILL.md` (~415 LOC). Every menu/routing change had to be applied twice; in practice it was only ever applied to SKILL.md, so the slash command silently served stale menus. The visible symptom: users running `/agent-flywheel:start` saw v3.5.3-era options (`Quick fix`, the old 4-option fresh-start menu) even after cache-fresh installs of v3.6.0+. The skill body was correct; the slash-command body was stale.

Single source of truth eliminates this class of bug for every future release.
