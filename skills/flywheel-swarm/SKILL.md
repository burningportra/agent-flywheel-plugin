---
name: flywheel-swarm
description: Launch a parallel swarm of agents to implement multiple beads simultaneously.
---

Launch a parallel swarm of implementation agents. $ARGUMENTS

1. Call `flywheel_approve_beads` with `action: "start"` via the agent-flywheel MCP server. This returns the list of ready beads.

2. If no beads are ready, say "No beads are ready for implementation. Run /agent-flywheel:start to create a plan first."

3. Ask the user: "How many agents should run in parallel? (Recommended: 2-4)"

4. **Setup coordination:**
   - Bootstrap Agent Mail: `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Swarm: <goal>")`
   - Create a team: `TeamCreate(team_name: "swarm-<goal-slug>")`

5. For each ready bead (up to the user's limit), create a task and spawn an agent:
   - `TaskCreate(subject: "Impl: <bead-id> <title>", status: "in_progress")`
   - Save the task ID
   ```
   Agent(
     subagent_type: "general-purpose",
     isolation: "worktree",
     name: "impl-<bead-id>",
     team_name: "swarm-<goal-slug>",
     run_in_background: true,
     prompt: "
       ## Agent Mail Bootstrap
       Call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6',
         task_description: 'Implementing bead <id>: <title>')
       Note your assigned agent name for messaging.

       ## File Reservation
       Before editing any files, call file_reservation_paths with the files you plan to modify.
       Release reservations when done: release_file_reservations.

       ## Bead: <id> — <title>
       <description>

       ## Acceptance criteria
       <criteria>

       ## On completion
       Send a completion message to <your-coordinator-name> via send_message.
     "
   )
   ```
   **Save each agent's task ID** — needed for `TaskStop` if they become unresponsive.

6. **Monitor swarm:**
   - If an agent goes idle without reporting completion, nudge it: `SendMessage(to: "impl-<bead-id>", message: "Please report your current status and any blockers.")`
   - Use `TaskList` to see overall swarm task status.
   - Use `TaskStop(task_id: "<id>")` to force-stop an unresponsive agent.

7. As each agent completes:
   - Update task: `TaskUpdate(taskId: "<task-id>", status: "completed")`
   - Shutdown agent: `SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})`
   - Do NOT broadcast shutdown to `"*"` — send to each agent individually.

8. Report: "Swarm launched: N agents working on N beads. Use `/agent-flywheel:flywheel-swarm-status` to monitor progress."

9. **Wave-completion review gate (MANDATORY — do not skip).**
   Once **every** spawned agent has reported back (or been force-stopped), you owe the user the consolidated review prompt — watching panes/agents print "done" is **not** review. Read `skills/start/_review.md` end-to-end and execute its Step 8 flow verbatim:
   - Run §8.0a risky-bead detection on the just-finished beads.
   - Surface the consolidated `AskUserQuestion` (single-bead form for one completion, multi-bead form when multiple finished together) with options **Looks good / Self review / Fresh-eyes** (plus **Duel review** when §8.0a flags risk).
   - Route the chosen option through `flywheel_review` (`action: "looks-good" | "self-review" | "hit-me"`). Fresh-eyes spawns 5 reviewers via `Agent()` (NOT NTM) with the strict Agent Mail bootstrap and disk-write requirement; nudge up to 3× per reviewer if findings don't arrive within 2 minutes; fall back to `docs/reviews/*.md` + `git diff` if inboxes stay empty.

   Do NOT end the turn at Step 8. Continue into the rest of the review/wrap-up cycle (test-coverage sweep 9.25, UI polish 9.4, wrap-up 9.5+) per `_review.md` and `_wrapup.md`. Dropping out after launching a swarm is a known bug — the swarm is the middle of the flywheel, not the end.
