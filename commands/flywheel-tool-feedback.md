---
description: Submit structured feedback about a tool or command to improve future flywheel sessions.
argument-hint: "<tool-name>: <feedback>"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-tool-feedback" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-tool-feedback/SKILL.md`, so the MCP response is the canonical workflow.
