---
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
argument-hint: "[goal-or-options]"
---

**First action:** When the flywheel tools are deferred, load every tool the opening screen uses with one `ToolSearch` query, `select:mcp__plugin_agent-flywheel_agent-flywheel__flywheel_get_skill,mcp__plugin_agent-flywheel_agent-flywheel__flywheel_doctor,mcp__plugin_agent-flywheel_agent-flywheel__flywheel_observe,mcp__plugin_agent-flywheel_agent-flywheel__flywheel_memory,AskUserQuestion` (use the names this session lists when its prefix differs), so Step 0 never stops to search again. Then call `flywheel_get_skill({ name: "agent-flywheel:start" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:start` name as `skills/start/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model. Do NOT inline the menu/routing logic — the skill at `skills/start/SKILL.md` is the single source of truth.

# `/agent-flywheel:start` — thin pointer to the canonical skill

This slash command delegates to the canonical start-skill at `skills/start/SKILL.md`. Maintaining the menu/routing logic in two places (here + the SKILL) caused drift across v3.5.4 → v3.6.2: edits to SKILL.md (Auto-swarm, Deslop pass, ScheduleWakeup wiring, Stay-in-turn rule) silently failed to reach the slash command. Replaced with a pointer in v3.6.3.

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:start" })
   ```

   Then follow the returned `body` as the skill, treating `$ARGUMENTS` as the skill's input. `$ARGUMENTS` forwards anything the user typed after `/agent-flywheel:start` (a goal sentence, a path, `--mode single-branch`, etc.) — the skill's `0.preflight` step classifies it.

   The MCP call always returns the body in Claude Code and in the OpenCode port. The `Skill` tool is NOT the right entry point here: this pointer file and `skills/start/SKILL.md` register under the same `agent-flywheel:start` name, so a `Skill` call for that same name collapses to "already loaded above" and the skill body never arrives.

2. **Do NOT** re-implement the opening ceremony, menus, routing, drift checks, or sub-skill loads inline. The skill file at `skills/start/SKILL.md` (resolved via `$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md` or under `~/.claude/plugins/cache/agent-flywheel/agent-flywheel/<VERSION>/skills/start/SKILL.md`) is the single source of truth and includes:

   - Step 0a–0c: version banner + state detection + welcome banner + doctor smoke check
   - Step 0d: main menu (3 variants based on detected state — `previous-session-exists` / `open-beads-exist` / `fresh-start`). Each menu has 4 options including **Auto-swarm (Recommended)** and **Deslop pass**.
   - Step 0e: routing table for every menu choice plus the work-on-beads bootstrap, drift check, research-repo mode selection, and degraded-mode handling
   - Steps 2–4: profile / discover / select goal
   - Phases referenced via `_planning.md`, `_beads.md`, `_implement.md`, `_review.md`, `_wrapup.md` (loaded on demand per UNIVERSAL RULE 3)
   - Sub-skill files at `skills/start/_inflight_prompt.md` (Auto-swarm body) and `skills/start/_deslop.md` (Deslop pass body) loaded on-demand by Step 0e routing

3. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/start/SKILL.md` directly and executing it verbatim — but this is a degraded path that indicates a plugin-install issue (run `/agent-flywheel:flywheel-doctor`).

## Why this is now a thin pointer

Prior to v3.6.3, this file was a verbatim duplicate of `skills/start/SKILL.md` (~415 LOC). Every menu/routing change had to be applied twice; in practice it was only ever applied to SKILL.md, so the slash command silently served stale menus.

Single source of truth eliminates this class of bug for every future release.
