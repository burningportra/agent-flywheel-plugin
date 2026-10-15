---
name: flywheel-stop
description: Stop the current flywheel session and reset state.
---

Stop the active flywheel session for this project.

1. Read `.pi-flywheel/checkpoint.json`. If no active session, say "No active session found."
2. Show the current state (phase, goal, bead progress) and ask the user to confirm stopping.
3. If confirmed:
   - Call `flywheel_approve_beads({ action: "reject" })`. The tool persists the idle phase; leave the checkpoint file to the server.
   - Call `release_file_reservations` for the current Agent Mail identity with `project_key` set to the current working directory.
   - Use `TaskList` to find any active flywheel tasks, then `TaskUpdate` each to `status: "deleted"` to cancel them.
4. Confirm: "Orchestration stopped. State cleared. Run `/agent-flywheel:start` to start fresh."
