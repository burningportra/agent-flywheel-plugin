---
description: Targeted scan of specific paths or concerns without a full flywheel scan.
argument-hint: "[path-or-focus-area]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-scan" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-scan/SKILL.md`, so the MCP response is the canonical workflow.
