---
name: orchestrate-refine-skill
description: Refine a specific agent skill using session evidence and feedback.
---

Refine a specific skill: $ARGUMENTS (skill name required)

1. Parse the skill name from $ARGUMENTS. If not provided, list available skills and ask which to refine.

2. Read the current skill from `skills/<name>/SKILL.md`.

3. Search agent-mail for feedback about this skill: call `search_messages` via `agent-mail` MCP with `query: "<skill-name> feedback"`.

4. Use `Agent(subagent_type: "general-purpose", run_in_background: true, name: "skill-refine", team_name: "refine-skill-<name>")` to analyze:
   - Current skill effectiveness based on evidence
   - Specific improvements to make instructions clearer or more actionable
   - Any DON'Ts to add based on observed bad patterns
   - Any DOs to add based on observed good patterns

   Agent prompt must include Agent Mail bootstrap (`macro_start_session`) and instruction to write proposed changes to `docs/skill-refine-<name>-proposed.md`, then send the file path via `send_message`.

   Save the task ID. Nudge if idle: `SendMessage(to: "skill-refine", message: "Please send your proposed changes.")`.
   Shutdown when done: `SendMessage(to: "skill-refine", message: {"type": "shutdown_request", "reason": "Analysis complete."})`.

5. Read the proposed changes file and show the user a diff:
   ```
   BEFORE: <current text>
   AFTER:  <proposed text>
   ```

6. Ask: "Apply these changes?" If yes, write the updated SKILL.md.

7. Confirm: "Skill `<name>` updated."
