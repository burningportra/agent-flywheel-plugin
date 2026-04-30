---
description: Run a state-aware /dueling-idea-wizards duel. Routes artifacts into the flywheel pipeline (discovery, plan, review) based on current phase.
---

Run a flywheel-aware dueling-idea-wizards duel: $ARGUMENTS

This is the direct entry point for ad-hoc adversarial duels inside the flywheel. It is the same skill the start workflow's Discover / Plan / Review menus invoke under the hood — pull this command when you already know you want a duel and don't want to walk through the menus.

## What this does

`/dueling-idea-wizards` orchestrates an ntm-powered swarm (Claude Code + Codex + Gemini-CLI, whichever are healthy) through a 5-phase pipeline: independent ideation → cross-scoring (0-1000) → reveal → optional rebuttal/steelman/blindspot → synthesis. This wrapper:

1. Reads the flywheel state (`.pi-flywheel/checkpoint.json`) to pick a sensible default `--mode`.
2. Pre-flights ntm + agent availability (mirrors the doctor's duel-ready probe).
3. Invokes the underlying skill.
4. Routes the resulting `DUELING_WIZARDS_REPORT.md` and `WIZARD_*.md` siblings into the right `docs/` subfolder for the current phase.
5. (When applicable) auto-calls `flywheel_discover` / `flywheel_approve_beads` so duel output flows into the rest of the pipeline without manual stitching.

## Arguments

`$ARGUMENTS` is forwarded to `/dueling-idea-wizards` after the auto-defaults. Useful flags to pass through:

- `--mode=ideas|architecture|security|ux|performance|reliability|innovation`
- `--top=N` (default 5 in discovery context, 3 in plan context)
- `--rounds=N` (default 1; use 2+ for recursive duels)
- `--expand` (run Phase 4b to expand 5→15)
- `--beads` (auto-create beads from consensus winners, scored 700+)
- `--focus="<topic>"` (bias the ideation toward a specific subject)

## Execution

1. **Load skill.** Run `Skill("agent-flywheel:flywheel-duel")` (or the SKILL.md content directly under `skills/flywheel-duel/SKILL.md`) for full state-aware orchestration: phase detection, pre-flight gates, post-duel artifact routing, and the discover/approve-beads chaining rules.

2. **If skills/flywheel-duel is unavailable** (older flywheel install): fall back to invoking `/dueling-idea-wizards $ARGUMENTS` directly and route the output manually:
   - Phase=discovering or no state → move report to `docs/discovery/duel-<date>.md`, then call `flywheel_discover` with consensus winners as candidates (each carrying `provenance.source = "duel"`).
   - Phase=planning → move report to `docs/plans/<goal-slug>-<date>-duel.md`, then call `flywheel_plan({mode: "duel", planFile: "<path>"})`.
   - Phase=awaiting_review or other → move report to `docs/duels/<phase>-<date>.md` and surface the consensus/contested summary back to the user.

3. **Pre-flight check (always run, even on the fallback path):**
   ```bash
   command -v ntm >/dev/null || { echo "ntm not installed — duel cannot run"; exit 1; }
   ntm deps -v >/dev/null 2>&1 || { echo "ntm deps check failed — run /flywheel-doctor"; exit 1; }
   AVAIL=0
   for bin in claude codex gemini; do command -v "$bin" >/dev/null 2>&1 && AVAIL=$((AVAIL+1)); done
   [ "$AVAIL" -ge 2 ] || { echo "duel needs ≥2 of {claude,codex,gemini}; found=$AVAIL"; exit 1; }
   ```
   The {cc, cod, gmi} labels are ntm pane types, not local binary names. Check `claude`, `codex`, `gemini` instead — `which cc` matches `/usr/bin/cc` (the C compiler) on most systems and gives a false positive. If fewer than 2 of the real binaries are present, abort; the duel needs ≥2 different model types.
