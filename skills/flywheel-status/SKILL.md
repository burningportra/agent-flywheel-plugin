---
name: flywheel-status
description: Show current flywheel status, bead progress, and inbox messages.
---

Show flywheel status for this project.

1. Call `flywheel_observe({ cwd })`, run `br list --json`, fetch the current Agent Mail identity's inbox, read `.pi-flywheel/calibration.json` when it exists, and inspect the returned wizard artifacts.

2. If $ARGUMENTS contains `--json`, call `flywheel_capabilities({ cwd })` for its `contract_version`. Print one JSON envelope and no surrounding prose:

   ```json
   {"tool":"flywheel_status","version":"<contract_version>","status":"ok","phase":"<phase>","data":{"checkpoint":{},"beads":[],"inbox":[],"calibration":null,"duel":null}}
   ```

   Errors use `status: "error"` and `data.kind: "error"` with `data.error.{code,message,hint,try_this,retryable}`.

3. Otherwise display:
   - The phase, selected goal, bead progress, phase elapsed time, and planning convergence from `observe.checkpoint`.
   - A bead table grouped `in_progress`, `open`, then `closed` or `deferred`.
   - Inbox messages from running agents and the current task list.
   - The result of `bv --robot-next`.

4. If wizard artifacts exist, identify ideation, cross-scoring, reveal, or a completed report from their filenames. Mark the duel stale when its newest artifact is older than seven days. Status is read-only and leaves every artifact in place.

5. When calibration has at least three considered beads, show the three rows with the largest sample counts. Include mean, median, p95, ratio, and sample count. Mark ratios above `1.25` with `▲`, ratios below `0.8` with `▼`, and low-confidence rows with their sample count. Mark calibration older than 30 days as stale. Omit the section when the file is missing or has fewer than three considered beads.
