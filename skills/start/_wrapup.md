# Wrap-up & Post-Flywheel — Steps 9.5, 10, 11, 12

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

**De-slopify all user-facing docs before committing.** README / CHANGELOG / public-facing docs must strip these AI-tell signatures:

- Emdash overuse (use commas / periods / semicolons instead).
- "It's not X, it's Y" contrast structure.
- "Here's why" / "Here's the thing" clickbait leads.
- "Let's dive in" / "buckle up" forced enthusiasm.
- "At its core..." / "fundamentally..." pseudo-profound openers.
- "It's worth noting..." / "it's important to remember..." unnecessary hedges.
- "Game-changer" / "powerful" / "seamless" / "robust" filler adjectives.
- Three-item list tricolons in every paragraph.

Invoke `/docs-de-slopify` on the changed doc files — it runs the canonical de-slop sweep. Technical docs (AGENTS.md, internal specs) are exempt — the rule targets user-facing prose.

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

## Step 10: Store session learnings

`flywheel_memory(operation: "store")` is the default path and wraps CASS under the hood. If the `cm` CLI is available and you want richer procedural memory semantics (tags, hierarchies, retrieval ranking), invoke `/cass-memory` directly instead — same underlying store, more control over how the learning is categorized.

For mining *prior* sessions (not storing new ones), invoke `/cass` — it ranks past prompts, decisions, and patterns beyond what `flywheel_memory search` surfaces.

Call `flywheel_memory` with `operation: "store"` and `cwd` to distill and persist session learnings:
- What worked well (tool choices, agent configurations, planning strategies)
- What failed or required manual intervention (agent shutdowns, file conflicts, review bottlenecks)
- Key decisions made during this session and their outcomes
- Any patterns worth replicating or avoiding in future sessions

**Structured error branching (mandatory).** For wrap-up tool failures (including `flywheel_memory`), route using `result.structuredContent?.data?.error?.code` (`FlywheelErrorCode`) instead of string matching on error text:

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
3. **Drain active teams (MANDATORY — prevents team leaks across sessions).** For each team this session created in `~/.claude/teams/`:
   ```bash
   # Trim team config to team-lead only (in-process agents don't respond to shutdown_request)
   jq '.members = [.members[] | select(.name == "team-lead")]' \
     ~/.claude/teams/<team-name>/config.json \
     > ~/.claude/teams/<team-name>/config.json.tmp \
     && mv ~/.claude/teams/<team-name>/config.json.tmp \
        ~/.claude/teams/<team-name>/config.json
   ```
   Then call `TeamDelete` for each. Verify `ls ~/.claude/teams/` returns no teams from this session. **Prior sessions' orphaned teams should also be swept here — `coolant-solver`-style leaks accumulate otherwise.**
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

> **"Done for now" also triggers team-drain.** Step 12's "Done for now" end-state should run the same team-drain as sub-step 3 above before returning control to the user — otherwise teams leak across Claude Code sessions (the runtime does NOT gc them on session exit).
