---
description: Review and improve all loaded agent skills based on session patterns and feedback.
argument-hint: "[--yes | --dry-run | --skill <name>]   rewrites SKILL.md files; bare invocation prints safe-alts and exits"
---

**First action:** Parse `$ARGUMENTS` for `--yes`, `--dry-run`, or `--skill <name>`.

- If none of those flags are present (bare invocation), **stop and print this safe-alt block, then exit without acting**:
  ```
  /flywheel-refine-skills is destructive: it spawns analysis agents and
  rewrites SKILL.md files in skills/. Skills are loaded into every
  Claude Code session, so a regression here propagates project-wide.

  Safe alternatives:
    /agent-flywheel:flywheel-refine-skill <name>   — refine a single skill in isolation
    /flywheel-refine-skills --skill <name>         — same effect; explicit
    /flywheel-refine-skills --dry-run              — analyze and write proposals
                                                     to docs/skill-refine-*.md
                                                     without touching SKILL.md
  Re-run with --yes to proceed across ALL skills.
  ```
  Do NOT spawn agents, do NOT modify any SKILL.md. Return.

- If `--dry-run`: run steps 1 through 7 below — analysis agents write proposals to `docs/skill-refine-<name>-proposed.md` — but **skip step 8 onward** (do not apply changes). Print the list of proposals and exit.

- If `--skill <name>`: route to `/agent-flywheel:flywheel-refine-skill <name>` (single-skill path) and exit.

- If `--yes`: proceed to step 1 and run the full sequence.

---

Refine all agent skills.

1. List all skills in the `skills/` directory.

2. Search agent-mail history for skill-related patterns via `search_messages` with query "skill feedback" and "planning pattern".

3. Read current bead completion data from `br list --json` (closed beads, review feedback).

4. **Setup coordination:**
   Bootstrap Agent Mail: `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Refine all skills")`.
   Create a team: `TeamCreate(team_name: "refine-skills")`.

5. For each skill found, spawn an analysis agent with `run_in_background: true`:
   ```
   Agent(
     subagent_type: "general-purpose",
     name: "skill-<name>",
     team_name: "refine-skills",
     run_in_background: true,
     prompt: "
       Bootstrap Agent Mail: macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6', task_description: 'Refine skill: <name>')
       Analyze: given these session patterns and bead outcomes, what improvements would make this skill more effective?
       Write proposed changes to docs/skill-refine-<name>-proposed.md.
       Send the file path to <your-coordinator-name> via send_message when done.
     "
   )
   ```
   Save each task ID for potential `TaskStop` use. Nudge idle agents individually by name.

6. After all agents report, shutdown each individually:
   `SendMessage(to: "skill-<name>", message: {"type": "shutdown_request", "reason": "Analysis complete."})`.
   Do NOT broadcast to `"*"`.

7. Present findings per skill with proposed changes (read from the docs files agents wrote).

8. Ask which skills to update.

9. For each approved skill, apply changes to the SKILL.md file.

10. Summarize: "Updated N skills with improvements."
