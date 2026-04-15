---
description: Submit structured feedback about a tool or command to improve future flywheel sessions.
---

Submit tool feedback: $ARGUMENTS

Record feedback to improve the agent-flywheel.

1. Parse $ARGUMENTS. Expected format: `<tool-name>: <feedback>` or just `<feedback>`.

2. If no tool name specified, ask: "Which tool or command are you giving feedback on?"

3. Collect feedback via a structured survey (ask these in order if not in $ARGUMENTS):
   - What happened? (actual behavior)
   - What did you expect? (expected behavior)
   - Severity: minor / annoying / blocking

4. Store feedback by calling `send_message` via `agent-mail` MCP:
   - `subject: "Tool Feedback: <tool-name>"`
   - `body_md: <formatted feedback>`
   - `thread_id: "agent-flywheel-feedback"`
   - `importance: "low"`

5. Search existing feedback for similar patterns: `search_messages` with query `"Tool Feedback: <tool-name>"`.

6. If 3+ similar feedback items found, flag it: "This is a recurring issue. Consider creating a bead to address it."

7. Confirm: "Feedback recorded. Thank you."
