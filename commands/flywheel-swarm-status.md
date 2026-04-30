---
description: Check the status of running swarm agents and bead progress.
---

Check swarm status.

1. Run `br list --json` via Bash. Display a status table:
   ```
   ID | Title | Status | Updated
   ```
   Highlight any beads `in_progress`.

2. Call `fetch_inbox` via `agent-mail` MCP tool. Display messages from running agents (sender, subject, time).

3. Flag beads that appear stuck: `updated_at` older than 30 minutes and still `in_progress`.

4. Show todo list status via TodoRead.

5. Recommend next action:
   - **Stuck agents detected** → suggest `/agent-flywheel:flywheel-swarm-stop` and restarting.
   - **All swarm beads have finished** (no `in_progress` rows tied to the active swarm AND completion messages received) → do **not** end here. Read `skills/start/_review.md` end-to-end and execute its Step 8 wave-completion review prompt: run §8.0a risky-bead detection, surface the consolidated `AskUserQuestion` with **Looks good / Self review / Fresh-eyes** (plus **Duel review** for risky beads), then route through `flywheel_review`. The swarm itself is not the terminal step — review/wrap-up still owes the user a turn.
   - **Mid-flight, no stalls** → report progress and stay idle (or `ScheduleWakeup` per `_implement.md` cadence).
