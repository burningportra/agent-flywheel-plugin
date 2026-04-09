# Proposed Changes to orchestrate SKILL.md

Session: 2026-04-09 | Evidence-driven refinements

---

## Change 1: Promote "already-closed beads" from edge case to expected default (Step 8)

**Problem:** `orch_review` errored with "Cannot read properties of undefined (reading 'split')" for ALL 7 Wave 1 beads. The skill documents this as an "Edge case" but it is the common case — impl agents call `br update --status closed` in Step 3 of their prompt, so beads are always closed before the coordinator requests review.

**BEFORE** (lines 269):
```markdown
  > **Edge case — already-closed beads:** If `orch_review` errors (e.g. "Cannot read properties of undefined"), the bead was likely already closed by the impl agent before review was requested. Skip the MCP tool and spawn review agents manually. Give each reviewer the specific git commit SHA (from `git log --oneline`) and instruct them to review via `git diff <commit>~1 <commit>` directly.
```

**AFTER:**
```markdown
  > **Expected behavior — beads are already closed:** Because impl agents close beads in their Step 3 (`br update --status closed`), `orch_review` will typically error (e.g. "Cannot read properties of undefined (reading 'split')") when called on completed beads. This is the **normal** case, not an edge case. When this happens:
  > 1. Skip the `orch_review` MCP tool entirely.
  > 2. Find the bead's commit SHA: `git log --oneline | grep "<bead-id>"` (or search for the bead title).
  > 3. Spawn review agents manually with `git diff <sha>~1 <sha>` as their review target instead of relying on `orch_review` output.
  >
  > Only use `orch_review` with `action: "looks-good"` if you confirmed the bead is still in an open state (check with `br list`).
```

---

## Change 2: Add reviewer nudge-by-name to monitoring loop (Step 8)

**Problem:** A reviewer's findings message never appeared in the coordinator's inbox. The coordinator had to explicitly nudge the reviewer by name to get the message resent.

**BEFORE** (lines 263-266):
```markdown
  1. Create a review team: `TeamCreate(team_name: "review-<bead-id>")`
  2. Spawn all 5 with `run_in_background: true`, each with `team_name` set and the strict STEP 0 Agent Mail bootstrap in their prompt
  3. If any go idle without reporting, nudge by name: `SendMessage(to: "<reviewer-name>", message: "Please send your review findings.")`
  4. Shutdown each reviewer individually after collecting results — do NOT broadcast structured messages to `"*"`
```

**AFTER:**
```markdown
  1. Create a review team: `TeamCreate(team_name: "review-<bead-id>")`
  2. Spawn all 5 with `run_in_background: true`, each with `team_name` set and the strict STEP 0 Agent Mail bootstrap in their prompt
  3. **Monitor with mandatory nudge loop** — reviewer messages frequently fail to arrive in the coordinator's inbox on the first attempt. After spawning, poll `fetch_inbox` every 30-60 seconds. For each reviewer that has not delivered findings within 2 minutes, nudge by name:
     ```
     SendMessage(to: "<reviewer-name>", message: "Your review findings for bead <id> have not arrived. Please resend to <coordinator-name> via Agent Mail with subject '[review] <id> findings'.")
     ```
     Nudge up to 3 times per reviewer before considering them failed.
  4. Shutdown each reviewer individually after collecting results — do NOT broadcast structured messages to `"*"`
```

---

## Change 3: Add `retire_agent` fallback for unresponsive impl agents (Step 7)

**Problem:** After sending `shutdown_request` to impl agents, two agents (fix-deep-plan and impl-3do) remained idle without exiting. Required `retire_agent` via Agent Mail as a fallback.

**BEFORE** (lines 227-230):
```markdown
4. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
```

**AFTER:**
```markdown
4. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
   **If the agent remains idle after shutdown_request** (check via `TaskList` — task still shows as active after 60 seconds):
   - Force-stop with `TaskStop(task_id: "<saved-task-id>")` if the task ID is available.
   - Retire in Agent Mail: `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")`.
   - If still listed in the team, edit `~/.claude/teams/<team>/config.json` to remove from the `"members"` array, then retry `TeamDelete` when ready.
```

---

## Change 4: Fix "Collect plans" to read from disk, not inbox bodies (Step 5, sub-step 5)

**Problem:** The skill says `fetch_inbox(include_bodies: true)` to collect plan bodies. But agents write plans to disk and send only file paths. Large plan bodies in inbox messages are unwieldy and may be truncated. The working approach from the session was: `fetch_inbox(include_bodies: false)` to get file paths, then read plans from disk.

**BEFORE** (line 85):
```markdown
5. **Collect plans** — call `fetch_inbox(project_key: cwd, agent_name: "<your-name>", include_bodies: true)` to retrieve all 3 plan bodies.
```

**AFTER:**
```markdown
5. **Collect plans** — call `fetch_inbox(project_key: cwd, agent_name: "<your-name>", include_bodies: false)` to retrieve message summaries. Each agent sent the file path to their plan on disk (e.g. `docs/plans/<date>-<perspective>.md`). Read the plan files directly from disk using the Read tool — do NOT rely on inbox message bodies for large plan content, as they may be truncated or unwieldy.
```

---

## Change 5: Add `broadcast shutdown_request does not work` warning to Step 7 (implement)

**Problem:** Broadcasting `shutdown_request` to `"*"` does NOT work for structured messages. This is already documented in Step 5 (deep plan) sub-step 6, but not in Step 7 (implement), where the coordinator also needs to shut down multiple impl agents.

**BEFORE** (lines 227-230 — Step 7, sub-step 4 only has the single-agent shutdown example):
```markdown
4. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
```

**AFTER** (add a note after the shutdown block, in addition to the retire_agent fallback from Change 3):
```markdown
4. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
   > **Important:** Structured shutdown messages CANNOT be broadcast to `"*"`. You must send to each impl agent individually by name. This applies to all structured JSON messages (shutdown_request, plan_approval_request, etc.).

   **If the agent remains idle after shutdown_request** (check via `TaskList` — task still shows as active after 60 seconds):
   - Force-stop with `TaskStop(task_id: "<saved-task-id>")` if the task ID is available.
   - Retire in Agent Mail: `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")`.
   - If still listed in the team, edit `~/.claude/teams/<team>/config.json` to remove from the `"members"` array, then retry `TeamDelete` when ready.
```

*Note: Changes 3 and 5 both modify the same section (Step 7, sub-step 4). When applying, merge them into a single replacement — the broadcast warning goes before the retire_agent fallback.*

---

## Summary of changes

| # | Section | Problem | Fix |
|---|---------|---------|-----|
| 1 | Step 8 "Fresh-eyes" edge case | orch_review errors on closed beads treated as edge case; it's the default | Promote to expected behavior with explicit workaround steps |
| 2 | Step 8 "Fresh-eyes" monitoring | Reviewer messages silently lost | Add mandatory nudge-by-name polling loop with retry count |
| 3 | Step 7 sub-step 4 | No fallback when impl agents ignore shutdown_request | Add retire_agent + config.json edit fallback chain |
| 4 | Step 5 sub-step 5 | Collect plans reads from inbox bodies (unwieldy) | Read from disk paths instead |
| 5 | Step 7 sub-step 4 | No broadcast warning for impl agent shutdown | Add "cannot broadcast structured messages" note |
