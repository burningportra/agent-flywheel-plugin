---
description: Stop the current flywheel session and reset state.
argument-hint: ""
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-stop" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-stop/SKILL.md`, so the MCP response is the canonical workflow.
