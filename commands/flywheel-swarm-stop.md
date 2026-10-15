---
description: Stop all running swarm agents and release their file reservations.
argument-hint: "[--yes | --dry-run]   destructive; bare invocation prints safe-alts and exits"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-swarm-stop" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-swarm-stop/SKILL.md`, so the MCP response is the canonical workflow.
