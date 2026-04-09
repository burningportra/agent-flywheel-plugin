## Proposed Changes to commands/orchestrate.md

### Change 1: Fix bead preview — never use orch_approve_beads for read-only preview

**Location:** Step 6 (Review and approve beads), lines 107-118
**Issue:** BUG 1 — Calling `orch_approve_beads` with `action: "polish"` to preview beads advances internal state counters. It is NOT read-only. By the time `action: "start"` is called, beads are already partially closed and `activeBeadIds` is never properly set. The skill must use `br list` to preview beads.

**BEFORE:**
```markdown
## Step 6: Review and approve beads

The plan creates beads (tasks) in the bead tracker. Show the beads list. Ask:

> "Here are the implementation beads. What would you like to do?
> 1. **Start implementing** — launch the implementation loop
> 2. **Polish further** — refine the beads more
> 3. **Reject** — start over with a different goal"

- "Start" → call `orch_approve_beads` with `action: "start"`
- "Polish" → call `orch_approve_beads` with `action: "polish"`, show updated beads, loop
- "Reject" → call `orch_approve_beads` with `action: "reject"`, return to Step 3
```

**AFTER:**
```markdown
## Step 6: Review and approve beads

After planning, beads must be created manually. Use `br list` to display the current beads. If no beads exist yet, see Step 5.5 below for the creation sequence.

> "Here are the implementation beads. What would you like to do?
> 1. **Start implementing** — launch the implementation loop
> 2. **Polish further** — refine the beads more
> 3. **Reject** — start over with a different goal"

- "Start" → call `orch_approve_beads` with `action: "start"`
- "Polish" → call `orch_approve_beads` with `action: "polish"`, then use `br list` to show updated beads, loop
- "Reject" → call `orch_approve_beads` with `action: "reject"`, return to Step 3

> **WARNING:** Never call `orch_approve_beads` with `action: "polish"` just to preview beads — `polish` advances internal state counters and is NOT read-only. Always use `br list` for read-only bead inspection.
```

---

### Change 2: Display convergence/quality score after orch_approve_beads start

**Location:** Step 6, lines 120-125 (bead summary table section)
**Issue:** BUG 2 — After `orch_approve_beads` with `action: "start"`, the skill says to display a bead summary table but does NOT instruct the coordinator to display the convergence score returned by the tool. Users expect to see a quality score before agents are launched.

**BEFORE:**
```markdown
After calling `orch_approve_beads` with `action: "start"`, display a summary table of approved beads including:

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Populate **Wave** from the bead's dependency wave assignment, **Effort** from the plan's effort estimate, and **Risk Flags** from any warnings or risk notes in the plan output. This gives the user visibility into what is about to be implemented and in what order.
```

**AFTER:**
```markdown
After calling `orch_approve_beads` with `action: "start"`, display **both** the convergence/quality score returned by the tool AND a summary table of approved beads:

1. **Convergence score** — extract and display the `convergenceScore` (or equivalent quality metric) from the `orch_approve_beads` response. Present it prominently, e.g.:
   > **Plan quality score: 0.82 / 1.00**

2. **Bead summary table:**

| Bead ID | Title | Wave | Effort | Risk Flags |
|---------|-------|------|--------|------------|

Populate **Wave** from the bead's dependency wave assignment, **Effort** from the plan's effort estimate, and **Risk Flags** from any warnings or risk notes in the plan output. This gives the user visibility into what is about to be implemented and in what order.

Wait for user confirmation before proceeding to Step 7 — the quality score may prompt them to polish further instead.
```

---

### Change 3: Handle already-closed beads in orch_review

**Location:** Step 8 (Review completed beads), lines 196-231
**Issue:** BUG 3 — When `orch_review` with `action: "hit-me"` is called for beads that were already marked closed by impl agents, it errors with "Cannot read properties of undefined (reading 'split')". The skill needs guidance for this edge case.

**BEFORE:**
```markdown
- **"Fresh-eyes `<id>`"** → call `orch_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Then:
  1. Create a review team: `TeamCreate(team_name: "review-<bead-id>")`
  2. Spawn all 5 with `run_in_background: true`, each with `team_name` set and the strict STEP 0 Agent Mail bootstrap in their prompt
  3. If any go idle without reporting, nudge by name: `SendMessage(to: "<reviewer-name>", message: "Please send your review findings.")`
  4. Shutdown each reviewer individually after collecting results — do NOT broadcast structured messages to `"*"`
  5. Collect and summarize results.
```

**AFTER:**
```markdown
- **"Fresh-eyes `<id>`"** → call `orch_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Then:
  1. Create a review team: `TeamCreate(team_name: "review-<bead-id>")`
  2. Spawn all 5 with `run_in_background: true`, each with `team_name` set and the strict STEP 0 Agent Mail bootstrap in their prompt
  3. If any go idle without reporting, nudge by name: `SendMessage(to: "<reviewer-name>", message: "Please send your review findings.")`
  4. Shutdown each reviewer individually after collecting results — do NOT broadcast structured messages to `"*"`
  5. Collect and summarize results.

  > **Edge case — already-closed beads:** If `orch_review` with `action: "hit-me"` fails (e.g. "Cannot read properties of undefined"), the bead was likely already closed by the impl agent before review was requested. In this case, skip the MCP tool and spawn review agents manually. Give each reviewer the specific git commit SHA (from `git log --oneline`) and instruct them to review via `git diff <commit>~1 <commit>` instead of relying on the bead tracker state.
```

---

### Change 4: Add explicit bead creation sequence

**Location:** Between Step 5 and Step 6 (new Step 5.5)
**Issue:** BUG 4 — The skill says "The plan creates beads (tasks) in the bead tracker" but beads do NOT auto-create from the plan. The coordinator must create them manually with `br create` + `br dep add`. The exact sequence needs to be documented.

**BEFORE (line 107-109):**
```markdown
## Step 6: Review and approve beads

The plan creates beads (tasks) in the bead tracker. Show the beads list. Ask:
```

**AFTER:**
```markdown
## Step 5.5: Create beads from the plan

Beads are NOT auto-created by `orch_plan`. The coordinator must create them manually from the plan output:

1. For each task/unit-of-work in the plan, create a bead:
   ```
   br create "<bead-title>" --desc "<description and acceptance criteria>"
   ```

2. After all beads are created, add dependency edges between them:
   ```
   br dep add <downstream-bead-id> <upstream-bead-id>
   ```
   This ensures beads are implemented in the correct wave order.

3. Verify the bead graph: `br list` to confirm all beads and dependencies look correct.

## Step 6: Review and approve beads

Use `br list` to display the current beads. Ask:
```

---

### Change 5: Fix impl agent template — use --status closed, not done

**Location:** Step 7, impl agent prompt template (line 175-180 area)
**Issue:** BUG 5 — The skill's impl agent template says `br update <id> --status done` but the actual br CLI uses `--status closed`. The template has the wrong status value.

**BEFORE (within the impl agent prompt, Step 3 area):**
```markdown
       ## STEP 3 — COMMIT
       Create a commit with a descriptive message referencing bead <id>.
```

**AFTER:**
```markdown
       ## STEP 3 — COMMIT & CLOSE BEAD
       Create a commit with a descriptive message referencing bead <id>.
       Then mark the bead as closed: `br update <id> --status closed`
       (Note: the br CLI uses `closed`, NOT `done`.)
```

---

### Change 6: Handle team reuse conflict between planning and implementation

**Location:** Step 7, line 131-135 (TeamCreate for implementation)
**Issue:** BUG 6 — The skill says to create a new team `TeamCreate(team_name: "impl-<goal-slug>")`, but if the deep-plan team is still active, TeamCreate may fail. The skill should explicitly clean up the planning team before creating the impl team, or reuse it.

**BEFORE:**
```markdown
1. Create a named implementation team if multiple beads are parallelizable:
   ```
   TeamCreate(team_name: "impl-<goal-slug>")
   ```
```

**AFTER:**
```markdown
1. Create a named implementation team if multiple beads are parallelizable:
   ```
   TeamCreate(team_name: "impl-<goal-slug>")
   ```
   > **NOTE:** If a planning team (e.g. `"deep-plan-<slug>"`) is still active from Step 5, you must delete it first via `TeamDelete(team_name: "deep-plan-<slug>")` before creating the impl team. If `TeamDelete` fails because agents are still registered, retire all planning agents via Agent Mail `retire_agent` first, then retry `TeamDelete`. Alternatively, reuse the existing team by renaming its purpose — but this is less clean.
```
