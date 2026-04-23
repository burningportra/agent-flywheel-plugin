---
description: Sweep docs/solutions/ for stale, duplicate, and contradictory learnings — Keep / Update / Consolidate / Replace / Delete.
---

Run a compound-engineering refresh sweep over `docs/solutions/`.

The sweep is read-only at the algorithm layer. Archival is the only mutation it performs, and Delete always requires explicit user confirmation via AskUserQuestion. Nothing is ever truly removed — Delete archives the doc to `docs/solutions/_archive/` instead.

Invoke the `flywheel-compound-refresh` skill — it will:
1. Run the 5-vector overlap scorer (problem / root cause / solution / files / prevention) over every doc under `docs/solutions/`, grouped by `(problem_type, component)`.
2. Surface a per-group classification: Keep, Update, Consolidate, Replace, or Delete.
3. For Consolidate / Replace / Delete, ask before acting and archive (never `rm`) the losing entries.
4. Optionally run `git log --follow` rename detection before flagging components stale, so renamed files don't get false-positive Delete recommendations.

Threshold defaults match CE's Phase 1.75 rubric: Consolidate ≥0.75, Replace ≥0.85 (plus stale evidence), Delete ≥0.9 stale score on a singleton.

$ARGUMENTS
