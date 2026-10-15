---
description: "Relentless goal/design interview that writes brainstorm + optional ADRs/glossary, then hands off to flywheel planning."
argument-hint: "[goal]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })` and follow its returned `body`, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:grill-with-docs` name as `skills/grill-with-docs/`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" and the skill body never arrives. Do NOT re-implement the interview — `skills/grill-with-docs/SKILL.md` is the single source of truth.

# `/agent-flywheel:grill-with-docs` — thin pointer

1. If `$ARGUMENTS` is non-empty, treat it as `RAW_GOAL`.
2. Fetch the canonical skill body:

   ```
   flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })
   ```

   Follow the returned `body` with `RAW_GOAL` as the skill's input.

3. On `GRILL_STATUS=approved`, the caller (usually `/agent-flywheel:start` Goal framing mode) must call `flywheel_select` with `GRILL_ENRICHED_GOAL` and continue into planning. This slash command alone does **not** create beads or plans.

4. On `GRILL_STATUS=aborted`, stop — no artifacts should have been written.
