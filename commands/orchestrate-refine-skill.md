---
description: Refine a specific agent skill using session evidence and feedback.
---

Refine a specific skill: $ARGUMENTS (skill name required)

1. Parse the skill name from $ARGUMENTS. If not provided, list available skills and ask which to refine.

2. Read the current skill from `skills/<name>/SKILL.md`.

3. Search agent-mail for feedback about this skill: call `search_messages` via `agent-mail` MCP with `query: "<skill-name> feedback"`.

4. Use Agent(general-purpose) to analyze:
   - Current skill effectiveness based on evidence
   - Specific improvements to make instructions clearer or more actionable
   - Any DON'Ts to add based on observed bad patterns
   - Any DOs to add based on observed good patterns

5. Show the user a diff of the proposed changes:
   ```
   BEFORE: <current text>
   AFTER:  <proposed text>
   ```

6. Ask: "Apply these changes?" If yes, write the updated SKILL.md.

7. Confirm: "Skill `<name>` updated."
