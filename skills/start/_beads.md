# Bead creation and approval: Steps 5.5 and 6

> ## `br` command reference
>
> | Operation | Correct form | Common wrong form |
> |-----------|--------------|-------------------|
> | Create bead | `br create --title "..." --description "..." --priority <0-4> --type task` | `--issue-type` (use `-t` or `--type`) |
> | Add dependency | `br dep add <downstream> <upstream>` (positional) | `--depends-on` (does not exist) |
> | Close bead with reason | `br close <id> --reason "..."` | `br update <id> --close-reason "..."` (does not exist) |
> | Update status | `br update <id> --status <open\|in_progress\|deferred\|closed>` | `br update <id> --status done` (`done` is not a status) |
> | List open beads | `br list` (default) or `br list --json` | — |
> | List closed beads | `br list --status closed --json` | `br list \| grep closed` (default view excludes closed) |
> | Show one bead | `br show <id> --json \| jq '.[0]'` (wraps in array) | `br show <id>` parsed as single object (will fail — output is an array) |
>
> If a command exits successfully without changing state, verify its syntax with `br <subcommand> --help` before retrying.

## Step 5.5: Create beads from the plan

`flywheel_plan` registers the plan but does not create beads. Create one focused bead per unit of work:

1. Create the implementation bead.
   ```
   br create --title "Verb phrase" --description "WHAT/WHY/HOW" --priority 2 --type task
   ```

   For `state.planSource === "duel"` or idea provenance `duel` / `reality-check-duel`, append this section to every description:

   ```markdown
   ## Provenance
   - **Source:** dueling-wizards (mode=<ideas|architecture|security|reliability>, run=<ISO timestamp>)
   - **Agent scores:** cc=<0-1000>, cod=<0-1000>, gmi=<0-1000 or n/a>
   - **Strongest surviving critique:** "<one line>"
   - **Steelman summary:** "<one line; omit if Phase 6.75 did not run>"
   - **Contested:** <true|false>
   ```

   Copy values only from `idea.provenance` or the matching Consensus, Contested, and Steelman entries in `DUELING_WIZARDS_REPORT.md`.

2. When the acceptance criteria require automated tests, create a companion test bead that depends on the implementation bead.
   ```
   br create --title "Test: <impl bead title>" --description "Write tests for <bead-id>: <specific test requirements from acceptance criteria>" --priority 2 --type task
   br dep add <test-bead-id> <impl-bead-id>
   ```

3. Add dependency edges downstream-first, verify the graph with `br list`, then continue to Step 6. Use `br list` for previews because `flywheel_approve_beads` mutates state.

The approval response supplies the canonical coverage and duplicate audit in `structuredContent.data.creationAudit`; do not recompute them here.

## Step 6: Review and approve beads

Run both user gates: bead approval, then launch confirmation. Wait for **Launch** from the second gate before calling `TeamCreate`, `Agent`, or any Step 7 tool.

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

- **Start implementing** → run the swarm-host gate in `_offload.md` (`flywheel_get_skill({ name: "agent-flywheel:start_offload" })`), then call `flywheel_approve_beads({ action: "start", coordinatorName: "<current Agent Mail name>" })`. If it returns bead-creation instructions instead of a score, create the beads and repeat the same call.
- **Polish further** → call `action: "polish"`, show the updated `br list`, and repeat this gate.
- **Reject** → call `action: "reject"` and return to Step 3.

Only `action: "start"` returns the launch score. A score request may call it early, but still ends at the launch-confirmation gate.

**Approval error codes.** Follow SKILL.md Universal Rule 4. For `flywheel_approve_beads` recovery:

```ts
const code = approveResult.structuredContent?.data?.error?.code;
if (code === "missing_prerequisite") await bootstrapGoalThenRetry();
if (code === "unsupported_action") return returnToStep6Menu();
if (code === "already_closed") return continueToNextBeadOrGate();
```

When a successful bead-approval response includes `structuredContent.data.creationAudit`, resolve it before following `nextStep`:

1. **Coverage.** Report the covered/total count, `uncoveredSections`, and `weakMappings`. For gaps, ask **Create catch-up beads (Recommended)**, **Sections out of scope**, or **Proceed as-is**. Create or defer the selected sections, then refresh with `action: "polish"`. A `null` report means the plan was unavailable.
2. **Duplicates.** For each candidate, report its reasons, shared files, and `canonicalBeadId`, then ask **Merge all**, **Review per-pair**, or **Keep separate**. A merge updates the canonical description and dependencies, then closes the duplicate with reason `merged into <canonical>` before refreshing with `action: "polish"`. Skip this question when the candidate list is empty.

Treat the server results as authoritative instead of rescanning plan or bead text.

After `action: "start"`, show `Plan quality score: X.XX / 1.00` (threshold 0.75) and this table:

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Fill Wave from dependency assignment, Effort from the plan estimate, and Risk Flags from plan warnings. Also flag oscillation, expanding scope, or a 0.60–0.70 score plateau lasting three or more rounds; resolve the choice, rescope at Step 5.6, or restart at Step 3 respectively.

Render only `med` and `high` rows from `structuredContent.data.matrix`, followed by its recommendation and confidence. Omit an empty matrix.

When `structuredContent.nextStep.type === "present_choices"`, pass its message and options to `AskUserQuestion` verbatim, preserving each `id`, `label`, `tool`, and `args`, then invoke the selected tool. That response is the launch-confirmation gate, so present it once.

When the response has no `present_choices`, branch on `data.quality.score` for the second mandatory gate:

- **Low quality (`score < 0.75`).** Ask **Polish beads (Recommended)**, **Back to plan**, **Launch anyway**, or **Reject** under header **Low quality**. Route to `action: "polish"`, Step 5.6, Step 7 with accepted risk, or `action: "reject"` and Step 3.
- **Acceptable quality (`score >= 0.75`).** Ask **Launch (Recommended)**, **Polish more**, or **Back to plan** under header **Launch**. Route to Step 7 and `_implement.md`, `action: "polish"`, or Step 5.6.

When at least half of the weak-bead reasons are title-format flags on wave prefixes such as `R1:`, mark them cosmetic and recommend **Launch anyway**. Reserve polishing for substantive weakness such as vague criteria, missing rationale, or oversized scope.
