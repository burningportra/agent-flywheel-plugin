---
description: Check the status of running swarm agents and bead progress.
argument-hint: "[--json]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-swarm-status" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-swarm-status/SKILL.md`, so the MCP response is the canonical workflow.
