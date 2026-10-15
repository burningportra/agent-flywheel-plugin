# Planning Phase — Steps 4.5 (Phase 0.5 brainstorm), 5, 5.55, 5.6

## Step 4.5: Phase 0.5 — Brainstorm pressure-test (MANDATORY unless skipped)

> **Why this exists.** `flywheel_discover` surfaces ideas; Step 5 picks a *plan shape*. But neither step interrogates the **framing** of the goal itself. "We planned the wrong thing" is the most expensive failure mode — beads ship but the goal was miscalibrated. A three-question pressure-test at this boundary catches the mis-framed goal before we spend plan + implement budget.
>
> Source: `docs/research/compound-engineering-apply.md` Proposal 4 ("Brainstorm step between discover and plan") — ported inline here rather than as a separate skill to avoid orchestrator fragmentation.

### 4.5a — Skip heuristic (fast-path)

Skip Phase 0.5 entirely and jump to Step 5 when **any** of the following holds:

1. `flywheel_discover` returned a top-ranked idea with `confidence >= 0.8` (the agent is highly certain about framing — no pressure-test needed).
2. The user's initial prompt captured in Step 0.preflight (`USER_INPUT`) is **>100 characters** AND reads as a detailed goal statement (multiple clauses specifying scope, users, or constraints — not just a one-word topic).
3. **Grill-complete brainstorm already on disk** — a file matching `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>.md` (prefer the path in `GRILL_BRAINSTORM_PATH` when set) contains **all three** headings: `## Framing synthesis`, plus either (`## Scope floor` **or** `## Smallest version`) **and** either (`## Ambition ceiling` **or** `## 10x version`). This is the normal exit from `skills/grill-with-docs` / Goal framing mode "Grill with docs" — re-asking floor/ceiling would double-interview.
4. `FRAMING_MODE === "grill"` **and** `GRILL_STATUS === "approved"` even if the path check is momentarily racy — trust the skill completion marker and skip; still prefer reading the brainstorm for planner context.

If ANY condition holds, emit a single line to the transcript noting the skip reason (e.g. `"Phase 0.5 skipped: discover confidence 0.87 >= 0.8"`, `"Phase 0.5 skipped: grill brainstorm docs/brainstorms/foo-2026-07-16.md has floor+ceiling+framing"`, or `"Phase 0.5 skipped: initial prompt is 247 chars with detailed framing"`) and proceed directly to Step 5.

Otherwise, run the dialogue below. **Do not skip silently** — an explicit skip notice is part of the audit trail.

> **Do not skip** when `FRAMING_MODE === "light"` or `"skip"` or `"brainstorm"` unless condition 1/2 also holds — Light explicitly wants the three Qs; Full brainstorm produces a design spec, not necessarily floor/ceiling.

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

1. Read `<goal-slug>` as `data.goalSlug` from the most recent `flywheel_select` response — it's also quoted in that response's text under **Goal slug**. Use the server's value verbatim; do not re-derive it in the skill. `flywheel_plan` looks the brainstorm up by exact slug match, so a locally-recomputed slug that drops the 60-char cut or the all-symbol fallback silently loses the file.
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

4. Mention the artifact path in a single line of your response (e.g. `Brainstorm written to docs/brainstorms/<goal-slug>-<date>.md`) so the user can see where it landed — but **do NOT end your turn here**.

5. **Proceed immediately to Step 5 in the SAME response**, calling Step 5's `AskUserQuestion` ("How would you like to plan?") without waiting for any user input. Per UNIVERSAL RULE 1, the flywheel must stay inside `AskUserQuestion` at every decision point. Writing a file is not a decision point — the next decision is the plan-mode choice, and it belongs in the same turn.

   ⚠ **Anti-pattern**: writing the artifact, saying "Written to `<path>`. Ready to plan?", and ending the turn. That "Ready to plan?" is a prose question, not an `AskUserQuestion` — it kicks the user out of the flywheel UX and forces them to free-text the next step. Always invoke Step 5's `AskUserQuestion` instead.

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

**On "Hand off to Codex"** — call `flywheel_rescue({ cwd, phase: 'plan', beadId, errorEnvelope })` and pass its `codexPrompt` field to the codex-rescue skill (`/codex:rescue --wait` so the rescue blocks Step 5). Store the returned `memoryLine` via `flywheel_memory(operation: "store", content: memoryLine)` so `flywheel_doctor`'s `rescues_last_30d` synthesis row sees it. `errorEnvelope` is the `structuredContent.data.error` object from the last failing `flywheel_plan` call; the server assembles the packet (goal, latest plan artifact, recent tool calls, Codex-tuned prompt rendering).

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
AskUserQuestion(questions: [
  {
    question: "How would you like to plan?",
    header: "Plan mode",
    options: [
      { label: "Standard plan", description: "Single planning pass — faster (~5 min)" },
      { label: "Deep plan", description: "3 AI models give competing perspectives, then synthesize — higher quality (~15 min, Recommended)" },
      { label: "Duel plan", description: "Adversarial 2-agent cross-scoring via /dueling-idea-wizards --mode=architecture — surviving design choices + contested-decision narrative (~30 min; needs ntm + 2 healthy CLIs)" },
      { label: "planning-workflow", description: "Invoke /planning-workflow — 4-5 sequential Codex review rounds via NTM + optional multi-model blending. Highest quality for major new features" }
    ],
    multiSelect: false
  },
  {
    question: "How ambitious should the plan be?",
    header: "Ambition",
    options: [
      { label: "As scoped", description: "Plan the goal as stated; the 10x version stays a future-direction appendix (Recommended)" },
      { label: "Ambitious", description: "Aim past the goal as asked: plan for the outcome behind it, a stretch target an outside check can verify, and methods borrowed from other fields. The scoped version ships first as the floor (adds ~5 min and one extra round of questions)" }
    ],
    multiSelect: false
  }
])
```

A second opinion from other models on the finished plan (formerly "Triangulated plan") is the **Triangulate** option in the Step 5.6 refinement menu, and it works for every plan mode.

**Ambitious**: run the ambition pass below first, then call `flywheel_plan` with the chosen mode plus `ambition: "ambitious"`. The tool injects the charter and the ambitious-plan requirements into every planner prompt (standard, each deep planner, and the duel pre-seed). If the charter file is missing, it returns `missing_prerequisite`; run the pass and call again. **As scoped**: omit `ambition`. A charter left on disk from an earlier run is then ignored.

### Ambition pass (only when Ambition = "Ambitious")

The pass rewrites the goal into an **ambition charter** before any planner sees it, so every planner and duel agent works toward the same higher target and competes only on how to reach it. It follows Felix Rieseberg's ["How to be more ambitious: A tutorial for humans with models"](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/). Ambition has three axes there: altitude (the outcome behind the task), depth (how the best people in the field would do it) and range (methods from other fields). Specific hard goals beat "do your best", and a floor gives permission to fail.

1. **Draft the charter.** Read the goal, the Phase 0.5 brainstorm if one exists (its 10x answer seeds the climb) and the repo profile. Then fill in each part of the template in step 3 in your own words.
   - **Altitude.** Ask what the user wants to happen after this goal is done. Write three rungs: the goal as asked, the outcome it serves, and the standing outcome that agents could keep true without a human handing out tasks. For example, "fix this crash" climbs to "ship releases without crash regressions" and then to "keep the app crash-free". Name the access a higher rung needs, such as crash reports, a version-to-commit map, or machines to reproduce on.
   - **Depth.** Answer four questions. What would a top professional in this field do here that wasn't asked for? What raw material would they start from instead of the digested version? Which specific methods and tools would they use (the instruments themselves, not their vocabulary)? What, other than you or the user, would show the result is right? Then set a stretch target about an order of magnitude past the obvious one, written as a number: asked for 5 s, aim for 200 ms. Treat it as reachable. Name one assumption the plan depends on and the raw-data check that could refute it, and one piece of new knowledge the work should produce.
   - **Range.** Restate the deliverable as verbs. "A dashboard" becomes "show an on-call engineer what broke and why in under a minute". From the verbs, pick 3–5 fields whose methods apply, including one adversarial field such as a red team, a short seller or a forensic auditor. Write the concrete method each one contributes. Borrow the field's methods, not a persona: plan to do what a short seller does, not to write like one.
   - **Floor.** Name the version that still ships if the stretch misses. Planners deliver it first. Also name an existence proof that the stretch is reachable, or write "none found" when it would be new.
2. **Let the user pick the rung and the stretch target** in one call. Fill the option descriptions with the rungs and numbers you drafted:

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

3. **Write the charter** with the Write tool to `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>-ambition.md`, where `<goal-slug>` is `data.goalSlug` from the last `flywheel_select` response (same value quoted in that response's **Goal slug** line — use it verbatim). Use the user's picks and this template:

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

4. Mention the charter path in one line, then call `flywheel_plan` with the chosen mode and `ambition: "ambitious"` in the same response. Don't end the turn between writing the charter and calling the tool.

### Plan mode routes

**When to pick Duel plan**: high-stakes architectural decisions where reasonable people disagree (rewrite vs. iterate, framework choice, data-model shape), contested existing code, or no obvious right answer. Cost is a budget choice, not a failure mode — see the high-stakes track in AGENTS.md. If only one of {cc, cod, gmi} is healthy at duel pre-flight, the plan tool downgrades to Deep automatically and emits a warning.

**Standard plan**: Call `flywheel_plan` with `cwd` and `mode: "standard"`. `flywheel_plan` auto-detects the most-recent `docs/brainstorms/<goal-slug>-*.md` (written by Phase 0.5) and threads its synthesized framing into the planner prompt; no extra argument is required. After it returns, **STOP and jump to Step 5.55 (Plan alignment check)** — that step runs the qualifying-questions loop and only then hands off to Step 5.6 (Plan-ready gate). Do NOT skip 5.55 or proceed to bead creation without the user explicitly selecting "Create beads" from the Step 5.6 menu.

**Plan error codes.** Follow SKILL.md Universal Rule 4. For `flywheel_plan` recovery:

```ts
const code = planResult.structuredContent?.data?.error?.code;
if (code === "deep_plan_all_failed") return await flywheel_plan({ cwd, mode: "standard" });
if (code === "empty_plan" || code === "parse_failure") return requestPlanRegeneration();
if (code === "cli_not_available") return showInstallGuide(planResult.structuredContent?.data?.error?.hint);
```

**Duel plan**: Call `flywheel_plan` with `cwd` and `mode: "duel"`. The tool returns the verbatim `/dueling-idea-wizards` invocation it expects (with `--mode=architecture --top=3 --rounds=1 --focus="<goal>" --output=docs/plans/<date>-<slug>-duel.md`) and stamps `state.planSource = "duel"` so bead-creation injects the Provenance block automatically.

Pre-flight (MANDATORY before invoking the duel skill):

1. **NTM readiness** — run `_implement.md` **Pre-flight: resolve NTM readiness**, the canonical doctor/remediate procedure. On `NTM_AVAILABLE=false`, fall back to `mode: "deep"` and emit `Duel-plan downgraded to Deep — NTM unavailable` to the user.
2. **Agent inventory** — run `which claude codex gemini 2>/dev/null` (these are the real binaries behind the `cc/cod/gmi` ntm pane types; do NOT `which cc` — it matches `/usr/bin/cc`). Need at least 2 of the 3. If only 1 is available, fall back to `mode: "deep"`.
3. **Brainstorm handoff** — same auto-detection as Deep plan. The duel agents read `docs/brainstorms/<goal-slug>-*.md` in their study phase.

When the duel completes, the synthesized plan lands at the `--output` path. Re-call `flywheel_plan({ cwd, mode: "duel", planFile: "<that path>" })` to register and advance phase to `awaiting_plan_approval`. Then jump directly to Step 5.55 (Plan alignment check) — the duel surfaces tensions the alignment check exists to surface; do NOT skip it.

**planning-workflow**: Invoke `/planning-workflow` to get the exact review prompt, then run 4-5 sequential Codex review rounds via NTM. Each round spawns a fresh Codex pane with the current plan and the planning-workflow review prompt; after it completes, integrate its revisions with `ultrathink` before spawning the next round. Optionally follow with multi-model blending (additional NTM panes for Gemini/Pi perspectives).

When Ambition is "Ambitious", run the ambition pass first. Open the draft plan with an `## Ambition charter` section built from the charter file, and paste the charter file into every review round's prompt so the rounds deepen the plan toward the stretch target instead of trimming it back. This route registers its plan through `planFile`, so `flywheel_plan` doesn't inject the charter for you.

After all rounds converge:
1. Write the final plan to `docs/plans/<date>-<goal-slug>-planning-workflow.md`.
2. Call `flywheel_plan` with `cwd`, `mode: "deep"`, and `planFile: "docs/plans/<date>-<goal-slug>-planning-workflow.md"`.
3. Jump to Step 5.55 (Plan alignment check).

NTM spawn pattern for each review round. Rounds are sequential — each round reads the plan revised by the prior round — but within a round the mixed `cc:cod:gmi` 1:1:1 cross-check runs in parallel. Each pane writes to its own per-pane revision file so concurrent writes don't clobber each other; the coordinator reconciles the three revisions into the canonical plan file before dispatching round N+1. The review-round guidance comes from the `/planning-workflow` skill, not an unversioned filesystem file. A spawn with `--label plan-review-round-<N>` creates the session `${NTM_PROJECT}--plan-review-round-<N>`; `--robot-send` and `--robot-wait` both target that session. Address panes by provider type (`--type=cc` / `--type=cod` / `--type=gmi`) rather than by index: a `--no-user` spawn with `tmux pane-base-index` 0 numbers its panes 0, 1, 2, so an index loop starting at 1 skips the cc pane entirely and misaligns the per-type output filenames. `--type` is index-agnostic.

```
SESSION="${NTM_PROJECT}--plan-review-round-<N>"
ntm spawn "$NTM_PROJECT" --label plan-review-round-<N> --no-user --cc=1 --cod=1 --gmi=1 --stagger-mode=smart
# Address panes by provider type (index-agnostic — the --no-user spawn starts at pane 0):
for TYPE in cc cod gmi; do
  ntm --robot-send="$SESSION" --type="$TYPE" --msg="Invoke the /planning-workflow skill and apply its review-round guidance to the plan at docs/plans/<date>-<goal-slug>-planning-workflow.md. Write YOUR revised plan to docs/plans/<date>-<goal-slug>-planning-workflow-round-<N>-${TYPE}.md — do not touch the canonical plan file; the coordinator will reconcile the three per-type revisions before dispatching round N+1."
done
```

Use `ntm --robot-wait="$SESSION" --wait-until=idle --wait-transition` to block until all three panes complete, then read the three `-round-<N>-{cc,cod,gmi}.md` files and reconcile (take the strongest point from each; break ties by majority) into the canonical `docs/plans/<date>-<goal-slug>-planning-workflow.md` before spawning round N+1. Stop at convergence (minor wording changes only) or after 5 rounds. Review rounds are sequential by design (each reads the prior round's reconciled revision); the per-perspective planner spawn later in this skill is a separate concern (deep-plan).

**Deep plan**:

> **Brainstorm handoff.** `flywheel_plan` auto-detects the most-recent `docs/brainstorms/<goal-slug>-*.md` artifact (if any) and injects its synthesized framing into every per-perspective planner prompt under a `## Phase 0.5 Brainstorm` header. Each spawned planner therefore inherits the scope floor, 10x ceiling, and adjacent-ask decisions from Phase 0.5 without you having to repeat them. If Phase 0.5 was skipped by heuristic, planners simply proceed without that section.

> **NTM readiness (MANDATORY — run BEFORE step 1).** Run `_implement.md` **Pre-flight: resolve NTM readiness**, including after `/compact` or session resume. The canonical doctor/remediate procedure recomputes `NTM_AVAILABLE` and `NTM_PROJECT` on every invocation and owns the safe collision question. Use the NTM branch below only when its final doctor result says `NTM_AVAILABLE=true`; otherwise use the `Agent()` fallback.

> **Codex config compatibility pre-spawn gate (MANDATORY when spawn includes a `cod` pane).** If `DOCTOR_REPORT.checks` shows `codex_config_compat` with severity `yellow` or `red`, surface this gate BEFORE spawning. Skipping it is a known failure mode: cod pane crashes within seconds with `'gpt-5.5-xhigh' model is not supported when using Codex with a ChatGPT account` (verified 2026-05-08).
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
> **Gemini model compatibility pre-spawn gate (MANDATORY when spawn includes a `gmi` pane).** If `DOCTOR_REPORT.checks` shows `gemini_model_compat` with severity `yellow` or `red`, surface this gate BEFORE spawning. The 2026-05-15 reality-check swarm confirmed gemini CLI rejects models outside its documented allowlist (`gemini-3.1-flash-preview`). The check ships in `mcp-server/src/tools/doctor.ts`; if it is absent from `DOCTOR_REPORT.checks` (older MCP server), treat it as `green` and continue.
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
> **Looper-driven / `--no-user` contexts** auto-downgrade silently with a one-line warning to the dispatch log (`⚠ codex_config_compat=<sev>; downgrading --cod=N→0` and analogous for gemini). Redistribute the dropped share via the substitution ladder (gmi→cod→pi→cc) before computing lane sizes.

1. **Bootstrap Agent Mail** — call `macro_start_session` with:
   - `human_key`: current working directory
   - `program`: "claude-code"
   - `model`: your model name
   - `task_description`: "Orchestrating deep plan for: <goal>"
   Note your assigned agent name (e.g. "CoralReef") — you are the coordinator.

2. **Create a team** — call `TeamCreate` with a descriptive `team_name` (e.g. `"deep-plan-<slug>"`).

3. **Spawn 3 plan agents IN PARALLEL.**

   **If `NTM_AVAILABLE`** (preferred): Use NTM to spawn planners into visible tmux panes. Load `/ntm` and `/vibing-with-ntm` first if you haven't — they carry the canonical orchestrator decision tree, stuck-pane ladder, and command surface this section assumes.

   `ntm spawn` takes a project name (which must be a directory under `projects_base`) and uses `--label` for the per-purpose suffix. Use `$NTM_PROJECT` captured in Step 0b (which equals `basename $PWD`):
   ```bash
   SESSION="${NTM_PROJECT}--deep-plan-<slug>"

   # --no-user omits pane 0 entirely; planners get pane indices 1, 2, 3.
   # --stagger-mode=smart prevents thundering-herd on simultaneous cold-boot.
   # Pane-type priority (Changed in v3.17.0 — see AGENTS.md "NTM pane priority"):
   #   mixed cc:cod:gem 1:1:1 is canonical. Substitution ladder on a missing
   #   provider: gmi→cod (--cc=1 --cod=2), then cod→pi (--cc=1 --pi=2), then
   #   pi→cc as the cc-only floor.
   ntm spawn "$NTM_PROJECT" --label deep-plan-<slug> --no-user --cc=1 --cod=1 --gmi=1 --stagger-mode=smart
   ```

   **Pane → planner mapping** (panes are addressed by numeric index — `cc-1` / `cod-1` / `gmi-1` style does NOT work):

   | Pane # | Type  | Perspective | Model hint  |
   |--------|-------|-------------|-------------|
   | 1      | `cc`  | correctness | opus        |
   | 2      | `cod` | ergonomics  | codex       |
   | 3      | `gmi` | robustness  | gemini      |

   Dispatch via `ntm --robot-send` (NOT `ntm send`). Plain `ntm send` aborts with `Continue anyway? [y/N]` when CASS dedup matches a similar past prompt — silent blocker in orchestrator loops (ntm skill gotcha #3). `--robot-send` is non-interactive by design:
   ```bash
   ntm --robot-send="$SESSION" --panes=1 --msg="<correctness planner prompt>"
   ntm --robot-send="$SESSION" --panes=2 --msg="<ergonomics  planner prompt>"
   ntm --robot-send="$SESSION" --panes=3 --msg="<robustness  planner prompt>"
   ```

   **Flag note (verified 2026-05-08).** Use `--panes=N` (plural; indices comma-separated). `--pane=N` (singular) is silently broadcast to ALL panes. Combining `--panes=N --type=cc` AND-restricts to zero matches at session-init time before pane-type metadata stabilizes — drop `--type=` when you already know the index. Test with `--msg="ping"` before the full prompt; verify `successful: ["N"]` returned, not `["0", "1", "2"]`.

   Each planner's prompt MUST still include the Agent Mail bootstrap (`macro_start_session` — the call auto-assigns an adjective+noun name; planner introduces itself to coordinator via `send_message` immediately after). NTM handles the process lifecycle; Agent Mail handles the coordination protocol.

   ⚠ **Forbidden in automation:** `ntm view` (retiles the user's tmux layout and returns nothing useful) and `ntm dashboard` / `ntm palette` (human-only TUIs). The user can run them; the orchestrator must not.

   **Monitor loop (MANDATORY — do NOT fire-and-forget).** NTM launches panes asynchronously; a pane process can live while the agent inside is idle, crashed, or skipping Agent Mail.

   ⚠ **Do NOT use `ntm status` / `ntm activity` / `ntm health` for monitoring.** They read cached timestamps and silently return stale signals (sometimes dated to the epoch / "56 years ago"), so panes appear dead while they're working (or vice versa). Use the `--robot-*` surfaces below — they sample live pane buffers and the provider's actual OAuth/quota state.

   **Bootstrap once** (capture the event cursor):
   ```bash
   ntm --robot-snapshot --robot-format=toon      # note the returned `cursor`
   ```

   **Tend.** Follow the `/vibing-with-ntm` orchestrator decision tree for nudge escalation, stuck-pane ladder, rate-limit probe, context-handoff and convergence termination. The flywheel-specific facts the loop needs on top of that:

   - Block the loop on `ntm --robot-wait "$SESSION" --wait-until=attention,action_required,mail_ack_required --timeout=90s`. On each wake, cross-reference `ntm --robot-is-working="$SESSION"` with your Agent Mail inbox (`fetch_inbox` + `mark_message_read`); the plan arrives as a `[plan] <perspective> delivered` subject whose body carries the disk path.
   - Never use `ntm status` (output is stale), `ntm send` (hits the CASS-dedup prompt and silently aborts) or `ntm view` (not a flag). Use `--robot-is-working`, `--robot-tail`, `--robot-send`.
   - Print one tick line only when state changes — pane status, inbox count, or plans-received count — so the user can see the orchestrator is alive without the scroll-spam of fixed-interval ticks.
   - About 60 s after spawn, confirm each pane registered an Agent Mail identity (`list_window_identities` or `list_contacts`). A missing identity means the pane skipped `macro_start_session`; nudge it with `--robot-send` so the identity bootstraps.
   - Session-name shape: pass the project as the positional arg and the purpose as `--label` (e.g. `ntm spawn "$NTM_PROJECT" --label deep-plan-<slug>`). A bare purpose as session name would resolve against `projects_base` and either fail or land in the wrong cwd.

   **If NTM is unavailable** (fallback): spawn each perspective as a background `Agent(...)` with `run_in_background: true`, save the returned task id, and have each one write to `docs/plans/<date>-<perspective>.md` and mail the path back. Force-stop any task that stops responding.

   ```
   Agent(model: "opus",    name: "correctness-planner", team_name: "<team>", run_in_background: true, prompt: "...")
   Agent(model: "sonnet",  name: "ergonomics-planner",  team_name: "<team>", run_in_background: true, prompt: "...")
   Agent(subagent_type: "codex:codex-rescue", name: "robustness-planner", team_name: "<team>", run_in_background: true, prompt: "...")
   ```

   Each prompt tells the planner to call `macro_start_session` first, read the goal + repo context + relevant `flywheel_memory` entries, write `docs/plans/<date>-<perspective>.md` with the Write tool (not Agent Mail body), and `send_message` the path back under subject `[deep-plan] <perspective> plan`. If a task misses two consecutive nudges, call `TaskStop(task_id: "<id>")` and `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")` so the team lead can proceed with the plans that landed.

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
  > **Synthesizer-recommendation acceptance (verified 2026-05-08).** This branch also fires when the user agrees with the synthesizer's recommendations on every question (i.e. the answer "changes" the plan to match what the synthesizer already proposed). The synthesizer adopted those choices in the plan body; the user's confirmation cross-validates without needing a refinement round. Proceed directly to Step 5.6.

- **Decisive convergence** — all answers request changes AND every change is a consistent pick from a SINGLE alternative source (e.g. the user picked the Codex column on every row of a triangulation report, or picked "plan B" on every question where plans diverged): run ONE refinement round to incorporate the user's selections, then **skip the re-extract loop and proceed directly to Step 5.6**. Rationale: the user has already arbitrated every open question in a single batch; re-asking "is the revised plan aligned?" is ceremonial. Surface in your end-of-turn summary: "Decisive convergence on <source> — skipped re-alignment round."

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

- **"Create beads"** → run **Step 5.6.5 — Rubric gate** (below) BEFORE `_beads.md`. Skipping the rubric gate is a bug; the wrap-up grader has nothing to grade against without it.
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

**Iterative deepening recipe** (only when "Refine plan" is chosen): first ask the user which refinement mode to use:

```
AskUserQuestion(questions: [{
  question: "How should we refine the plan?",
  header: "Refine mode",
  options: [
    { label: "Internal (Opus agent)", description: "Spawn a fresh-context Opus agent to critique and revise in-process — fast, no external tools needed (Recommended)" },
    { label: "planning-workflow (Codex via NTM)", description: "Invoke /planning-workflow — spawn a Codex review round via NTM with the exact review prompt, integrate revisions with ultrathink, repeat until convergence" },
    { label: "Triangulate", description: "Invoke /multi-model-triangulation on the plan for a second opinion from other models, then resolve where they diverge" }
  ],
  multiSelect: false
}])
```

**Triangulate**: invoke `/multi-model-triangulation` with the plan file as input. Capture the triangulation report (agreements, disagreements, unique insights per model). Turn each disagreement into a qualifying question and run them through Step 5.55 so the user sees where external models diverge from the plan before approving. Then return to the "Plan ready" menu above.

**planning-workflow (Codex via NTM)**: invoke `/planning-workflow` to get the exact review prompt. Spawn a Codex pane via NTM (`ntm spawn --type=cod`) with the current plan and the planning-workflow review prompt. Wait with `ntm --robot-wait`, then integrate the returned revisions in-place using `ultrathink` — be meticulous. Repeat until convergence (minor wording changes only) or 5 rounds. After integration, return to the "Plan ready" menu above.

**Internal (Opus agent)**: spawn a NEW agent (fresh context, no memory of prior rounds) that reviews and proposes improvements:

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

## Step 5.6.5: Rubric gate (MANDATORY — fires after "Create beads" picks Step 5.6)

> **Hard rule**: After the operator picks "Create beads" from Step 5.6, you MUST run this rubric gate before `_beads.md`. The wrap-up grader (`flywheel_grade_outcome` in `_wrapup.md` Step 9.5) reads `state.outcomeRubricPath` to decide what to grade against; skipping this gate leaves it nothing to read AND silently skips outcome grading without recording the skip flag. A successful `flywheel_synthesize_rubric({ action: "skip" })` call is the only legitimate skip path for either an explicit operator choice or a synthesis-error fallback. It saves `state.outcomeGradingSkipped = true` so wrap-up surfaces the verbatim §"Skipped Notice" instead of a verdict.

### 5.6.5a — Synthesize the draft rubric

Call `flywheel_synthesize_rubric` with `cwd` and `action: "synthesize"` (default). The tool reads the active plan, spawns the synthesizer subagent, validates the output against `RubricSchemaV1`, and writes `.pi-flywheel/plans/<slug>/rubric.md`. It also seeds `state.outcomeRubricPath` so the doctor's `outcome_rubric_validity` check picks the file up next sweep.

If the call returns `kind: "rubric_preserved"`, an operator-edited rubric is already on disk; print the verbatim re-entry preview and continue to the gate below:

```text
Outcome rubric already edited at <rubric-path>; preserving it unless you choose Regenerate.
```

Otherwise (kind = `rubric_synthesized`), print the verbatim Rubric Preview line:

```text
Outcome rubric drafted at <rubric-path> with <N> criteria. Source: auto.
```

**Rubric error codes.** Follow SKILL.md Universal Rule 4. For rubric synthesis recovery:

- `rubric_synth_invalid` → present a recovery `AskUserQuestion` with options `Re-edit / Regenerate from scratch / Abort` (use the verbatim §"Edit Parse Failure Recovery" copy below). The synthesizer's output didn't match `RubricSchemaV1`; the file was NOT written.
- `parse_failure` / `cli_failure` → surface the hint and offer `Retry / Skip rubric / Abort` (one auto-retry happens inside the tool already).
- any other code → call `flywheel_synthesize_rubric({ cwd, action: "skip", reason: "rubric synthesis failed with <code>" })`. Continue to `_beads.md` only when it returns `kind: "rubric_skipped"`; otherwise surface the persistence error and stay at this gate. Record the original failure via `flywheel_memory(operation: "store", content: "rubric synth failed with <code>; skipped this cycle")`.

### 5.6.5b — Rubric gate

Surface the verbatim Rubric Gate question:

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

Branch on the answer:

- **Approve rubric** → set `state.outcomeRubricPath` (already written by the tool) and proceed to `_beads.md` Step 5.5. No tool call needed; the rubric is already on disk.
- **Edit inline** → run §5.6.5c (edit-inline follow-up) below.
- **Regenerate** → call `flywheel_synthesize_rubric` with `action: "regenerate"` and `force: true` (overrides the edited-source guard). Re-show the Rubric Gate above when the new draft lands. Loop with a hard cap: after 3 regenerations without an Approve, surface `Skip rubric / Edit inline / Abort` to break out.
- **Skip rubric** → call `flywheel_synthesize_rubric({ cwd, action: "skip", planSlug: "<active-plan-slug>", reason: "operator skipped rubric at Step 5.6.5" })`. When it returns `kind: "rubric_skipped"`, print the §"Skipped Notice" sentinel and proceed to `_beads.md`. On an error, surface the persistence hint and stay at this gate. **Do NOT loop the rubric gate after a successful Skip.**

### 5.6.5c — Edit-inline follow-up

Surface the verbatim Edit Inline Follow-Up question:

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

Map the operator's selection and `Other` text into a `flywheel_synthesize_rubric` call:

```
flywheel_synthesize_rubric({
  cwd,
  action: "edit",
  editIntent: { kind: "<tighten|add|remove|custom>", text: "<Other field text>" },
})
```

Three outcomes:

1. **Success (`kind: "rubric_edited"`)** → re-show the Rubric Gate (5.6.5b) so the operator can confirm.
2. **Zod parse failure (`code: "rubric_synth_invalid"`)** → the file was NOT overwritten (D15 invariant). Run §5.6.5d below.
3. **Other error** → surface the hint and route through the Edit Parse Failure Recovery flow (5.6.5d).

### 5.6.5d — Edit parse failure recovery

Surface the verbatim Edit Parse Failure Recovery question:

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
- **Abort** → stop the cycle. Do NOT proceed to `_beads.md` — the operator needs to fix the rubric manually before `flywheel_grade_outcome` can read it.
