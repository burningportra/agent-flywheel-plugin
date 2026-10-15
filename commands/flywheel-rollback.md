---
description: Roll back a completed bead implementation.
argument-hint: "[bead-id]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-rollback" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-rollback/SKILL.md`, so the MCP response is the canonical workflow.
