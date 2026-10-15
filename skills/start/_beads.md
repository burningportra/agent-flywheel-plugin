# Bead Creation & Approval — Steps 5.5, 6

> ## br CLI command reference (use EXACTLY these flags — the CLI silently accepts unknown flags and returns empty JSON)
>
> | Operation | Correct form | Common wrong form |
> |-----------|--------------|-------------------|
> | Create bead | `br create --title "…" --description "…" --priority 2 --type task` | `--issue-type` (silently ignored — use `-t`/`--type`) |
> | Add dependency | `br dep add <downstream> <upstream>` (positional) | `--depends-on` (does not exist) |
> | Close bead with reason | `br close <id> --reason "…"` or `br close <id> -r "…"` | `br update <id> --close-reason "…"` (does not exist) |
> | Mark status closed | `br update <id> --status closed` | `br update <id> --status done` (status enum is `open`/`deferred`/`in_progress`/`closed`) |
> | List open beads | `br list` (default) or `br list --json` | — |
> | List closed beads | `br list --status closed --json` | `br list \| grep closed` (default view excludes closed) |
> | Show one bead | `br show <id> --json \| jq '.[0]'` (wraps in array) | `br show <id>` parsed as single object (will fail — output is an array) |
>
> **Hard rule**: if `br` returns empty JSON or exits 0 with no visible effect, you likely used a flag that doesn't exist. Re-run with `--help` to verify before retrying.
>
> **Tend-cycle note**: `br list` (no flags) shows only `open` and `in_progress`. To check this cycle's completion count, use `br list --status closed --json`. Common false-alarm pattern: orchestrator sees commits but `br list` shows 0 closed → assumes implementer is committing without closing → wastes a tend cycle on a phantom problem.

## Step 5.5: Create beads from the plan

Beads are **NOT** auto-created by `flywheel_plan`. The coordinator must create them manually from the plan output:

1. For each task/unit-of-work in the plan, create a bead:
   ```
   br create --title "Verb phrase" --description "WHAT/WHY/HOW" --priority 2 --type task
   ```

   **Provenance block (MANDATORY when source is a duel).** If `state.planSource === "duel"` (set by `flywheel_plan mode="duel"`) OR the source idea's `provenance.source === "duel"` / `"reality-check-duel"` (set by `flywheel_discover` from a duel run), append a `## Provenance` section to every bead's `--description` payload. This is the highest-leverage, lowest-cost piece of the high-stakes track — every downstream agent (implementer, reviewer, swarm) inherits the adversarial context for free. Template:

   ```markdown
   ## Provenance
   - **Source:** dueling-wizards (mode=<ideas|architecture|security|reliability>, run=<ISO timestamp>)
   - **Agent scores:** cc=<0-1000>, cod=<0-1000>, gmi=<0-1000 or n/a>
   - **Strongest surviving critique:** "<one-line critique from the opponent's reveal-phase that the originator did NOT successfully defend against>"
   - **Steelman summary:** "<one-line steelman from Phase 6.75 if it ran; omit the line if no steelman phase>"
   - **Contested:** <true|false> — true means the agents disagreed >300 pts on cross-score; the user explicitly accepted the contested winner.
   ```

   Pull the values from `idea.provenance` (discovery) or the parsed `DUELING_WIZARDS_REPORT.md` synthesis (plan). Read the matching Consensus winners, Contested decisions, and Steelman entries; never invent scores.

2. **Auto-generate test beads:** If a bead's acceptance criteria include testing requirements (unit tests, e2e tests, integration tests), create a companion test bead that depends on the implementation bead:
   ```
   br create --title "Test: <impl bead title>" --description "Write tests for <bead-id>: <specific test requirements from acceptance criteria>" --priority 2 --type task
   br dep add <test-bead-id> <impl-bead-id>
   ```

3. After all beads are created, add dependency edges with the positional form in the command table: downstream first, upstream second.

4. Verify with `br list` — confirm all beads and dependencies look correct.

> **WARNING:** Use `br list` for all read-only bead inspection. Never call `flywheel_approve_beads` just to preview beads — it is NOT read-only and advances internal state counters regardless of the action used.

5. Proceed to Step 6. Do not parse the plan or rescan bead text here: the approval response returns the canonical coverage and duplicate audit in `structuredContent.data.creationAudit`.

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

If the user asks for the quality score before choosing, call `flywheel_approve_beads(action="start")`; it is the only response that includes the launch score. Still require the launch-confirmation gate below before dispatching Step 7.

**Approval error codes.** Follow SKILL.md Universal Rule 4. For `flywheel_approve_beads` recovery:

```ts
const code = approveResult.structuredContent?.data?.error?.code;
if (code === "missing_prerequisite") await bootstrapGoalThenRetry();
if (code === "unsupported_action") return returnToStep6Menu();
if (code === "already_closed") return continueToNextBeadOrGate();
```

When a successful bead-approval response includes `structuredContent.data.creationAudit`, resolve it before following `nextStep`:

1. **Coverage.** Report `planCoverage.coveredSections / planCoverage.totalSections`, plus the headings in `uncoveredSections` and `weakMappings`. If either list is non-empty, use `AskUserQuestion` with **Create catch-up beads (Recommended)**, **Sections out of scope**, and **Proceed as-is**. Create one catch-up bead per missing section, or append the deferred headings to the plan, then call `flywheel_approve_beads(action="polish")` to refresh the audit. If `planCoverage` is `null`, say that the plan document was unavailable; never invent coverage.
2. **Duplicates.** Report each `duplicateCandidates` pair with its `reasons`, `sharedFiles`, and suggested `canonicalBeadId`. If any exist, use `AskUserQuestion` with **Merge all**, **Review per-pair**, and **Keep separate**. A merge extends the canonical description with `br update`, carries dependencies with `br dep add`, and closes the duplicate with `br close <duplicate-id> --reason "merged into <canonical>"`; then refresh via `action="polish"`. If the array is empty, proceed without a dedup question.

Do not recompute either audit from plan headings, titles, descriptions, or file lists. The server owns those heuristics.

After calling `flywheel_approve_beads` with `action: "start"`, display **both** the convergence/quality score and a summary table:

**Plan quality score: X.XX / 1.00** (threshold: 0.75 — if below, route the next step through `AskUserQuestion` per Universal Rule 1, with options to polish, reject-and-replan, or proceed despite the low score)

**Polish red flags** (independent of score — surface these to the user alongside the score when any apply):
- **Oscillation** — polish rounds keep flipping between two approaches. Signal: the taste question is unresolved; pick one, commit the trade-off in the plan, and stop polishing.
- **Expansion** — each round *adds* beads rather than refining existing ones. Signal: scope is unbounded; return to Step 5.6 to re-scope the plan before more bead polish.
- **Low-quality plateau** — score stable at 0.60-0.70 across 3+ rounds. Signal: the plan framing is off; start fresh from Step 3 with a different goal angle.

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Populate **Wave** from the bead's dependency wave assignment, **Effort** from the plan's effort estimate, and **Risk Flags** from any warnings or risk notes in the plan output. This gives the user visibility into what is about to be implemented and in what order.

**Hotspot matrix (I5).** `flywheel_approve_beads(action: "start")` attaches the deterministic shared-write analysis at `structuredContent.data.matrix`. Render only `med` and `high` rows, then show its recommendation and confidence. Skip the block when no such rows exist.

```
Shared-write hotspot analysis:
  <path-1>          — N bead(s) (<bead-id-list>) — <severity>
  <path-2>          — N bead(s) (<bead-id-list>) — <severity>
  ...
Recommendation: <matrix.recommendation>  (confidence: <matrix.confidence>)
```

**Server-owned choices.** When `structuredContent.nextStep.type === "present_choices"`, pass its `message` and `options` to `AskUserQuestion` verbatim, preserving every option `id`, `label`, `tool`, and `args`. Invoke the selected option's `tool` with its `args`; do not reconstruct the hotspot or refinement menu in prose. A hotspot `present_choices` response is the launch-confirmation gate, so do not add another launch menu.

When the response has no `present_choices`, branch on `data.quality.score` for the second mandatory gate:

- **Low quality (`score < 0.75`).** Ask with header **Low quality** and options **Polish beads (Recommended)**, **Back to plan**, **Launch anyway**, and **Reject**. Polish calls `action="polish"`; Back to plan returns to Step 5.6; Launch proceeds to Step 7 and records the accepted risk; Reject calls `action="reject"` and returns to Step 3.
- **Acceptable quality (`score >= 0.75`).** Ask with header **Launch** and options **Launch (Recommended)**, **Polish more**, and **Back to plan**. Launch proceeds to Step 7 and reads `_implement.md`; Polish calls `action="polish"`; Back to plan returns to Step 5.6.

> **Cosmetic-lint exception**: if ≥ 50% of the weak-bead reasons are lint cosmetic flags (e.g., "title not a verb phrase" on wave-prefix beads like `R1:`, `T13:`, `D12:`), surface them to the user as "cosmetic only" in `<weak-bead-summary>` and pre-recommend "Launch anyway". Title-format lint on wave-prefix beads is a known false-positive — do not force a polish round over it. Reserve polish rounds for substantive weakness (vague acceptance criteria, missing WHY, oversized scope).
