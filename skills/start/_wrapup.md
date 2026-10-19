# Wrap-up and post-flywheel: Steps 9.45, 9.5, 10, 11, 12

When `_offload.md` moved the swarm to another Mac, call `flywheel_swarm_host({ cwd, action: "release" })` first, so the alignment check, grading, and commit review read the swarm's final work. If its last pull fails, show the message and hint, fix it, and release again.

## Step 9.45: Check alignment before wrap-up

Skip this gate when fewer than three beads closed or this session already recorded a `reality-check-<date>` entry. Otherwise ask:

```
AskUserQuestion(questions: [{
  question: "Before wrap-up: gap-check the implementation against the original goal '<state.selectedGoal>'?",
  header: "Gap check",
  options: [
    { label: "Skip — looks aligned", description: "Proceed directly to Step 9.5 wrap-up (Recommended if scope was tight and reviews already converged)" },
    { label: "Quick check", description: "Read AGENTS.md + README.md, scan the closed beads, surface any obvious aspirational-vs-real divergence inline (no new beads)" },
    { label: "Full reality-check pass", description: "Read skills/start/_reality_check.md and run the depth-selection menu — gap report, optionally convert to beads, optionally re-launch swarm" }
  ],
  multiSelect: false
}])
```

- **"Skip — looks aligned"** → proceed to Step 9.5.
- **"Quick check"** → compare AGENTS.md, README.md, and this session's closed beads against `selectedGoal`, summarize any gap, then ask:
  ```
  AskUserQuestion(questions: [{
    question: "Quick check done. Proceed to wrap-up or escalate?",
    header: "Decision",
    options: [
      { label: "Proceed to wrap-up", description: "Findings are minor or out-of-scope — wrap up as-is" },
      { label: "Escalate to full pass", description: "Run skills/start/_reality_check.md before wrapping" },
      { label: "Create beads now", description: "Open new beads for the divergences via br create, do NOT close this session yet" }
    ],
    multiSelect: false
  }])
  ```
- **"Full reality-check pass"** → load `skills/start/_reality_check.md`, run its depth menu, then repeat Step 9.45.

## Step 9.5.0: Grade the outcome before wrap-up

Call `flywheel_grade_outcome({ cwd })` before the Step 9.5 question.

Print `result.content[0].text` verbatim once. The server text owns the verdict summary, failing-criteria table, persistence status, grader fallback notice, diff-truncation notice, and failed-verdict explanation. Use `structuredContent` only for the decisions below.

Follow SKILL.md Universal Rule 4 for every error envelope in this phase.
Use `AskUserQuestion` for every verdict or recovery choice.

- `grading_skipped`: continue to Step 9.5.
- A verdict kind: use its in-memory `data.verdict`, including when persistence failed.
- `satisfied`: continue to Step 9.5.
- `needs_revision` below the cap: ask `Verdict` with `Iterate`, `Accept anyway`, and `Abort`.
- `max_iterations_reached`, or an uncoerced revision at the cap: ask `Verdict` with `Accept anyway` and `Abort` only.
- `failed`: show an `Abort` choice and the server explanation. Retry only after editing `rubric.md`, with `force: true`.
- `grader_timeout`, `grader_unavailable`, or `verdict_invalid`: ask `Recover` with `Retry grading`, `Accept without grade`, and `Abort`; include `error.hint`.

On `Iterate`, call `flywheel_approve_beads(action: "remediate")` once per non-met rubric criterion, passing the criterion ID, full rubric description, status, evidence, gaps, plan slug, and verdict iteration. Then return to Step 6.

## Step 9.5: Wrap-up — commit, version bump, rebuild

Once all beads are reviewed and closed, use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "All beads done. How should I wrap up?",
  header: "Wrap-up",
  options: [
    { label: "Full wrap-up", description: "Review commits, update docs, version bump, rebuild (Recommended)" },
    { label: "Commit only", description: "Just commit and push — skip docs and version bump" },
    { label: "Skip wrap-up", description: "Leave everything as-is — I'll handle it manually" }
  ],
  multiSelect: false
}])
```

- **"Full wrap-up"** -> run all seven substeps.
- **"Commit only"** -> run substeps 1, 3, and 7, then continue to Step 10.
- **"Skip wrap-up"** -> continue to Step 10.

### 1. Review bead commits
Show this session's bead commits with `git log --oneline`. When two or more touch one subsystem, ask:

```
AskUserQuestion(questions: [{
  question: "<N> bead commits touch <subsystem> (<sha-list>). Squash into one?",
  header: "Squash",
  options: [
    { label: "Squash", description: "Combine into one commit with message: '<proposed message>'" },
    { label: "Keep separate", description: "Leave each bead as its own commit (Recommended for traceability)" },
    { label: "Pick subset", description: "Specify which SHAs to squash in Other" }
  ],
  multiSelect: false
}])
```

Run `git rebase -i` only after **Squash** or **Pick subset**.

### 2. Update documentation
Update only affected sections in `AGENTS.md`, `README.md`, and `CHANGELOG.md`. Keep the architecture, testing, constraints, models, and release notes aligned with what shipped.

Invoke `/docs-de-slopify` once on the changed user-facing docs before committing. Technical docs such as AGENTS.md and internal specs are exempt.

If the project ships a changelog, invoke `/changelog-md-workmanship`.

### 3. Commit any stray tracked/untracked files
Check `git status`. When files remain, propose commit groups:

```
AskUserQuestion(questions: [{
  question: "Found <N> uncommitted files: <short list>. How should I commit them?",
  header: "Stray files",
  options: [
    { label: "Use proposed groups", description: "<list the proposed group->files mapping in this option's description>" },
    { label: "One commit", description: "Bundle everything into a single chore: commit" },
    { label: "Skip stray files", description: "Leave them uncommitted; user will handle" },
    { label: "Custom split", description: "Specify the grouping in Other" }
  ],
  multiSelect: false
}])
```

Group plan artifacts, skill changes, and configuration changes separately. If `checkpoint.compliance.overrides` is non-empty, append `Compliance-Override: <comma-separated bead IDs>` to every wrap-up and version commit.

Never commit `.env`, credentials, or files matching `*-secret-*` even on "Use proposed groups" — re-prompt and exclude.

### 4. Version bump
Ask for the semantic version bump:

```
AskUserQuestion(questions: [{
  question: "What version bump for this release?",
  header: "Version",
  options: [
    { label: "Patch (x.x.X)", description: "Bug fixes, doc-only changes, stale comment cleanup" },
    { label: "Minor (x.X.0)", description: "New features or modules" },
    { label: "Major (X.0.0)", description: "Breaking API or schema changes" },
    { label: "Skip", description: "No version bump needed" }
  ],
  multiSelect: false
}])
```

Unless the user picks **Skip**, update `mcp-server/package.json`.

### 5. Rebuild
Run `npm run build` in `mcp-server/`. For cross-platform binaries when GitHub Actions is unavailable, invoke `/dsr`.

### 6. Commit the version bump
Commit the version file as `chore: bump version to X.Y.Z: <summary>`.

### 7. Show final log
Show `git log --oneline -10`, then continue to Step 10.

## Step 10.0: Draft the post-mortem

Call `flywheel_memory({ cwd, operation: "draft_postmortem" })` and inspect its draft:

```ts
const res = await flywheel_memory({ cwd, operation: "draft_postmortem" });
const draftMarkdown = res.structuredContent?.data?.draft?.markdown;
const warnings = res.structuredContent?.data?.draft?.warnings ?? [];
```

`warnings.includes("postmortem_empty_session")` means the draft has no shippable commits; rebuild it from `git log --since="<session-start-time>" --oneline` before asking. `warnings.includes("postmortem_checkpoint_stale")` means the draft used a fallback git range. Both are successful degraded drafts, so show the warning with the partial draft. Apply Universal Rule 4 only to an error envelope.

Present to the user:

```
AskUserQuestion(questions: [{
  question: "Session post-mortem draft ready. What next?",
  header: "Post-mortem",
  options: [
    { label: "Store to CASS", description: "Persist this draft as a learning via flywheel_memory operation=store (Recommended)" },
    { label: "Edit first", description: "Print the draft; I'll edit then store" },
    { label: "Skip", description: "Discard draft for this session" }
  ],
  multiSelect: false
}])
```

- **"Store to CASS"** → call `flywheel_memory({ cwd, operation: "store", content: draftMarkdown })`, retain the result as `storeResult`, then continue.
- **"Edit first"** → print the draft and repeat this question with the edited content.
- **"Skip"** → set `storeResult = null` and continue without persistence. The draft is never auto-committed.

## Step 10: Store session learnings

Reuse `storeResult` from Step 10.0; do not call `store` again. A null result skips durable storage and Step 10.55. For an error envelope, apply Universal Rule 4 and these recoveries:

```ts
const code = storeResult.structuredContent?.data?.error?.code;
if (code === "cli_failure") return retryOnceWithBackoff();
if (code === "parse_failure") return requestManualSummaryFallback();
if (code === "blocked_state") return surfaceHintAndPause(storeResult.structuredContent?.data?.error?.hint);
```

After an unrecovered error, set `storeResult = null`.

## Step 10.5: Continue to the durable solution doc

No orchestrator tool exposes `flushTelemetry`, so this phase has no telemetry action. Continue to Step 10.55.

## Step 10.55: Durable solution doc

Run this step only when `storeResult` succeeded. Capture `entryId` from the final non-empty line of `storeResult.content[0].text`, then draft the document:

```ts
const draftRes = await flywheel_memory({
  cwd,
  operation: "draft_solution_doc",
  entryId,
});
const doc = draftRes.structuredContent?.data?.doc;
const rendered = draftRes.structuredContent?.data?.rendered;
```

For `invalid_input`, derive `entryId` once more from the store text and retry. Skip the write for any other error. `doc.path` is a validated path under `docs/solutions/`. Create its parent directory first because Write fails when the parent is missing, then use the native tool:

```
Write({
  file_path: <absolute path = repoRoot + "/" + doc.path>,
  content: rendered,
})
```

Optionally commit `docs/solutions/` unless Step 9.5 skipped wrap-up. Keep the frontmatter `entry_id` immutable; it joins the file to CASS.

## Step 11: Refine this skill

If `storeResult` is null, continue to Step 12. Otherwise use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Session learnings saved. One more step?",
  header: "Improve",
  options: [
    { label: "Refine skills", description: "Improve the flywheel skill based on this session's evidence" },
    { label: "Skip to finish", description: "Done — go straight to the final menu" }
  ],
  multiSelect: false
}])
```

- **"Refine skills"** -> run `/flywheel-refine-skill start`, then continue to Step 12.
- **"Skip to finish"** -> continue to Step 12.

## Step 12: Post-flywheel menu

After all steps complete, present a follow-up menu using `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Orchestration complete. What would you like to do next?",
  header: "Next action",
  options: [
    { label: "Run another cycle", description: "Start a new flywheel session with a fresh goal" },
    { label: "Audit the codebase", description: "Run /flywheel-audit to scan for bugs, security issues, and test gaps" },
    { label: "Check drift", description: "Run /flywheel-drift-check to verify code matches the plan" },
    { label: "Done for now", description: "End the session — no further action needed" }
  ],
  multiSelect: false
}])
```

Actions:
- **"Run another cycle"** -> run the cycle-reset checklist below, then return to Step 2.
- **"Audit the codebase"** -> invoke `/flywheel-audit`
- **"Check drift"** -> invoke `/flywheel-drift-check`
- **"Done for now"** -> end gracefully with a summary of what shipped

#### Cycle-reset checklist (run in order before re-entering Step 2):

1. **Delete the checkpoint:** `rm -f .pi-flywheel/checkpoint.json` (Bash). Without this, the next cycle inherits the prior `selectedGoal` / `activeBeadIds` / `phase` and the new "Resume session" drift check fires unnecessarily.
2. **Verify no impl agents remain.** Run `TaskList`; if any impl-* tasks are still listed, retire and force-stop them per the Step 9 pause checklist before continuing.
3. **Drain active teams.** List the teams created by this session. Add an older team only after `TaskList` and the live agent state confirm that nothing owns it. If the list is non-empty, run `sh "$CLAUDE_PLUGIN_ROOT/mcp-server/scripts/team-drain.sh" <team-name>...`. The script prepares only those configs and prints one team name per line. Call `TeamDelete` for each printed name, then verify that none of the named teams remains under `~/.claude/teams/`.
4. **Confirm clean tree:** run `git status -s`. If uncommitted changes exist, present:
   ```
   AskUserQuestion(questions: [{
     question: "Working tree has <N> uncommitted change(s): <short list>. How should I proceed?",
     header: "Dirty tree",
     options: [
       { label: "Proceed anyway", description: "Step 2's profiler will see the dirty state — that's fine for discovery" },
       { label: "Stash first", description: "Run git stash, proceed, then remind me to pop later" },
       { label: "Cancel cycle", description: "Stop here so I can commit or revert manually" }
     ],
     multiSelect: false
   }])
   ```
   Route per choice; never silently proceed past a dirty tree without acknowledgment.
5. Proceed to Step 2.

> **"Done for now" also triggers team-drain.** Run sub-step 3 before returning control to the user.
