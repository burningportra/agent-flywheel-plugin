---
name: orchestrate
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

# Orchestrate: Full Flywheel

Run the orchestrator for this project. $ARGUMENTS (optional: initial goal or `--mode single-branch`)

## Step 0: Show version

Attempt to find `mcp-server/package.json` by searching the Claude plugins directory:
```bash
find ~/.claude/plugins -path "*/claude-orchestrator/mcp-server/package.json" 2>/dev/null | head -1
```
If found, read it and display the version:

> **claude-orchestrator v`<version>`**

If not found, display and continue — do NOT block:

> **claude-orchestrator (version unknown — MCP server not installed)**

## Step 0.5: Verify MCP tools are available

Before proceeding, check that the orchestrator MCP tools are registered:

1. Use `ToolSearch` with query `"select:orch_profile"`.
2. If the tool schema is returned: proceed to Step 1.
3. If NOT found, display:

> **Orchestrator MCP server is not configured.**
> The `orch_*` tools (`orch_profile`, `orch_discover`, `orch_plan`, etc.) are not available.
>
> **To install:** Run `/orchestrate-setup` to configure the MCP server.
>
> **To continue without it:** The structured flywheel (planning quality scores, bead management, session memory) will not be available. Type "continue anyway" to proceed in degraded mode.

4. If the user chooses to continue in degraded mode, set an internal flag `MCP_DEGRADED = true` and apply these overrides for all subsequent steps:
   - **Step 2:** Use Explore subagent only (skip `orch_profile`).
   - **Step 3:** Use Explore-derived ideas (skip `orch_discover`).
   - **Step 5:** Standard plan only — generate via Explore agent, write to `docs/plans/<date>-<goal-slug>.md` (skip `orch_plan`).
   - **Step 5.5:** Create beads with `br create` as normal.
   - **Step 6:** Present beads via `br list`, ask user to confirm manually — no quality score available.
   - **Step 8:** Offer "Looks good" and "Self review" only (skip `orch_review`).
   - **Step 10:** Skip `orch_memory` — remind user that session learnings were not auto-persisted.

5. If the user declines, stop gracefully.

## Step 1: Check for existing session

Read `.pi-orchestrator/checkpoint.json` if it exists. If a non-idle/non-complete session is found, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Found a previous session (phase: <phase>, goal: <goal>). What would you like to do?",
  header: "Session",
  options: [
    { label: "Resume", description: "Continue from where we left off" },
    { label: "Start fresh", description: "Discard previous state and begin a new session" }
  ],
  multiSelect: false
}])
```

If the user chooses "Start fresh", delete the checkpoint file.

## Step 2: Scan and profile the repository

Call `orch_profile` with `cwd`. The tool uses a git-HEAD-keyed cache — if the repo hasn't changed since the last scan, it returns instantly from cache.

- **Cache hit** (output says "Profile loaded from cache"): Skip the Explore agent — the profile is fresh. Proceed directly to Step 3.
- **Cache miss** (fresh scan): Optionally spawn an Explore agent for deeper analysis if the profile reveals a complex or unfamiliar codebase. For known repos, skip it.
- **Force re-scan**: Pass `force: true` to `orch_profile` to bypass the cache (e.g. after major restructuring).

If `MCP_DEGRADED` is true or `orch_profile` fails, fall back to an Explore agent for manual profiling.

## Step 3: Discover improvement ideas

If `MCP_DEGRADED` is false, call `orch_discover` with `cwd`.

If `MCP_DEGRADED` is true (or `orch_discover` fails), generate improvement ideas from the Explore agent's findings in Step 2: identify code quality issues, missing tests, architectural improvements, and documentation gaps. Rank by estimated impact.

Present the top ideas to the user using `AskUserQuestion`. Include up to 4 top-ranked ideas as options (the "Other" option is automatically provided for custom goals):

```
AskUserQuestion(questions: [{
  question: "Which goal would you like to pursue?",
  header: "Goal",
  options: [
    { label: "<idea 1 short title>", description: "<one-line summary>" },
    { label: "<idea 2 short title>", description: "<one-line summary>" },
    { label: "<idea 3 short title>", description: "<one-line summary>" },
    { label: "<idea 4 short title>", description: "<one-line summary>" }
  ],
  multiSelect: false
}])
```

If the user selects "Other" and enters a custom goal, run the `/brainstorming` skill first to explore intent, constraints, and edge cases before committing to scope. The brainstorming skill will use `AskUserQuestion` to ask clarifying questions about:
- What problem the user is trying to solve and why
- Known constraints or non-goals
- Desired outcome and acceptance criteria

After brainstorming completes and the goal is refined, use `AskUserQuestion` to confirm scope:

```
AskUserQuestion(questions: [{
  question: "Goal refined: '<refined goal from brainstorming>'. How should I scope this?",
  header: "Scope",
  options: [
    { label: "Full flywheel", description: "Deep scan, plan, implement with agents, review" },
    { label: "Plan only", description: "Generate and review a plan, stop before implementation" },
    { label: "Quick fix", description: "Skip planning — use /orchestrate-fix for a targeted change" }
  ],
  multiSelect: false
}])
```

- **"Full flywheel"** → proceed to Step 4 with the refined goal
- **"Plan only"** → proceed through Step 5, then stop after bead creation
- **"Quick fix"** → invoke `/orchestrate-fix` with the refined goal instead

## Step 4: Select goal

Once the user chooses, call `orch_select` with `cwd` and `goal` set to their choice.

## Step 5: Choose planning mode

Before presenting the choice, briefly frame the Three Reasoning Spaces to help the user understand why planning investment matters:

> **The Flywheel operates across three reasoning spaces:**
> - **Plan Space** (where we are now) — architecture, features, tradeoffs. Fixing errors here costs **1x**.
> - **Bead Space** (next) — self-contained work units with dependencies. Fixing errors here costs **5x**.
> - **Code Space** (implementation) — source files and tests. Fixing errors here costs **25x**.
>
> Deep planning front-loads effort where corrections are cheapest.

Use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "How would you like to plan?",
  header: "Plan mode",
  options: [
    { label: "Standard plan", description: "Single planning pass — faster" },
    { label: "Deep plan", description: "3 AI models give competing perspectives, then synthesize — higher quality, takes longer" }
  ],
  multiSelect: false
}])
```

**Standard plan**: Call `orch_plan` with `cwd` and `mode: "standard"`.

**Deep plan**:

1. **Bootstrap Agent Mail** — call `macro_start_session` with:
   - `human_key`: current working directory
   - `program`: "claude-code"
   - `model`: your model name
   - `task_description`: "Orchestrating deep plan for: <goal>"
   Note your assigned agent name (e.g. "CoralReef") — you are the coordinator.

2. **Create a team** — call `TeamCreate` with a descriptive `team_name` (e.g. `"deep-plan-<slug>"`).

3. **Spawn 3 plan agents IN PARALLEL** using the Agent tool with `team_name` set and `run_in_background: true` so they get task IDs (required for `TaskStop` if they become unresponsive):
   - `Agent(model: "opus", name: "correctness-planner", team_name: "<team>", run_in_background: true, prompt: "...")`
   - `Agent(model: "sonnet", name: "ergonomics-planner", team_name: "<team>", run_in_background: true, prompt: "...")`
   - `Agent(subagent_type: "codex:codex-rescue", name: "robustness-planner", team_name: "<team>", run_in_background: true, prompt: "...")`

   **Save the task ID returned by each Agent call** — you'll need them to force-stop unresponsive agents via `TaskStop(task_id: "<id>")`.

   Each agent's prompt MUST include:
   - Instructions to call `macro_start_session` first (same `human_key`, their model, their task)
   - Their focused planning perspective (correctness / ergonomics / robustness)
   - Full repo context (path, stack, goal, recent commits, known bugs)
   - Instruction to **write their plan to disk**: `docs/plans/<date>-<perspective>.md` (use the Write tool — do NOT send large plan text through Agent Mail message body)
   - Instruction to send YOU just the file path via `send_message` with subject `"[deep-plan] <perspective> plan"` once written
   - Instruction to message their team lead when done

4. **Monitor and nudge** — agents go idle between turns (this is normal). If a teammate has gone idle without delivering their plan:
   - Use `SendMessage(to: "<agent-name>", message: "Your plan is needed — please send it to <your-name> via Agent Mail and report back.")` to wake them.
   - Check your inbox with `fetch_inbox` to see which plans have arrived.
   - Use `TaskList` to see overall team task status.
   - If an agent is unresponsive after nudging, force-stop it with `TaskStop(task_id: "<saved-task-id>")`. Then retire it in Agent Mail: `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")`. Do not rely on shutdown_request messages alone — in-process agents may not respond to them.
   - **If `TaskStop` fails** (e.g. no task ID found in `TaskList` for in-process agents): retire via Agent Mail `retire_agent(project_key: cwd, agent_name: "<stale-agent-name>")`, then edit `~/.claude/teams/<team>/config.json` to remove the stale member from the `"members"` array. Then retry `TeamDelete`.

5. **Collect plans** — call `fetch_inbox(project_key: cwd, agent_name: "<your-name>", include_bodies: false)` to retrieve message summaries. Each agent sent the file path to their plan on disk (e.g. `docs/plans/<date>-<perspective>.md`). Read the plan files directly from disk using the Read tool — do NOT rely on inbox message bodies for large plan content, as they may be truncated or unwieldy.

6. **Shutdown teammates individually** — structured shutdown messages CANNOT be broadcast to `"*"`. Send to each agent by name:
   ```
   SendMessage(to: "correctness-planner", message: {"type": "shutdown_request", "reason": "Planning complete."})
   SendMessage(to: "ergonomics-planner",  message: {"type": "shutdown_request", "reason": "Planning complete."})
   SendMessage(to: "robustness-planner",  message: {"type": "shutdown_request", "reason": "Planning complete."})
   ```

7. **Synthesize (Best-of-All-Worlds)** — spawn one synthesis agent with `run_in_background: true`:
   ```
   Agent(model: "opus", name: "plan-synthesizer", team_name: "<team>", run_in_background: true,
     prompt: "
       Read the plan files written by the planning agents:
         docs/plans/<date>-correctness.md
         docs/plans/<date>-ergonomics.md
         docs/plans/<date>-robustness.md
         (and docs/plans/<date>-fresh-perspective.md if it exists)

       ## Best-of-All-Worlds Synthesis

       For EACH plan, BEFORE proposing any changes:
       1. Honestly acknowledge what that plan does better than the others.
       2. Identify the unique insight each plan contributes that the others miss.

       Then synthesize:
       3. Blend the strongest ideas from all plans into a single superior document.
       4. For each major decision, state which plan's approach you adopted and why.
       5. Flag unresolved tensions where plans fundamentally disagree.

       The synthesis must be BETTER than any individual plan, not a lowest-common-denominator average.

       Write the result to: docs/plans/<date>-<goal-slug>-synthesized.md
       Send the file path to <your-coordinator-name> via Agent Mail when done.
     "
   )
   ```
   Do NOT embed plan content inline in the prompt — read from disk.
   Shutdown after done: `SendMessage(to: "plan-synthesizer", message: {"type": "shutdown_request", "reason": "Synthesis complete."})`.

8. Call `orch_plan` with `cwd`, `mode: "deep"`, and `planFile: "docs/plans/<date>-<goal-slug>-synthesized.md"`.
   **Never pass `planContent`** — large text over MCP stdio stalls the server. Always write to disk first.

9. **Optional: Iterative deepening** — to prevent model anchoring, run 2-3 fresh refinement rounds on the synthesized plan. Each round spawns a NEW agent (fresh context, no memory of prior rounds) that reviews and proposes improvements:
   ```
   Agent(model: "opus", name: "refine-round-<N>", isolation: "worktree", run_in_background: true,
     prompt: "
       Read the synthesized plan at docs/plans/<date>-<goal-slug>-synthesized.md.
       You have NOT seen any prior plans or revisions — this is your first and only look.
       Carefully review the entire plan. Come up with the best revisions you can.
       For each change, give detailed analysis and rationale.
       Provide changes in git-diff format. Use ultrathink.
       Write your revised plan to the same file path when done.
     "
   )
   ```
   Stop when a round produces only minor wording changes — this signals the plan has converged. Fresh conversations prevent anchoring on prior output.

## Step 5.5: Create beads from the plan

Beads are **NOT** auto-created by `orch_plan`. The coordinator must create them manually from the plan output:

1. For each task/unit-of-work in the plan, create a bead:
   ```
   br create --title "Verb phrase" --description "WHAT/WHY/HOW" --priority 2 --type task
   ```

2. **Auto-generate test beads:** If a bead's acceptance criteria include testing requirements (unit tests, e2e tests, integration tests), create a companion test bead that depends on the implementation bead:
   ```
   br create --title "Test: <impl bead title>" --description "Write tests for <bead-id>: <specific test requirements from acceptance criteria>" --priority 2 --type task
   br dep add <test-bead-id> <impl-bead-id>
   ```

3. After all beads are created, add dependency edges:
   ```
   br dep add <downstream-bead-id> <upstream-bead-id>
   ```
   > **Syntax note:** Arguments are positional — `<downstream>` depends on `<upstream>`. The `--depends-on` flag does NOT exist. If the command fails, verify you are passing two positional IDs with no flags.

4. Verify with `br list` — confirm all beads and dependencies look correct.

> **WARNING:** Use `br list` for all read-only bead inspection. Never call `orch_approve_beads` just to preview beads — it is NOT read-only and advances internal state counters regardless of the action used.

## Step 6: Review and approve beads

Use `br list` to display the current beads. Then use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Here are the implementation beads. What would you like to do?",
  header: "Beads",
  options: [
    { label: "Start implementing", description: "Launch the implementation loop with agents" },
    { label: "Polish further", description: "Refine the beads before implementing" },
    { label: "Reject", description: "Discard these beads and start over with a different goal" }
  ],
  multiSelect: false
}])
```

- "Start" → call `orch_approve_beads` with `action: "start"`
  > **Note:** If the plan was just registered via `orch_plan`, the first `orch_approve_beads` call may return "Create beads from plan" instructions instead of the quality score. In that case, create beads with `br create`, then call `orch_approve_beads` with `action: "start"` a second time to get the quality score and launch.
- "Polish" → call `orch_approve_beads` with `action: "polish"`, then use `br list` to show updated beads, loop
- "Reject" → call `orch_approve_beads` with `action: "reject"`, return to Step 3

If the user asks "what's the quality score?" before choosing to start, call `orch_approve_beads` with `action: "start"` immediately — this is the only way to surface the score. Present it, then wait for confirmation before proceeding to implementation.

After calling `orch_approve_beads` with `action: "start"`, display **both** the convergence/quality score and a summary table:

**Plan quality score: X.XX / 1.00** (threshold: 0.75 — if below, discuss with user before proceeding)

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Populate **Wave** from the bead's dependency wave assignment, **Effort** from the plan's effort estimate, and **Risk Flags** from any warnings or risk notes in the plan output. This gives the user visibility into what is about to be implemented and in what order.

Wait for user confirmation before proceeding to Step 7 — the quality score may prompt them to polish further.

## Step 7: Implement each bead

Use `TaskCreate` to create a task per bead. For each ready bead:

1. Create a named implementation team if multiple beads are parallelizable:
   ```
   TeamCreate(team_name: "impl-<goal-slug>")
   ```
   > **NOTE:** If a planning team (e.g. `"deep-plan-<slug>"`) is still active from Step 5, you must delete it first via `TeamDelete(team_name: "deep-plan-<slug>")` before creating the impl team. If `TeamDelete` fails because agents are still registered, retire them via Agent Mail `retire_agent` first, then retry `TeamDelete`. Alternatively, reuse the existing planning team by passing its `team_name` to impl agents.

2. Spawn an implementation agent with team membership. **Agent Mail bootstrap is only required for parallel beads** — if beads are sequential (linear dependency chain, one agent at a time), omit STEP 0 to reduce overhead. For parallel beads, include the strict bootstrap to prevent file conflicts:
   ```
   Agent(
     subagent_type: "general-purpose",
     isolation: "worktree",
     name: "impl-<bead-id>",
     team_name: "impl-<goal-slug>",
     prompt: "
       ## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY — DO THIS BEFORE ANYTHING ELSE)
       Do NOT read any files or run any commands until all 3 sub-steps below are complete.

       0a. Call macro_start_session(
             human_key: '<cwd>',
             program: 'claude-code',
             model: '<model>',
             task_description: 'Implementing bead <id>: <title>')
           Note your assigned agent name.

       0b. Call file_reservation_paths to reserve every file you plan to edit.
           If any file is already reserved, wait 30 seconds and retry up to 3 times.
           If still blocked after 3 retries, send a message to '<coordinator-agent-name>'
           reporting the conflict, then STOP.

       0c. Send a 'started' message to '<coordinator-agent-name>' via send_message
           with subject '[impl] <bead-id> started'.

       Only after 0a, 0b, 0c are ALL complete may you proceed to Step 1.

       ## STEP 1 — IMPLEMENT
       <bead title>
       <bead description>
       Acceptance criteria: <criteria>

       ## STEP 2 — VALIDATE
       Run tests and linting relevant to your changes. Fix any failures.

       ## STEP 3 — COMMIT & CLOSE BEAD
       Create a commit with a descriptive message referencing bead <id>.
       Then mark the bead closed: `br update <bead-id> --status closed`
       (Note: the br CLI uses `closed`, NOT `done`.)

       ## STEP 4 — RELEASE + REPORT (MANDATORY)
       4a. Release all file reservations via release_file_reservations.
       4b. Send a completion summary to '<coordinator-agent-name>' via send_message
           with subject '[impl] <bead-id> done' including:
           - Files changed
           - Tests added/modified
           - Any open concerns or follow-ups
     "
   )
   ```

3. Mark the bead's task as `in_progress`. If the agent goes idle before reporting back, nudge it:
   ```
   SendMessage(to: "impl-<bead-id>", message: "Please report your current status and any blockers.")
   ```

4. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
   > **Important:** Structured shutdown messages CANNOT be broadcast to `"*"`. You must send to each impl agent individually by name. This applies to all structured JSON messages (shutdown_request, plan_approval_request, etc.).

   **If the agent remains idle after shutdown_request** (check via `TaskList` — task still shows as active after 60 seconds):
   - Force-stop with `TaskStop(task_id: "<saved-task-id>")` if the task ID is available.
   - Retire in Agent Mail: `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")`.
   - If still listed in the team, edit `~/.claude/teams/<team>/config.json` to remove from the `"members"` array, then retry `TeamDelete` when ready.

## Step 8: Review completed beads

When one or more beads complete, present a consolidated review prompt. Never ask per-bead if multiple are ready.

If a **single bead** finishes, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Bead <id> is done. How would you like to review?",
  header: "Review",
  options: [
    { label: "Looks good", description: "Accept and move on" },
    { label: "Self review", description: "Send the impl agent back to audit its own diff" },
    { label: "Fresh-eyes", description: "5 parallel review agents give independent feedback" }
  ],
  multiSelect: false
}])
```

If **multiple beads** finish together, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Beads <id1>, <id2>, <id3> are done. How would you like to review?",
  header: "Review",
  options: [
    { label: "Looks good all", description: "Accept all and move on" },
    { label: "Self review", description: "Pick a specific bead for self-review (enter bead ID in Other)" },
    { label: "Fresh-eyes", description: "Pick a specific bead for 5-agent review (enter bead ID in Other)" }
  ],
  multiSelect: false
}])
```

Users can also type a custom combination via "Other" (e.g. "Looks good all except fresh-eyes `<id2>`").

Actions:

- **"Looks good" / "Looks good all"** → call `orch_review` with `action: "looks-good"` and `beadId` for each accepted bead.

- **"Self review `<id>`"** → send the impl agent a message asking it to audit its own diff:
  ```
  SendMessage(to: "impl-<id>", message: "Self-review: run `git diff` on your changes, check for bugs, missing tests, and style issues. Report findings to <coordinator> via Agent Mail with subject '[review] <id> self-review'.")
  ```
  After the self-review report arrives, call `orch_review` with `action: "looks-good"` and `beadId` to close it.

- **"Fresh-eyes `<id>`"** → call `orch_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Then:
  1. Create a review team: `TeamCreate(team_name: "review-<bead-id>")`
  2. Spawn all 5 with `run_in_background: true`, each with `team_name` set and the strict STEP 0 Agent Mail bootstrap in their prompt
  3. **Monitor with mandatory nudge loop** — reviewer messages frequently fail to arrive in the coordinator's inbox on the first attempt. After spawning, poll `fetch_inbox` every 30-60 seconds. For each reviewer that has not delivered findings within 2 minutes, nudge by name:
     ```
     SendMessage(to: "<reviewer-name>", message: "Your review findings for bead <id> have not arrived. Please resend to <coordinator-name> via Agent Mail with subject '[review] <id> findings'.")
     ```
     Nudge up to 3 times per reviewer before considering them failed.
  4. Shutdown each reviewer individually after collecting results — do NOT broadcast structured messages to `"*"`
  5. Collect and summarize results.

  > **Expected behavior — beads are already closed:** Because impl agents close beads in their Step 3 (`br update --status closed`), `orch_review` will typically error (e.g. "Cannot read properties of undefined (reading 'split')") when called on completed beads. This is the **normal** case, not an edge case. When this happens:
  > 1. Skip the `orch_review` MCP tool entirely.
  > 2. Find the bead's commit SHA: `git log --oneline | grep "<bead-id>"` (or search for the bead title).
  > 3. Spawn review agents manually with `git diff <sha>~1 <sha>` as their review target instead of relying on `orch_review` output.
  >
  > Only use `orch_review` with `action: "looks-good"` if you confirmed the bead is still in an open state (check with `br list`).

  > **Edge case — team already active:** `TeamCreate` for a review team fails with "already leading a team" if an impl team is still running. Reuse the existing team by passing `team_name: "impl-<goal-slug>"` to the review agents instead of creating a new one.

## Step 9: Loop until complete

Continue implementing and reviewing beads until all are done. Show a final summary of what was accomplished.

## Step 9.5: Wrap-up — commit, version bump, rebuild

Once all beads are reviewed and closed, perform a clean session wrap-up **before** storing learnings:

### 1. Review bead commits
Run `git log --oneline` to show the bead commits from this session. Propose logical groupings to the user — e.g. "3 beads touched the same subsystem; want me to squash them?" Only squash if the user confirms.

### 2. Update documentation
Before committing anything, update these files to reflect what shipped:

- **`AGENTS.md`** — update the Hard Constraints, Testing, and any module-level guidance that changed (e.g. new logger convention, new test runner, new CLI tools). Sub-agents read this; stale guidance causes bugs.
- **`README.md`** — update the architecture map (add/remove files), key design decisions (document new patterns), and the models table if routing changed.

Only update sections that are actually affected by this session's changes. Do not rewrite unchanged sections.

### 3. Commit any stray tracked/untracked files
Check `git status` for uncommitted files (plan docs, skill updates, config changes). Commit them in logical groups:
- Plan artifacts: `docs: add session plan artifact for <goal>`
- Skills added/updated: `feat(skills): ...`
- Config or gitignore changes: `chore: ...`

### 4. Version bump
Determine the correct semver bump based on what shipped:
- **patch** (x.x.X): bug fixes, stale comment cleanup, doc-only changes
- **minor** (x.X.0): new features or modules (new tool, new logger, new config fields)
- **major** (X.0.0): breaking API or schema changes

Ask the user to confirm the bump level if uncertain. Update `mcp-server/package.json` version field.

### 5. Rebuild
Run `npm run build` in `mcp-server/` to compile the bumped version into `dist/`.

### 6. Commit the version bump
```
git add mcp-server/package.json
git commit -m "chore: bump version to X.Y.Z — <one-line summary of what shipped>"
```

### 7. Show final log
`git log --oneline -10` so the user can see the clean commit stack before moving on.

## Step 10: Store session learnings

Call `orch_memory` with `operation: "store"` and `cwd` to distill and persist session learnings:
- What worked well (tool choices, agent configurations, planning strategies)
- What failed or required manual intervention (agent shutdowns, file conflicts, review bottlenecks)
- Key decisions made during this session and their outcomes
- Any patterns worth replicating or avoiding in future sessions

Present the stored learnings to the user for confirmation.

## Step 11: Refine this skill

Run `/orchestrate-refine-skill orchestrate` to improve this skill based on evidence from the current session. This closes the flywheel loop — each session makes the next one better.

## Step 12: Post-orchestration menu

After all steps complete, present a follow-up menu using `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Orchestration complete. What would you like to do next?",
  header: "Next action",
  options: [
    { label: "Run another cycle", description: "Start a new orchestrate session with a fresh goal" },
    { label: "Audit the codebase", description: "Run /orchestrate-audit to scan for bugs, security issues, and test gaps" },
    { label: "Check drift", description: "Run /orchestrate-drift-check to verify code matches the plan" },
    { label: "Done for now", description: "End the session — no further action needed" }
  ],
  multiSelect: false
}])
```

Actions:
- **"Run another cycle"** → return to Step 2 (clear checkpoint first)
- **"Audit the codebase"** → invoke `/orchestrate-audit`
- **"Check drift"** → invoke `/orchestrate-drift-check`
- **"Done for now"** → end gracefully with a summary of what shipped
