# Triage: in-place

Date: 2026-10-19

**Target.** Halve the median time to the first decision on the fixture, from 84 s to about 42 s, with every oracle check passing.

**Call: in-place.** None of the cost comes from the architecture or the data. The time is spread across sequential model turns and a few slow probes, and each of those is a local fix. If Step 0 took four turns (load tools, load the skill, one parallel state batch, render), with tool waits near 5 s, the per-turn model time measured in the baseline (about 7 s per turn, more for the final render) puts the best case near 35 to 45 s. That reaches the target without a redesign.

The hotspots, ranked by what they cost on the critical path:

1. **Sequential turns (about 6 extra turns, roughly 40 s).** The skill had the model fetch the version with Bash, call the doctor alone, then fan out, then fill gaps with its own probes. Fix: get the version from the `flywheel_get_skill` result, load every Step 0 tool with one `ToolSearch`, and make all of Step 0's state calls in one parallel message next to the version banner.
2. **`flywheel_profile` on the start screen (12 to 14 s on a miss).** Fix: leave it to Step 2, which already calls it.
3. **The doctor's first-run probe (about 5 s).** Fix: answer from the checkpoint, plan files, and legacy state first, and spawn `br` and `cass` only when none of them exist, taking the first probe that finds history.
4. **CASS history search (about 5.5 s per memory query).** Fix: give `flywheel_memory` search an optional `history` count, and pass 0 from Step 0, which only shows recorded learnings.
5. **Ad-hoc checkpoint and bead probes, and the wrong counts.** Fix: read session, beads, git, and Agent Mail from `flywheel_observe`, and make observe count beads with `br count`, which is exact and includes blocked beads.

The re-architecture lane doesn't apply.
