---
name: flywheel-swarm-stop
description: Stop all running swarm agents and release their file reservations.
---

Parse $ARGUMENTS before any mutation.

- With neither `--yes` nor `--dry-run`, print this block and exit:

  ```
  /flywheel-swarm-stop is destructive: it kills all running swarm agents
  and releases every file reservation held by that swarm.

  Safe alternatives:
    /agent-flywheel:flywheel-swarm-status
    /flywheel-swarm-stop --dry-run

  Re-run with --yes to proceed.
  ```

- With `--dry-run`, identify the active swarm agents, their reservations, and their `in_progress` beads. Print what the command would stop, release, and reopen. Call no mutating tool.

- With `--yes`, run the sequence below.

1. Use the current task list, NTM pane status, and Agent Mail identities to identify agents and beads owned by this swarm.

2. Send each active agent an urgent Agent Mail request to finish its current step, commit recoverable partial work, and exit. Send structured shutdown requests individually. Structured messages cannot be broadcast.

3. Wait for acknowledgements. Use each saved task ID with `TaskStop` only for an agent that does not stop.

4. Call `release_file_reservations` once per stopped Agent Mail identity, passing that `agent_name` and the current project key.

5. Reopen only the stopped swarm's remaining `in_progress` beads with `br update <id> --status open`.

6. Mark the stopped swarm tasks deleted and report the numbers of agents stopped, reservations released, and beads reopened.
