# Planning phase: Steps 4.5, 4.6, 5, 5.55, and 5.6

## Step 4.5: Phase 0.5 brainstorm

### 4.5a — Skip heuristic (fast-path)

Skip Phase 0.5 and continue to Step 5 when any condition holds:

1. `flywheel_discover` returned a top-ranked idea with `confidence >= 0.8`.
2. Step 0.preflight captured a detailed `USER_INPUT` longer than 100 characters.
3. **Grill-complete brainstorm already on disk.** `GRILL_BRAINSTORM_PATH`, or `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>.md`, contains `## Framing synthesis`, a floor heading (`## Scope floor` or `## Smallest version`), and a ceiling heading (`## Ambition ceiling` or `## 10x version`).
4. `FRAMING_MODE === "grill"` and `GRILL_STATUS === "approved"`. Prefer the brainstorm file when available.

Log one skip reason when matched. Otherwise run the dialogue below.

> **Do not skip** for `FRAMING_MODE === "light"`, `"skip"`, or `"brainstorm"` unless condition 1 or 2 also holds.

### 4.5b — Three-question pressure-test dialogue

Ask these three questions separately so each answer shapes the next:

**Question 1 — Smallest version (scope floor).**

```
AskUserQuestion(questions: [{
  question: "What's the SMALLEST version of this that would still be worth shipping?",
  header: "Smallest",
  options: [
    { label: "Core-only slice", description: "Ship only the load-bearing primitive; skip nice-to-haves for v1" },
    { label: "Happy-path MVP", description: "Cover the 80% case end-to-end; defer edge cases and polish" },
    { label: "Time-boxed prototype", description: "Ship whatever lands in one cycle; accept throwaway code" }
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
    { label: "Breadth expansion", description: "Same pattern applied across every related surface" },
    { label: "Depth expansion", description: "A single surface but radically smarter (automated, self-healing)" },
    { label: "Platform play", description: "Reusable infrastructure others build on, not a point solution" }
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
    { label: "Nothing adjacent", description: "This goal is isolated" },
    { label: "Bundle a related ask", description: "Specify which adjacent ask to include in Other" },
    { label: "Related but defer", description: "Name the adjacent ask but park it for a later cycle" },
    { label: "Unsure — I'll decide during planning", description: "Let the planner surface adjacents" }
  ],
  multiSelect: false
}])
```

### 4.5c — Synthesize and write the brainstorm artifact

1. Read `<goal-slug>` verbatim from `flywheel_select`'s `data.goalSlug` and `<date>` as `YYYY-MM-DD`.
2. Write `docs/brainstorms/<goal-slug>-<date>.md`:

```markdown
# Brainstorm — <goal title>

**Date:** <YYYY-MM-DD>
**Goal slug:** <goal-slug>
**Source:** Phase 0.5 pressure-test (skills/start/_planning.md §4.5)

## Framing synthesis

<Synthesize deliverable, floor, deferred work, and ambition ceiling in 2–4 sentences.>

## User answers

### Smallest version (scope floor)
- **Selected:** <label>
- **Detail:** <description + Other text>

### 10x version (ambition ceiling)
- **Selected:** <label>
- **Detail:** <description + Other text>

### Adjacent asks (scope creep radar)
- **Selected:** <label>
- **Detail:** <description + Other text>

## Depth
<Only when `DEPTH_NOTES` is set by SKILL.md Goal deepening: what a top professional would add, raw material, methods/tools, and outside check.>

## Planner instructions

Anchor the plan to the smallest version. Put the 10x version in a future-direction appendix. Include adjacent work only when "Bundle a related ask" was selected; otherwise list under explicit non-goals.
```

3. State the artifact path and invoke Step 5's `AskUserQuestion` in the same response.

### 4.5d: Codex rescue on planner stall

When `flywheel_plan` fails twice with the same `error_code`, deep-plan synthesizer scores `< 0.5` after revision, or a planner is silent `> 5m`, ask:

```
AskUserQuestion(questions: [{
  question: "Plan phase has stalled (<error_code> twice; hint: <hint from envelope>). How do you want to proceed?",
  header: "Plan stall",
  options: [
    { label: "Retry once more", description: "Spend the final retry on the same planner" },
    { label: "Hand off to Codex (Recommended)", description: "Build a rescue packet via flywheel_rescue and invoke /codex:rescue --wait" },
    { label: "Abort phase", description: "Stop planning and return to Step 4.5" }
  ],
  multiSelect: false
}])
```

For **Hand off to Codex**, call `flywheel_rescue({ cwd, phase: "plan", beadId, errorEnvelope })`, pass `codexPrompt` to `/codex:rescue --wait`, and register revised `data.packet.artifact_path` via `flywheel_plan({ cwd, mode: "standard", planFile })`.

---

## Step 4.6: Structured interview and Poteto mode (pstack)

**Six-category interview.** When product questions remain open after framing, interview along the Complete Guide's six categories (skipping any covered in the brainstorm): Users & Personas, Core Value & MVP, Technical Stack & Constraints, Integrations & Data, Scale & Performance, Risks & Non-Goals (up to 4 questions per `AskUserQuestion`, appended to `## User answers`).

**Poteto mode (pstack).** For architectural or high-stakes goals, offer the pstack track (`interrogate -> architect -> plan -> red-green-implement -> verify -> ship`):

1. **Interrogate:** Run `/agent-flywheel:interrogate` → `docs/specs/<goal-slug>-interrogation.md`.
2. **Architect:** Run `/agent-flywheel:architect` → `docs/architecture/<goal-slug>-adr.md`.
3. **Pre-code research:** Cover `architecture`, `dependencies`, `security`, and `performance` in the ADR.
4. **Plan:** Call `flywheel_plan` with `poteto: true` and `preCodeResearch: { architecture: true, dependencies: true, security: true, performance: true }` (resolves `poteto_prerequisite_missing` / `pre_code_research_incomplete`).
5. **Red-green-implement:** Failing test first (`/pstack:tdd` when `pstack_plugin` is green).
6. **Verify & Ship:** Independent agent verification (`_beads.md` / `_implement.md` gate) + `.pi-flywheel/ledger.tsv` audit at `_wrapup.md` Step 9.5.

## Step 5: Choose planning mode

```
AskUserQuestion(questions: [
  {
    question: "How would you like to plan?",
    header: "Plan mode",
    options: [
      { label: "Standard plan", description: "One planning pass (~5 min)" },
      { label: "Deep plan", description: "Three competing perspectives and a synthesis (~15 min, Recommended)" },
      { label: "Duel plan", description: "Two agents cross-score architecture choices (~30 min; needs NTM + 2 CLIs)" },
      { label: "planning-workflow", description: "Sequential multi-model review rounds via NTM" }
    ],
    multiSelect: false
  },
  {
    question: "How ambitious should the plan be?",
    header: "Ambition",
    options: [
      { label: "As scoped", description: "Plan the stated goal; keep 10x as future direction (Recommended)" },
      { label: "Ambitious", description: "Target the outcome behind the goal with a measurable stretch and scoped floor" }
    ],
    multiSelect: false
  }
])
```

For **Ambitious**, run the Ambition pass below and pass `ambition: "ambitious"` to `flywheel_plan` (add `poteto: true` and `preCodeResearch` on the Poteto track).

### Ambition pass (only when Ambition = "Ambitious")

1. **Draft the charter** from the goal, brainstorm, `DEPTH_NOTES`, and profile:
   - **Altitude:** Rung 1 (as asked), Rung 2 (outcome), Rung 3 (standing outcome agents maintain) + required access.
   - **Depth:** Top-practitioner additions, raw material, instruments, ~10x numeric stretch, challenged assumption, and new knowledge.
   - **Range:** Deliverable as verbs + 3–5 fields (including 1 adversarial field).
   - **Floor:** Version that ships first + existence proof (`none found` if none).
2. **Confirm rung and stretch:**

```
AskUserQuestion(questions: [
  {
    question: "Which rung should this plan target?",
    header: "Rung",
    options: [
      { label: "Standing outcome", description: "<rung 3>: agents keep it true autonomously (Recommended)" },
      { label: "The outcome", description: "<rung 2>: the result the goal exists to produce" },
      { label: "As asked", description: "<rung 1>: keep scope, plan with depth and range" }
    ],
    multiSelect: false
  },
  {
    question: "Which stretch target should the plan commit to?",
    header: "Stretch",
    options: [
      { label: "Full stretch", description: "<stretch number>, verified by <outside judge> (Recommended)" },
      { label: "Halfway", description: "<midpoint between obvious target and stretch>" },
      { label: "Obvious target", description: "<target as asked>; ambition from rung, depth, and range" }
    ],
    multiSelect: false
  }
])
```

3. **Write `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>-ambition.md`** (`## Goal ladder`, `## Stretch target`, `## Depth`, `## Range`, `## Outside judge`), state its path, and call `flywheel_plan` with `ambition: "ambitious"` in the same turn.

### Plan mode routes

**Plan error codes.** Follow SKILL.md Universal Rule 4:
- `deep_plan_all_failed` → fall back to `flywheel_plan({ cwd, mode: "standard" })`.
- `empty_plan` / `parse_failure` → regenerate plan.
- `cli_not_available` → surface `data.error.hint`.

- **Standard plan:** Call `flywheel_plan({ cwd, mode: "standard" })`, then run Step 5.55 and Step 5.6.
- **Duel plan:** Check NTM readiness (`_implement.md`) and `which claude codex gemini 2>/dev/null` (need ≥2 non-disabled healthy providers, else downgrade to Deep and print `Duel-plan downgraded to Deep — NTM unavailable`). Call `flywheel_plan({ cwd, mode: "duel" })`, run its `/dueling-idea-wizards` command, register the output via `flywheel_plan({ cwd, mode: "duel", planFile: "<output>" })`, and run Step 5.55.
- **planning-workflow:** Set `PLAN_PATH=docs/plans/<date>-<goal-slug>-planning-workflow.md` (or `state.planDocument` during Step 5.6 refinement). Spawn reviewers via `swarm-spawn.js` and address each pane by its printed `index` so each lane writes its own revision file:

```
: "${PLAN_PATH:?Set PLAN_PATH before starting a review round}"
SESSION="${NTM_PROJECT}--plan-review-round-<N>"
# PANE001-OVERRIDE: review rounds keep one cc, cod and gmi reviewer; AGENTS.md "Deep plan exception".
node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" "$NTM_PROJECT" --label plan-review-round-<N> --cc=1 --cod=1 --gmi=1
# Then, for each printed pane, with LANE set to its lane (cc, cod, gmi) and INDEX to its index:
ntm --robot-send="$SESSION" --panes="$INDEX" --msg="Invoke the /planning-workflow skill and apply its review-round guidance to the plan at $PLAN_PATH. Write YOUR revised plan to ${PLAN_PATH%.md}-round-<N>-${LANE}.md; do not touch the canonical plan file."
```

Omit `--gmi=1` when `gemini_cli` is disabled/non-green or `gemini_model_compat` is yellow. Wait with `ntm --robot-wait="$SESSION" --wait-until=idle --wait-transition` (and wait for `-round-<N>-gmi.md`), reconcile `-round-<N>-{cc,cod,gmi}.md` into `$PLAN_PATH`, and repeat up to 5 rounds until changes are minor. Register a new plan with `flywheel_plan({ cwd, mode: "deep", planFile: PLAN_PATH })` and run Step 5.55.

- **Deep plan:**
  1. Resolve NTM readiness (`_implement.md`), then ask which lanes the 3 deep-plan planners should run:
     ```
     AskUserQuestion(questions: [{
       question: "Which lanes should run the 3 deep-plan lenses (correctness, robustness, ergonomics)?",
       header: "Plan lanes",
       options: [
         { label: "Claude + AGY (Recommended)", description: "1 Claude + 2 Antigravity panes (--cc=1 --agy=2) — no Pi setup required" },
         { label: "Claude + Pi (optional Pi)", description: "1 Claude + 2 Pi panes (--cc=1 --pi=2) and pick Pi models via flywheel_pi_models" },
         { label: "Claude + Codex", description: "2 Claude + 1 Codex panes (--cc=2 --cod=1)" }
       ],
       multiSelect: false
     }])
     ```
     Only when the user picks **Claude + Pi (optional Pi)** (and `flywheel_plan` returns `runner: "pi-pane"`), call `flywheel_pi_models({ cwd, action: "list", roles: ["robustness", "ergonomics"] })`, pass `data.questions` to `AskUserQuestion`, and call `flywheel_pi_models({ cwd, action: "choose", picks: { robustness: "<answer>", ergonomics: "<answer>" } })` to set `PI_ROBUSTNESS_MODEL` and `PI_ERGONOMICS_MODEL`.
  2. If Pi panes are unavailable (`piReady: false`), fall back to `--cc=1 --agy=2` (or `--cc=2 --cod=1`). If `codex_config_compat` is yellow/red on a Codex route, ask via `AskUserQuestion` (`Apply fix and proceed (Recommended)` via `flywheel_remediate({ checkName: 'codex_config_compat', mode: 'execute', autoConfirm: true })`, `Skip cod from swarm` (`--cc=3`), or `Continue anyway`).
  3. Bootstrap `macro_start_session` and spawn the 3 planners (using `--cc=1 --agy=2` for **Claude + AGY**, or the Pi flags below when **Claude + Pi** was chosen):
     ```bash
     SESSION="${NTM_PROJECT}--deep-plan-<slug>"
     # PANE001-OVERRIDE: deep plan is one Claude lens plus two AGY/Pi lenses; AGENTS.md "Deep plan exception".
     node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" "$NTM_PROJECT" --label deep-plan-<slug> --cc=1 --pi=2 --pi-model="$PI_ROBUSTNESS_MODEL" --pi-model="$PI_ERGONOMICS_MODEL" --pi-name=deep-plan
     ```
     Send prompts by printed `index` via `ntm --robot-send="$SESSION" --panes=<index> --msg="<prompt>"`. Each planner writes `docs/plans/<date>-<perspective>.md` (`correctness`, `robustness`, `ergonomics`) and mails `[deep-plan] <perspective> plan` (use background `Agent()` tasks when `NTM_AVAILABLE=false`).
  4. Tend with `--robot-is-working`, `--robot-tail`, and `tmux capture-pane -p -t <paneId>`, then spawn `Agent(model: "opus", name: "plan-synthesizer")` to write `docs/plans/<date>-<goal-slug>-synthesized.md` (agreement report + `+/-/~` diff summary + synthesized plan).
  5. Register `docs/plans/<date>-<goal-slug>-synthesized.md` with `flywheel_plan({ cwd, mode: "deep", planFile })` (**never pass `planContent`**), then run Step 5.55 and Step 5.6.

## Step 5.55: Plan alignment check

Read `state.planDocument`, verify any codebase counts or third-party SDK claims before asking, and extract 2–4 load-bearing questions (Scope, Approach, Risk) in one `AskUserQuestion` batch:

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
])
```

- **All confirm** → proceed to Step 5.6.
- **Decisive convergence** (all changes pick one alternative source) → refine once, report `Decisive convergence on <source> — skipped re-alignment round.`, and proceed to Step 5.6.
- **Mixed answers** → spawn `Agent(model: "opus", name: "align-refine-<N>", isolation: "worktree")` to revise `<state.planDocument>` in place, then re-run Step 5.55. After 3 rounds without convergence, ask `Stuck` (`One more round` / `Back to Step 5.6` / `Start over`).

## Step 5.6: Plan-ready gate

Display a brief plan summary (path, lines, headers) and ask:

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
- **Refine plan** → ask `Refine mode`: `Internal (Opus agent)` (Recommended), `planning-workflow (Codex via NTM)`, or `Triangulate` (`/multi-model-triangulation`), then return to Plan ready.
- **Review plan** → print path, ask `Post-review` (`Looks good` / `Refine plan` / `Start over` / `Still reading`), and route back to Step 5.6.
- **Start over** → delete plan file, clear `state.planDocument`, return to Step 3.

## Step 5.6.5: Rubric gate

1. **Synthesize:** Call `flywheel_synthesize_rubric({ cwd, action: "synthesize" })`. Print preserved/synthesized status (`state.outcomeRubricPath`). Follow SKILL.md Universal Rule 4 on errors (`rubric_synth_invalid` → §5.6.5d; `parse_failure`/`cli_failure` → `Retry / Skip rubric / Abort`).
2. **Rubric gate:**
   ```
   AskUserQuestion(questions: [{
     question: "Outcome rubric ready (<N> criteria, source <auto|edited|user>). What should happen before bead creation?",
     header: "Rubric",
     options: [
       { label: "Approve rubric", description: "Use this rubric for wrap-up grading and continue to Create beads (Recommended)." },
       { label: "Edit inline", description: "Update rubric.md criteria, validate, and re-show this gate." },
       { label: "Regenerate", description: "Discard current draft and synthesize a new rubric from the plan." },
       { label: "Skip rubric", description: "Skip outcome grading for this cycle only." }
     ],
     multiSelect: false
   }])
   ```
   - **Approve rubric** → proceed to `_beads.md` Step 5.5.
   - **Edit inline** → ask `Edit` (`Tighten criteria (Recommended)` / `Add criterion` / `Remove criterion` / `Custom edit`), call `flywheel_synthesize_rubric({ cwd, action: "edit", editIntent: { kind, text } })`, and re-show the Rubric gate.
   - **Regenerate** → call `action: "regenerate", force: true` and re-show the Rubric gate.
   - **Skip rubric** → call `flywheel_synthesize_rubric({ cwd, action: "skip" })` and proceed to `_beads.md` Step 5.5.
3. **Recovery (§5.6.5d):** On `rubric_synth_invalid`, ask `Recover` (`Re-edit (Recommended)` / `Regenerate from scratch` / `Abort`).
