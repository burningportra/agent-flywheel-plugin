---
description: Review and improve all loaded agent skills based on session patterns and feedback.
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
