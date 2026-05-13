# Tutorial bead — first-run guided tour

> **When to fire.** Only invoked from Step 0d when `IS_FIRST_RUN === true` AND the user picked "Take the 5-min tour". Never run on a returning repo — the bead-detection logic in `mcp-server/src/first-run.ts` (T5.1) gates this.

This skill walks a brand-new operator through `scan → plan → bead → implement → commit` end-to-end against a real (but trivial) goal so they see the full loop fire once with their own hands.

## Step 1 — Welcome + consent

Print:

> "Welcome to agent-flywheel! 5-min tour. I'll run a real micro-bead end-to-end so you can see the loop. Goal: 'Add a CHANGELOG entry for today'. **This WILL commit to your repo.**"

Then:

```
AskUserQuestion(questions: [{
  question: "Run the tutorial bead now?",
  header: "Tour",
  options: [
    { label: "Continue (Recommended)", description: "5 phases, ~3 min, real commit on this branch" },
    { label: "Skip — go to regular menu", description: "Jump to Step 0d main menu without the tour" }
  ],
  multiSelect: false
}])
```

Route the choice:

- **Continue** → proceed to Step 2.
- **Skip** → return to `skills/start/SKILL.md` Step 0d (do NOT print the tour glossary line; the operator chose to bypass).

## Step 2 — Phase 1/5: PROFILE

Announce in one sentence:

> "Step 1/5: PROFILE — scan your repo for languages, frameworks, and structure. About 30 seconds."

Call `flywheel_profile({ cwd })`. Render exactly 3 lines of key findings (no more) so the operator sees the scope of the profile without a wall of text:

```
Languages: <top 3 by file count>
Frameworks: <top 3 detected, or "(none detected)">
Files: <total tracked file count>
```

## Step 3 — Phase 2/5: PLAN

Announce:

> "Step 2/5: PLAN — generate a tiny one-section plan describing what we're about to do."

Write `docs/plans/<YYYY-MM-DD>-tutorial.md` with this content (substitute today's date):

```markdown
# Tutorial plan

## Add a CHANGELOG entry for today

- Modify CHANGELOG.md (create if missing) with one line: `YYYY-MM-DD: First flywheel run`
- Acceptance: line present at top of CHANGELOG.md under the appropriate version header
```

Then call `flywheel_plan({ planFile: 'docs/plans/<YYYY-MM-DD>-tutorial.md', source: 'tutorial' })` so the plan flows through the same gate as a real plan.

## Step 4 — Phase 3/5: BEAD

Announce:

> "Step 3/5: BEAD — plans turn into beads. One bead for this tour."

Call `flywheel_approve_beads({ action: 'start' })`. Creates exactly one bead via `br create` and captures the returned bead id as `TUTORIAL_BEAD_ID`. Confirm the count is `1` before continuing — if more than one bead was created, abort the tour and print:

> "Unexpected: tutorial plan produced more than one bead. Aborting tour to avoid committing extra work. Run `br list --status open` to inspect."

## Step 5 — Phase 4/5: IMPLEMENT

Announce:

> "Step 4/5: IMPLEMENT — do the work. We'll edit inline this time (real swarms parallelize across agents)."

Use the `Edit` (or `Write`) tool against `CHANGELOG.md`:

- **If CHANGELOG.md exists**: prepend `## <YYYY-MM-DD>\n- First flywheel run (tutorial)\n\n` to the top of the file.
- **If not**: create it with `# CHANGELOG\n\n## <YYYY-MM-DD>\n- First flywheel run (tutorial)\n`.

Mark the bead done:

```bash
br update <TUTORIAL_BEAD_ID> --status closed --note "tutorial bead"
```

## Step 6 — Phase 5/5: COMMIT

Announce:

> "Step 5/5: COMMIT — close the loop. This is the only step that touches your git history."

Run via Bash (single commit, no `--amend`, no push):

```bash
git add CHANGELOG.md docs/plans/<YYYY-MM-DD>-tutorial.md
git commit -m "docs: tutorial bead (first flywheel run)"
```

Capture the short SHA for the wrap-up message.

## Step 7 — Wrap-up

Print:

> "Done! ✓ You just ran **scan → plan → bead → implement → commit**. That's the flywheel.
>
> Commit: `<short-sha>` on the current branch. Bead `<TUTORIAL_BEAD_ID>` is closed.
>
> Glossary: bead=atomic task · plan=grouped beads · flywheel=full loop · NTM=tmux multi-agent · agent-mail=inter-agent inbox · MCP=Model Context Protocol
>
> Next: run `/agent-flywheel:start` anytime to enter the regular menu — or run `/agent-flywheel:flywheel-doctor` to verify everything is wired up."

Then offer the rollback gate below.

## Step 7b — Rollback option (T5.4)

```
AskUserQuestion(questions: [{
  question: "Tour complete. Keep the CHANGELOG entry + commit, or roll back?",
  header: "Cleanup",
  options: [
    { label: "Keep (Recommended)", description: "Leave CHANGELOG.md and the commit; real work, ship it" },
    { label: "Roll back",          description: "Reverse the tutorial commit, remove CHANGELOG entry, delete the tutorial plan + bead — repo back to pre-tour state" },
    { label: "Keep CHANGELOG, drop plan/bead", description: "Preserve the CHANGELOG addition but remove docs/plans/<date>-tutorial.md and the tutorial bead row, then amend the commit message" }
  ],
  multiSelect: false
}])
```

Route the choice:

- **Keep** → no-op. Jump to `skills/start/SKILL.md` Step 0d main menu (the operator now sees the regular menu with the tutorial commit on `HEAD`).
- **Roll back** → in a single Bash block (atomic on success, abort on first non-zero):
  ```bash
  git reset --soft HEAD~ \
    && git restore --staged CHANGELOG.md docs/plans/<YYYY-MM-DD>-tutorial.md \
    && git checkout HEAD -- CHANGELOG.md 2>/dev/null || rm -f CHANGELOG.md \
    && rm -f docs/plans/<YYYY-MM-DD>-tutorial.md \
    && br delete <TUTORIAL_BEAD_ID>
  ```
  If `CHANGELOG.md` existed before the tutorial (we prepended), `git checkout HEAD -- CHANGELOG.md` restores the pre-tour content; if it didn't exist, the file is removed entirely. Then jump to Step 0d.
- **Keep CHANGELOG, drop plan/bead** → amend the commit to keep only the CHANGELOG change:
  ```bash
  git reset --soft HEAD~ \
    && git restore --staged docs/plans/<YYYY-MM-DD>-tutorial.md \
    && rm -f docs/plans/<YYYY-MM-DD>-tutorial.md \
    && br delete <TUTORIAL_BEAD_ID> \
    && git add CHANGELOG.md \
    && git commit -m "docs: CHANGELOG entry (post-tutorial cleanup)"
  ```
  Then jump to Step 0d.

All three routes leave the working tree in a clean, well-defined state — every command above runs only against artifacts the tutorial just created (the CHANGELOG diff, the dated plan file, the single tutorial bead), so a rollback cannot accidentally clobber a parallel agent's work.

## Failure handling

If any of the 5 phases throws, stop immediately and print:

> "Tutorial paused at Phase <N>/5 (<phase-name>): <error.message>
>
> Try: <error.tryThis or 'see /flywheel-doctor'>
>
> Nothing has been committed yet. Re-run `/agent-flywheel:start` to resume from the regular menu."

Do NOT attempt to recover — the tutorial's job is to demonstrate the happy path. Real recovery flows live in `/flywheel-doctor` and `/flywheel-setup`.
