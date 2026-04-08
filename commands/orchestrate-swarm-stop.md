---
description: Stop all running swarm agents and release their file reservations.
---

Stop the swarm and clean up.

1. Fetch all active agents via `fetch_inbox` on the `agent-mail` MCP tool to identify who is running.

2. Call `release_file_reservations` via `agent-mail` MCP tool with `project_key` set to the current working directory to release all reservations.

3. Send a stop signal to all active agents via `send_message` in `agent-mail`:
   - `subject: "STOP — Swarm shutdown requested"`
   - `body_md: "The orchestrator has requested a clean stop. Please finish your current step, commit any partial work, and exit."`
   - `importance: "urgent"`

4. For beads still marked `in_progress` in `br list --json`, reset them to `open`:
   Run `br update <id> --status open` via Bash for each.

5. Update todos to `cancelled` for swarm-related items using TodoWrite.

6. Report: "Swarm stopped. N agents signaled to stop, N beads reset to open."
