---
description: "Relentless goal/design interview that writes brainstorm + optional ADRs/glossary, then hands off to flywheel planning."
argument-hint: "[goal]"
---

**First action:** Invoke `Skill(skill: "agent-flywheel:grill-with-docs", args: "$ARGUMENTS")` immediately; do NOT re-implement the interview — the skill at `skills/grill-with-docs/SKILL.md` is the single source of truth.

# `/agent-flywheel:grill-with-docs` — thin pointer

1. If `$ARGUMENTS` is non-empty, treat it as `RAW_GOAL`.
2. Invoke:

   ```
   Skill(skill: "agent-flywheel:grill-with-docs", args: "$ARGUMENTS")
   ```

   Prefer MCP fallback when the Skill tool returns a stub:

   ```
   flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })
   ```

3. On `GRILL_STATUS=approved`, the caller (usually `/agent-flywheel:start` Goal framing mode) must call `flywheel_select` with `GRILL_ENRICHED_GOAL` and continue into planning. This slash command alone does **not** create beads or plans.

4. On `GRILL_STATUS=aborted`, stop — no artifacts should have been written.
