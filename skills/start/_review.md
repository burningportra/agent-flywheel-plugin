# Review & Loop — Steps 8, 9, 9.25, 9.4

## Step 8.0: Pick a review mode (bead `agent-flywheel-plugin-f0j`)

> **Why this exists.** Today review is one-shape — sequential reviewer personas emit suggestions the user must apply manually. The mode matrix dispatches the **same** reviewer agents into four human workflows so the same effort fits four different contexts (shipping a fixup PR vs. asking for advice vs. running unattended in CI vs. teaching a junior).

Before the per-bead consolidated review prompt below, pick how reviewers should run for **this wave**. Resolve the active doctor signal first (cached `lastDoctorReport.checks` from the most recent `flywheel_doctor` run) and `git status --porcelain`:

- **Green doctor + clean tree** -> recommend **Autofix** (the bead `agent-flywheel-plugin-f0j` sweet spot).
- **Yellow doctor or warnings** -> recommend **Report-only** so findings get written to disk without touching code.
- **Red doctor or dirty tree** -> recommend **Interactive** (current default — the user steers each finding).
- **Non-interactive shell / CI run** -> use **Headless** without prompting.

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

Pass the chosen mode into every `flywheel_review` `hit-me` call this wave (`mode: "autofix" | "report-only" | "headless" | "interactive"`). The MCP layer:

- **autofix** — gates on green doctor + clean `git status --porcelain`. If either check fails, the tool downgrades to `interactive` and returns `payload.modeGateWarning` explaining why. Reviewer prompts include "apply fixes + commit" instructions; coordinator MUST NOT `AskUserQuestion` per finding when the gate held.
- **report-only** — reviewers write `docs/reviews/<beadId>-<perspective>-<YYYY-MM-DD>.md` and DO NOT edit code. Coordinator collects file paths via Agent Mail, summarizes them in a single message, then proceeds.
- **headless** — reviewers emit one JSON line per finding (`{ severity, file, line, message }`). Coordinator aggregates counts; if any reviewer's `findings.length > 0`, surface `FlywheelErrorCode` `review_headless_findings` (`exitCode: 1`); on reviewer crash, `exitCode: 2`. Never `AskUserQuestion` in this mode — pass through to the caller's exit handler.
- **interactive** — original behavior (per-finding AskUserQuestion below).

**Optional flag:** `parallelSafe: true` asserts to the coordinator that reviewers won't race on the same files. It's advisory only and does NOT disable the autofix gate.

## Step 8: Review completed beads

> **Wave-completion gate (MANDATORY).** Before entering this step, wait until **every** impl agent spawned in the current wave has reported back via Agent Mail (or has been force-stopped per Step 7's escalation path). Track the wave's bead IDs in a local set; do NOT enter Step 8 until that set is empty. If you receive an Agent Mail completion notification mid-wave, store the result and stay in Step 7's monitor loop until the rest finish. Reviewing wave-1 while wave-2 is mid-flight produces stale state and per-bead review prompts (which the consolidation rule below explicitly forbids).

> **NTM does NOT bypass this gate.** If impl ran via NTM panes, the coordinator STILL owes the user the `AskUserQuestion` review prompt below — watching a pane print "done" is not review. Fresh-eyes review agents spawn via `Agent()` (they're short-lived and benefit from subagent isolation), NOT via NTM.

Once the full wave is in, present a consolidated review prompt. Never ask per-bead if multiple beads finished together.

### 8.0a — Risky-bead detection (offer Duel review automatically)

Before asking the user how to review, classify each just-finished bead. A bead is **risky** if any of:

- `priority === 0` (P0)
- `br show <id>` reports >5 changed files in the bead's working diff
- the bead body or labels mention any of: `security`, `auth`, `crypto`, `secret`, `permission`, `migration`, `breaking-change`
- `state.beadResults[<id>].status === "partial"` (impl agent reported it didn't fully land)
- the bead's `provenance.contested === true` (came from a Duel discovery and was the contested winner the user picked anyway)

For risky beads, the review menu below gains a **Duel review** row that replaces the 5-agent fresh-eyes path with a 2-agent adversarial review via `/dueling-idea-wizards --mode=security` (for security/auth/crypto/secret/permission signals) or `--mode=reliability` (for everything else). Non-risky beads keep the original 3-row menu — running a duel on every bead in a 200-bead project burns budget for no signal.

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

- **"Self review `<id>`"** -> hand the audit back to the same agent that implemented the bead. **DO NOT close, kill, restart, or retire that agent's NTM pane** — the whole point is that the original implementor (with full context) reviews their own diff. Pane teardown happens at wrap-up (Step 9.5 cycle-reset), not here.

  1. Resolve the pane's actual Agent Mail identity. Impl agents spawned via NTM register adjective+noun names (e.g. `CoralDune`), NOT literal `impl-<id>`. Look up the right name:
     ```bash
     # Either map via the bead-to-identity index Agent Mail keeps for the project:
     list_window_identities(project_key: <cwd>)
     # Or tail the pane to read its own announced name:
     ntm --robot-tail="$NTM_PROJECT" --panes=<pane-index> --lines=20
     ```
  2. Send the self-review request to that resolved name (NOT `impl-<id>`):
     ```
     SendMessage(to: "<resolved-agent-name>", message: "Self-review for bead <id>: run `git diff` on your worktree, check for bugs, missing tests, and style issues. Report findings to <coordinator> via Agent Mail with subject '[review] <id> self-review'. Stay in your pane — do not exit.")
     ```
  3. If Agent Mail delivery to a live pane is unreliable (no inbox ack within 2 min), nudge directly into the pane via NTM (use `--robot-send`, NOT `ntm send`):
     ```bash
     ntm --robot-send="$NTM_PROJECT" --panes=<pane-index> --msg="Self-review for bead <id>: ... (same body as above)"
     ```
  4. Wait for the `[review] <id> self-review` Agent Mail report. Only AFTER it arrives, call `flywheel_review` with `action: "looks-good"` and `beadId` to close the bead. Do NOT close the bead before the report; doing so causes the gates to auto-advance and may trigger downstream pane teardown before review actually happened.
  5. If the pane has genuinely died or been recycled (verified via `ntm --robot-is-working` returning `gone` AND no Agent Mail traffic for >10 min AND not recoverable via the stuck-pane ladder in `_implement.md`), fall back to a coordinator-side `git diff` review of that bead's files only — do NOT spawn fresh reviewer agents and do NOT touch other panes.

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

- **"Duel review `<id>`"** (only offered for risky beads per §8.0a) -> invoke `/dueling-idea-wizards` against the bead's diff:
  1. Resolve the bead's primary signal class:
     - security/auth/crypto/secret/permission keyword in body or labels → `--mode=security`
     - everything else risky → `--mode=reliability`
  2. Stage the bead's diff into a review-input file the duel agents can study:
     ```bash
     mkdir -p docs/reviews
     git diff <pre-bead-sha>..HEAD -- $(br show <id> --files) > docs/reviews/<id>-duel-input.diff
     ```
  3. Invoke the duel skill with the bead context as focus:
     ```
     /dueling-idea-wizards --mode=<security|reliability> \
       --top=3 --rounds=1 \
       --focus="Review bead <id> diff at docs/reviews/<id>-duel-input.diff for <signal>" \
       --output=docs/reviews/<id>-duel-report.md
     ```
  4. Pre-flight: `which ntm` + `which claude codex gemini 2>/dev/null` (the real binaries behind the `cc/cod/gmi` ntm pane types — do NOT `which cc` literally; it matches `/usr/bin/cc`) must yield ntm + ≥2 agents. On failure, fall back to Fresh-eyes (5-agent) automatically and emit `Duel review downgraded to Fresh-eyes — <reason>`.
  5. After the report lands at `docs/reviews/<id>-duel-report.md`, read it and route on its **consensus** verdicts only:
     - **Consensus issues** (both agents flagged) → block the bead with `flywheel_review action: "hit-me"` and prepend the consensus issue list to the per-bead review notes.
     - **Contested findings** (one agent flagged, the other defended) → surface via `AskUserQuestion` with the two arguments side-by-side; the user arbitrates. Do NOT auto-block on contested findings.
     - **No findings** → call `flywheel_review action: "looks-good"` for the bead.
  6. Why this is cheaper than 5-agent: 2 agents adversarially cross-checked beats 5 agents independently brainstorming when the question is "is THIS specific bead safe to ship?". Duel review is targeted, not exploratory.

  > **Closed-bead handling:** `flywheel_review` now reconciles the bead state itself — `looks-good` is idempotent (advances to the next bead/gates), `hit-me` runs a post-close audit (payload tagged `postClose: true`), and `skip` returns `already_closed`. No manual workaround needed.

  > **Edge case — team already active:** `TeamCreate` for a review team fails with "already leading a team" if an impl team is still running. Reuse the existing team by passing `team_name: "impl-<goal-slug>"` to the review agents instead of creating a new one.

After review actions are resolved for all beads in this wave, proceed immediately to Step 9. Do NOT end the turn.

**Structured error branching (mandatory).** For `flywheel_review` and `flywheel_verify_beads`, branch on `result.structuredContent?.data?.error?.code` (a `FlywheelErrorCode`) rather than matching error strings:

```ts
const code = result.structuredContent?.data?.error?.code;
if (code === "already_closed") return continueToNextBeadOrGate();
if (code === "parse_failure") return runManualVerifyFallback();
if (code === "not_found") return promptForRetryOrPause();
```

## Step 8.5: Codex-rescue handoff on reviewer non-convergence (per bead `agent-flywheel-plugin-1qn`)

> **Why this exists.** Fresh-eyes reviewers occasionally produce contradictory verdicts (one demands a refactor, another demands the opposite) or two of the five reviewers fail to deliver after all three nudges. The coordinator either has to pick a winner with insufficient evidence or cascade more reviewers — both bad. A targeted Codex rescue with the consolidated review artifact is faster and produces a single tie-breaking opinion. Source: bead `agent-flywheel-plugin-1qn`.
>
> **Trigger condition (N-1 rule for review).** Fire BEFORE the third reviewer-nudge cycle, not after. Concrete signals:
>
> - Two of the five reviewers have **conflicting** verdicts on the same change (e.g. one says "split this commit", another says "merge with the prior bead") AND the coordinator cannot reconcile from `git diff` alone.
> - At least 2 of the 5 reviewers failed to deliver findings after Nudge 2, **or**
> - A `flywheel_review` `hit-me` call returned the same `FlywheelErrorCode` on the immediately prior attempt and the next attempt would be the second retry.

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

**On "Hand off to Codex"** — assemble the artifact, build the packet, dispatch via the codex-prompt adapter (consumer-only — do NOT edit `mcp-server/src/adapters/codex-prompt.ts`):

```ts
import { buildRescuePacket, renderRescuePromptForCodex, formatRescueEventForMemory }
  from '../mcp-server/dist/codex-handoff.js';

// 1. Concatenate every available review file + the bead's full diff.
//    Whatever reviewers actually delivered, plus git diff, is the artifact.
const artifactPath = `.pi-flywheel/rescue/review-${beadId}-${Date.now()}.md`;
const consolidated = [
  '# Review artifact for Codex tie-breaker',
  ...reviewFilesOnDisk.map((p) => `\n## ${p}\n\n${fs.readFileSync(p, 'utf8')}`),
  `\n## git diff\n\n\`\`\`diff\n${await execStr('git', ['diff', baseSha, 'HEAD'])}\n\`\`\``,
].join('\n');
fs.writeFileSync(artifactPath, consolidated);

const packet = buildRescuePacket({
  phase: 'review',
  goal: `Reconcile reviewer disagreement on bead ${beadId}`,
  artifact_path: artifactPath,
  error_code: lastError.code,
  hint: lastError.hint ?? '',             // VERBATIM from bead 478 hint contract
  recent_tool_calls: state.recentToolCalls.slice(-10),
  proposed_next_step: 'Read the consolidated review notes; deliver one verdict (accept / request change) with a one-paragraph rationale and any blocking concerns.',
});

const adapted = renderRescuePromptForCodex(packet, {
  coordinatorName: '<your-agent-mail-name>',
  projectKey: process.env.NTM_PROJECT,
  rescueAgentName: '<adjective+noun from agent-names pool>',
});

// 2. Dispatch /codex:rescue --wait so the rescue blocks Step 9 progression.
//    Codex panes need 2 trailing newlines (AdaptedPrompt.trailingNewlines).
```

**Persist the rescue event to CASS** for the doctor's `rescues_last_30d` synthesis row:

```
flywheel_memory(operation: "store", content: formatRescueEventForMemory(packet))
```

**On Codex completion:**

- Treat Codex's verdict as one more reviewer voice — but **weighted** as a tie-breaker. If Codex says "accept", call `flywheel_review` with `action: "looks-good"`. If Codex says "request change", surface the blocking concerns via `AskUserQuestion` so the user picks the next move (re-open the bead vs. accept with a follow-up bead).
- If Codex itself stalls, fall back to "Abort phase" — accept the bead and write a CASS entry capturing the unresolved disagreement so future sessions can revisit.

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
