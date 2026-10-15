# Wrap-up & Post-Flywheel — Steps 9.45, 9.5, 10, 11, 12

## Step 9.45: Pre-wrap reality-check gate (new in v3.6.5)

Before declaring the cycle done, offer a strategic alignment check. Beads can technically close while the *aggregate* of the work drifts from the original goal — this gate is a one-question speed bump that catches it.

**Skip this step entirely** if:
- Fewer than 3 beads were closed this session (not enough surface area to drift), OR
- A reality-check pass was already run during this session (look for it in checkpoint history or recent CASS entries tagged `reality-check-<date>`).

Otherwise, surface:

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
- **"Quick check"** → `Read` AGENTS.md + README.md (root), then `br list --json` to enumerate this session's closed beads. Compare in your head: does the closed-beads body cover the goal end-to-end? Surface any divergence as a one-paragraph note. Then surface a follow-up:
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
- **"Full reality-check pass"** → read `skills/start/_reality_check.md` and execute its depth-selection flow. After Phase 1 + (optionally) Phase 2 complete, return here and re-show the original Step 9.45 menu — the user may now pick "Skip" with confidence.

The gate is one round-trip on the happy path (the user picks "Skip" and proceeds). It's a guardrail against the silent failure mode where every bead closes but the project still doesn't deliver.

## Step 9.5.0: Outcome grading (MANDATORY — fires before the wrap-up question)

> **Hard rule**: Run this gate before the existing Step 9.5 wrap-up question. The verdict drives whether the cycle proceeds to commit review (`satisfied`), iterates back to implementation (`needs_revision` + Iterate), or stops here (`failed` / `max_iterations_reached` + Abort). Skipping this gate means the cycle ships without ever validating against the rubric the operator approved at Step 5.6.5.

### 1. Call the grader

```
flywheel_grade_outcome({ cwd })
```

Print `result.content[0].text` verbatim once. The server text owns the verdict summary, failing-criteria table, persistence status, grader fallback notice, diff-truncation notice, and failed-verdict explanation. Use `structuredContent` only for the decisions below.

### 2. Branch on `result.structuredContent.data`

Follow SKILL.md Universal Rule 4 for every error envelope in this phase.

- `kind: "grading_skipped"` → continue to Step 9.5 without a question.
- `kind: "grader_verdict" | "grading_capped" | "grading_persistence_failed"` → bind `data.verdict` as `verdict`, then branch on `verdict.status` below. The in-memory verdict remains authoritative when persistence failed.
- Error envelope → use the recovery question below.

Branch on `verdict.status`:

- **`satisfied`** → continue to the existing Step 9.5 wrap-up question. The cycle met the rubric.
- **`needs_revision` below the iteration cap** → call `AskUserQuestion` with header `Verdict` and the counts from the tool result. Offer `Iterate` (create remediation beads and return to implementation, recommended), `Accept anyway` (continue with the verdict recorded), and `Abort` (stop before commit review).
- **`max_iterations_reached`** → call the same `Verdict` question with only `Accept anyway` and `Abort`. Never offer `Iterate`. Treat an uncoerced `needs_revision` at the cap the same way.
- **`failed`** → call a one-option `Verdict` question with `Abort`. The tool text already explains the failure; tell the operator to edit `rubric.md` and retry `flywheel_grade_outcome({ force: true })`.

#### 2c — Error envelope (`code: "grader_timeout" | "grader_unavailable" | "verdict_invalid"`) → recovery question

Call `AskUserQuestion` with header `Recover`. Offer `Retry grading` (recommended), `Accept without grade`, and `Abort`. Use `data.error.hint` as the question context for `grader_unavailable` and `verdict_invalid`.

### 3. On "Iterate" — create remediation beads and route back to Step 6

For each `verdict.perCriterion` entry where `c.status !== 'met'`, read its full description from `.pi-flywheel/plans/<slug>/rubric.md`, then call once:

```
flywheel_approve_beads({
  cwd,
  action: "remediate",
  remediation: {
    planSlug: "<slug>",
    iteration: verdict.iteration,
    criterionId: c.criterionId,
    criterionDescription: "<looked-up from rubric.md>",
    status: c.status,
    evidence: c.evidence,
    gaps: c.gaps,
  }
})
```

Create one bead per failing criterion, not per gap. After all calls, return to Step 6. The tool increments `state.iterationRound`, and the server enforces the iteration cap on the next wrap-up pass.

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

- **"Full wrap-up"** -> run all sub-steps below
- **"Commit only"** -> run sub-steps 1, 3, 7 only (review commits, commit strays, show log), then skip to Step 10
- **"Skip wrap-up"** -> skip to Step 10

### 1. Review bead commits
Run `git log --oneline` to show the bead commits from this session. If two or more touch the same subsystem, propose squashing them via:

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

Only run `git rebase -i` if the user picks Squash or Pick subset. Default-keep is safe.

### 2. Update documentation
Before committing anything, update these files to reflect what shipped:

- **`AGENTS.md`** — update the Hard Constraints, Testing, and any module-level guidance that changed (e.g. new logger convention, new test runner, new CLI tools). Sub-agents read this; stale guidance causes bugs.
- **`README.md`** — update the architecture map (add/remove files), key design decisions (document new patterns), and the models table if routing changed.
- **`CHANGELOG.md`** (if present) — append the shipped version's entry.

Only update sections that are actually affected by this session's changes. Do not rewrite unchanged sections.

Invoke `/docs-de-slopify` once on the changed user-facing docs before committing. Technical docs such as AGENTS.md and internal specs are exempt.

**CHANGELOG rebuild** — if `CHANGELOG.md` exists or the project is published, invoke `/changelog-md-workmanship` to rebuild the changelog from git tags, issues, and PR titles. This is cleaner than manually appending and catches commits that were missed.

### 3. Commit any stray tracked/untracked files
Check `git status` for uncommitted files (plan docs, skill updates, config changes). If any exist, propose groupings via:

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

Default proposed groups (use these to populate the first option's description):
- Plan artifacts -> `docs: add session plan artifact for <goal>`
- Skills added/updated -> `feat(skills): ...`
- Config or gitignore changes -> `chore: ...`

**Compliance override trailer.** Before creating any wrap-up commit in this sub-step or in the version-bump sub-step, check `state.checkpoint.compliance?.overrides?.length`. If it is greater than 0, append a `Compliance-Override:` trailer to the commit message:

```bash
COMPLIANCE_OVERRIDE="$(echo '<comma-separated overrides>' | tr -d '\n')"
git commit -m "$(cat <<EOF
<existing message body>

Compliance-Override: $COMPLIANCE_OVERRIDE
EOF
)"
```

This creates a permanent audit trail. Every overridden compliance failure is searchable via `git log --grep='Compliance-Override:'`.

Never commit `.env`, credentials, or files matching `*-secret-*` even on "Use proposed groups" — re-prompt and exclude.

### 4. Version bump
Determine the correct semver bump based on what shipped and use `AskUserQuestion`:

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

Update `mcp-server/package.json` version field unless "Skip" was chosen.

### 5. Rebuild
Run `npm run build` in `mcp-server/` to compile the bumped version into `dist/`. If the project publishes cross-platform binaries and GitHub Actions is throttled or unavailable, invoke `/dsr` (Doodlestein Self-Releaser) as a fallback to produce local release artifacts.

### 6. Commit the version bump
```
git add mcp-server/package.json
git commit -m "chore: bump version to X.Y.Z — <one-line summary of what shipped>"
```

### 7. Show final log
`git log --oneline -10` so the user can see the clean commit stack.

After wrap-up completes, proceed immediately to Step 10. Do NOT end the turn or exit the workflow — session learnings and the post-flywheel menu are still required.

## Step 10.0: Post-mortem draft (new in v3.4.0)

Before asking the user to store learnings, synthesize a draft from the session's mechanical artifacts (checkpoint, git log, inbox, error-code telemetry) and let them review it.

Call `flywheel_memory` with `operation: "draft_postmortem"` and `cwd`. The tool returns `structuredContent.data.draft` with a `markdown` field — a session-learnings entry synthesized by `draftPostmortem()` in `episodic-memory.ts`:

```ts
const res = await flywheel_memory({ cwd, operation: "draft_postmortem" });
const draftMarkdown = res.structuredContent?.data?.draft?.markdown;
const warnings = res.structuredContent?.data?.draft?.warnings ?? [];
```

**Post-mortem degraded cases.** These are successful drafts, not error envelopes. Branch on `warnings`:
- `warnings.includes("postmortem_empty_session")` → proceed with the AskUserQuestion below and note that the session had no shippable commits. **Common cause (verified 2026-05-08)**: this cycle SHIPPED a state-capture feature at a session-boundary point (e.g. `cycleStartSha` capture in `flywheel_select`), but the capture wasn't yet implemented when this cycle's `flywheel_select` was called — so the auto-postmortem can't see this cycle's commits. Hand-write the post-mortem from `git log --since="<session-start-time>" --oneline` instead. The next cycle will work correctly.
- `warnings.includes("postmortem_checkpoint_stale")` → `sessionStartSha` no longer resolves in `git log`. Surface the warning and the partial `draftMarkdown` so the user can decide whether to keep it.

If the tool returns an actual error envelope, apply Universal Rule 4. Skip Step 10.0 for codes without a local recovery and proceed to Step 10.

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

- **"Store to CASS"** → call `flywheel_memory` with `operation: "store"` and `content: draftMarkdown`. Then proceed to Step 10.
- **"Edit first"** → print the draft verbatim. After the user edits (they paste the revised text in their next message or the "Other" field), loop this AskUserQuestion with the new content.
- **"Skip"** → discard the draft. Note in the end-of-turn summary that post-mortem was skipped. Proceed to Step 10. **Never auto-commit the draft — invariant P-3.**

## Step 10: Store session learnings

`flywheel_memory(operation: "store")` is the default path and wraps CASS under the hood. If the `cm` CLI is available and you want richer procedural memory semantics (tags, hierarchies, retrieval ranking), invoke `/cass-memory` directly instead — same underlying store, more control over how the learning is categorized.

For mining *prior* sessions (not storing new ones), invoke `/cass` — it ranks past prompts, decisions, and patterns beyond what `flywheel_memory search` surfaces.

Call `flywheel_memory` with `operation: "store"` and `cwd` to distill and persist session learnings:
- What worked well (tool choices, agent configurations, planning strategies)
- What failed or required manual intervention (agent shutdowns, file conflicts, review bottlenecks)
- Key decisions made during this session and their outcomes
- Any patterns worth replicating or avoiding in future sessions

**Memory-store error codes.**

```ts
const code = memoryResult.structuredContent?.data?.error?.code;
if (code === "cli_failure") return retryOnceWithBackoff();
if (code === "parse_failure") return requestManualSummaryFallback();
if (code === "blocked_state") return surfaceHintAndPause(memoryResult.structuredContent?.data?.error?.hint);
```

Present the stored learnings to the user, then use `AskUserQuestion`:

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

- **"Refine skills"** -> proceed to Step 11, then Step 12
- **"Skip to finish"** -> proceed to Step 12

After the user responds, continue to the next step. Do NOT end the turn or exit the workflow.

## Step 10.5: Telemetry flush (new in v3.4.0)

Before leaving the wrap-up phase, persist the in-memory error-code counts accumulated during this session. Call `flushTelemetry({ cwd })` from `mcp-server/src/telemetry.ts`. The function atomically writes `.pi-flywheel/error-counts.json` (top-20 codes + last-100 ring buffer) and mirrors the summary into `checkpoint.errorCodeTelemetry` for backward-compat.

This runs even when the rest of wrap-up errored — it is tolerant of I/O failures (silent degrade on write lock contention). If `flushTelemetry` rejects, log the error but do not surface it to the user; the next session's Step 0c trend block will simply show a gap.

## Step 10.55: Durable solution doc (new in bead 71x)

CASS entries are opaque — only queryable through `cm`. Write a sibling markdown file under `docs/solutions/` so future sessions (and humans, and `rg`) can grep for the same learning without the CASS daemon.

**Skip this step entirely** if Step 10.0 was skipped OR the user picked "Skip" at Step 10.0's "Store to CASS" prompt — there is no CASS `entry_id` to pair against, so there is nothing to reconcile. Only run when Step 10 successfully executed `flywheel_memory` with `operation: "store"` and returned an entry id.

### 1. Capture the CASS entry id

The `operation: "store"` response from Step 10 surfaces the new entry id in either `structuredContent.data.entryId` or the trailing line of the text output (`Memory stored successfully.\n\n<id>`). Capture it as `entryId` — it is required for the next call.

### 2. Draft the SolutionDoc

```ts
const draftRes = await flywheel_memory({
  cwd,
  operation: "draft_solution_doc",
  entryId, // captured in step 1
});
const doc = draftRes.structuredContent?.data?.doc;          // SolutionDoc object
const rendered = draftRes.structuredContent?.data?.rendered; // full markdown w/ frontmatter
```

**SolutionDoc error codes.**
- `invalid_input` → `entryId` was missing or empty. Re-derive it from Step 10's response, then retry once. If still missing, skip the rest of Step 10.55.
- any other code → log the error and skip the file write; do not block on solution-doc capture.

### 3. Write the file

`doc.path` is repo-relative and matches `docs/solutions/<category>/<slug>-YYYY-MM-DD.md` (Zod-validated server-side). The category is one of `build | test | runtime | tooling | coordination | docs | refactor | general`, picked heuristically from the goal + touched files.

Use the native **Write** tool (NOT `Bash` heredoc, NOT `ctx_execute`):

```
Write({
  file_path: <absolute path = repoRoot + "/" + doc.path>,
  content: rendered,
})
```

If the parent directory does not exist, run `mkdir -p docs/solutions/<category>` via Bash first — Write will fail on a missing parent.

### 4. Stage and commit (optional but recommended)

`git add docs/solutions/ && git commit -m "docs(solutions): capture <slug> learning"` — keeps the doc in the same wrap-up stack as the post-mortem. Skip the commit if the user chose "Skip wrap-up" at Step 9.5.

### Reconciliation contract

The frontmatter `entry_id` field is the **join key** between docs/solutions/ and CASS. Downstream sweepers (e.g. the parallel bead `bve` `/flywheel-compound-refresh` tool) use `rg 'entry_id: "<id>"' docs/solutions/` to find the markdown sibling for any CASS row, and inversely `cm show <id>` to verify the CASS entry still exists. Never edit `entry_id` after the file is written — treat it as immutable.

## Step 11: Refine this skill

Run `/flywheel-refine-skill start` to improve this skill based on evidence from the current session. This closes the flywheel loop — each session makes the next one better.

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
