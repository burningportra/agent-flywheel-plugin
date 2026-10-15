# Planning phase: Steps 4.5, 5, 5.55, and 5.6

## Step 4.5: Phase 0.5 brainstorm

### 4.5a — Skip heuristic (fast-path)

Skip Phase 0.5 and continue to Step 5 when any condition holds:

1. `flywheel_discover` returned a top-ranked idea with `confidence >= 0.8`.
2. Step 0.preflight captured a detailed `USER_INPUT` longer than 100 characters.
3. **Grill-complete brainstorm already on disk.** `GRILL_BRAINSTORM_PATH`, or `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>.md`, contains `## Framing synthesis`, a floor heading (`## Scope floor` or `## Smallest version`), and a ceiling heading (`## Ambition ceiling` or `## 10x version`).
4. `FRAMING_MODE === "grill"` and `GRILL_STATUS === "approved"`. Prefer the brainstorm file when it is available.

Log one skip reason when a condition matches. Otherwise, run the dialogue below.

> **Do not skip** for `FRAMING_MODE === "light"`, `"skip"`, or `"brainstorm"` unless condition 1 or 2 also holds. Light requests these questions, and a full brainstorm may not define a floor and ceiling.

### 4.5b — Three-question pressure-test dialogue

Ask these questions separately so each answer can shape the next. The client supplies an Other field.

**Question 1 — Smallest version (scope floor).**

```
AskUserQuestion(questions: [{
  question: "What's the SMALLEST version of this that would still be worth shipping?",
  header: "Smallest",
  options: [
    { label: "Core-only slice", description: "Ship only the load-bearing primitive; skip every nice-to-have for v1" },
    { label: "Happy-path MVP", description: "Cover the 80% case end-to-end; defer edge cases and polish" },
    { label: "Time-boxed prototype", description: "Ship whatever lands in one cycle; explicitly accept throwaway code" }
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
    { label: "Platform play", description: "Ship this as reusable infrastructure others build on, not a point solution" }
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

After all three answers, write the planner context to disk.

1. Read `<goal-slug>` from the latest `flywheel_select` response's `data.goalSlug`. Use it verbatim because `flywheel_plan` requires an exact slug match.
2. Compute `<date>` as `YYYY-MM-DD` from today.
3. Use the Write tool to create `docs/brainstorms/<goal-slug>-<date>.md` with this shape:

```markdown
# Brainstorm — <goal title>

**Date:** <YYYY-MM-DD>
**Goal slug:** <goal-slug>
**Source:** Phase 0.5 pressure-test (skills/start/_planning.md §4.5)

## Framing synthesis

<Synthesize the deliverable, the floor and deferred work, and the ambition ceiling in 2–4 sentences.>

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

Anchor the plan to the smallest version. Put the 10x version in a future-direction appendix. Include adjacent work only when the user selected "Bundle a related ask"; otherwise list it under explicit non-goals.
```

4. State the artifact path, then invoke Step 5's `AskUserQuestion` in the same response. Do not end the turn between them.

### 4.5d: Codex rescue on planner stall

Open the rescue choice before the final retry when any signal appears:

- The previous `flywheel_plan` attempt returned the same `error_code`, and the next attempt would be the second retry.
- The deep-plan synthesizer scored below `0.5` after one revision.
- The planner stayed silent on Agent Mail for more than five minutes while its task remained `in_progress`.

When the trigger fires, present the rescue choice via `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Plan phase has stalled (<error_code> twice; hint: <hint from envelope>). How do you want to proceed?",
  header: "Plan stall",
  options: [
    { label: "Retry once more", description: "Spend the final retry on the same Claude planner — sometimes a transient flake clears" },
    { label: "Hand off to Codex (Recommended)", description: "Build a rescue packet from the failing envelope + plan artifact and invoke the codex-rescue skill" },
    { label: "Abort phase", description: "Stop planning; return to Step 4.5 (brainstorm) or earlier to re-frame" }
  ],
  multiSelect: false
}])
```

For **Hand off to Codex**, call `flywheel_rescue({ cwd, phase: "plan", beadId, errorEnvelope })` with the last `flywheel_plan` error at `structuredContent.data.error`. Pass `codexPrompt` to `/codex:rescue --wait`. The tool writes and records the packet before returning.

**On Codex completion:**

- When Codex revises `data.packet.artifact_path`, register it with `flywheel_plan({ cwd, mode: "standard", planFile: data.packet.artifact_path })`, then rerun the plan gate.
- Route a clarifying question through `AskUserQuestion`. If Codex stalls, use Abort phase instead of another rescue.

---

## Step 5: Choose planning mode

Use one `AskUserQuestion` call:

```
AskUserQuestion(questions: [
  {
    question: "How would you like to plan?",
    header: "Plan mode",
    options: [
      { label: "Standard plan", description: "One planning pass (~5 min)" },
      { label: "Deep plan", description: "Three competing perspectives and a synthesis (~15 min, Recommended)" },
      { label: "Duel plan", description: "Two agents cross-score architecture choices (~30 min; needs NTM and two healthy CLIs)" },
      { label: "planning-workflow", description: "Sequential Codex review rounds via NTM for major features" }
    ],
    multiSelect: false
  },
  {
    question: "How ambitious should the plan be?",
    header: "Ambition",
    options: [
      { label: "As scoped", description: "Plan the stated goal; keep the 10x version as a future direction (Recommended)" },
      { label: "Ambitious", description: "Target the outcome behind the goal, with a measurable stretch and a scoped floor (~5 min extra)" }
    ],
    multiSelect: false
  }
])
```

The Step 5.6 **Triangulate** refinement works with every plan mode.

For **Ambitious**, run the pass below, then call `flywheel_plan` with the chosen mode and `ambition: "ambitious"`. If the tool returns `missing_prerequisite`, write the charter and retry. For **As scoped**, omit `ambition`; the tool ignores an old charter.

### Ambition pass (only when Ambition = "Ambitious")

The ambition charter gives every planner the same altitude, depth, range, stretch target, and scoped floor.

1. **Draft the charter.** Read the goal, the optional Phase 0.5 brainstorm, and the repo profile. Fill the template in step 3.
   - **Altitude.** Write three rungs: the goal as asked, the outcome it serves, and a standing outcome that agents can maintain. Name the access required by the higher rung.
   - **Depth.** Name what a top practitioner would add, the raw material and instruments they would use, and an outside check. Set a numeric stretch about an order of magnitude past the obvious target. Add one assumption with a raw-data check and one new fact the work should produce.
   - **Range.** Restate the deliverable as verbs. Choose three to five relevant fields, including one adversarial field, and name one concrete method from each.
   - **Floor.** Define the version that ships first and an existence proof for the stretch, or write `none found`.
2. **Let the user pick the rung and stretch target.** Fill the option descriptions with the drafted rungs and numbers:

```
AskUserQuestion(questions: [
  {
    question: "Which rung should this plan target?",
    header: "Rung",
    options: [
      { label: "Standing outcome", description: "<rung 3 as drafted>: agents keep it true without a human handing out tasks (Recommended)" },
      { label: "The outcome", description: "<rung 2 as drafted>: the result the goal exists to produce" },
      { label: "As asked", description: "<rung 1>: keep the goal's scope, but still plan with depth and range" }
    ],
    multiSelect: false
  },
  {
    question: "Which stretch target should the plan commit to?",
    header: "Stretch",
    options: [
      { label: "Full stretch", description: "<drafted stretch number>, verified by <outside judge> (Recommended)" },
      { label: "Halfway", description: "<a number between the obvious target and the stretch>" },
      { label: "Obvious target", description: "<the target as first asked>; ambition comes from rung, depth and range only" }
    ],
    multiSelect: false
  }
])
```

3. **Write the charter** with the Write tool to `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>-ambition.md`. Use `data.goalSlug` from the last `flywheel_select` response verbatim and fill this template:

```markdown
# Ambition charter — <goal title>

**Date:** <YYYY-MM-DD>
**Goal slug:** <goal-slug>
**Source:** Step 5 ambition pass (skills/start/_planning.md)

## Goal ladder
1. **As asked:** <the goal as stated>
2. **Outcome:** <the goal beyond the goal>
3. **Standing outcome:** <what agents keep true without a human handing out tasks>
- **Target rung:** <the user's pick>
- **Access this rung needs:** <data, tools, machines or permissions agents need to own it>

## Stretch target
- **Stretch:** <the user's pick, as a number>
- **Floor:** <the version that still ships if the stretch misses; delivered first>
- **Existence proof:** <precedent showing it is reachable, or "none found">

## Depth
- **What a top professional would add:** <…>
- **Raw material:** <…>
- **Instruments:** <specific methods and tools>
- **Assumption to challenge:** <belief + the raw-data check that could refute it>
- **New knowledge:** <one finding the work should produce>

## Range
- **Verbs:** <the deliverable restated as verbs>
- **Crew:** <one line per field: field → the concrete method it contributes; one adversarial field>

## Outside judge
- <for the stretch target and each climb: the benchmark, test, dataset or user metric that shows it worked; never a model's opinion of its own work>
```

4. State the charter path, then call `flywheel_plan` with the chosen mode and `ambition: "ambitious"` in the same response.

### Plan mode routes

Choose **Duel plan** for contested or high-stakes architecture. If fewer than two of `cc`, `cod`, and `gmi` are healthy, downgrade to Deep and warn the user.

For **Standard plan**, call `flywheel_plan({ cwd, mode: "standard" })`. The tool finds the latest matching Phase 0.5 artifact. After it returns, run Step 5.55, then the Step 5.6 Plan-ready gate.

**Plan error codes.** Follow SKILL.md Universal Rule 4. For `flywheel_plan` recovery:

```ts
const code = planResult.structuredContent?.data?.error?.code;
if (code === "deep_plan_all_failed") return await flywheel_plan({ cwd, mode: "standard" });
if (code === "empty_plan" || code === "parse_failure") return requestPlanRegeneration();
if (code === "cli_not_available") return showInstallGuide(planResult.structuredContent?.data?.error?.hint);
```

For **Duel plan**, call `flywheel_plan({ cwd, mode: "duel" })` and run the `/dueling-idea-wizards` command it returns. The tool records duel provenance.

Before invoking the duel skill:

1. Run `_implement.md` **Pre-flight: resolve NTM readiness**. If `NTM_AVAILABLE=false`, use Deep and print `Duel-plan downgraded to Deep — NTM unavailable`.
2. Run `which claude codex gemini 2>/dev/null`. These are the binaries behind `cc`, `cod`, and `gmi`; `which cc` matches `/usr/bin/cc`. Require two healthy providers or use Deep.
3. Let the duel read the matching Phase 0.5 artifact through the normal brainstorm handoff.

When the duel writes its output, register it with `flywheel_plan({ cwd, mode: "duel", planFile: "<output>" })`, then run Step 5.55.

For **planning-workflow**, invoke `/planning-workflow`. Run sequential review rounds until changes become minor or five rounds finish. Each round uses a mixed `cc:cod:gmi` check and writes one revision per provider before the coordinator reconciles the canonical plan.

For Ambitious mode, put the charter in the draft and every review prompt. This route registers the final file through `planFile`.

Set `PLAN_PATH=docs/plans/<date>-<goal-slug>-planning-workflow.md` for a new planning-workflow plan. During Step 5.6 refinement, set `PLAN_PATH=state.planDocument` instead. Address panes with `--type=cc`, `--type=cod`, and `--type=gmi` because a `--no-user` session can start at pane index 0. Each provider writes a separate revision file.

```
: "${PLAN_PATH:?Set PLAN_PATH before starting a review round}"
SESSION="${NTM_PROJECT}--plan-review-round-<N>"
ntm spawn "$NTM_PROJECT" --label plan-review-round-<N> --no-user --cc=1 --cod=1 --gmi=1 --stagger-mode=smart
# Provider selectors: --type=cc, --type=cod, --type=gmi
for TYPE in cc cod gmi; do
  ntm --robot-send="$SESSION" --type="$TYPE" --msg="Invoke the /planning-workflow skill and apply its review-round guidance to the plan at $PLAN_PATH. Write YOUR revised plan to ${PLAN_PATH%.md}-round-<N>-${TYPE}.md; do not touch the canonical plan file."
done
```

Run `ntm --robot-wait="$SESSION" --wait-until=idle --wait-transition`, reconcile the three `-round-<N>-{cc,cod,gmi}.md` files into `$PLAN_PATH`, then start the next round. Stop when changes become minor or after five rounds. For a new plan, register `$PLAN_PATH` with `flywheel_plan({ cwd, mode: "deep", planFile: PLAN_PATH })` and run Step 5.55. For refinement, return to Plan ready.

**Deep plan**:

> `flywheel_plan` puts the latest matching Phase 0.5 artifact into every planner prompt. If none exists, planning continues without it.

> Run `_implement.md` **Pre-flight: resolve NTM readiness**, including after resume or compaction. Use NTM only when its final result sets `NTM_AVAILABLE=true`; otherwise use the `Agent()` fallback.

> Before a `cod` spawn, show this gate when `codex_config_compat` is yellow or red:
>
> ```
> AskUserQuestion(questions: [{
>   question: "Doctor flagged codex_config_compat (~/.codex/config.toml model='X' is rejected by ChatGPT-account auth). Apply the fix before spawning?",
>   header: "Codex config",
>   options: [
>     { label: "Apply fix and proceed (Recommended)", description: "Run: flywheel_remediate({checkName: 'codex_config_compat', mode: 'execute', autoConfirm: true}). Idempotent. Then spawn the swarm." },
>     { label: "Skip cod from swarm", description: "Spawn with --cc=N --gmi=M only (no cod panes). Loses Codex perspective but avoids crash." },
>     { label: "Continue anyway", description: "Spawn cod panes despite known incompatibility — they will likely crash within seconds." }
>   ],
>   multiSelect: false
> }])
> ```
>
> Before a `gmi` spawn, show this gate when `gemini_model_compat` is yellow or red. Treat a missing row from an older server as green.
>
> ```
> AskUserQuestion(questions: [{
>   question: "Doctor flagged gemini_model_compat (configured gemini model outside the documented allowlist). How to handle the gmi lane?",
>   header: "Gemini",
>   options: [
>     { label: "Skip gmi from swarm (Recommended)", description: "Re-shape lane sizes via substitution ladder (gmi→cod→pi→cc). Loses Gemini perspective but avoids spawn crash." },
>     { label: "Continue anyway", description: "Spawn gmi panes despite known incompatibility — they will likely reject the configured model and exit." }
>   ],
>   multiSelect: false
> }])
> ```
>
> In looper-driven or `--no-user` contexts, log the downgrade and apply the `gmi→cod→pi→cc` substitution ladder without another question.

1. **Bootstrap coordination.** Call `macro_start_session`, note the assigned name, and create `deep-plan-<slug>` with `TeamCreate`.

2. **Spawn three planners.** When NTM is available, load `/ntm` and `/vibing-with-ntm`, then use the canonical mixed ratio:

   ```bash
   SESSION="${NTM_PROJECT}--deep-plan-<slug>"
   ntm spawn "$NTM_PROJECT" --label deep-plan-<slug> --no-user --cc=1 --cod=1 --gmi=1 --stagger-mode=smart
   ```

   Assign pane 1 to correctness, pane 2 to ergonomics, and pane 3 to robustness. Dispatch with `ntm --robot-send`; plain `ntm send` can stop at the CASS dedup prompt.

   ```bash
   ntm --robot-send="$SESSION" --panes=1 --msg="<correctness planner prompt>"
   ntm --robot-send="$SESSION" --panes=2 --msg="<ergonomics planner prompt>"
   ntm --robot-send="$SESSION" --panes=3 --msg="<robustness planner prompt>"
   ```

   Use `--panes=N`. The singular `--pane=N` broadcasts. When an index is known, omit `--type=` because combining it with `--panes` can match no pane during startup. Send a ping first and require `successful: ["N"]`.

   Each planner calls `macro_start_session`, reads the goal, repository context, and relevant memory, writes `docs/plans/<date>-<perspective>.md`, then mails the path under `[deep-plan] <perspective> plan`. Pass the project as the positional NTM argument and the purpose through `--label` so the session resolves inside `projects_base`.

   When NTM is unavailable, spawn the same three perspectives as background agents. Save their task ids, require the same files and mail subjects, and force-stop an unresponsive task.

3. **Tend and collect.** Follow `/vibing-with-ntm`. Wait on the live robot surfaces and cross-check Agent Mail. `ntm status` is stale, `ntm send` can stop for dedup confirmation, and `ntm view` changes the user's layout; use `--robot-is-working`, `--robot-tail`, and `--robot-send`. Read delivered plan paths from disk and commit each perspective plan when it lands. Shutdown messages go to each agent by name because they cannot be broadcast.

4. **Synthesize.** Spawn one synthesis agent:
   ```
   Agent(model: "opus", name: "plan-synthesizer", team_name: "<team>", run_in_background: true,
     prompt: "
       Read these plan files:
         docs/plans/<date>-correctness.md
         docs/plans/<date>-ergonomics.md
         docs/plans/<date>-robustness.md
         (and docs/plans/<date>-fresh-perspective.md if it exists)

       For each plan, name its strongest and unique contribution. Synthesize the compatible decisions, explain each major choice, and flag unresolved conflicts.
       Write docs/plans/<date>-<goal-slug>-synthesized.md and mail its path to <your-coordinator-name>.
     "
   )
   ```
   Read plans from disk instead of embedding their text. Shutdown the synthesizer after delivery.

5. Register `docs/plans/<date>-<goal-slug>-synthesized.md` with `flywheel_plan({ cwd, mode: "deep", planFile })`. **Never pass `planContent`**; large MCP text can stall the server. Then run Step 5.55 and wait for the Step 5.6 **Create beads** choice.

## Step 5.55: Plan alignment check

After `flywheel_plan` returns, run this alignment loop before the Step 5.6 Plan-ready gate. Refine on disagreement and repeat until the user confirms the plan.

### 1. Read the plan and extract qualifying questions

Read `state.planDocument` end to end. Identify two to four decisions that could force a major rewrite:

- Scope boundaries and explicit non-goals.
- Architecture, tool, and trade-off choices.
- Ordering and dependency assumptions.
- Deferred risks and missing coverage.

Skip the obvious. Ask only about decisions where reasonable people would disagree.

#### 1a. Verify numeric claims

Run a command to verify codebase counts before asking the user, especially when source plans disagree. Use the measured value in the question and later synthesis.

### 2. Present the questions in one batch

Use one `AskUserQuestion` call with up to four questions. Give each question two to four distinct user choices.

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

Ask only high-value questions. Two sharp questions beat four fuzzy ones.

### 3. Branch on the answers

- **All answers confirm the plan** → proceed to Step 5.6 and report that alignment was confirmed. This includes answers that accept every recommendation already present in a synthesized plan.

- **Decisive convergence** → when every answer requests a change and every change selects one alternative source, run one refinement round, then proceed to Step 5.6 without re-extracting questions. Report `Decisive convergence on <source> — skipped re-alignment round.`

- **Mixed answers (some confirm, some change; or changes drawn from multiple sources)** → run a refinement round automatically. The Step 2 AskUserQuestion already captured the user's answers; no further confirmation gate before spawning. Spawn:

  ```
  Agent(model: "opus", name: "align-refine-<N>", isolation: "worktree", run_in_background: true,
    prompt: "
      Read the plan at <state.planDocument>.
      The user reviewed it and requested these changes:
        - Scope: <user's scope answer + their Other-field text if any>
        - Approach: <user's approach answer + Other text>
        - Risk: <user's risk answer + Other text>
        (omit lines for questions where the user confirmed.)

      Use ultrathink.
      Apply every requested change and trace its substantive effects through
      dependencies, coverage, and assumptions. Report every implication;
      don't pad. Preserve the sections, task table, and verification block.
      Add a concise rationale at each changed decision.
      Write the revised plan to the same file path when done.
    "
  )
  ```

  After it completes, **return to step 1 of this section** (re-read the revised plan, regenerate qualifying questions based on the new content, present again). Loop until all answers confirm.

### 4. Convergence guard

After three rounds without convergence, present:

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

Route the choice, then either refine once, accept the current plan, or restart planning.

## Step 5.6: Plan-ready gate

After `flywheel_plan` succeeds in any mode, present this menu. Wait for an explicit **Create beads** choice before calling `br create`, `flywheel_approve_beads`, or an implementation tool.

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

- **Create beads** → run Step 5.6.5 before `_beads.md`.
- **Refine plan** → run the refinement flow, then return to this menu.
- **Review plan** → print the plan path, then present:
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
- **Start over** → delete the plan file, clear `state.planDocument`, and return to Step 3.

For **Refine plan**, ask which mode to use:

```
AskUserQuestion(questions: [{
  question: "How should we refine the plan?",
  header: "Refine mode",
  options: [
    { label: "Internal (Opus agent)", description: "Use a fresh Opus agent to critique and revise (Recommended)" },
    { label: "planning-workflow (Codex via NTM)", description: "Run the planning-workflow review rounds above" },
    { label: "Triangulate", description: "Compare the plan across models, then resolve disagreements" }
  ],
  multiSelect: false
}])
```

For **Triangulate**, invoke `/multi-model-triangulation` on the plan. Turn each disagreement into a Step 5.55 question, then return to Plan ready.

For **planning-workflow (Codex via NTM)**, run the shared procedure above with `PLAN_PATH=state.planDocument`, then return to Plan ready.

For **Internal (Opus agent)**, spawn a fresh agent:

```
Agent(model: "opus", name: "refine-round-<N>", isolation: "worktree", run_in_background: true,
  prompt: "
    Read the plan at <state.planDocument>.
    This is your first and only look. Use ultrathink.
    Report every substantive assumption, edge case, weak dependency, and
    missing verification step; don't pad. Revise each issue you find and add
    concise rationale at the change site.
    Write your revised plan to the same file path when done.
  "
)
```

Return to Plan ready after the agent finishes. A round with only minor wording changes ends refinement.

## Step 5.6.5: Rubric gate

After **Create beads**, run this gate before `_beads.md`. Only `flywheel_synthesize_rubric({ action: "skip" })` can skip it; the tool records the one-cycle grading skip for wrap-up.

### 5.6.5a — Synthesize the draft rubric

Call `flywheel_synthesize_rubric({ cwd, action: "synthesize" })`. It validates and writes the rubric, then sets `state.outcomeRubricPath`.

For `kind: "rubric_preserved"`, print:

```text
Outcome rubric already edited at <rubric-path>; preserving it unless you choose Regenerate.
```

For `kind: "rubric_synthesized"`, print:

```text
Outcome rubric drafted at <rubric-path> with <N> criteria. Source: auto.
```

Follow SKILL.md Universal Rule 4 for errors:

- `rubric_synth_invalid` → show the recovery question in §5.6.5d. The tool did not write the invalid file.
- `parse_failure` or `cli_failure` → surface the hint and offer `Retry / Skip rubric / Abort` after the tool's automatic retry.
- Any other code → call the skip action with the failure code as its reason. Continue only after `kind: "rubric_skipped"`; otherwise stay at this gate. Store the original failure with `flywheel_memory`.

### 5.6.5b — Rubric gate

Present the Rubric question:

```
AskUserQuestion(questions: [{
  question: "Outcome rubric ready (<N> criteria, source <auto|edited|user>). What should happen before bead creation?",
  header: "Rubric",
  options: [
    { label: "Approve rubric", description: "Use this rubric for wrap-up grading and continue to Create beads (Recommended)." },
    { label: "Edit inline", description: "Describe criteria to add, remove, or tighten; I will update rubric.md, validate it, and re-show this gate." },
    { label: "Regenerate", description: "Discard the current draft and synthesize a new rubric from the plan." },
    { label: "Skip rubric", description: "Skip outcome grading for this cycle only; wrap-up will record grading as skipped." }
  ],
  multiSelect: false
}])
```

- **Approve rubric** → proceed to `_beads.md` Step 5.5; the tool already set the path.
- **Edit inline** → run §5.6.5c.
- **Regenerate** → call the regenerate action with `force: true`, then show this gate again. After three regenerations, offer `Skip rubric / Edit inline / Abort`.
- **Skip rubric** → call the skip action with the active plan slug and the operator's reason. On `rubric_skipped`, print §"Skipped Notice" and proceed once. On error, stay at this gate and surface the hint.

### 5.6.5c — Edit-inline follow-up

Present the Edit question:

```
AskUserQuestion(questions: [{
  question: "What should change in <rubric-path>? Use Other for the exact edit text.",
  header: "Edit",
  options: [
    { label: "Tighten criteria", description: "Make existing criteria more testable and file/behavior-specific (Recommended)." },
    { label: "Add criterion", description: "Add one criterion from the Other field, then rebalance if weights exist." },
    { label: "Remove criterion", description: "Remove or merge criteria named in Other." },
    { label: "Custom edit", description: "Apply the precise edit instructions from Other." }
  ],
  multiSelect: false
}])
```

Map the selection and Other text into this call:

```
flywheel_synthesize_rubric({
  cwd,
  action: "edit",
  editIntent: { kind: "<tighten|add|remove|custom>", text: "<Other field text>" },
})
```

On `rubric_edited`, show the Rubric gate again. On `rubric_synth_invalid`, the original file remains and §5.6.5d handles recovery. Route any other error through the same recovery flow with its hint.

### 5.6.5d — Edit parse failure recovery

Present the recovery question:

```
AskUserQuestion(questions: [{
  question: "The edited rubric did not parse: <short parse error>. How should I recover?",
  header: "Recover",
  options: [
    { label: "Re-edit", description: "Keep the current file, apply a correction from Other, and validate again (Recommended)." },
    { label: "Regenerate from scratch", description: "Overwrite the broken rubric with a fresh auto-generated rubric from the plan." },
    { label: "Abort", description: "Stop before bead creation so the rubric can be fixed manually." }
  ],
  multiSelect: false
}])
```

- **Re-edit** → return to §5.6.5c with the operator's corrected `Other` text.
- **Regenerate from scratch** → return to §5.6.5a with `action: "regenerate"` + `force: true`.
- **Abort** → stop the cycle until the operator fixes the rubric.
