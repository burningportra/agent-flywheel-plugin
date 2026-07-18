---
description: "Relentless goal/design interview that writes brainstorm + optional ADRs/glossary, then hands off to flywheel planning. OpenCode entry point — loads the bundled skill through the flywheel MCP server (no native grill-with-docs skill dir required)."
---

**First action:** load the bundled skill body through the flywheel MCP server and execute it verbatim:

```
flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })
```

Do **not** delegate to a native same-name skill. `grill-with-docs` is intentionally NOT a managed OpenCode skill directory — on a fresh machine there is no `skills/grill-with-docs/` in the ported config, so a native same-name skill lookup would fail. The skill ships inside the flywheel MCP skills bundle instead, and this command is the closure-safe entry point that loads it.

# `/grill-with-docs` — bundled-MCP entry point

1. If `$ARGUMENTS` is non-empty, treat it as `RAW_GOAL`.
2. Load the canonical interview body:

   ```
   flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })
   ```

   OpenCode surfaces the flywheel MCP tools with a doubled prefix, so the same call also resolves as `flywheel_flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })` — either form returns the bundled body. Execute that body as-is; do not re-implement the interview here (the bundled skill is the single source of truth).
3. On `GRILL_STATUS=approved`, call `flywheel_select` with `GRILL_ENRICHED_GOAL` and continue into planning. This command alone does **not** create beads or plans.
4. On `GRILL_STATUS=aborted`, stop — no artifacts should have been written.
