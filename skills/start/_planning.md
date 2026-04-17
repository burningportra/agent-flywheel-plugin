# Planning Phase — Steps 5, 5.55, 5.6

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

**Standard plan**: Call `flywheel_plan` with `cwd` and `mode: "standard"`. After it returns, **STOP and jump to Step 5.55 (Plan alignment check)** — that step runs the qualifying-questions loop and only then hands off to Step 5.6 (Plan-ready gate). Do NOT skip 5.55 or proceed to bead creation without the user explicitly selecting "Create beads" from the Step 5.6 menu.

**Deep plan**:

1. **Bootstrap Agent Mail** — call `macro_start_session` with:
   - `human_key`: current working directory
   - `program`: "claude-code"
   - `model`: your model name
   - `task_description`: "Orchestrating deep plan for: <goal>"
   Note your assigned agent name (e.g. "CoralReef") — you are the coordinator.

2. **Create a team** — call `TeamCreate` with a descriptive `team_name` (e.g. `"deep-plan-<slug>"`).

3. **Spawn 3 plan agents IN PARALLEL.**

   **If `NTM_AVAILABLE`** (preferred): Use NTM to spawn planners into visible tmux panes:
   ```bash
   ntm spawn deep-plan-<slug> --cc=1 --cod=1 --gmi=1
   ntm send deep-plan-<slug> --pane=cc-1 "<correctness planner prompt>"
   ntm send deep-plan-<slug> --pane=cod-1 "<ergonomics planner prompt>"
   ntm send deep-plan-<slug> --pane=gmi-1 "<robustness planner prompt>"
   ```
   Each agent's prompt MUST still include the Agent Mail bootstrap (`macro_start_session`, `send_message` to coordinator on completion). NTM handles the process lifecycle; Agent Mail handles the coordination protocol.

   Monitor via `ntm status deep-plan-<slug>` and `fetch_inbox`. If a pane goes idle, nudge with `ntm send deep-plan-<slug> --pane=<pane> "Your plan is needed — please complete and send via Agent Mail."`.

   **If NTM is unavailable** (fallback): Use the Agent tool with `team_name` set and `run_in_background: true` so they get task IDs (required for `TaskStop` if they become unresponsive):
   - `Agent(model: "opus", name: "correctness-planner", team_name: "<team>", run_in_background: true, prompt: "...")`
   - `Agent(model: "sonnet", name: "ergonomics-planner", team_name: "<team>", run_in_background: true, prompt: "...")`
   - `Agent(subagent_type: "codex:codex-rescue", name: "robustness-planner", team_name: "<team>", run_in_background: true, prompt: "...")`

   **Save the task ID returned by each Agent call** — you'll need them to force-stop unresponsive agents via `TaskStop(task_id: "<id>")`.

   Each agent's prompt MUST include:
   - Instructions to call `macro_start_session` first (same `human_key`, their model, their task)
   - Their focused planning perspective (correctness / ergonomics / robustness)
   - Full repo context (path, stack, goal, recent commits, known bugs)
   - **CASS context**: Query `flywheel_memory` with `query: "architecture planning decisions <goal>"` and include the top learnings in the agent prompt as a "Prior Session Context" section. This prevents agents from repeating past mistakes or reinventing prior decisions.
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

   **Progressive plan commit (recommended).** As soon as each perspective plan lands on disk, commit it — do NOT batch plan artifacts for Step 9.5 wrap-up. This keeps the git log interleaved with the implementation cycle so future bisects land on a plan+code pair. One commit per perspective plan + one for the synthesized plan + one for the triangulation report:
   ```bash
   git add docs/plans/<date>-correctness.md
   git commit -m "docs(plans): add <date>-correctness.md (deep-plan pass, <goal-slug>)"
   ```
   Step 9.5 §3 should find fewer stray plan artifacts; only the `-final.md` revision written post-alignment-check usually needs batching there.

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

       Use ultrathink.

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

8. Call `flywheel_plan` with `cwd`, `mode: "deep"`, and `planFile: "docs/plans/<date>-<goal-slug>-synthesized.md"`.
   **Never pass `planContent`** — large text over MCP stdio stalls the server. Always write to disk first.

   **Triangulated plan mode** — if the user picked "Triangulated plan" at Step 5 entry, AFTER `flywheel_plan` returns, invoke `/multi-model-triangulation` with the synthesized plan file as input. Capture the triangulation report (agreements, disagreements, unique insights per model). Present the report alongside the Step 5.55 alignment questions so the user sees where external models diverge from the Opus synthesis before approving.

9. **STOP — jump to Step 5.55 (Plan alignment check).** That step runs the qualifying-questions loop and only then hands off to Step 5.6 (Plan-ready gate). Do NOT skip 5.55 or proceed to bead creation without the user explicitly selecting "Create beads" from the Step 5.6 menu.

## Step 5.55: Plan alignment check (MANDATORY — both standard and deep)

> **Hard rule**: After `flywheel_plan` returns and BEFORE showing the Step 5.6 plan-ready gate, run this alignment check. The deeper the plan, the more assumptions are baked in — the user must confirm those assumptions match intent before any bead is created. This loop mirrors the bead-refinement loop: ask, refine on disagreement, re-ask, until aligned.

### 1. Read the plan and extract qualifying questions

Read `state.planDocument` end-to-end. Identify 2-4 **load-bearing** decisions that, if wrong, would force a major rewrite later. Look specifically for:

- **Scope boundaries** — what's in vs explicitly out (non-goals).
- **Architectural choices** — pattern X chosen over Y; library/tool selections; trade-offs the plan calls out.
- **Order/dependency assumptions** — "do A before B because…" claims.
- **Risk acceptances** — "we'll skip Z and revisit later" notes.
- **Missing coverage you noticed** — areas the plan brushes past that the user might care about.

Skip the obvious. Ask only about decisions where reasonable people would disagree.

#### 1a. Empirically verify numeric claims before asking the user

If the plan (or deep-plan synthesis) contains numeric claims about the actual codebase — file counts, line counts, dependency counts, test counts, package counts — and especially if multiple source plans disagree on a number, **run the command to get the real value before building an alignment question around it**. Examples:

| Claim shape                         | Verification command                                              |
|-------------------------------------|-------------------------------------------------------------------|
| "~N AskUserQuestion calls"          | `grep -rc "AskUserQuestion" skills/ \| awk -F: '{s+=$2} END {print s}'` |
| "~N transitive packages of <pkg>"   | `npm ls <pkg> --all --json \| jq '.. \| .dependencies? // empty \| keys' \| jq -s 'add \| unique \| length'` |
| "N changed files since <sha>"       | `git diff --name-only <sha>..HEAD \| wc -l`                       |
| "N test files in module"            | `find <dir> -name '*.test.*' \| wc -l`                            |

Cost: one shell command, seconds. Benefit: the user arbitrates on real numbers, not competing guesses. If the two plans' numbers bracket reality (e.g. plans say "28 or 59", real=38), note which plan was closer when synthesizing the next round.

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

- **Decisive convergence** — all answers request changes AND every change is a consistent pick from a SINGLE alternative source (e.g. the user picked the Codex column on every row of a triangulation report, or picked "plan B" on every question where plans diverged): run ONE refinement round to incorporate the user's selections, then **skip the re-extract loop and proceed directly to Step 5.6**. Rationale: the user has already arbitrated every open question in a single batch; re-asking "is the revised plan aligned?" is ceremonial. Surface in your end-of-turn summary: "Decisive convergence on <source> — skipped re-alignment round."

- **Mixed answers (some confirm, some change; or changes drawn from multiple sources)** → run a refinement round automatically (do NOT prompt the user again first). Spawn:

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

> **Hard rule**: After `flywheel_plan` returns successfully — regardless of `mode` — you MUST stop here and present this menu. Do NOT call `br create`, `flywheel_approve_beads`, or any implementation tool until the user explicitly selects "Create beads". Skipping this gate is a bug.

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

- **"Create beads"** → proceed to Step 5.5 (read `_beads.md`).
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
