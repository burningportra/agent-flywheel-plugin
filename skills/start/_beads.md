# Bead Creation & Approval — Steps 5.5, 6

## Step 5.5: Create beads from the plan

Beads are **NOT** auto-created by `flywheel_plan`. The coordinator must create them manually from the plan output:

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

> **WARNING:** Use `br list` for all read-only bead inspection. Never call `flywheel_approve_beads` just to preview beads — it is NOT read-only and advances internal state counters regardless of the action used.

5. **Beads created — run coverage + dedup checks before Step 6.**

6. **Plan-Bead coverage check (MANDATORY).** Parse `##`/`###` section headers from `state.planDocument`. For each section, search the bead list for any bead whose title or description references that section's topic. Build a coverage report: `<section> -> <bead-ids or NONE>`.

   Present:
   ```
   AskUserQuestion(questions: [{
     question: "Plan-Bead coverage: <X>/<Y> sections covered. <missing section list if any>. What next?",
     header: "Coverage",
     options: [
       { label: "All covered", description: "Every plan section has at least one bead — proceed to dedup" },
       { label: "Create catch-up beads", description: "Generate beads for the missing section(s) before proceeding (Recommended)" },
       { label: "Sections out of scope", description: "Mark missing sections as deferred in plan; proceed" }
     ],
     multiSelect: false
   }])
   ```
   - "Create catch-up beads" -> run `br create` per missing section with a stub description the user refines, then re-run this check.
   - "Sections out of scope" -> append a `## Deferred` block to the plan listing the dropped sections, then proceed.

7. **Deduplication sweep (MANDATORY).** Scan bead titles + descriptions for overlap: two beads touching the same files with similar intent, or near-duplicate titles. Build a `<duplicate-pair -> suggested-merge>` report.

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

- "Start" -> call `flywheel_approve_beads` with `action: "start"`
  > **Note:** If the plan was just registered via `flywheel_plan`, the first `flywheel_approve_beads` call may return "Create beads from plan" instructions instead of the quality score. In that case, create beads with `br create`, then call `flywheel_approve_beads` with `action: "start"` a second time to get the quality score and launch.
- "Polish" -> call `flywheel_approve_beads` with `action: "polish"`, then use `br list` to show updated beads, loop
- "Reject" -> call `flywheel_approve_beads` with `action: "reject"`, return to Step 3

If the user asks "what's the quality score?" before choosing to start, call `flywheel_approve_beads` with `action: "start"` immediately — this is the only way to surface the score. Present it, then wait for confirmation before proceeding to implementation.

**Structured error branching (mandatory).** For `flywheel_approve_beads` failures, branch on `result.structuredContent?.data?.error?.code` (typed as `FlywheelErrorCode`) and never parse `error.message` text:

```ts
const code = approveResult.structuredContent?.data?.error?.code;
if (code === "missing_prerequisite") await bootstrapGoalThenRetry();
if (code === "unsupported_action") return returnToStep6Menu();
if (code === "already_closed") return continueToNextBeadOrGate();
```

After calling `flywheel_approve_beads` with `action: "start"`, display **both** the convergence/quality score and a summary table:

**Plan quality score: X.XX / 1.00** (threshold: 0.75 — if below, discuss with user before proceeding)

**Polish red flags** (independent of score — surface these to the user alongside the score when any apply):
- **Oscillation** — polish rounds keep flipping between two approaches. Signal: the taste question is unresolved; pick one, commit the trade-off in the plan, and stop polishing.
- **Expansion** — each round *adds* beads rather than refining existing ones. Signal: scope is unbounded; return to Step 5.6 to re-scope the plan before more bead polish.
- **Low-quality plateau** — score stable at 0.60-0.70 across 3+ rounds. Signal: the plan framing is off; start fresh from Step 3 with a different goal angle.

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Populate **Wave** from the bead's dependency wave assignment, **Effort** from the plan's effort estimate, and **Risk Flags** from any warnings or risk notes in the plan output. This gives the user visibility into what is about to be implemented and in what order.

**Hotspot matrix (I5).** `flywheel_approve_beads(action: "start")` attaches a `hotspotMatrix` field to `structuredContent.data` — the deterministic shared-write analysis from `plan-simulation.ts`. When `matrix.recommendation === "coordinator-serial"` or `matrix.maxContention >= 2`, the tool also emits a `present_choices` nextStep with the 4-option menu described below. Surface the matrix to the user before showing the launch menu:

```
Shared-write hotspot analysis:
  <path-1>          — N bead(s) (<bead-id-list>) — <severity>
  <path-2>          — N bead(s) (<bead-id-list>) — <severity>
  ...
Recommendation: <matrix.recommendation>  (confidence: <matrix.confidence>)
```

Only render rows with `severity` of `med` or `high` (the `low` rows are noise). If the matrix is empty or no row is med/high, skip this block entirely — proceed straight to the regular launch menu.

**When the hotspot matrix recommends `coordinator-serial` or contention is med/high, use the 4-option launch menu** instead of the regular 3-option launch menu below. The `present_choices` nextStep from `approve.ts` already carries the exact option IDs — render them as:

```
AskUserQuestion(questions: [{
  question: "Shared-file contention detected across ready beads. How do you want to launch?",
  header: "Launch mode",
  options: [
    { label: "Coordinator-serial", description: "One bead at a time through the coordinator — contention-safe (Recommended)" },
    { label: "Swarm anyway", description: "Parallel agents — accept contention risk" },
    { label: "Polish beads", description: "Return to Step 6 to refine beads and remove overlap" },
    { label: "Reject", description: "Discard these beads and return to Step 3" }
  ],
  multiSelect: false
}])
```

Route the choice:
- **"Coordinator-serial"** → set `state.launchMode = "coordinator-serial"` (approve.ts records this on the structuredContent data), then proceed to Step 7. Step 7 must spawn ONE agent that iterates through every ready bead sequentially — not N parallel agents. If the user also acted on a `flywheel_approve_beads` choice, the tool's nextStep records `approve-beads-coordinator-serial` as the selected option; use that as the source of truth.
- **"Swarm anyway"** → proceed to Step 7 as normal (N parallel agents). Note in your end-of-turn summary that the user accepted contention risk.
- **"Polish beads"** → call `flywheel_approve_beads` with `action: "polish"` and re-enter Step 6.
- **"Reject"** → call `flywheel_approve_beads` with `action: "reject"` and return to Step 3.

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

- "Polish beads" -> call `flywheel_approve_beads` with `action: "polish"`, return to Step 6.
- "Back to plan" -> return to Step 5.6 plan-ready gate menu.
- "Launch anyway" -> proceed to Step 7 (note the user accepted the risk in your end-of-turn summary).
- "Reject" -> call `flywheel_approve_beads` with `action: "reject"`, return to Step 3.

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

- **"Launch"** -> proceed to Step 7 (read `_implement.md`)
- **"Polish more"** -> call `flywheel_approve_beads` with `action: "polish"`, then return to Step 6
- **"Back to plan"** -> return to the Step 5.6 plan-ready gate menu
