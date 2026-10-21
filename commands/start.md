---
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
argument-hint: "[goal-or-options]"
---

**First action:** When flywheel tools are deferred, load the opening-screen tools in one `ToolSearch` query (`select:mcp__plugin_agent-flywheel_agent-flywheel__flywheel_get_skill,mcp__plugin_agent-flywheel_agent-flywheel__flywheel_doctor,mcp__plugin_agent-flywheel_agent-flywheel__flywheel_observe,mcp__plugin_agent-flywheel_agent-flywheel__flywheel_memory,AskUserQuestion`). Then call `flywheel_get_skill({ name: "agent-flywheel:start" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill input.

Do NOT call the `Skill` tool for `agent-flywheel:start` (same-name dedup returns `"already loaded above"` without the skill body), and do NOT re-implement menus or routing inline — `skills/start/SKILL.md` is the single source of truth. Fall back to reading `skills/start/SKILL.md` from disk only if `flywheel_get_skill` errors.
