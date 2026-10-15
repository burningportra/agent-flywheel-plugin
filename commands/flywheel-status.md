---
description: Show current flywheel status, bead progress, and inbox messages.
argument-hint: "[--json]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-status" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-status/SKILL.md`, so the MCP response is the canonical workflow.
