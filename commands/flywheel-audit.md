---
description: Audit the codebase for bugs, security issues, test gaps, and dead code.
argument-hint: "[full|quick]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-audit" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:flywheel-audit` name as `skills/flywheel-audit/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model.

# `/agent-flywheel:flywheel-audit` — thin pointer to the canonical skill

Run a codebase audit. $ARGUMENTS

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:flywheel-audit" })
   ```

   Then follow the returned `body` with `$ARGUMENTS` as the skill's input. The audit mode (`full` / `quick`) is parsed by the skill's intake step.

2. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/flywheel-audit/SKILL.md` directly — degraded path, run `/agent-flywheel:flywheel-doctor` to triage.
