---
description: Fast path to apply a targeted fix without running the full flywheel.
---

Apply a targeted fix: $ARGUMENTS

Fast-path implementation for small, focused changes.

1. Parse the fix description from $ARGUMENTS. If empty, ask: "What needs to be fixed?"

2. Use `Agent(subagent_type: "Explore")` to analyze the relevant code and understand the scope of the fix.

3. Create a single bead for the fix:
   ```bash
   br create --title "Fix: <description>" --description "<full context>" --type bug
   ```
   Track it with `TaskCreate(subject: "Fix: <description>", status: "in_progress")`.

4. Bootstrap Agent Mail: call `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Fix: <description>")`.
   Create a team: `TeamCreate(team_name: "fix-<slug>")`.

5. Spawn a focused implementation agent with `run_in_background: true`:
   ```
   Agent(
     subagent_type: "general-purpose",
     isolation: "worktree",
     name: "fix-impl",
     team_name: "fix-<slug>",
     run_in_background: true,
     prompt: "
       ## Agent Mail Bootstrap
       Call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6', task_description: 'Fix: <description>')
       Reserve files you will edit: call file_reservation_paths(...) before making changes.
       Release reservations when done: call release_file_reservations(...).
       Send a completion message to <your-name> via send_message when done.

       ## Fix
       Apply this fix: <description>

       Context from codebase analysis:
       <analysis>

       Keep changes minimal and targeted. Do not refactor unrelated code.
     "
   )
   ```
   Save the returned task ID for potential `TaskStop` use.

6. If the agent goes idle without reporting, nudge: `SendMessage(to: "fix-impl", message: "Please report your status.")`.

7. After completion, shutdown: `SendMessage(to: "fix-impl", message: {"type": "shutdown_request", "reason": "Fix complete."})`.
   Update task: `TaskUpdate(taskId: "<id>", status: "completed")`.

8. Call `flywheel_review` with `action: "hit-me"` to get fresh-eyes review.

9. Show the results and ask: "Looks good to commit?" If yes, mark the bead closed: `br update <id> --status closed`.
