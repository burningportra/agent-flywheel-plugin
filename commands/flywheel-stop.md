---
description: Stop the current orchestration session and reset state.
---

Stop the active orchestration session for this project.

1. Read `.pi-orchestrator/checkpoint.json`. If no active session, say "No active session found."
2. Show the current state (phase, goal, bead progress) and ask the user to confirm stopping.
3. If confirmed:
   - Call `orch_approve_beads` with `action: "reject"` via the `orchestrator` MCP tool to release bead locks.
   - Delete `.pi-orchestrator/checkpoint.json` using the Bash tool: `rm -f .pi-orchestrator/checkpoint.json`
   - Call `release_file_reservations` via the `agent-mail` MCP tool with `project_key` set to the current working directory.
   - Use `TaskList` to find any active orchestration tasks, then `TaskUpdate` each to `status: "deleted"` to cancel them.
4. Confirm: "Orchestration stopped. State cleared. Run `/claude-orchestrator:orchestrate` to start fresh."
