---
description: Sweep docs/solutions/ for stale, duplicate, and contradictory learnings — Keep / Update / Consolidate / Replace / Delete.
argument-hint: "[options]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-compound-refresh" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:flywheel-compound-refresh` name as `skills/flywheel-compound-refresh/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model.

# `/agent-flywheel:flywheel-compound-refresh` — thin pointer to the canonical skill

Sweep `docs/solutions/` for stale, duplicate, and contradictory learnings using CE's Phase 1.75 5-vector overlap rubric. The sweep is read-only at the algorithm layer; archival is the only mutation and Delete always requires explicit user confirmation via `AskUserQuestion`. Nothing is ever truly removed — Delete archives to `docs/solutions/_archive/` instead.

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:flywheel-compound-refresh" })
   ```

   Then follow the returned `body` with `$ARGUMENTS` as the skill's input. The skill's hard rules (never auto-delete, archive via `git mv`, rename detection before stale, read-only first run) and threshold defaults (Consolidate ≥0.75, Replace ≥0.85, Delete ≥0.9 stale score) live in the body.

2. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/flywheel-compound-refresh/SKILL.md` directly — degraded path, run `/agent-flywheel:flywheel-doctor` to triage.
