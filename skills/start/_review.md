# Review & Loop — Steps 8, 9, 9.25, 9.4

## Step 8: Review completed beads

> **Wave-completion gate (MANDATORY).** Before entering this step, wait until **every** impl agent spawned in the current wave has reported back via Agent Mail (or has been force-stopped per Step 7's escalation path). Track the wave's bead IDs in a local set; do NOT enter Step 8 until that set is empty. If you receive an Agent Mail completion notification mid-wave, store the result and stay in Step 7's monitor loop until the rest finish. Reviewing wave-1 while wave-2 is mid-flight produces stale state and per-bead review prompts (which the consolidation rule below explicitly forbids).

> **NTM does NOT bypass this gate.** If impl ran via NTM panes, the coordinator STILL owes the user the `AskUserQuestion` review prompt below — watching a pane print "done" is not review. Fresh-eyes review agents spawn via `Agent()` (they're short-lived and benefit from subagent isolation), NOT via NTM.

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

- **"Looks good" / "Looks good all"** -> call `flywheel_review` with `action: "looks-good"` and `beadId` for each accepted bead.

- **"Self review `<id>`"** -> send the impl agent a message asking it to audit its own diff:
  ```
  SendMessage(to: "impl-<id>", message: "Self-review: run `git diff` on your changes, check for bugs, missing tests, and style issues. Report findings to <coordinator> via Agent Mail with subject '[review] <id> self-review'.")
  ```
  After the self-review report arrives, call `flywheel_review` with `action: "looks-good"` and `beadId` to close it.

- **"Fresh-eyes `<id>`"** -> call `flywheel_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Then:
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

  > **Closed-bead handling:** `flywheel_review` now reconciles the bead state itself — `looks-good` is idempotent (advances to the next bead/gates), `hit-me` runs a post-close audit (payload tagged `postClose: true`), and `skip` returns `already_closed`. No manual workaround needed.

  > **Edge case — team already active:** `TeamCreate` for a review team fails with "already leading a team" if an impl team is still running. Reuse the existing team by passing `team_name: "impl-<goal-slug>"` to the review agents instead of creating a new one.

After review actions are resolved for all beads in this wave, proceed immediately to Step 9. Do NOT end the turn.

## Step 9: Loop until complete

> **Fixed in v2.10.1:** `flywheel_verify_beads` correctly unwraps the `br show --json` array shape via `unwrapBrShowValue()` in `mcp-server/src/beads.ts`. If you see `parse_failure` errors on a current install, you're on v2.9.x or older — rebuild via `cd mcp-server && npm run build`. The fallback procedure below remains valid for older installs and for cases where `br` emits an entirely new shape.
>
> **Manual fallback (only if verify still fails for some IDs):**
>
> 1. For each failing bead ID, run:
>    ```bash
>    br show <bead-id> --json | jq -r '.[0].status'
>    git log --oneline --grep="<bead-id>" -n 5
>    ```
> 2. Classify manually:
>    - `status == "closed"` -> verified, move on.
>    - `status != "closed"` AND commit exists -> straggler; run `br update <bead-id> --status closed` yourself (this is what `autoClosed` would have done).
>    - `status != "closed"` AND no commit -> route into the `unclosedNoCommit` menu below with the bead ID.

**Reconcile the wave first.** Before showing the menu, call `flywheel_verify_beads` with the IDs of beads completed in this wave:

```
flywheel_verify_beads(cwd: <cwd>, beadIds: [<bead-1>, <bead-2>, ...])
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
      { label: "Pause cycle", description: "Stop and let me investigate; resume later via /start" }
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
      { label: "Retry verify", description: "Call flywheel_verify_beads again on the failed IDs (Recommended)" },
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
    { label: "Pause", description: "Stop here — resume later with /start" },
    { label: "Wrap up early", description: "Skip remaining beads and wrap up what's done" }
  ],
  multiSelect: false
}])
```

- **"Continue"** -> return to Step 7 for the next wave of ready beads
- **"Check status"** -> run `br list` + `bv --robot-triage` and display. Then run the **Come-to-Jesus drift reality-check** below before returning to this menu.
- **"Pause"** -> run the pause checklist below, then end the turn
- **"Wrap up early"** -> skip to Step 9.5 with only the completed beads

#### Come-to-Jesus drift reality-check

Busy agents are not the goal — closing the *actual* gap is. After displaying status, ask:

```
AskUserQuestion(questions: [{
  question: "If we intelligently completed every remaining open bead, would '<original selectedGoal>' actually be achieved?",
  header: "Drift",
  options: [
    { label: "Yes, on track", description: "Return to the progress menu and continue" },
    { label: "Missing pieces", description: "New beads needed to close the gap — create them before more impl" },
    { label: "Strategic drift", description: "Remaining beads won't close the gap — invoke /flywheel-drift-check and regress to plan refinement" },
    { label: "Goal has changed", description: "Update selectedGoal via flywheel_select, then re-scope the bead graph" }
  ],
  multiSelect: false
}])
```

- "Yes" -> return to progress menu.
- "Missing pieces" -> `br create` the gap-closers with dependencies wired to the ready frontier, then return to progress menu.
- "Strategic drift" -> invoke `/flywheel-drift-check` for diagnostic output, then call `flywheel_review` with `beadId: "__regress_to_plan__"` to revisit the plan.
- "Goal has changed" -> call `flywheel_select` with the new goal, then return to the progress menu so the user can decide whether to keep or reject current beads.

#### Pause checklist (run in order):

1. **Drain in-flight agents.** For each impl agent still listed in `TaskList` from the current wave: send `SendMessage(to: "<name>", message: {"type": "shutdown_request", "reason": "Session paused"})`. Wait up to 60s for them to exit; force-stop with `TaskStop(task_id: "<id>")` if they hang.
2. **Retire Agent Mail teammates** that won't be needed on resume (impl-* agents). Leave the coordinator session itself active (it's the agent-flywheel's identity and CASS will use it on resume).
3. **Confirm checkpoint is current.** State is checkpointed by every tool call, so this is usually a no-op — but verify `.pi-flywheel/checkpoint.json` exists and `git rev-parse HEAD` matches `checkpoint.gitHead`. If they differ, the user has uncommitted moves; surface that in the summary.
4. **Print resume hint.** One line: `Run /start to resume from <phase> with <N> beads remaining.`
5. **End turn** with a summary of progress so far (beads closed this session, beads remaining, any blockers). Do not call further tools after the summary.

When ALL beads are complete, display a completion message and proceed through the remaining steps in order:

> All <N> beads complete. Proceeding to post-implementation review.
>
> **Remaining steps (MANDATORY — do NOT skip or exit):**
> 1. Step 9.25 — Test-coverage sweep
> 2. Step 9.4 — UI/UX polish pass (if applicable)
> 3. Step 9.5 — Wrap-up (commit, version bump, rebuild)
> 4. Step 10 — Store session learnings to CASS
> 5. Step 11 — Refine skills (optional, user-gated)
> 6. Step 12 — Post-flywheel menu

## Step 9.25: Test-coverage sweep (MANDATORY before wrap-up)

After all beads close, scan changed files for missing test coverage before starting Step 9.5:

1. Determine changed files since session start: `git diff --name-only <session-start-sha>..HEAD`.
2. For each changed production file, check for a sibling/mirror test file (`*.test.ts` / `*_test.go` / `test_*.py` / `*.spec.rs` per stack convention).
3. Build a coverage summary: `<file> -> <test-file or MISSING>`.

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

- "Create catch-up test beads" -> `br create` one bead per MISSING entry with description `Write tests for <file>: unit coverage + edge cases`. Pick the right testing skill per bead based on what the file does:

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
- Everything else -> advance to Step 9.4.

## Step 9.4: UI/UX polish pass (optional — only if project has a UI)

Detect UI: check `package.json` for `react` / `vue` / `svelte` / `next` / `nuxt` / `solid-js`, OR the presence of `.tsx` / `.vue` / `.svelte` files, OR Flutter / SwiftUI / Jetpack Compose signals. If no UI detected, skip to Step 9.5 (read `_wrapup.md`).

If UI detected, present:

```
AskUserQuestion(questions: [{
  question: "Project has UI. Run a polish pass before wrap-up?",
  header: "UI polish",
  options: [
    { label: "Run polish pass", description: "Invoke the 5-step scrutiny -> beads -> implement loop (Recommended for production-bound cycles)" },
    { label: "Skip this cycle", description: "Defer polish — revisit next cycle (Recommended for internal / early-stage work)" },
    { label: "Light polish only", description: "Run scrutiny prompt once, surface top 5 issues, skip beadifying" }
  ],
  multiSelect: false
}])
```

If "Run polish pass" is chosen, invoke `/ui-polish` (Stripe-level iterative polish). If the project-local `/ui-ux-polish` skill is preferred, use that instead. Either runs the canonical 5-step loop: scrutiny -> pick suggestions -> beadify -> implement wave -> repeat 2-3x until improvements are marginal. Come back to Step 9.5 when done.

If "Light polish only" is chosen, spawn one reviewer agent with the scrutiny prompt from `/ui-polish` and present its top 5 findings as an `AskUserQuestion` — user picks which to fix inline vs defer to next cycle.

After this step, proceed to Step 9.5 (read `_wrapup.md`).
