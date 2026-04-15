---
description: Show current orchestration status, bead progress, and inbox messages.
---

Show orchestration status for this project.

1. **Checkpoint**: Read `.pi-orchestrator/checkpoint.json`. Display:
   - Current phase
   - Selected goal
   - Bead progress (completed/total)
   - Time elapsed in current phase (from `phaseStartedAt`)
   - Polish convergence score (if in planning phase)

2. **Live beads**: Run `br list --json` via Bash. Display a table:
   ```
   ID | Title | Status | Priority | Review passes
   ```
   Group by: in_progress → open → closed/deferred.

3. **Inbox**: Call `fetch_inbox` via the `agent-mail` MCP tool with `agent_name: "Orchestrator"`. Display any messages from running agents. Acknowledge read messages by calling `acknowledge_message` for each.

4. **Todos**: Display current todo list from TodoRead.

5. **Next recommended bead**: Run `bv --robot-next` via Bash to get the next optimal bead to work on.
