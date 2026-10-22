# Review & Loop — Steps 8, 9, 9.25, 9.4

## Step 8.0: Pick a review mode (for `Fresh-eyes` / `hit-me` wave reviewers)

When spawning wave reviewers (`Fresh-eyes` / `action: "hit-me"` in Step 8 below; skip this prompt when the operator picks **Looks good** or **Self review** in Step 8), choose one mode for the wave from the latest doctor report and `git status --porcelain`:

- Green doctor and clean tree: recommend **Autofix**.
- Yellow doctor: recommend **Report-only**.
- Red doctor or dirty tree: recommend **Interactive**.
- Non-interactive shell or CI: use **Headless** without prompting.

```
AskUserQuestion(questions: [{
  question: "How should this wave's reviewers run? (doctor=<green|yellow|red>, tree=<clean|dirty>)",
  header: "Review mode",
  options: [
    { label: "Autofix", description: "Reviewers apply diffs + commit a fixup per perspective (Recommended on green doctor + clean tree)" },
    { label: "Report-only", description: "Reviewers write docs/reviews/<perspective>-<date>.md and exit; no code edits" },
    { label: "Headless", description: "CI-friendly: reviewers emit JSON-on-stdout; coordinator surfaces exit code per finding count" },
    { label: "Interactive", description: "Current default — AskUserQuestion per finding" }
  ],
  multiSelect: false
}])
```

Pass the mode to every `flywheel_review` `hit-me` call. Autofix downgrades to interactive when its doctor or tree gate fails. Report-only writes `docs/reviews/<beadId>-<perspective>-<YYYY-MM-DD>.md` without code edits. Headless returns exit `0` when clean, `review_headless_findings` with exit `1` when findings exist, and exit `2` on reviewer crash. Interactive asks about each finding. `parallelSafe: true` is advisory and does not bypass the autofix gate.

## Step 8: Review completed beads

Enter Step 8 after every current-wave implementer reports through Agent Mail or is force-stopped through Step 7. Track pending bead IDs locally and remain in the monitor loop until the set is empty. NTM completion does not replace review. Present one consolidated prompt when multiple beads finish together.

### 8.0a — Risky-bead detection (offer Duel review automatically)

Classify a bead as risky when it is P0, changes more than five files, reports partial implementation, has contested provenance, or mentions `security`, `auth`, `crypto`, `secret`, `permission`, `migration`, or `breaking-change`. For risky beads, add **Duel review** as the fourth option. Use security mode for the security-related keywords and reliability mode otherwise. Non-risky beads keep the three standard options.

If a **single bead** finishes, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Bead <id> is done. How would you like to review?",
  header: "Review",
  options: [
    { label: "Looks good", description: "Accept and move on" },
    { label: "Self review", description: "Send the impl agent back to audit its own diff" },
    { label: "Fresh-eyes", description: "5 parallel review agents give independent feedback" }
    // If the bead is risky (per §8.0a), add a 4th option:
    // , { label: "Duel review", description: "2 agents (cc + cod) cross-critique via /dueling-idea-wizards --mode=security|reliability — adversarial signal for high-stakes beads (~20 min)" }
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
- **"Self review `<id>`"** -> keep the original implementer pane alive. Resolve its adjective-noun Agent Mail identity with `list_window_identities` or `ntm --robot-tail`, then send the review request there. If mail has no acknowledgement after 2 minutes, use `ntm --robot-send`; `ntm send` hits a dedup prompt. Wait for the `[review] <id> self-review` report before calling `looks-good`. Closing first advances the gates and can tear down the pane. Use a coordinator-side `git diff` review only when the pane is gone, mail has been silent for more than 10 minutes, and `_implement.md` recovery failed.
- **"Fresh-eyes `<id>`"** -> call `flywheel_review` with `action: "hit-me"`. Prefix every returned reviewer spec with the strict Step 0 Agent Mail `macro_start_session` bootstrap, spawn all five, and collect `docs/reviews/<perspective>-<date>.md` paths through Agent Mail. Nudge a missing reviewer up to three times. Then read its file from disk, falling back to the bead diff when no file exists. Stop reviewers individually because shutdown messages cannot be broadcast.
- **"Duel review `<id>`"** -> write the bead diff to `docs/reviews/<id>-duel-input.diff`, then invoke `/dueling-idea-wizards --mode=<security|reliability> --top=3 --rounds=1 --focus="Review bead <id> diff at <input>" --output=docs/reviews/<id>-duel-report.md`. Pre-flight with `which ntm` and `which claude codex gemini 2>/dev/null`; `which cc` matches `/usr/bin/cc`. If fewer than two agents are healthy, use Fresh-eyes. Consensus issues return to `hit-me`, contested findings go to `AskUserQuestion`, and a clean report calls `looks-good`.

`looks-good` is idempotent for a closed bead, `hit-me` runs a post-close audit, and `skip` returns `already_closed`. Reuse an active implementation team instead of creating a second team.

After resolving every bead in the wave, continue to Step 9.

**Review error codes.** Follow SKILL.md Universal Rule 4. For `flywheel_review` and `flywheel_verify_beads` recovery:

```ts
const code = result.structuredContent?.data?.error?.code;
if (code === "already_closed") return continueToNextBeadOrGate();
if (code === "parse_failure") return runManualVerifyFallback();
if (code === "not_found") return promptForRetryOrPause();
```

## Step 8.5: Codex rescue for reviewer non-convergence

Offer rescue before the third nudge when two reviewers conflict, two reviewers are still missing after Nudge 2, or `hit-me` returned the same `FlywheelErrorCode` on the prior attempt.

When triggered, present the rescue choice via `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Reviewers haven't converged on bead <id> (<error_code>; hint: <hint>). How do you want to proceed?",
  header: "Review stall",
  options: [
    { label: "Retry once more", description: "Re-spawn the missing reviewers OR ask one reviewer to reconcile the conflict directly" },
    { label: "Hand off to Codex (Recommended)", description: "Build a rescue packet from the consolidated review notes + diff and invoke the codex-rescue skill for a tie-breaker" },
    { label: "Abort phase", description: "Accept the bead as-is (looks-good) and document the unresolved review concern in CASS" },
    { label: "Other", description: "Describe a different recovery path" }
  ],
  multiSelect: false
}])
```

For **Hand off to Codex**, call `flywheel_rescue({ cwd, phase: 'review', beadId, errorEnvelope })`, pass `codexPrompt` to `/codex:rescue --wait`, and store `memoryLine` through `flywheel_memory`. Accept calls `looks-good`; a change request returns to `AskUserQuestion`. If rescue stalls, accept the bead and store the unresolved concern in CASS.

### Step 8.6: Guided completion gates

When `flywheel_review` sends `beadId: "__gates__"`, call `hit-me`, perform the returned gate, then call `looks-good` to advance or `hit-me` to repeat. Completion requires five consecutive passed gates; a failure resets the circuit.

### Step 8.7: Converge and cross-agent review

**Converge loop.** For a bead that needs repeated fresh-eyes passes, run one review round, fix its findings, then call `flywheel_review({ cwd, beadId, action: "converge", findingCount: <findings this round> })`. Repeat until the response reports `converged: true`, which happens after two clean rounds in a row (`findingCount: 0`) or after five rounds. Report the real count each round; a round with findings resets the clean streak.

**Cross-agent review.** `flywheel_review({ cwd, beadId, action: "cross-agent" })` returns `data.prompt` for a reviewer from a model family other than the implementer's, named in `data.reviewerFamily`. Send the prompt to a pane of that family by its index. When an earlier review rejected the bead, pass `rejectedReason`: the prompt then names the rejection, and the response adds `data.selfAnnealingRule`, a rule draft to store with `flywheel_memory({ cwd, operation: "store", content: <rule> })` so later cycles can find the mistake.

## Step 9: Loop until complete

**Reconcile the wave first.** Before showing the menu, call `flywheel_verify_beads` with the IDs of beads completed in this wave:

```
flywheel_verify_beads(cwd: <cwd>, beadIds: [<bead-1>, <bead-2>, ...])
```

The tool returns `{verified, autoClosed, unclosedNoCommit, errors}`:
- **`verified`** — beads `br show` confirms as closed. Move on.
- **`autoClosed`** — stragglers that had a matching commit; the tool ran `br update --status closed` for you and synced state. Move on.
- **`unclosedNoCommit`** — beads still open with no matching commit. Present:
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

### Step 9.0a — Compliance audit (default-on wave gate)

When verification has no `unclosedNoCommit` entries or errors, call `flywheel_compliance_audit({ cwd, beadIds: <closed-ids>, mode: "single-bead", threshold: 700 })`.

Branch on `result.structuredContent?.data?.status`:

- `skipped`: show the override and continue.
- `error`: show the reason and continue because the audit error is advisory.
- `ok` with no failures: show the pass count and continue.
- `ok` with failures: show Step 9.0b.

### Step 9.0b — Compliance failure menu

```
AskUserQuestion(questions: [{
  question: "Compliance audit found <N> false-closed bead(s). What now?",
  header: "Compliance",
  options: [
    { label: "Re-implement failed (Recommended)", description: "Reopened beads <ids> - route back to Step 7 with these as the new wave" },
    { label: "Show evidence", description: "Open <passUtc>/REPORT.md, then re-show this menu" },
    { label: "Override + proceed", description: "Stamp `Compliance-Override: <ids>` trailer in wrap-up commit. Beads stay reopened, session continues" },
    { label: "Skip and continue (advisory)", description: "Treat the audit as advisory, ignore the reopens, proceed to wrap-up. Logged but not gated" }
  ],
  multiSelect: false
}])
```

`flywheel_compliance_audit` already reopened every bead in `failed[]`.

### Step 9.0c — Failure menu routing

- **Re-implement failed**: set `activeBeadIds` to the failed IDs and return to Step 7. The beads are already approved.
- **Show evidence**: open `<passUtc>/REPORT.md`, then repeat Step 9.0b.
- **Override + proceed**: store the failed IDs and current time under `checkpoint.compliance`; `_wrapup.md` adds the `Compliance-Override:` trailer.
- **Skip and continue**: leave the reopened beads and checkpoint unchanged, then continue.

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

- **"Continue"** -> return to Step 7.
- **"Check status"** -> show `br list` and `bv --robot-triage`, then run the drift check below.
- **"Pause"** -> run the pause checklist and end the turn.
- **"Wrap up early"** -> continue to Step 9.5 with completed beads only.

#### Come-to-Jesus drift reality-check

After displaying status, check whether the remaining graph still achieves `selectedGoal`:

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

1. Ask each in-flight implementer to shut down. Wait up to 60 seconds, then force-stop any survivor.
2. Retire implementation teammates but keep the coordinator identity active.
3. Confirm that the checkpoint exists and its `gitHead` matches `HEAD`; report a mismatch.
4. Print `Run /start to resume from <phase> with <N> beads remaining.`
5. End with closed, remaining, and blocked counts.

When all beads are complete, run Step 9.25, Step 9.4 when applicable, then load `_wrapup.md` for Steps 9.5 through 12.

## Step 9.25: Test-coverage sweep

List production files changed since the session start and their conventional test files. Mark missing coverage, then ask:

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

- **Create catch-up test beads**: create one bead per missing test and cite the matching testing skill for its domain. Return to Step 7, then repeat Step 9.25.
- Other choices continue to Step 9.4.

## Step 9.4: UI/UX polish pass (optional — only if project has a UI)

Detect React, Vue, Svelte, Next.js, Nuxt, Solid, Flutter, SwiftUI, or Jetpack Compose. Without a UI, load `_wrapup.md` at Step 9.5.

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

**Run polish pass** invokes `/ui-polish`, or the project-local `/ui-ux-polish`, and returns here when gains become marginal. **Light polish only** runs one scrutiny review and asks which of its top five findings to fix. Then load `_wrapup.md` at Step 9.5.
