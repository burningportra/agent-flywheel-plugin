---
description: Launch a parallel swarm of agents to implement multiple beads simultaneously.
argument-hint: "[goal-or-options]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-swarm" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. The same-name `Skill` call reloads this command instead of `skills/flywheel-swarm/SKILL.md`, so the MCP response is the canonical workflow. That workflow passes `coordinatorName` to `flywheel_approve_beads(action: "start")` and dispatches its server-owned `data.lanes` and `data.prompts` unchanged.
