---
name: flywheel-duel
description: Run a state-aware /dueling-idea-wizards duel inside the flywheel. Routes artifacts into discovery, plan, or review pipelines based on the current phase. Use when the user invokes /flywheel-duel directly, or when start.md routes here from a Discover/Plan/Review menu.
---

# /flywheel-duel — state-aware adversarial duel

This skill is the flywheel's wrapper around the global `/dueling-idea-wizards` skill. It does three things:

1. **Pre-flight** — verify ntm + ≥2 healthy CLIs (cc, cod, gmi).
2. **Mode auto-detect** — pick `--mode` based on `state.phase` from the flywheel checkpoint.
3. **Artifact routing** — after the duel completes, move `DUELING_WIZARDS_REPORT.md` + `WIZARD_*.md` into the right `docs/` subfolder and chain into the next flywheel tool (`flywheel_discover` / `flywheel_plan` / per-bead review).

## Step 1: Pre-flight gate (MANDATORY)

```bash
# 1. ntm presence + dependency check
command -v ntm >/dev/null 2>&1 || { echo "DUEL_BLOCKED reason=ntm-missing"; exit 1; }
ntm deps -v >/dev/null 2>&1 || { echo "DUEL_BLOCKED reason=ntm-deps-failed"; exit 1; }

# 2. Agent inventory — need at least 2 of {cc, cod, gmi}
AVAIL=0
for bin in cc cod gmi; do command -v "$bin" >/dev/null 2>&1 && AVAIL=$((AVAIL+1)); done
[ "$AVAIL" -ge 2 ] || { echo "DUEL_BLOCKED reason=insufficient-agents found=$AVAIL"; exit 1; }
```

If any check fails, surface the blocker via `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Duel cannot start: <reason>. How do you want to proceed?",
  header: "Duel blocked",
  options: [
    { label: "Run /flywheel-doctor", description: "Get the diagnostic report and fix the underlying issue" },
    { label: "Fall back to single-agent", description: "Use /idea-wizard (discovery) or mode=deep (plan) instead — no duel" },
    { label: "Abort", description: "Stop here; user will retry later" }
  ],
  multiSelect: false
}])
```

## Step 2: Detect phase and pick defaults

Read `.pi-flywheel/checkpoint.json` (best-effort — file may not exist for ad-hoc invocations):

| `state.phase`              | Default `--mode`   | Default `--top` | Output destination                                   | Post-duel chaining                            |
|----------------------------|--------------------|------------------|------------------------------------------------------|-----------------------------------------------|
| `idle` / no state          | `ideas`            | 5                | `docs/duels/<date>.md`                               | None — show summary only                      |
| `discovering`              | `ideas`            | 5                | `docs/discovery/duel-<date>.md`                      | `flywheel_discover` with provenance           |
| `awaiting_selection`       | `ideas`            | 5                | `docs/discovery/duel-<date>.md`                      | `flywheel_discover` (replaces candidates)     |
| `planning`                 | `architecture`     | 3                | `docs/plans/<date>-<slug>-duel.md`                   | `flywheel_plan({ mode: "duel", planFile })`   |
| `awaiting_plan_approval`   | `architecture`     | 3                | `docs/plans/<date>-<slug>-duel-refine.md`            | Replace plan, jump to Step 5.55               |
| `reviewing` / `iterating`  | `reliability`      | 3                | `docs/reviews/<beadId>-duel-report.md`               | Per-bead consensus → block / approve          |
| `creating_beads` / etc.    | `architecture`     | 3                | `docs/duels/<phase>-<date>.md`                       | Show summary; do NOT auto-chain               |

**User-supplied flags always win.** If `$ARGUMENTS` already contains `--mode=...` or `--top=...`, do not override.

## Step 3: Invoke /dueling-idea-wizards

Build the command line from the defaults + user-supplied args:

```
/dueling-idea-wizards \
  --mode=<auto-detected or user-supplied> \
  --top=<auto-detected or user-supplied> \
  --rounds=1 \
  --output=<phase-specific path from §2 table> \
  <pass-through user args>
```

If `state.selectedGoal` is set and the user did NOT pass `--focus`, append `--focus="<goal>"` so the duel agents anchor on the active goal.

Hand off to the skill via `Skill("dueling-idea-wizards", args: <command-line>)`. The skill itself drives the swarm (Phase 1 detection → spawn → study → ideation → cross-score → reveal → synthesis). This wrapper does not orchestrate panes — that is the duel skill's job.

## Step 4: Wait for completion

Block until `<output-path>` exists and is non-empty. The duel skill writes the synthesis report last, so file presence + non-zero size is the canonical "done" signal. Sample at 30s intervals:

```bash
while [ ! -s "$OUTPUT_PATH" ]; do sleep 30; done
```

If the duel skill exits non-zero or the report never appears within the budget (~55 min worst case), surface the failure via `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Duel did not complete (<reason>). Salvage partial output?",
  header: "Duel stalled",
  options: [
    { label: "Salvage", description: "Read whichever WIZARD_*.md files exist and synthesize manually" },
    { label: "Retry", description: "Re-run the duel from scratch" },
    { label: "Abort", description: "Stop; restore flywheel state to pre-duel phase" }
  ],
  multiSelect: false
}])
```

## Step 5: Route artifacts based on phase

### Phase = discovering / awaiting_selection

1. Parse the report's "Consensus winners" + "Contested decisions" sections.
2. Build a `CandidateIdea[]` array. For each winner, populate:
   - `provenance.source = "duel"`
   - `provenance.runAt = <ISO timestamp>`
   - `provenance.agentScores = { cc, cod, gmi }` (from the score matrix)
   - `provenance.contested = false` for consensus winners; `true` for contested
   - `provenance.survivingCritique = "<one line>"` (from the reveal phase)
   - `provenance.steelman = "<one line>"` (from Phase 6.75 if it ran; else omit)
3. Call `flywheel_discover({ cwd, ideas: <built array> })`.
4. Then run the standard goal-selection menu, but group options as **Consensus winners** / **Contested** (and include a footnote line listing dead ideas by title only).

### Phase = planning / awaiting_plan_approval

1. Move the report to `docs/plans/<date>-<slug>-duel.md`.
2. Call `flywheel_plan({ cwd, mode: "duel", planFile: "<path>" })`.
3. Jump directly to Step 5.55 (Plan alignment check) — the duel surfaces tensions the alignment check exists to surface.

### Phase = reviewing / iterating (per-bead)

1. Read the report.
2. Apply the consensus rule from `_review.md` Step 8:
   - Consensus issues (both agents flagged) → `flywheel_review action: "hit-me"` with the consensus list as findings.
   - Contested findings → `AskUserQuestion` with both arguments side-by-side; user arbitrates.
   - No findings → `flywheel_review action: "looks-good"`.

### Phase = idle or other

Do not auto-chain. Present a summary of the consensus/contested winners + a one-line "next steps" hint pointing the user to whichever flywheel command would consume the artifact next.

## Step 6: Final summary to the user

Print a compact summary regardless of phase:

```
Duel complete — <mode>, <N> agents, <Y> consensus winners, <Z> contested.
Report: <output-path>
Transcripts: WIZARD_IDEAS_*.md, WIZARD_SCORES_*.md, WIZARD_REACTIONS_*.md (project root)
Next: <auto-chained tool, or manual next step>
```

Leave the `WIZARD_*.md` siblings in place — they are the full transcript and feed the bead Provenance block at bead-creation time. `flywheel-cleanup` flags them stale after 7 days; never auto-delete.
