---
description: Full health check of the codebase and flywheel dependencies.
argument-hint: "[--json] [options]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-healthcheck" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:flywheel-healthcheck` name as `skills/flywheel-healthcheck/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model.

# `/agent-flywheel:flywheel-healthcheck` — thin pointer to the canonical skill

Full health check of the codebase and flywheel dependencies. The skill parses `--json` for the machine-readable envelope and otherwise renders the human-friendly health report with duel-readiness and duel-artifact hygiene included.

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:flywheel-healthcheck" })
   ```

   Then follow the returned `body` with `$ARGUMENTS` as the skill's input.

2. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/flywheel-healthcheck/SKILL.md` directly — degraded path, run `/agent-flywheel:flywheel-doctor` to triage.
