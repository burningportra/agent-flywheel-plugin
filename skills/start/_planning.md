# Planning Phase — Steps 4.5 (Phase 0.5 brainstorm), 5, 5.55, 5.6

## Step 4.5: Phase 0.5 — Brainstorm pressure-test (MANDATORY unless skipped)

> **Why this exists.** `flywheel_discover` surfaces ideas; Step 5 picks a *plan shape*. But neither step interrogates the **framing** of the goal itself. "We planned the wrong thing" is the most expensive failure mode — beads ship but the goal was miscalibrated. A three-question pressure-test at this boundary catches the mis-framed goal before we spend plan + implement budget.
>
> Source: `docs/research/compound-engineering-apply.md` Proposal 4 ("Brainstorm step between discover and plan") — ported inline here rather than as a separate skill to avoid orchestrator fragmentation.

### 4.5a — Skip heuristic (fast-path)

Skip Phase 0.5 entirely and jump to Step 5 when **either** of the following holds:

1. `flywheel_discover` returned a top-ranked idea with `confidence >= 0.8` (the agent is highly certain about framing — no pressure-test needed).
2. The user's initial prompt captured in Step 0.preflight (`USER_INPUT`) is **>100 characters** AND reads as a detailed goal statement (multiple clauses specifying scope, users, or constraints — not just a one-word topic).

If EITHER condition holds, emit a single line to the transcript noting the skip reason (e.g. `"Phase 0.5 skipped: discover confidence 0.87 >= 0.8"` or `"Phase 0.5 skipped: initial prompt is 247 chars with detailed framing"`) and proceed directly to Step 5.

Otherwise, run the dialogue below. **Do not skip silently** — an explicit skip notice is part of the audit trail.

### 4.5b — Three-question pressure-test dialogue

Use THREE separate `AskUserQuestion` calls, one per question, so the user's answer to each shapes how the next is framed. Each question offers 2–4 labeled options covering scope / adjacents / ambition. Leverage the "Other" field for custom answers.

**Question 1 — Smallest version (scope floor).**

```
AskUserQuestion(questions: [{
  question: "What's the SMALLEST version of this that would still be worth shipping?",
  header: "Smallest",
  options: [
    { label: "Core-only slice", description: "Ship only the load-bearing primitive; skip every nice-to-have for v1" },
    { label: "Happy-path MVP", description: "Cover the 80% case end-to-end; defer edge cases and polish" },
    { label: "Time-boxed prototype", description: "Ship whatever lands in one cycle; explicitly accept throwaway code" },
    { label: "Other (describe)", description: "Specify a different floor in the Other field" }
  ],
  multiSelect: false
}])
```

**Question 2 — 10x version (ambition ceiling).**

```
AskUserQuestion(questions: [{
  question: "What's the 10x version of this — what would it look like if we weren't constrained?",
  header: "10x",
  options: [
    { label: "Breadth expansion", description: "Same pattern applied across every related surface (all commands, all users, all entrypoints)" },
    { label: "Depth expansion", description: "A single surface but radically smarter (automated, learning, self-healing)" },
    { label: "Platform play", description: "Ship this as reusable infrastructure others build on, not a point solution" },
    { label: "Other (describe)", description: "Specify a different ceiling in the Other field" }
  ],
  multiSelect: false
}])
```

**Question 3 — Adjacent user asks (scope creep radar).**

```
AskUserQuestion(questions: [{
  question: "What have users (or you) asked for ADJACENT to this that might belong in the same cycle?",
  header: "Adjacents",
  options: [
    { label: "Nothing adjacent", description: "This goal is isolated — no related asks to fold in" },
    { label: "Bundle a related ask", description: "Specify which adjacent ask to include in the Other field" },
    { label: "Related but defer", description: "Name the adjacent ask but park it for a later cycle" },
    { label: "Unsure — I'll decide during planning", description: "Let the planner surface adjacents as it goes" }
  ],
  multiSelect: false
}])
```

### 4.5c — Synthesize and write the brainstorm artifact

After all three answers land, write a brainstorm artifact to disk so `flywheel_plan` (both standard and deep) can read it back as planner context.

1. Compute `<goal-slug>` from the currently selected goal (same slugify rule used elsewhere — lowercase, hyphens, strip non-alphanumerics).
2. Compute `<date>` as `YYYY-MM-DD` from today.
3. Write the file to `docs/brainstorms/<goal-slug>-<date>.md` using the **Write** tool (not bash heredoc) with this shape:

```markdown
# Brainstorm — <goal title>

**Date:** <YYYY-MM-DD>
**Goal slug:** <goal-slug>
**Source:** Phase 0.5 pressure-test (skills/start/_planning.md §4.5)

## Framing synthesis

<2–4 sentence synthesis combining the three answers into a single framing
statement: what we're building, what we're NOT building (from Q1 floor and
Q3 defer), and the ambition ceiling we're aiming at (from Q2). Write this
in your own words as the orchestrator — this is the payload the planner
reads.>

## User answers

### Smallest version (scope floor)
- **Selected:** <label>
- **Detail:** <description + any Other-field text>

### 10x version (ambition ceiling)
- **Selected:** <label>
- **Detail:** <description + any Other-field text>

### Adjacent asks (scope creep radar)
- **Selected:** <label>
- **Detail:** <description + any Other-field text>

## Planner instructions

Planner agents: read this file FIRST. Anchor the plan's scope to the smallest
version. Reserve the 10x version as a "future direction" appendix, not a v1
requirement. Fold in adjacents ONLY if the user selected "Bundle a related
ask"; otherwise list them under "Explicit non-goals" so they don't leak in.
```

4. Surface the artifact path in your next turn so the user can see where it landed.

### 4.5d — Phase 0.6: Codex-rescue handoff on planner stall

> **Why this exists.** A planner agent that hits its retry budget (e.g. `flywheel_plan` errors twice with the same `FlywheelErrorCode`, or a deep-plan synthesizer scores below 0.5 after two revisions) is almost always wrestling with framing-or-tooling friction that a different model (GPT-5 / Codex) can untangle in one pass. Rather than burn a third Claude retry, offer the user a structured Codex handoff. Source: bead `agent-flywheel-plugin-1qn`.
>
> **Trigger condition (N-1 retry rule).** Detect stall *before* the final retry — at the (N-1)th failure, not the Nth. Concrete signals:
>
> - `flywheel_plan` returned an error envelope on the **immediately prior** attempt with the same `error_code` AND the next attempt would be the second retry.
> - Deep-plan synthesizer (Step 5.6) returned a coverage score `< 0.5` after one revision pass.
> - Planner agent has been silent on Agent Mail for >5 min while its task is still `in_progress`.
>
> Any one of these fires this branch. Do NOT wait for two of them — the point is to escalate before the user has to ask "is it stuck?".

When the trigger fires, present the rescue choice via `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Plan phase has stalled (<error_code> twice; hint: <hint from envelope>). How do you want to proceed?",
  header: "Plan stall",
  options: [
    { label: "Retry once more", description: "Spend the final retry on the same Claude planner — sometimes a transient flake clears" },
    { label: "Hand off to Codex (Recommended)", description: "Build a rescue packet from the failing envelope + plan artifact and invoke the codex-rescue skill" },
    { label: "Abort phase", description: "Stop planning; return to Step 4.5 (brainstorm) or earlier to re-frame" },
    { label: "Other", description: "Describe a different recovery path" }
  ],
  multiSelect: false
}])
```

**On "Hand off to Codex"** — build a `RescuePacket` (defined in `mcp-server/src/codex-handoff.ts`) and dispatch:

```ts
// 1. Construct the packet from the failing envelope.
import { buildRescuePacket, renderRescuePromptForCodex, formatRescueEventForMemory }
  from '../mcp-server/dist/codex-handoff.js';

const packet = buildRescuePacket({
  phase: 'plan',
  goal: state.selectedGoal,
  artifact_path: 'docs/plans/<latest-plan-file>.md',
  error_code: lastError.code,             // from the prior FlywheelToolError
  hint: lastError.hint ?? '',             // VERBATIM from bead 478 hint contract
  recent_tool_calls: state.recentToolCalls.slice(-10),
  proposed_next_step: 'Re-plan the failing section with explicit acceptance criteria; if blocked, surface a single clarifying question back to the coordinator.',
});

// 2. Render via the codex-prompt adapter (consumer-only — do NOT modify it).
const adapted = renderRescuePromptForCodex(packet, {
  coordinatorName: '<your-agent-mail-name>',
  projectKey: process.env.NTM_PROJECT,
  rescueAgentName: '<adjective+noun from agent-names pool>',
});

// 3. Invoke /codex:rescue with the rendered prompt body.
//    The /codex:rescue skill handles model selection / resume vs. fresh.
//    Pass `--wait` (foreground) so the rescue result blocks Step 5 progression.
```

Remember to send Codex two trailing newlines (`AdaptedPrompt.trailingNewlines === 2`) — this is the same input-buffer quirk documented in `_implement.md` Step 7.

**Persist the rescue event to CASS** so `flywheel_doctor`'s `rescues_last_30d` synthesis row picks it up:

```
flywheel_memory(operation: "store", content: formatRescueEventForMemory(packet))
```

The `RESCUE_EVENT_PREFIX` constant (`flywheel-rescue`) is the canonical doctor lookup prefix — do NOT roll your own message format.

**On Codex completion:**

- Codex returns a revised plan or a clarifying question. Accept the revised plan via `flywheel_plan` (mode="standard", `planContent: <codex output>`) and re-run the plan gate.
- If Codex produced a clarifying question, surface it to the user via `AskUserQuestion` and feed the answer back into the next planner call.
- If Codex itself stalls, fall back to "Abort phase" — do NOT cascade rescues.

---

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

**Standard plan**: Call `flywheel_plan` with `cwd` and `mode: "standard"`. `flywheel_plan` auto-detects the most-recent `docs/brainstorms/<goal-slug>-*.md` (written by Phase 0.5) and threads its synthesized framing into the planner prompt; no extra argument is required. After it returns, **STOP and jump to Step 5.55 (Plan alignment check)** — that step runs the qualifying-questions loop and only then hands off to Step 5.6 (Plan-ready gate). Do NOT skip 5.55 or proceed to bead creation without the user explicitly selecting "Create beads" from the Step 5.6 menu.

**Structured error branching (mandatory).** When `flywheel_plan` returns `status: "error"`, branch on `result.structuredContent?.data?.error?.code` (a `FlywheelErrorCode`) instead of matching message text:

```ts
const code = planResult.structuredContent?.data?.error?.code;
if (code === "deep_plan_all_failed") return await flywheel_plan({ cwd, mode: "standard" });
if (code === "empty_plan" || code === "parse_failure") return requestPlanRegeneration();
if (code === "cli_not_available") return showInstallGuide(planResult.structuredContent?.data?.error?.hint);
```

**Deep plan**:

> **Brainstorm handoff.** `flywheel_plan` auto-detects the most-recent `docs/brainstorms/<goal-slug>-*.md` artifact (if any) and injects its synthesized framing into every per-perspective planner prompt under a `## Phase 0.5 Brainstorm` header. Each spawned planner therefore inherits the scope floor, 10x ceiling, and adjacent-ask decisions from Phase 0.5 without you having to repeat them. If Phase 0.5 was skipped by heuristic, planners simply proceed without that section.

1. **Bootstrap Agent Mail** — call `macro_start_session` with:
   - `human_key`: current working directory
   - `program`: "claude-code"
   - `model`: your model name
   - `task_description`: "Orchestrating deep plan for: <goal>"
   Note your assigned agent name (e.g. "CoralReef") — you are the coordinator.

2. **Create a team** — call `TeamCreate` with a descriptive `team_name` (e.g. `"deep-plan-<slug>"`).

3. **Spawn 3 plan agents IN PARALLEL.**

   **If `NTM_AVAILABLE`** (preferred): Use NTM to spawn planners into visible tmux panes. `ntm spawn` takes a project name (which must be a directory under `projects_base`) and uses `--label` for the per-purpose suffix. Use `$NTM_PROJECT` captured in Step 0b (which equals `basename $PWD`):
   ```bash
   SESSION="${NTM_PROJECT}--deep-plan-<slug>"
   ntm spawn "$NTM_PROJECT" --label deep-plan-<slug> --cc=1 --cod=1 --gmi=1
   ntm send "$SESSION" --pane=cc-1 "<correctness planner prompt>"
   ntm send "$SESSION" --pane=cod-1 "<ergonomics planner prompt>"
   ntm send "$SESSION" --pane=gmi-1 "<robustness planner prompt>"
   ```
   Each agent's prompt MUST still include the Agent Mail bootstrap (`macro_start_session`, `send_message` to coordinator on completion). NTM handles the process lifecycle; Agent Mail handles the coordination protocol.

   **Monitor loop (MANDATORY — do NOT fire-and-forget).** NTM launches panes asynchronously; a pane process can live while the agent inside is idle, crashed, or skipping Agent Mail.

   ⚠ **Do NOT use `ntm status` / `ntm activity` / `ntm health` for monitoring.** They read cached timestamps and silently return stale signals (sometimes dated to the epoch / "56 years ago"), so panes appear dead while they're working (or vice versa). Use the `--robot-*` surfaces below — they sample live pane buffers and the provider's actual OAuth/quota state.

   **Bootstrap once** (capture the event cursor):
   ```bash
   ntm --robot-snapshot --robot-format=toon      # note the returned `cursor`
   ```

   **Tend — event-driven, not timer-driven.** Block on the attention feed until all 3 plans arrive in your inbox. It wakes on real state changes instead of burning cycles on fixed 60-90s polling:
   ```bash
   ntm --robot-wait "$SESSION" \
       --wait-until=attention,action_required,mail_ack_required \
       --timeout=90s
   ```

   **On each wake, read the live per-pane truth:**
   ```bash
   ntm --robot-is-working="$SESSION"             # working | idle | rate_limited | error | context_low
   ntm --robot-agent-health="$SESSION"           # OAuth, quota, context-window, account state
   ntm --robot-tail="$SESSION" --panes=<N> --lines=50   # sample the actual pane buffer for any pane flagged idle/error
   ```
   Plus: `fetch_inbox(project_key: cwd, agent_name: "<your-name>", include_bodies: false)` to see which planners have delivered their plan-file path.

   If the event cursor expires, re-run `ntm --robot-snapshot` and continue.

   **Agent Mail usage verification.** Bootstrap in the prompt is not enough — confirm each pane's agent actually registered AND is messaging:
   1. After 60s post-spawn, call `list_window_identities` (or `list_contacts`) and confirm a registered identity exists per planner pane. A missing identity means the agent skipped `macro_start_session`.
   2. On any missing identity, nudge immediately:
      ```bash
      ntm send "$SESSION" --pane=<pane> "Before anything else, run macro_start_session and send a 'started' message to <coordinator-name>. Do not skip Agent Mail bootstrap — the flywheel cannot collect your plan otherwise."
      ```
   3. If the agent has an identity but hasn't sent a message in >3 min, treat as idle and start the nudge escalation below.

   **Nudge escalation per idle pane.** "Idle" = `ntm --robot-is-working` reports `idle` for the pane OR no Agent Mail traffic in 3 min. Treat `rate_limited` and `context_low` as separate paths, NOT idle:
   - `rate_limited` → probe reality (`tmux send-keys -t "$SESSION":<pane> "ping" Enter; sleep 5; ntm --robot-tail`); if still limited, rotate via `/caam` or `ntm rotate "$SESSION" --all-limited`.
   - `context_low` → restart the pane on a fresh account: `ntm --robot-restart-pane="$SESSION" --panes=<N>` with a re-dispatch prompt.

   For a genuinely idle pane:
   - Nudge 1: `ntm send "$SESSION" --pane=<pane> "Your plan is needed — deliver the file path to <coordinator> via Agent Mail."`
   - Nudge 2 (2 min later): `ntm send "$SESSION" --pane=<pane> "Still waiting on your <perspective> plan. Report status and any blockers."`
   - Nudge 3 (2 min later): `ntm send "$SESSION" --pane=<pane> "Final nudge — deliver now or I proceed to synthesis without you."`
   - After 3 nudges AND identical `--robot-tail` for ≥3 ticks, the pane is wedged. Climb the stuck-pane ladder: `--robot-smart-restart` → `--robot-smart-restart --hard-kill` → `--robot-restart-pane`. If the restart doesn't recover the planner within one more tick, mark it as failed and continue to synthesis with the plans you have (2 is usable; 1 is a degraded-warning case). Do NOT block the flywheel indefinitely on a stuck planner.

   ⚠ Do NOT use `ntm spawn deep-plan-<slug>` (bare purpose as session name). `ntm` resolves the session name as `projects_base/<session_name>`, and a `deep-plan-<slug>` directory won't exist, so the spawn either fails or lands in the wrong cwd. Always pass the project name as positional arg and the purpose as `--label`.

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

       Think carefully and step-by-step before responding; this synthesis
       is harder than it looks — subtle tradeoffs between the three plans
       propagate to every downstream bead.

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
      reviewers see the user's intent.
      Think carefully and step-by-step before responding; ripple effects
      are harder to trace than they look.
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
    Provide changes in git-diff format.
    Think carefully and step-by-step before responding; this critique is
    harder than it looks — surface assumptions other reviewers missed.
    Write your revised plan to the same file path when done.
  "
)
```

After the refinement agent completes, return to the "Plan ready" menu above. Stop offering "Refine plan" when a round produces only minor wording changes — this signals convergence.
