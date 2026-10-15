---
description: Search, store, or manage CASS long-term memory.
argument-hint: "[stats|search <query>|store <content>|view|prune]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:memory" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/memory/SKILL.md`, so the MCP response is the canonical workflow.
