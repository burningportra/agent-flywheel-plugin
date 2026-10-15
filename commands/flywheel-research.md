---
description: Deep research on an external GitHub repository to extract implementation insights.
argument-hint: "<github-url>"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-research" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:flywheel-research` name as `skills/flywheel-research/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model.

# `/agent-flywheel:flywheel-research` — thin pointer to the canonical skill

Research an external GitHub repository: $ARGUMENTS

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:flywheel-research" })
   ```

   Then follow the returned `body` with `$ARGUMENTS` (the GitHub URL) as the skill's input. The skill drives the 7-phase research pipeline.

2. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/flywheel-research/SKILL.md` directly — degraded path, run `/agent-flywheel:flywheel-doctor` to triage.
