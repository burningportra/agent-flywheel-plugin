---
name: orchestrate-rollback
description: Roll back a completed bead implementation.
---

Roll back a bead implementation. $ARGUMENTS (optional: bead ID)

1. If a bead ID is provided in $ARGUMENTS, use it. Otherwise, run `br list --json` and show completed beads for the user to choose from.

2. Show the commits associated with the selected bead: `git log --oneline -10` via Bash.

3. Ask: "Which commit marks the start of bead `<id>`? (Or: roll back to before this bead was implemented)"

4. Ask the user to confirm: "This will revert changes. Are you sure?"

5. If confirmed:
   - `git revert <commit>` or `git revert <from>..<to>` via Bash (prefer revert over reset).
   - Update bead status: `br update <id> --status open` via Bash.
   - Update checkpoint to remove the bead from `beadResults`.
   - Use `TaskList` to find the task for this bead, then `TaskUpdate(taskId: "<id>", status: "deleted")` to cancel it.

6. Confirm: "Rolled back bead `<id>`. It is now open and ready to re-implement."
