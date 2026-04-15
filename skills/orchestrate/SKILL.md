---
name: orchestrate
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

# Orchestrate: Full Flywheel

Run the orchestrator for this project. $ARGUMENTS (optional: initial goal or `--mode single-branch`)

> ## ⚠️ UNIVERSAL RULE 1 — `AskUserQuestion` is the only way to ask the user anything
>
> Every user decision in this skill — phase routing, plan refinement, bead approval, launch confirmation, wrap-up choices, recovery branches — MUST be presented via the `AskUserQuestion` tool with concrete labeled options (2–4 per question). Free-text "ask the user…" prompts, "wait for confirmation", "wait for the user's next message", or implicit decision points are bugs. The "Other" field absorbs custom answers when none of the prepared options fit.
>
> If you find yourself about to write text like *"surface this to the user"*, *"propose this to the user"*, *"check with the user"*, or *"only do X if the user confirms"* — STOP and write an `AskUserQuestion` call instead. No exceptions.
>
> ## ⚠️ UNIVERSAL RULE 2 — invoke specialist skills by name when they apply
>
> This SKILL references many specialist skills by slash-name (`/idea-wizard`, `/ubs-workflow`, `/caam`, `/ui-polish`, `/docs-de-slopify`, testing-*, stack-specific skills, etc.). When a step names one, invoke it via the `Skill` tool rather than re-implementing its logic inline. Specialist skills carry project-tested prompts and conventions you don't have time to recreate.
>
> Equally important: if a step does NOT name a skill but you notice one applies to the situation (e.g. a React component bead and `/react-component-generator` exists), invoke it anyway. Skills are hints-with-authority — use them by default, skip only when they clearly don't fit.

## Step 0: Opening Ceremony

### 0.preflight — Captured user input (DO THIS FIRST)

If the user's prompt contains anything beyond `/orchestrate <args>` — a goal sentence, a pasted plan, a path to a plan file, a directive like "fix X then Y" — capture it as `USER_INPUT` and treat it as a candidate goal or plan. **Do NOT act on it yet. Do NOT skip the welcome banner or Step 0b detection.** Run the full Step 0a–0d flow silently so the user sees current state (existing session, open beads, AM status) before deciding.

Then route in Step 0e instead of showing the default main menu:

**Classification heuristics**:
- **Plan-shaped USER_INPUT** — multi-paragraph, contains `##`/`###` headers, mentions specific files, OR is an existing path matching `docs/plans/*.md` → treat as plan.
- **Goal-shaped USER_INPUT** — ≤300 chars, no markdown headers, reads as one or two sentences → treat as goal.
- **Ambiguous** — long unstructured prose → treat as goal but route through `/brainstorming` to refine first.

**Routing override for Step 0e** (only when USER_INPUT is non-empty):

- Plan-shaped:
  ```
  AskUserQuestion(questions: [{
    question: "I see a plan in your message ('<first 60 chars>…'). What should I do with it?",
    header: "Plan input",
    options: [
      { label: "Use as plan", description: "Register via orch_plan and jump to bead creation (Recommended)" },
      { label: "Treat as goal", description: "Use the plan content as the goal description and run the full flywheel from Step 4" },
      { label: "Discard", description: "Ignore the input and show the regular start menu" }
    ],
    multiSelect: false
  }])
  ```
  - "Use as plan" → if USER_INPUT was a file path, call `orch_plan` with `planFile`. If it was inline, write it to `docs/plans/<date>-<goal-slug>.md` first, then call `orch_plan` with `planFile`. Then jump to Step 5.5.
  - "Treat as goal" → call `orch_select` with the input as goal, jump to Step 5.
  - "Discard" → fall back to the default Step 0e menu.

- Goal-shaped:
  ```
  AskUserQuestion(questions: [{
    question: "I see a goal in your message: '<USER_INPUT>'. Run the flywheel on this?",
    header: "Goal input",
    options: [
      { label: "Yes, full flywheel", description: "Skip discovery, plan and implement this goal (Recommended)" },
      { label: "Refine first", description: "Run /brainstorming to clarify scope before planning" },
      { label: "Plan only", description: "Generate a plan, stop before implementation" },
      { label: "Discard", description: "Ignore the input and show the regular start menu" }
    ],
    multiSelect: false
  }])
  ```
  - "Yes, full flywheel" → call `orch_select` with USER_INPUT as goal, proceed to Step 5.
  - "Refine first" → invoke `/brainstorming` with the input, then return to Step 4 with the refined goal.
  - "Plan only" → call `orch_select`, proceed through Step 5, stop after bead creation.
  - "Discard" → fall back to the default Step 0e menu.

- Ambiguous → always run `/brainstorming` first, then route as goal-shaped after refinement.

**Hard rule**: never act on USER_INPUT directly without first showing the banner and getting an explicit menu choice. The flywheel's gates exist for a reason — pre-prompt content does NOT bypass them.

### 0a. Detect version

Attempt to find `mcp-server/package.json` by searching the Claude plugins directory:
```bash
find ~/.claude/plugins -path "*/claude-orchestrator/mcp-server/package.json" 2>/dev/null | head -1
```
Read it and extract the version. Also read the project name from `package.json` in cwd (or use the directory name).

### 0b. Detect state

Gather context silently (do NOT display raw output yet). Run checks 1-5 in parallel where possible:

1. **MCP tools**: Call `orch_profile` directly with `cwd` — if the call succeeds, MCP is available (cache the result to avoid a redundant call in Step 1). If the tool is not found or errors, set `MCP_DEGRADED = true`. Do NOT use `ToolSearch` — MCP tools may be deferred and unavailable to ToolSearch at startup.
2. **Existing session**: Read `.pi-orchestrator/checkpoint.json` if it exists. Note phase and goal.
3. **Existing beads**: Run `br list --json 2>/dev/null` and count open/in-progress/closed beads.
4. **Git status**: Run `git log --oneline -1` to get latest commit.
5. **CASS memory**: Call `orch_memory` with `operation: "search"` and `query: "session learnings orchestration"` to load prior session context. If CASS is unavailable, skip silently.
6. **Agent Mail**: Run `curl -s --max-time 2 http://127.0.0.1:8765/health/liveness` via Bash. If unreachable, set `AGENT_MAIL_DOWN = true` — display `Agent Mail: offline` in the banner and warn before any step that spawns parallel agents. Do NOT block the session or require `/orchestrate-setup` — single-agent workflows work fine without it.

### 0c. Display the welcome banner

Display a single cohesive welcome message. Example:

```
 ╔══════════════════════════════════════════════════╗
 ║                                                  ║
 ║   claude-orchestrator v2.6.0                     ║
 ║   The Agentic Coding Flywheel                    ║
 ║                                                  ║
 ║   Project: <project-name>                        ║
 ║   Branch:  <current-branch> @ <short-sha>        ║
 ║   Beads:   <N open> | <M in-progress> | <K done> ║
 ║                                                  ║
 ╚══════════════════════════════════════════════════╝
```

If beads is zero, show `Beads: none yet`. If MCP tools are unavailable, show `MCP: not configured` in the banner.

If CASS returned learnings from prior sessions, display them below the banner:

> **From prior sessions:**
> - <top 3-5 most relevant learnings, anti-patterns, or gotchas>

This gives the user (and the orchestrator) context from past runs before making any decisions.

### 0d. Present the main menu

Build the menu options dynamically based on detected state:

**If a previous session exists** (checkpoint found with non-idle phase):

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Resume session", description: "Continue '<goal>' from <phase> phase" },
    { label: "Work on beads", description: "<N> open beads exist — refine, implement, or inspect" },
    { label: "New goal", description: "Start fresh with a new goal (discards previous session)" },
    { label: "Research repo", description: "Paste a GitHub URL to study an external repo for insights" }
  ],
  multiSelect: false
}])
```

**If open/in-progress beads exist** but no active session:

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Work on beads", description: "<N> open beads exist — refine, implement, or inspect" },
    { label: "New goal", description: "Scan the repo and discover improvement ideas" },
    { label: "Research repo", description: "Paste a GitHub URL to study an external repo for insights" },
    { label: "Quick fix", description: "Apply a targeted fix without the full flywheel" }
  ],
  multiSelect: false
}])
```

**If no beads and no session** (fresh start):

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Scan & discover", description: "Profile the repo and find improvement opportunities" },
    { label: "Set a goal", description: "I already know what I want to build" },
    { label: "Research repo", description: "Paste a GitHub URL to study an external repo for insights" },
    { label: "Setup", description: "Run /orchestrate-setup to configure prerequisites" }
  ],
  multiSelect: false
}])
```

### 0e. Route the user's choice

> **If `USER_INPUT` was captured in step 0.preflight, use the routing override there instead of this menu.** The default menu below applies only when the user invoked `/orchestrate` with no extra prompt content.

| Choice | Action |
|--------|--------|
| **Resume session** | Run the **drift check** below before jumping to the saved phase |
| **Work on beads** | Run the **Work-on-beads sub-menu + bootstrap** below — do NOT call `orch_approve_beads` directly |
| **New goal** | Delete checkpoint if exists, proceed to Step 2 |
| **Scan & discover** | Proceed to Step 2 |
| **Set a goal** | Run `/brainstorming` to refine the goal, then proceed to Step 4 |
| **Research repo** | Prompt for GitHub URL via the menu below, then invoke `/orchestrate-research` |
| **Quick fix** | Invoke `/orchestrate-fix` |
| **Audit** | Invoke `/orchestrate-audit` |
| **Setup** | Invoke `/orchestrate-setup` |

#### Work on beads — sub-menu + bootstrap (MANDATORY)

`orch_approve_beads` requires `state.selectedGoal`. On a fresh session with leftover beads, the goal is empty and the tool errors with `missing_prerequisite`. Bootstrap it before any approve call:

1. **Synthesize a default goal from the existing beads.** Read the top 3 open bead titles from `br list --json` and build a default like `Continue: <title-1>; <title-2>; <title-3>` (truncate at 200 chars).
2. **Confirm or override the goal:**
   ```
   AskUserQuestion(questions: [{
     question: "These beads need a goal label so the orchestrator can resume. Use the synthesized default?",
     header: "Goal",
     options: [
       { label: "Use default", description: "'<synthesized goal>' (Recommended)" },
       { label: "Custom goal", description: "Provide a one-line goal in the Other field" }
     ],
     multiSelect: false
   }])
   ```
3. **Call `orch_select` with the chosen goal.** This populates `state.selectedGoal` and unblocks every downstream tool.
4. **Then present the action sub-menu:**
   ```
   AskUserQuestion(questions: [{
     question: "<N> open beads. What do you want to do with them?",
     header: "Beads",
     options: [
       { label: "Implement", description: "Jump to Step 6 with launch as the default action (Recommended)" },
       { label: "Refine", description: "Jump to Step 6 with polish as the default action — restructure beads/deps before implementing" },
       { label: "Inspect", description: "Show br list + bv dependency graph, then re-show this menu" }
     ],
     multiSelect: false
   }])
   ```
   - **"Implement"** → jump to Step 6 (full beads-approval menu; user can still pick Polish or Reject from there).
   - **"Refine"** → jump to Step 6 but pre-select the polish path: call `orch_approve_beads(action: "polish")` first to enter `refining_beads` phase, then show Step 6's menu so the user can iterate (Polish further / Start / Reject) until satisfied.
   - **"Inspect"** → run `br list` + `bv --robot-triage` (or `bv` alone if `--robot-triage` not supported), display, then re-show the action sub-menu.

#### Resume session — drift check (MANDATORY)

Before jumping to the saved phase, compare the checkpoint to reality:

1. `git rev-parse HEAD` → compare to `checkpoint.gitHead`. If they differ, HEAD has moved.
2. `br list --json` → compare bead IDs/statuses to `checkpoint.activeBeadIds` and `checkpoint.beadResults`. If beads listed in checkpoint don't exist (or are all closed when checkpoint says `phase: implementing`), state is stale.

If either check shows drift, present:

```
AskUserQuestion(questions: [{
  question: "Checkpoint drift detected: <summary, e.g. 'HEAD moved 5 commits ahead; 0/8 active beads still open'>. How should I proceed?",
  header: "Drift",
  options: [
    { label: "Start fresh", description: "Discard the stale checkpoint and run the start menu (Recommended)" },
    { label: "Inspect first", description: "Show the diff between checkpoint and reality, then re-prompt" },
    { label: "Force resume", description: "Resume anyway — useful only if you know the checkpoint is still relevant" }
  ],
  multiSelect: false
}])
```

- "Start fresh" → delete `.pi-orchestrator/checkpoint.json`, route as if user picked "New goal".
- "Inspect first" → print the diff (`git log <checkpoint.gitHead>..HEAD --oneline` + bead status table), then re-show this menu.
- "Force resume" → load checkpoint, jump to saved phase as before.

If both checks pass (no drift), resume directly without showing the menu.

#### Research repo — mode selection

Use `AskUserQuestion` to collect the URL and mode:

```
AskUserQuestion(questions: [{
  question: "Paste the GitHub URL you want to research:",
  header: "Research",
  options: [
    { label: "Research only", description: "Extract insights and patterns — no code changes" },
    { label: "Research + integrate", description: "Study the repo, then create an integration plan with beads" }
  ],
  multiSelect: false
}])
```

The user pastes the URL in the "Other" field, or picks a mode first and provides the URL when prompted. Then:
- **"Research only"** → invoke `/orchestrate-research <url>`.
- **"Research + integrate"** → invoke `/orchestrate-research <url> --mode integrate` (the slash command's research skill reads `--mode integrate` to run Phases 8–12 / Major Feature Integration). If the slash command rejects the flag, fall back to invoking `/orchestrate-research <url>` and prepend the prompt context "After research, generate an integration plan and create implementation beads."

### 0f. Degraded modes

**MCP tools missing** (orch_profile call failed or tool not found in step 0b):

- Display in the banner: `MCP: not configured — run /orchestrate-setup`
- Set `MCP_DEGRADED = true` and apply these overrides for all subsequent steps:
  - **Step 2:** Use Explore subagent only (skip `orch_profile`).
  - **Step 3:** Use Explore-derived ideas (skip `orch_discover`).
  - **Step 5:** Standard plan only — generate via Explore agent, write to `docs/plans/<date>-<goal-slug>.md` (skip `orch_plan`).
  - **Step 5.5:** Create beads with `br create` as normal.
  - **Step 6:** Present beads via `br list`, ask user to confirm manually — no quality score available.
  - **Step 8:** Offer "Looks good" and "Self review" only (skip `orch_review`).
  - **Step 10:** Skip `orch_memory` — remind user that session learnings were not auto-persisted.

**Agent Mail offline** (`AGENT_MAIL_DOWN = true` from step 0b check 6):

- Display in the banner: `Agent Mail: offline — parallel agents will skip file reservations`
- Do NOT block or require `/orchestrate-setup`. All orchestration still works.
- Overrides for affected steps only:
  - **Step 7 (impl agents):** Skip STEP 0 (Agent Mail bootstrap) in agent prompts. Agents work without file reservations or messaging — the coordinator monitors via TaskOutput instead of inbox.
  - **Step 5 (deep plan):** Skip Agent Mail bootstrap for plan agents. Agents write plan files to disk; coordinator reads them directly.
- If Agent Mail comes up mid-session, detect it on next parallel spawn and resume normal bootstrapping.

## Step 2: Scan and profile the repository

Call `orch_profile` with `cwd`. The tool uses a git-HEAD-keyed cache — if the repo hasn't changed since the last scan, it returns instantly from cache.

- **Cache hit** (output says "Profile loaded from cache"): Skip the Explore agent — the profile is fresh. Proceed directly to Step 3.
- **Cache miss** (fresh scan): Optionally spawn an Explore agent for deeper analysis if the profile reveals a complex or unfamiliar codebase. For known repos, skip it.
- **Force re-scan**: Pass `force: true` to `orch_profile` to bypass the cache (e.g. after major restructuring).

If `MCP_DEGRADED` is true or `orch_profile` fails, fall back to an Explore agent for manual profiling.

After profiling completes, briefly display the key findings (languages, frameworks, test setup) then use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Repository profiled. What next?",
  header: "Profile",
  options: [
    { label: "Discover ideas", description: "Find improvement opportunities based on the profile (Recommended)" },
    { label: "Set a goal", description: "I already know what I want to work on" },
    { label: "Re-scan", description: "Force a fresh profile scan (force: true)" }
  ],
  multiSelect: false
}])
```

- **"Discover ideas"** → proceed to Step 3
- **"Set a goal"** → run `/brainstorming`, then proceed to Step 4
- **"Re-scan"** → call `orch_profile` with `force: true`, then return to this menu

## Step 3: Discover improvement ideas

Before discovering ideas, query CASS for past goal history: call `orch_memory` with `operation: "search"` and `query: "past goals success failure anti-pattern"`. If results are returned, use them to:
- Deprioritize ideas that failed before (unless circumstances changed)
- Boost ideas similar to past successes
- Surface anti-patterns to avoid

**Choose discovery depth** via AskUserQuestion:

```
AskUserQuestion(questions: [{
  question: "How deep should discovery go?",
  header: "Discovery depth",
  options: [
    { label: "Fast (default)", description: "orch_discover one-shot \u2014 5-10 ranked ideas (Recommended for repeat cycles)" },
    { label: "Deep (idea-wizard)", description: "Invoke /idea-wizard for the 6-phase 30\u21925\u219215 pipeline \u2014 matches guide's Phase 5 (Recommended for fresh projects or wide-open cycles)" },
    { label: "Market-validated", description: "Run /idea-wizard, then /xf to check X/Twitter signal on each top idea" },
    { label: "Triangulated", description: "Run /idea-wizard, then /multi-model-triangulation for second-opinion scoring across Codex/Gemini/Grok" }
  ],
  multiSelect: false
}])
```

- **Fast** → continue below with `orch_discover`.
- **Deep** → invoke `/idea-wizard`, feed its output into `orch_discover`, then continue with the standard goal-selection menu.
- **Market-validated** → run `/idea-wizard`, then for each top-3 idea invoke `/xf` with a query like `"<idea title>" site:x.com`. Annotate each candidate with real-world signal before showing the goal menu.
- **Triangulated** → run `/idea-wizard`, then `/multi-model-triangulation` on the top-5 list to surface which ideas all models agree on vs which are one-model bets.

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
    { label: "Deep plan", description: "3 AI models give competing perspectives, then synthesize — higher quality, takes longer (Recommended)" },
    { label: "Triangulated plan", description: "Deep plan + /multi-model-triangulation second-opinion on the synthesis before alignment check — highest quality, longest" }
  ],
  multiSelect: false
}])
```

**Standard plan**: Call `orch_plan` with `cwd` and `mode: "standard"`. After it returns, **STOP and jump to Step 5.55 (Plan alignment check)** — that step runs the qualifying-questions loop and only then hands off to Step 5.6 (Plan-ready gate). Do NOT skip 5.55 or proceed to bead creation without the user explicitly selecting "Create beads" from the Step 5.6 menu.

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
   - **CASS context**: Query `orch_memory` with `query: "architecture planning decisions <goal>"` and include the top learnings in the agent prompt as a "Prior Session Context" section. This prevents agents from repeating past mistakes or reinventing prior decisions.
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

   **Triangulated plan mode** — if the user picked "Triangulated plan" at Step 5 entry, AFTER `orch_plan` returns, invoke `/multi-model-triangulation` with the synthesized plan file as input. Capture the triangulation report (agreements, disagreements, unique insights per model). Present the report alongside the Step 5.55 alignment questions so the user sees where external models diverge from the Opus synthesis before approving.

9. **STOP — jump to Step 5.55 (Plan alignment check).** That step runs the qualifying-questions loop and only then hands off to Step 5.6 (Plan-ready gate). Do NOT skip 5.55 or proceed to bead creation without the user explicitly selecting "Create beads" from the Step 5.6 menu.

## Step 5.55: Plan alignment check (MANDATORY — both standard and deep)

> **Hard rule**: After `orch_plan` returns and BEFORE showing the Step 5.6 plan-ready gate, run this alignment check. The deeper the plan, the more assumptions are baked in — the user must confirm those assumptions match intent before any bead is created. This loop mirrors the bead-refinement loop: ask, refine on disagreement, re-ask, until aligned.

### 1. Read the plan and extract qualifying questions

Read `state.planDocument` end-to-end. Identify 2-4 **load-bearing** decisions that, if wrong, would force a major rewrite later. Look specifically for:

- **Scope boundaries** — what's in vs explicitly out (non-goals).
- **Architectural choices** — pattern X chosen over Y; library/tool selections; trade-offs the plan calls out.
- **Order/dependency assumptions** — "do A before B because…" claims.
- **Risk acceptances** — "we'll skip Z and revisit later" notes.
- **Missing coverage you noticed** — areas the plan brushes past that the user might care about.

Skip the obvious. Ask only about decisions where reasonable people would disagree.

### 2. Present the questions in ONE batch

Use a single `AskUserQuestion` call with up to 4 questions (the tool's max). Each question must have 2-4 distinct, mutually-exclusive options framed as user-facing choices, not yes/no validations:

```
AskUserQuestion(questions: [
  {
    question: "Plan scopes <X, Y, Z>. Anything to add or drop?",
    header: "Scope",
    options: [
      { label: "Scope is right", description: "Proceed with X, Y, Z as defined" },
      { label: "Drop <Z>", description: "Out of scope for this cycle" },
      { label: "Add <something>", description: "Specify in Other" }
    ],
    multiSelect: false
  },
  {
    question: "Plan picks <approach A> over <approach B> because <reason>. Agree?",
    header: "Approach",
    options: [
      { label: "Agree with A", description: "Proceed with the plan's choice" },
      { label: "Switch to B", description: "Refine plan to use approach B" },
      { label: "Hybrid", description: "Specify the blend in Other" }
    ],
    multiSelect: false
  },
  {
    question: "Plan defers <risk Z> to a later cycle. Acceptable?",
    header: "Risk",
    options: [
      { label: "Defer is fine", description: "Park Z; revisit next cycle" },
      { label: "Address now", description: "Refine plan to include Z" }
    ],
    multiSelect: false
  }
  // Add a 4th only if there's a genuinely load-bearing decision left.
])
```

Do NOT pad with low-value questions. 2 sharp questions beat 4 fuzzy ones.

### 3. Branch on the answers

- **All answers confirm the plan** ("Scope is right" / "Agree with A" / "Defer is fine" etc.) → proceed to Step 5.6 (Plan-ready gate). Note in your end-of-turn summary that alignment was confirmed.
- **Any answer requests a change** → run a refinement round automatically (do NOT prompt the user again first). Spawn:

  ```
  Agent(model: "opus", name: "align-refine-<N>", isolation: "worktree", run_in_background: true,
    prompt: "
      Read the plan at <state.planDocument>.
      The user reviewed it and requested these changes:
        - Scope: <user's scope answer + their Other-field text if any>
        - Approach: <user's approach answer + Other text>
        - Risk: <user's risk answer + Other text>
        (omit lines for questions where the user confirmed.)

      Revise the plan to incorporate ALL requested changes. Prior reviewers
      found **80+ distinct implications** downstream of changes like these
      that they fixed — ripple effects in dependencies, coverage gaps,
      invalidated assumptions. Find AT LEAST that many. Don't just patch
      the three lines the user pointed at; trace every knock-on effect
      through the plan and fix those too.

      Preserve the structure (sections, task table, verification block).
      For each change, add a one-line rationale at the change site so future
      reviewers see the user's intent. Use ultrathink.
      Write the revised plan to the same file path when done.
    "
  )
  ```

  After it completes, **return to step 1 of this section** (re-read the revised plan, regenerate qualifying questions based on the new content, present again). Loop until all answers confirm.

### 4. Convergence guard

If the alignment loop runs more than 3 rounds without converging, break out and present:

```
AskUserQuestion(questions: [{
  question: "We've done <N> alignment rounds without converging. Continue refining or step back?",
  header: "Stuck",
  options: [
    { label: "One more round", description: "User provides specific instructions in Other" },
    { label: "Back to Step 5.6", description: "Accept current plan; iterate later via Refine plan" },
    { label: "Start over", description: "Discard plan, return to Step 3" }
  ],
  multiSelect: false
}])
```

This prevents infinite loops when the plan and the user's intent are fundamentally misaligned (signal to start over) or when the user is over-tweaking (signal to ship and iterate).

## Step 5.6: Plan-ready gate (MANDATORY — both standard and deep)

> **Hard rule**: After `orch_plan` returns successfully — regardless of `mode` — you MUST stop here and present this menu. Do NOT call `br create`, `orch_approve_beads`, or any implementation tool until the user explicitly selects "Create beads". Skipping this gate is a bug.

Display a brief summary of the plan (file path, line count, top-level section headers), then use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Plan created (<N> lines, at <path>). What next?",
  header: "Plan ready",
  options: [
    { label: "Create beads", description: "Convert the plan into implementation beads (Recommended)" },
    { label: "Refine plan", description: "Run a fresh refinement round to deepen the plan" },
    { label: "Review plan", description: "Open the plan file for manual review before proceeding" },
    { label: "Start over", description: "Discard this plan and pick a different goal" }
  ],
  multiSelect: false
}])
```

- **"Create beads"** → proceed to Step 5.5.
- **"Refine plan"** → run the iterative deepening recipe below, then return to this menu (loop).
- **"Review plan"** → print the plan file path so the user can read it offline, then immediately present:
  ```
  AskUserQuestion(questions: [{
    question: "Done reviewing <plan-path>. What next?",
    header: "Post-review",
    options: [
      { label: "Looks good", description: "Proceed to Create beads" },
      { label: "Refine plan", description: "Run a refinement round (Recommended if changes needed)" },
      { label: "Start over", description: "Discard plan and pick a different goal" },
      { label: "Still reading", description: "Re-show this menu in a few minutes" }
    ],
    multiSelect: false
  }])
  ```
  Route the answer back into Step 5.6.
- **"Start over"** → delete the plan file, clear `state.planDocument`, return to Step 3.

**Iterative deepening recipe** (only when "Refine plan" is chosen): spawn a NEW agent (fresh context, no memory of prior rounds) that reviews and proposes improvements:

```
Agent(model: "opus", name: "refine-round-<N>", isolation: "worktree", run_in_background: true,
  prompt: "
    Read the plan at <state.planDocument>.
    You have NOT seen any prior plans or revisions — this is your first and only look.
    Prior reviewers found **80+ distinct issues** in this plan that they fixed.
    Find AT LEAST that many. Be ruthless — surface every assumption,
    every missing edge case, every hand-wavy section, every dependency that
    isn't airtight. Do not accept the plan at face value. The goal is
    exhaustive critique, not polite commentary.
    For each change, give detailed analysis and rationale.
    Provide changes in git-diff format. Use ultrathink.
    Write your revised plan to the same file path when done.
  "
)
```

After the refinement agent completes, return to the "Plan ready" menu above. Stop offering "Refine plan" when a round produces only minor wording changes — this signals convergence.

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

5. **Beads created — run coverage + dedup checks before Step 6.**

6. **Plan↔Bead coverage check (MANDATORY).** Parse `##`/`###` section headers from `state.planDocument`. For each section, search the bead list for any bead whose title or description references that section's topic. Build a coverage report: `<section> → <bead-ids or NONE>`.

   Present:
   ```
   AskUserQuestion(questions: [{
     question: "Plan↔Bead coverage: <X>/<Y> sections covered. <missing section list if any>. What next?",
     header: "Coverage",
     options: [
       { label: "All covered", description: "Every plan section has at least one bead — proceed to dedup" },
       { label: "Create catch-up beads", description: "Generate beads for the missing section(s) before proceeding (Recommended)" },
       { label: "Sections out of scope", description: "Mark missing sections as deferred in plan; proceed" }
     ],
     multiSelect: false
   }])
   ```
   - "Create catch-up beads" → run `br create` per missing section with a stub description the user refines, then re-run this check.
   - "Sections out of scope" → append a `## Deferred` block to the plan listing the dropped sections, then proceed.

7. **Deduplication sweep (MANDATORY).** Scan bead titles + descriptions for overlap: two beads touching the same files with similar intent, or near-duplicate titles. Build a `<duplicate-pair → suggested-merge>` report.

   Present:
   ```
   AskUserQuestion(questions: [{
     question: "Dedup scan: <N> overlap pair(s) found: <list>. How to resolve?",
     header: "Dedup",
     options: [
       { label: "Merge all", description: "Combine each pair into the canonical richer bead; carry over dependencies" },
       { label: "Review per-pair", description: "Go through each pair; list which to merge / keep in Other" },
       { label: "None found", description: "No real overlaps — proceed to Step 6 (Recommended when scan is empty)" },
       { label: "Keep separate", description: "Pairs are distinct; add a one-line rationale to each bead's description explaining the distinction" }
     ],
     multiSelect: false
   }])
   ```
   On merge, use `br update` to extend the canonical bead's description + `br dep add` to carry over edges, then `br close <duplicate-id> --reason "merged into <canonical>"`.

8. **Proceed to Step 6** once coverage is acknowledged and dedup is resolved.

## Step 6: Review and approve beads

> **Hard rule**: This step contains TWO mandatory user gates (beads-approval menu, then launch-confirmation menu). Do NOT call `TeamCreate`, `Agent`, or any Step 7 tool until the user has explicitly selected "Launch" from the second menu. Skipping either gate is a bug.

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

**Polish red flags** (independent of score — surface these to the user alongside the score when any apply):
- **Oscillation** — polish rounds keep flipping between two approaches. Signal: the taste question is unresolved; pick one, commit the trade-off in the plan, and stop polishing.
- **Expansion** — each round *adds* beads rather than refining existing ones. Signal: scope is unbounded; return to Step 5.6 to re-scope the plan before more bead polish.
- **Low-quality plateau** — score stable at 0.60-0.70 across 3+ rounds. Signal: the plan framing is off; start fresh from Step 3 with a different goal angle.

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Populate **Wave** from the bead's dependency wave assignment, **Effort** from the plan's effort estimate, and **Risk Flags** from any warnings or risk notes in the plan output. This gives the user visibility into what is about to be implemented and in what order.

**Branch on the quality score** — if `score < 0.75`, use the low-quality menu instead of the regular launch menu (do NOT launch silently).

**Low quality (`score < 0.75`):**

```
AskUserQuestion(questions: [{
  question: "Quality score: <X.XX>/1.00 — below the 0.75 threshold. <weak-bead-summary>. How should I proceed?",
  header: "Low quality",
  options: [
    { label: "Polish beads", description: "Run another bead refinement round (Recommended)" },
    { label: "Back to plan", description: "Return to Step 5.6 to refine the plan itself" },
    { label: "Launch anyway", description: "Proceed despite low score — accept the risk" },
    { label: "Reject", description: "Discard these beads and start over with a different goal" }
  ],
  multiSelect: false
}])
```

- "Polish beads" → call `orch_approve_beads` with `action: "polish"`, return to Step 6.
- "Back to plan" → return to Step 5.6 plan-ready gate menu.
- "Launch anyway" → proceed to Step 7 (note the user accepted the risk in your end-of-turn summary).
- "Reject" → call `orch_approve_beads` with `action: "reject"`, return to Step 3.

**Acceptable quality (`score >= 0.75`):**

```
AskUserQuestion(questions: [{
  question: "Quality score: <X.XX>/1.00. Ready to launch implementation?",
  header: "Launch",
  options: [
    { label: "Launch", description: "Start implementing <N> beads with agents (Recommended)" },
    { label: "Polish more", description: "Run another refinement round on the beads" },
    { label: "Back to plan", description: "Return to plan refinement before implementing" }
  ],
  multiSelect: false
}])
```

- **"Launch"** → proceed to Step 7
- **"Polish more"** → call `orch_approve_beads` with `action: "polish"`, then return to Step 6
- **"Back to plan"** → return to the Step 5.6 plan-ready gate menu

## Step 7: Implement each bead

### Pre-loop — swarm scaling + stagger

**Agent ratio by open-bead count** (from `br ready --json`). Pick the smallest tier that accommodates your wave:

| Open beads | Claude : Codex : Gemini | Notes |
|-----------|--------------------------|-------|
| < 100     | 1 : 1 : 1                | Single rep each — coordination overhead stays low |
| 100-399   | 3 : 3 : 2                | Standard swarm |
| 400+      | 4 : 4 : 2                | Parallel tracks essential |

Claude owns architecture / complex reasoning, Codex owns fast iteration / testing, Gemini provides a second perspective for docs / review. Cap parallel spawns at the wave's independent-bead count — do not spin up agents with nothing to do.

**Thundering-herd mitigation** — stagger spawns by **30 seconds minimum**. Do NOT spawn all agents simultaneously; they all read AGENTS.md, hit Agent Mail, and query `br ready` at once — piling onto the same frontier bead. Use `run_in_background: true` and wait 30s between each `Agent(...)` call.

**Codex input-buffer quirk** — after the prompt lands in a Codex agent, send Enter TWICE (or append a trailing newline) so the long prompt clears the input buffer.

**Rate-limit management** — if any impl agent reports a rate-limit error (429, "usage limit reached", etc.), invoke `/caam` to switch that model's account. `caam activate <model> <backup-account>` takes <100ms and keeps the wave moving. Don't kill and restart the agent; the wrapper just re-authenticates the current session.

**Destructive-command coordination** — if any impl agent proposes `git reset --hard`, `git push --force`, `DROP TABLE`, `rm -rf`, `kubectl delete`, or similar, invoke `/slb` to require two-person approval. The coordinator is the second party; never let an agent self-approve destructive ops. If `/dcg` is configured as a hook, most of these are already blocked at the harness layer — still confirm via `/slb` for anything slipping through.

### Implementation loop

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

       0d. **Re-read AGENTS.md end-to-end** (MANDATORY — do not skip even if
           you think you remember it). Agents that skip this produce
           non-idiomatic code and break project conventions. If the repo has
           no AGENTS.md, note that in your started message.

       Only after 0a, 0b, 0c, 0d are ALL complete may you proceed to Step 1.

       ## STEP 0.5 — LOAD MEMORY (if CASS available)
       Call orch_memory with operation='search' and query='implementation gotchas <bead-title>'.
       If results returned, review them before starting — they contain lessons from past sessions.

       ## STEP 0.7 — DOMAIN-SKILL LOOKUP (invoke relevant skills BEFORE writing code)
       Scan the bead title + description for domain keywords and invoke the matching skill
       via the Skill tool. Each hit gives you best-practice patterns specific to that stack.

         Bead mentions                            Invoke skill
         ─────────────────────────────────────────────────────────
         admin, /admin, /api/admin              → /admin-page-for-nextjs-sites
         A/B test, variant, experiment          → /ab-testing
         MRR, churn, cohort, customer analytics → /saas-customer-analytics
         stripe, paypal, checkout, subscription → /stripe-checkout
         supabase, RLS, drizzle, postgres SaaS  → /supabase
         tanstack, react-query, react-table     → /tanstack
         react component, .tsx, JSX             → /react-component-generator
         og image, twitter card, social preview → /og-share-images
         TUI, bubble tea, charm, CLI UI         → /tui-glamorous
         installer, curl|bash, one-liner        → /installer-workmanship
         CLI automation, atuin, shell history   → /automating-your-automations
         perf, optimize, bottleneck, p95, p99   → /extreme-software-optimization
         MCP tool, MCP server                   → /mcp-server-design
         multi-repo, ru sync                    → /ru-multi-repo-workflow
         crash, segfault, hang, deadlock        → /gdb-for-debugging
         playwright, e2e webapp, next.js test   → /e2e-testing-for-webapps
         fuzz, property-based, crash discovery  → /testing-fuzzing
         protocol, RFC, conformance             → /testing-conformance-harnesses
         snapshot, approval, golden output      → /testing-golden-artifacts
         ML test, oracle-less, metamorphic      → /testing-metamorphic
         formal proof, lean, rust verification  → /lean-formal-feedback-loop

       If no keywords match, skip and proceed to STEP 1. Never force a skill invocation on
       an unrelated bead — the lookup is hints, not mandates.

       ## STEP 1 — IMPLEMENT
       <bead title>
       <bead description>
       Acceptance criteria: <criteria>

       ## STEP 2 — VALIDATE (MANDATORY GATES — all must pass before STEP 3)
       Run in order; fix failures before proceeding. Do NOT commit until all pass.

       2a. **Compile + lint gate** — pick the stack's commands:
           - Rust:       cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo fmt --check
           - Go:         go build ./... && go vet ./...
           - TypeScript: npx tsc --noEmit (plus your eslint / biome script)
           - Python:     python -m compileall -q . (plus ruff / mypy per project)
           Check package.json / Cargo.toml / Makefile for project-specific scripts first.

       2b. **Test gate** — run the test suite for files you touched (not the whole suite unless fast).

       2c. **UBS gate** (if `ubs` CLI is installed): `ubs <changed-files>`. Treat
           findings as blocking unless clearly out of scope. If `ubs` is not
           available, note that in your completion report and skip this gate.

       ## STEP 2.5 — STORE LEARNINGS
       If you encountered anything non-obvious during implementation — unexpected API behavior,
       tricky edge cases, workarounds for tooling issues, rebase gotchas, or decisions that
       future agents would benefit from knowing — store each as a CASS memory:
       Call orch_memory with operation='store' and content describing the learning.
       Prefix with the bead ID for traceability, e.g.:
       "Bead <id>: <concise learning with enough context to be useful standalone>"
       Skip this step if the implementation was straightforward with no surprises.

       ## STEP 3 — COMMIT & CLOSE BEAD
       Create a commit with a descriptive message referencing bead <id>.
       Then mark the bead closed: `br update <bead-id> --status closed`
       (Note: the br CLI uses `closed`, NOT `done`.)
       Verify the close took effect: `br show <bead-id> --json` and confirm
       `"status": "closed"`. If the status is anything else, retry the update
       once before continuing to STEP 4. Stragglers are a known failure mode
       and the coordinator will catch them via `orch_verify_beads`, but
       verifying here keeps the wave clean.

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

3. **Auto-capture failures**: If an agent reports a blocker or failure via Agent Mail, automatically store it in CASS:
   ```
   orch_memory(operation: "store", content: "Bead <id> (<title>) hit blocker: <failure description>. Resolution: <what fixed it or 'unresolved'>")
   ```
   This ensures future sessions can recall what went wrong and avoid the same pitfall.

4. Mark the bead's task as `in_progress`. If the agent goes idle before reporting back, nudge it:
   ```
   SendMessage(to: "impl-<bead-id>", message: "Please report your current status and any blockers.")
   ```

   **Zero-output escalation**: After 2 nudges, check `git log --oneline` to confirm whether any commits appeared since spawning. If zero new commits:
   - Do NOT spawn a replacement agent — it will likely stall the same way.
   - Implement the bead directly as the coordinator.
   - Close the bead: `br update <id> --status closed`.
   - This is faster than multiple failed spawn cycles and produces the same outcome.

5. **Store cross-cutting learnings**: When an agent's completion report mentions something non-obvious (unexpected file renames, rebase conflicts, API quirks, tooling workarounds), store it in CASS:
   ```
   orch_memory(operation: "store", content: "Bead <id> (<title>): <learning from agent report>")
   ```
   Don't store routine completions — only surprises or gotchas that would help future sessions.

6. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
   > **Important:** Structured shutdown messages CANNOT be broadcast to `"*"`. You must send to each impl agent individually by name. This applies to all structured JSON messages (shutdown_request, plan_approval_request, etc.).

   **If the agent remains idle after shutdown_request** (check via `TaskList` — task still shows as active after 60 seconds):
   - Force-stop with `TaskStop(task_id: "<saved-task-id>")` if the task ID is available.
   - Retire in Agent Mail: `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")`.
   - If still listed in the team, edit `~/.claude/teams/<team>/config.json` to remove from the `"members"` array, then retry `TeamDelete` when ready.

### Stuck-swarm diagnostics

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Multiple agents pick the same bead | Unsynced starts; not marking `in_progress` early | Stagger starts 30s; require `br update --status in_progress` + Agent Mail claim before any edit; audit file reservations |
| Agent circles after compaction | Forgot the AGENTS.md contract | Nudge: `SendMessage(to: "<name>", message: "Re-read AGENTS.md so it's still fresh, then continue from your last Agent Mail message.")` — kill+restart only if it stays erratic |
| Bead sits `in_progress` too long | Crash / blocker / lost plot | Check Agent Mail thread for last report; if silent, implement directly as coordinator OR split the blocker into sub-beads with `br create` + `br dep add` |
| Contradictory implementations across beads | Poor coordination / stale reservations | Audit `file_reservation_paths`; revise bead boundaries so two beads never edit the same file |
| Much code, goal still far | Strategic drift | Run the "Come to Jesus" reality check in Step 9's Check-status option |

## Step 8: Review completed beads

> **Wave-completion gate (MANDATORY).** Before entering this step, wait until **every** impl agent spawned in the current wave has reported back via Agent Mail (or has been force-stopped per Step 7's escalation path). Track the wave's bead IDs in a local set; do NOT enter Step 8 until that set is empty. If you receive an Agent Mail completion notification mid-wave, store the result and stay in Step 7's monitor loop until the rest finish. Reviewing wave-1 while wave-2 is mid-flight produces stale state and per-bead review prompts (which the consolidation rule below explicitly forbids).

Once the full wave is in, present a consolidated review prompt. Never ask per-bead if multiple beads finished together.

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
  2. Spawn all 5 with `run_in_background: true`, each with `team_name` set and the strict STEP 0 Agent Mail bootstrap in their prompt. Each reviewer prompt **MUST** include:
     - Instruction to write findings to disk: `docs/reviews/<perspective>-<date>.md`
     - Instruction to send **only the file path** (not body content) via Agent Mail
     - **Do NOT** include review content inline in the Agent Mail message body — inbox delivery is unreliable and large bodies may be silently dropped
  3. **Monitor with mandatory nudge loop** — reviewer messages frequently fail to arrive in the coordinator's inbox on the first attempt. After spawning, poll `fetch_inbox` every 30-60 seconds. For each reviewer that has not delivered findings within 2 minutes, nudge by name:
     ```
     SendMessage(to: "<reviewer-name>", message: "Your review findings for bead <id> have not arrived. Please resend to <coordinator-name> via Agent Mail with subject '[review] <id> findings'.")
     ```
     Nudge up to 3 times per reviewer before considering them failed.
     **Persistent inbox failure fallback**: If inbox remains empty after all nudges, do not block. Read findings files directly from disk (`docs/reviews/<perspective>-<date>.md`) using the Read tool. If no disk file exists either, synthesize from `git diff <base-sha>..HEAD` directly.
  4. Shutdown each reviewer individually after collecting results — do NOT broadcast structured messages to `"*"`
  5. Collect and summarize results. If fewer than 5 reviewers delivered via inbox, synthesize from disk files + `git diff` — do NOT wait indefinitely for unresponsive reviewers.

  > **Closed-bead handling:** `orch_review` now reconciles the bead state itself — `looks-good` is idempotent (advances to the next bead/gates), `hit-me` runs a post-close audit (payload tagged `postClose: true`), and `skip` returns `already_closed`. No manual workaround needed. (Prior versions required spawning reviewers from `git diff <sha>~1 <sha>`; that path is gone.)

  > **Edge case — team already active:** `TeamCreate` for a review team fails with "already leading a team" if an impl team is still running. Reuse the existing team by passing `team_name: "impl-<goal-slug>"` to the review agents instead of creating a new one.

## Step 9: Loop until complete

**Reconcile the wave first.** Before showing the menu, call `orch_verify_beads` with the IDs of beads completed in this wave:

```
orch_verify_beads(cwd: <cwd>, beadIds: [<bead-1>, <bead-2>, ...])
```

The tool returns `{verified, autoClosed, unclosedNoCommit, errors}`:
- **`verified`** — beads `br show` confirms as closed. Move on.
- **`autoClosed`** — stragglers that had a matching commit; the tool ran `br update --status closed` for you and synced state. Move on.
- **`unclosedNoCommit`** — beads still open with no commit referencing them. **MUST** present:
  ```
  AskUserQuestion(questions: [{
    question: "<N> bead(s) have no commit and were not auto-closed: <comma-list with statuses>. How should I handle them?",
    header: "Stragglers",
    options: [
      { label: "Re-run impl agent", description: "Spawn a fresh impl agent for these beads (Recommended)" },
      { label: "Mark deferred", description: "Set status=deferred and proceed without these beads" },
      { label: "Close manually", description: "I'll close them outside this session — proceed without action" },
      { label: "Pause cycle", description: "Stop and let me investigate; resume later via /orchestrate" }
    ],
    multiSelect: false
  }])
  ```
  Route per choice; never silently skip.
- **`errors`** — `br show` failures. If the errors map is non-empty, present:
  ```
  AskUserQuestion(questions: [{
    question: "br show failed for <N> bead(s): <comma-list with first error excerpt>. How to proceed?",
    header: "br errors",
    options: [
      { label: "Retry verify", description: "Call orch_verify_beads again on the failed IDs (Recommended)" },
      { label: "Skip and proceed", description: "Treat the unverifiable beads as still in flight; come back later" },
      { label: "Pause cycle", description: "Stop so I can debug br locally" }
    ],
    multiSelect: false
  }])
  ```

Then check remaining beads with `br list`. If beads remain, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "<N> beads complete, <M> remaining. What next?",
  header: "Progress",
  options: [
    { label: "Continue", description: "Implement the next batch of ready beads (Recommended)" },
    { label: "Check status", description: "Show detailed bead status, dependency graph, and drift check" },
    { label: "Pause", description: "Stop here — resume later with /orchestrate" },
    { label: "Wrap up early", description: "Skip remaining beads and wrap up what's done" }
  ],
  multiSelect: false
}])
```

- **"Continue"** → return to Step 7 for the next wave of ready beads
- **"Check status"** → run `br list` + `bv --robot-triage` and display. Then run the **Come-to-Jesus drift reality-check** below before returning to this menu.
- **"Pause"** → run the pause checklist below, then end the turn
- **"Wrap up early"** → skip to Step 9.5 with only the completed beads

#### Come-to-Jesus drift reality-check

Busy agents are not the goal — closing the *actual* gap is. After displaying status, ask:

```
AskUserQuestion(questions: [{
  question: "If we intelligently completed every remaining open bead, would '<original selectedGoal>' actually be achieved?",
  header: "Drift",
  options: [
    { label: "Yes, on track", description: "Return to the progress menu and continue" },
    { label: "Missing pieces", description: "New beads needed to close the gap — create them before more impl" },
    { label: "Strategic drift", description: "Remaining beads won't close the gap — invoke /orchestrate-drift-check and regress to plan refinement" },
    { label: "Goal has changed", description: "Update selectedGoal via orch_select, then re-scope the bead graph" }
  ],
  multiSelect: false
}])
```

- "Yes" → return to progress menu.
- "Missing pieces" → `br create` the gap-closers with dependencies wired to the ready frontier, then return to progress menu.
- "Strategic drift" → invoke `/orchestrate-drift-check` for diagnostic output, then call `orch_review` with `beadId: "__regress_to_plan__"` to revisit the plan.
- "Goal has changed" → call `orch_select` with the new goal, then return to the progress menu so the user can decide whether to keep or reject current beads.

#### Pause checklist (run in order):

1. **Drain in-flight agents.** For each impl agent still listed in `TaskList` from the current wave: send `SendMessage(to: "<name>", message: {"type": "shutdown_request", "reason": "Session paused"})`. Wait up to 60s for them to exit; force-stop with `TaskStop(task_id: "<id>")` if they hang.
2. **Retire Agent Mail teammates** that won't be needed on resume (impl-* agents). Leave the coordinator session itself active (it's the orchestrator's identity and CASS will use it on resume).
3. **Confirm checkpoint is current.** State is checkpointed by every tool call, so this is usually a no-op — but verify `.pi-orchestrator/checkpoint.json` exists and `git rev-parse HEAD` matches `checkpoint.gitHead`. If they differ, the user has uncommitted moves; surface that in the summary.
4. **Print resume hint.** One line: `Run /orchestrate to resume from <phase> with <N> beads remaining.`
5. **End turn** with a summary of progress so far (beads closed this session, beads remaining, any blockers). Do not call further tools after the summary.

When ALL beads are complete, display a completion message and proceed directly to Step 9.5:

> All <N> beads complete. Proceeding to wrap-up.

## Step 9.25: Test-coverage sweep (MANDATORY before wrap-up)

After all beads close, scan changed files for missing test coverage before starting Step 9.5:

1. Determine changed files since session start: `git diff --name-only <session-start-sha>..HEAD`.
2. For each changed production file, check for a sibling/mirror test file (`*.test.ts` / `*_test.go` / `test_*.py` / `*.spec.rs` per stack convention).
3. Build a coverage summary: `<file> → <test-file or MISSING>`.

Present:

```
AskUserQuestion(questions: [{
  question: "Test-coverage sweep: <X>/<Y> changed files have tests. Missing: <list>. How to proceed?",
  header: "Coverage",
  options: [
    { label: "Coverage is adequate", description: "Either tests exist or gaps are intentional (e.g., pure type-only files) — proceed to Step 9.4" },
    { label: "Create catch-up test beads", description: "Generate beads for missing test files and run a mini-Step-7 loop to implement (Recommended for production-bound releases)" },
    { label: "Skip coverage sweep", description: "Proceed without adding tests — note the gap in the wrap-up summary" }
  ],
  multiSelect: false
}])
```

- "Create catch-up test beads" → `br create` one bead per MISSING entry with description `Write tests for <file>: unit coverage + edge cases`. Pick the right testing skill per bead based on what the file does:

  | File type / domain                                   | Skill to cite in the test-bead description |
  |------------------------------------------------------|--------------------------------------------|
  | Business logic touching real DB / external API       | `/testing-real-service-e2e-no-mocks`        |
  | Protocol implementations, RFC parsers, codecs         | `/testing-conformance-harnesses`            |
  | Parsers, serializers, deterministic output            | `/testing-golden-artifacts`                 |
  | Security-critical code, input validators, crypto      | `/testing-fuzzing`                          |
  | ML models, compilers, search, oracle-less systems     | `/testing-metamorphic`                      |
  | Next.js webapp UI flows                              | `/e2e-testing-for-webapps`                  |
  | Rust code needing formal proofs                       | `/lean-formal-feedback-loop`                |
  | Default (plain unit tests)                           | (no extra skill — standard test framework)  |

  After test beads close, return to Step 7 for the test-bead wave. After those close, re-enter Step 9.25.
- Everything else → advance to Step 9.4.

## Step 9.4: UI/UX polish pass (optional — only if project has a UI)

Detect UI: check `package.json` for `react` / `vue` / `svelte` / `next` / `nuxt` / `solid-js`, OR the presence of `.tsx` / `.vue` / `.svelte` files, OR Flutter / SwiftUI / Jetpack Compose signals. If no UI detected, skip to Step 9.5.

If UI detected, present:

```
AskUserQuestion(questions: [{
  question: "Project has UI. Run a polish pass before wrap-up?",
  header: "UI polish",
  options: [
    { label: "Run polish pass", description: "Invoke the 5-step scrutiny → beads → implement loop (Recommended for production-bound cycles)" },
    { label: "Skip this cycle", description: "Defer polish — revisit next cycle (Recommended for internal / early-stage work)" },
    { label: "Light polish only", description: "Run scrutiny prompt once, surface top 5 issues, skip beadifying" }
  ],
  multiSelect: false
}])
```

If "Run polish pass" is chosen, invoke `/ui-polish` (Stripe-level iterative polish). If the project-local `/ui-ux-polish` skill is preferred, use that instead. Either runs the canonical 5-step loop: scrutiny → pick suggestions → beadify → implement wave → repeat 2-3× until improvements are marginal. Come back to Step 9.5 when done.

If "Light polish only" is chosen, spawn one reviewer agent with the scrutiny prompt from `/ui-polish` and present its top 5 findings as an `AskUserQuestion` — user picks which to fix inline vs defer to next cycle.

## Step 9.5: Wrap-up — commit, version bump, rebuild

Once all beads are reviewed and closed, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "All beads done. How should I wrap up?",
  header: "Wrap-up",
  options: [
    { label: "Full wrap-up", description: "Review commits, update docs, version bump, rebuild (Recommended)" },
    { label: "Commit only", description: "Just commit and push — skip docs and version bump" },
    { label: "Skip wrap-up", description: "Leave everything as-is — I'll handle it manually" }
  ],
  multiSelect: false
}])
```

- **"Full wrap-up"** → run all sub-steps below
- **"Commit only"** → run sub-steps 1, 3, 7 only (review commits, commit strays, show log), then skip to Step 10
- **"Skip wrap-up"** → skip to Step 10

### 1. Review bead commits
Run `git log --oneline` to show the bead commits from this session. If two or more touch the same subsystem, propose squashing them via:

```
AskUserQuestion(questions: [{
  question: "<N> bead commits touch <subsystem> (<sha-list>). Squash into one?",
  header: "Squash",
  options: [
    { label: "Squash", description: "Combine into one commit with message: '<proposed message>'" },
    { label: "Keep separate", description: "Leave each bead as its own commit (Recommended for traceability)" },
    { label: "Pick subset", description: "Specify which SHAs to squash in Other" }
  ],
  multiSelect: false
}])
```

Only run `git rebase -i` if the user picks Squash or Pick subset. Default-keep is safe.

### 2. Update documentation
Before committing anything, update these files to reflect what shipped:

- **`AGENTS.md`** — update the Hard Constraints, Testing, and any module-level guidance that changed (e.g. new logger convention, new test runner, new CLI tools). Sub-agents read this; stale guidance causes bugs.
- **`README.md`** — update the architecture map (add/remove files), key design decisions (document new patterns), and the models table if routing changed.
- **`CHANGELOG.md`** (if present) — append the shipped version's entry.

Only update sections that are actually affected by this session's changes. Do not rewrite unchanged sections.

**De-slopify all user-facing docs before committing.** README / CHANGELOG / public-facing docs must strip these AI-tell signatures:

- Emdash overuse (use commas / periods / semicolons instead).
- "It's not X, it's Y" contrast structure.
- "Here's why" / "Here's the thing" clickbait leads.
- "Let's dive in" / "buckle up" forced enthusiasm.
- "At its core…" / "fundamentally…" pseudo-profound openers.
- "It's worth noting…" / "it's important to remember…" unnecessary hedges.
- "Game-changer" / "powerful" / "seamless" / "robust" filler adjectives.
- Three-item list tricolons in every paragraph.

Invoke `/docs-de-slopify` on the changed doc files — it runs the canonical de-slop sweep. Technical docs (AGENTS.md, internal specs) are exempt — the rule targets user-facing prose.

**CHANGELOG rebuild** — if `CHANGELOG.md` exists or the project is published, invoke `/changelog-md-workmanship` to rebuild the changelog from git tags, issues, and PR titles. This is cleaner than manually appending and catches commits that were missed.

### 3. Commit any stray tracked/untracked files
Check `git status` for uncommitted files (plan docs, skill updates, config changes). If any exist, propose groupings via:

```
AskUserQuestion(questions: [{
  question: "Found <N> uncommitted files: <short list>. How should I commit them?",
  header: "Stray files",
  options: [
    { label: "Use proposed groups", description: "<list the proposed group→files mapping in this option's description>" },
    { label: "One commit", description: "Bundle everything into a single chore: commit" },
    { label: "Skip stray files", description: "Leave them uncommitted; user will handle" },
    { label: "Custom split", description: "Specify the grouping in Other" }
  ],
  multiSelect: false
}])
```

Default proposed groups (use these to populate the first option's description):
- Plan artifacts → `docs: add session plan artifact for <goal>`
- Skills added/updated → `feat(skills): ...`
- Config or gitignore changes → `chore: ...`

Never commit `.env`, credentials, or files matching `*-secret-*` even on "Use proposed groups" — re-prompt and exclude.

### 4. Version bump
Determine the correct semver bump based on what shipped and use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "What version bump for this release?",
  header: "Version",
  options: [
    { label: "Patch (x.x.X)", description: "Bug fixes, doc-only changes, stale comment cleanup" },
    { label: "Minor (x.X.0)", description: "New features or modules" },
    { label: "Major (X.0.0)", description: "Breaking API or schema changes" },
    { label: "Skip", description: "No version bump needed" }
  ],
  multiSelect: false
}])
```

Update `mcp-server/package.json` version field unless "Skip" was chosen.

### 5. Rebuild
Run `npm run build` in `mcp-server/` to compile the bumped version into `dist/`. If the project publishes cross-platform binaries and GitHub Actions is throttled or unavailable, invoke `/dsr` (Doodlestein Self-Releaser) as a fallback to produce local release artifacts.

### 6. Commit the version bump
```
git add mcp-server/package.json
git commit -m "chore: bump version to X.Y.Z — <one-line summary of what shipped>"
```

### 7. Show final log
`git log --oneline -10` so the user can see the clean commit stack before moving on.

## Step 10: Store session learnings

`orch_memory(operation: "store")` is the default path and wraps CASS under the hood. If the `cm` CLI is available and you want richer procedural memory semantics (tags, hierarchies, retrieval ranking), invoke `/cass-memory` directly instead — same underlying store, more control over how the learning is categorized.

For mining *prior* sessions (not storing new ones), invoke `/cass` — it ranks past prompts, decisions, and patterns beyond what `orch_memory search` surfaces.

Call `orch_memory` with `operation: "store"` and `cwd` to distill and persist session learnings:
- What worked well (tool choices, agent configurations, planning strategies)
- What failed or required manual intervention (agent shutdowns, file conflicts, review bottlenecks)
- Key decisions made during this session and their outcomes
- Any patterns worth replicating or avoiding in future sessions

Present the stored learnings to the user, then use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Session learnings saved. One more step?",
  header: "Improve",
  options: [
    { label: "Refine skills", description: "Improve the orchestrate skill based on this session's evidence" },
    { label: "Skip to finish", description: "Done — go straight to the final menu" }
  ],
  multiSelect: false
}])
```

- **"Refine skills"** → proceed to Step 11
- **"Skip to finish"** → skip to Step 12

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
- **"Run another cycle"** → run the cycle-reset checklist below, then return to Step 2.
- **"Audit the codebase"** → invoke `/orchestrate-audit`
- **"Check drift"** → invoke `/orchestrate-drift-check`
- **"Done for now"** → end gracefully with a summary of what shipped

#### Cycle-reset checklist (run in order before re-entering Step 2):

1. **Delete the checkpoint:** `rm -f .pi-orchestrator/checkpoint.json` (Bash). Without this, the next cycle inherits the prior `selectedGoal` / `activeBeadIds` / `phase` and the new "Resume session" drift check fires unnecessarily.
2. **Verify no impl agents remain.** Run `TaskList`; if any impl-* tasks are still listed, retire and force-stop them per the Step 9 pause checklist before continuing.
3. **Confirm clean tree:** run `git status -s`. If uncommitted changes exist, present:
   ```
   AskUserQuestion(questions: [{
     question: "Working tree has <N> uncommitted change(s): <short list>. How should I proceed?",
     header: "Dirty tree",
     options: [
       { label: "Proceed anyway", description: "Step 2's profiler will see the dirty state — that's fine for discovery" },
       { label: "Stash first", description: "Run git stash, proceed, then remind me to pop later" },
       { label: "Cancel cycle", description: "Stop here so I can commit or revert manually" }
     ],
     multiSelect: false
   }])
   ```
   Route per choice; never silently proceed past a dirty tree without acknowledgment.
4. Proceed to Step 2.
