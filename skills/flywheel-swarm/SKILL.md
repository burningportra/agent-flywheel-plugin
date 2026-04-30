---
name: flywheel-swarm
description: Launch a parallel swarm of agents to implement multiple beads simultaneously.
---

Launch a parallel swarm of implementation agents. $ARGUMENTS

> **NTM-first contract (MANDATORY).** All multi-agent fan-out goes through `ntm spawn` + `ntm --robot-send`. Do NOT use raw `Task`/`Agent()`, background CLIs, or direct `tmux` for impl agents. Before spawning anything, invoke the `/vibing-with-ntm` skill — it carries the project-tested marching-orders prompts, work-claim/reservation conventions, and pane-tending loops you don't have time to recreate. The only `Agent()` call permitted in this skill is for fresh-eyes reviewers in Step 9 (short-lived, benefits from subagent isolation).
>
> **NTM-unavailable fallback only.** If `which ntm` fails OR `ntm deps -v` reports a broken stack, surface a one-line warning, ask the user before downgrading, and only then fall back to the `Agent()` form preserved at the bottom of this skill. NTM-unavailable should be a rare, user-acknowledged degradation — never a silent default.

0. **Invoke `/vibing-with-ntm`.** Use the `Skill` tool with `vibing-with-ntm`. Follow its guidance for session bootstrap (NTM project resolution, Agent Mail, beads claim) and pane-tending (looper cadence, stuck-pane ladder, completion polling). The rest of this skill assumes its conventions are loaded.

1. Call `flywheel_approve_beads` with `action: "start"` via the agent-flywheel MCP server. This returns the list of ready beads.

2. If no beads are ready, say "No beads are ready for implementation. Run /agent-flywheel:start to create a plan first."

3. Ask the user: "How many agents should run in parallel? (Recommended: 2-4)"

4. **Setup coordination:**
   - Bootstrap Agent Mail: `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Swarm: <goal>")`
   - Create a team: `TeamCreate(team_name: "swarm-<goal-slug>")`
   - Resolve NTM project: read `projects_base` from `ntm config show` and confirm `$projects_base/$(basename $PWD)` resolves (per the readiness gate in `_inflight_prompt.md`). On miss, follow the symlink/config path from `flywheel-setup` §6 before continuing.
   - Apply the **AGENTS.md NTM pane priority** for swarm composition: prefer **4 pi + 2 cc** when both are healthy; fall back to **4 cod** if Pi is unavailable. Run `which cc cod gmi pi 2>/dev/null` and `ntm deps -v` to pick the live mix; never spawn agents whose CLI is missing.

5. For each ready bead (up to the user's limit), create a task and spawn an NTM-backed impl agent:
   - `TaskCreate(subject: "Impl: <bead-id> <title>", status: "in_progress")`
   - Save the task ID
   - Spawn the pane via NTM (per `/vibing-with-ntm` and `/ntm`):
     ```
     ntm spawn "$NTM_PROJECT" --pane-name="impl-<bead-id>" --agent="<cc|cod|pi>"
     ```
   - Send the marching-orders prompt via `ntm --robot-send` (NOT inline `Agent()`):
     ```
     ntm --robot-send="$NTM_PROJECT" --pane-name="impl-<bead-id>" --msg="
       ## Agent Mail Bootstrap
       Call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: '<resolved-model>',
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
     ```
   **Save each agent's task ID and pane name** — needed for `ntm --robot-restart-pane` and `TaskStop` if they become unresponsive.

6. **Monitor swarm (per `/vibing-with-ntm` tending loop):**
   - Schedule the looper at the cadence set by `/vibing-with-ntm` (typically `ScheduleWakeup(270s, …)`); poll `fetch_inbox` and `ntm --robot-is-working` between wakes.
   - If an agent goes idle without reporting completion, nudge it: `SendMessage(to: "impl-<bead-id>", message: "Please report your current status and any blockers.")`. Escalate per the stuck-pane ladder in `_implement.md` — nudge → context-handoff restart → force-stop.
   - Use `TaskList` to see overall swarm task status; use `ntm --robot-restart-pane` to recycle a wedged pane (preserves bead state via Agent Mail handoff).
   - `TaskStop(task_id: "<id>")` is last resort — only after the stuck-pane ladder is exhausted.

7. As each agent completes:
   - Update task: `TaskUpdate(taskId: "<task-id>", status: "completed")`
   - Shutdown agent: `SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})`
   - Do NOT broadcast shutdown to `"*"` — send to each agent individually.
   - **Do NOT close, kill, or restart the pane here** — the original pane stays alive until wrap-up (Step 9.5 cycle-reset) so the **Self review** path in Step 9 can hand the audit back to the same implementor with full context.

8. Report: "Swarm launched: N agents working on N beads via NTM. Use `/agent-flywheel:flywheel-swarm-status` to monitor progress."

9. **Wave-completion review gate (MANDATORY — do not skip).**
   Once **every** spawned agent has reported back (or been force-stopped), you owe the user the consolidated review prompt — watching panes/agents print "done" is **not** review. Read `skills/start/_review.md` end-to-end and execute its Step 8 flow verbatim:
   - Run §8.0a risky-bead detection on the just-finished beads.
   - Surface the consolidated `AskUserQuestion` (single-bead form for one completion, multi-bead form when multiple finished together) with options **Looks good / Self review / Fresh-eyes** (plus **Duel review** when §8.0a flags risk).
   - Route the chosen option through `flywheel_review` (`action: "looks-good" | "self-review" | "hit-me"`). Fresh-eyes spawns 5 reviewers via `Agent()` (NOT NTM) with the strict Agent Mail bootstrap and disk-write requirement; nudge up to 3× per reviewer if findings don't arrive within 2 minutes; fall back to `docs/reviews/*.md` + `git diff` if inboxes stay empty.

   Do NOT end the turn at Step 8. Continue into the rest of the review/wrap-up cycle (test-coverage sweep 9.25, UI polish 9.4, wrap-up 9.5+) per `_review.md` and `_wrapup.md`. Dropping out after launching a swarm is a known bug — the swarm is the middle of the flywheel, not the end.
