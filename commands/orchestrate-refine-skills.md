---
description: Review and improve all loaded agent skills based on session patterns and feedback.
---

Refine all agent skills.

1. List all skills in the `skills/` directory.

2. Search agent-mail history for skill-related patterns via `search_messages` with query "skill feedback" and "planning pattern".

3. Read current bead completion data from `br list --json` (closed beads, review feedback).

4. For each skill found:
   - Use Agent(general-purpose) to analyze: "Given these session patterns and bead outcomes, what improvements would make this skill more effective?"
   - Generate specific, actionable suggestions

5. Present findings per skill with proposed changes.

6. Ask which skills to update.

7. For each approved skill, apply changes to the SKILL.md file.

8. Summarize: "Updated N skills with improvements."
