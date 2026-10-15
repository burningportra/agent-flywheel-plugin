---
description: One-shot diagnostic of every flywheel dependency. Reports MCP connectivity, Agent Mail, br/bv/ntm/cm, node, git, dist drift, orphaned worktrees, and checkpoint validity with a single glyph per line.
argument-hint: "[--json] [options]"
---

**First action:** Call `flywheel_get_skill({ name: "agent-flywheel:flywheel-doctor" })` and follow its returned `body` as the skill, forwarding `$ARGUMENTS` as the skill's input. Do NOT use the `Skill` tool for this: the slash expands to this file and this file is registered under the same `agent-flywheel:flywheel-doctor` name as `skills/flywheel-doctor/SKILL.md`, so a `Skill` call that re-requests this command's own name comes back as "already loaded above" (what loaded is this pointer, not the skill), and SKILL.md's body never reaches the model.

# `/agent-flywheel:flywheel-doctor` — thin pointer to the canonical skill

Diagnose every flywheel dependency and print each state with a single glyph per line. $ARGUMENTS

## Instructions

1. Fetch the canonical skill body via the MCP tool:

   ```
   flywheel_get_skill({ name: "agent-flywheel:flywheel-doctor" })
   ```

   Then follow the returned `body` with `$ARGUMENTS` as the skill's input. The skill parses `--json` for the machine-readable envelope and otherwise renders the `[OK]` / `[WARN]` / `[FAIL]` checklist, with duel-readiness synthesis included.

2. If `flywheel_get_skill` errors (bundle disabled via `FW_SKILL_BUNDLE=off`, MCP transport down, or skill missing from the bundle), fall back to reading `skills/flywheel-doctor/SKILL.md` directly — degraded path. (Doctor itself is the triage tool for this failure, so if `flywheel_get_skill` is also down something is quite wrong — run `/agent-flywheel:flywheel-setup` next.)
