---
name: orchestrate-swarm-status
description: Check the status of running swarm agents and bead progress.
---

Check swarm status.

1. Run `br list --json` via Bash. Display a status table:
   ```
   ID | Title | Status | Updated
   ```
   Highlight any beads `in_progress`.

2. Call `fetch_inbox` via `agent-mail` MCP tool. Display messages from running agents (sender, subject, time).

3. Flag beads that appear stuck: `updated_at` older than 30 minutes and still `in_progress`.

4. Show todo list status via TodoRead.

5. Recommend next action: if stuck agents detected, suggest running `/claude-orchestrator:orchestrate-swarm-stop` and restarting.
