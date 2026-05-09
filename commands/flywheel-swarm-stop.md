---
description: Stop all running swarm agents and release their file reservations.
argument-hint: "[--yes | --dry-run]   destructive; bare invocation prints safe-alts and exits"
---

**First action:** Parse `$ARGUMENTS` for `--yes`, `--dry-run`, or neither.

- If neither flag is present (bare invocation), **stop and print this safe-alt block, then exit without acting**:
  ```
  /flywheel-swarm-stop is destructive: it kills all running swarm agents
  and releases every file reservation held under this project.

  Safe alternatives:
    /agent-flywheel:flywheel-swarm-status   — see what is running first
    /flywheel-swarm-stop --dry-run          — preview without acting

  Re-run with --yes to proceed.
  ```
  Do NOT call `release_file_reservations`, do NOT signal agents, do NOT mutate beads. Return.

- If `--dry-run`: run steps 1 through 5 below in **read-only mode** — fetch the agent list, list which reservations would be released, list which beads would be reset, but do NOT call any mutating tool. Print the would-be summary and exit.

- If `--yes`: proceed to step 1 and run the full sequence.

---

Stop the swarm and clean up.

1. Fetch all active agents via `fetch_inbox` on the `agent-mail` MCP tool to identify who is running.

2. Call `release_file_reservations` via `agent-mail` MCP tool with `project_key` set to the current working directory to release all reservations.

3. Send a stop signal to each active agent **individually** via `send_message` in `agent-mail` (do NOT broadcast to `"*"` — structured messages cannot be broadcast):
   - For each known active agent name, send:
     - Plain text nudge first: `send_message(to: "<name>", subject: "STOP — Swarm shutdown requested", body_md: "Please finish your current step, commit any partial work, and exit.", importance: "urgent")`
   - Then send structured shutdown: `SendMessage(to: "<name>", message: {"type": "shutdown_request", "reason": "Swarm stopped by user."})`
   - Use `TaskStop(task_id: "<id>")` for agents that don't respond (use saved task IDs from when they were spawned).

4. For beads still marked `in_progress` in `br list --json`, reset them to `open`:
   Run `br update <id> --status open` via Bash for each.

5. Use `TaskList` to find active swarm tasks, then `TaskUpdate` each to `status: "deleted"`.

6. Report: "Swarm stopped. N agents signaled to stop, N beads reset to open."
