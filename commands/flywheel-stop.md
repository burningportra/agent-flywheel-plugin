---
description: Stop the current flywheel session and reset state.
---

Stop the active flywheel session for this project.

1. Read `.pi-flywheel/checkpoint.json`. If no active session, say "No active session found."
2. Show the current state (phase, goal, bead progress) and ask the user to confirm stopping.
3. If confirmed:
   - Call `flywheel_approve_beads` with `action: "reject"` via the agent-flywheel MCP server to release bead locks.
   - Delete `.pi-flywheel/checkpoint.json` using the Bash tool: `rm -f .pi-flywheel/checkpoint.json`
   - Call `release_file_reservations` via the `agent-mail` MCP tool with `project_key` set to the current working directory.
   - Use `TaskList` to find any active flywheel tasks, then `TaskUpdate` each to `status: "deleted"` to cancel them.
4. Confirm: "Orchestration stopped. State cleared. Run `/agent-flywheel:flywheel` to start fresh."
