---
description: Show current flywheel status, bead progress, and inbox messages.
---

Show flywheel status for this project.

1. **Checkpoint**: Read `.pi-flywheel/checkpoint.json`. Display:
   - Current phase
   - Selected goal
   - Bead progress (completed/total)
   - Time elapsed in current phase (from `phaseStartedAt`)
   - Polish convergence score (if in planning phase)

2. **Live beads**: Run `br list --json` via Bash. Display a table:
   ```
   ID | Title | Status | Priority | Review passes
   ```
   Group by: in_progress → open → closed/deferred.

3. **Inbox**: Call `fetch_inbox` via the `agent-mail` MCP tool with `agent_name: "Orchestrator"`. Display any messages from running agents. Acknowledge read messages by calling `acknowledge_message` for each.

4. **Todos**: Display current todo list from TodoRead.

5. **Next recommended bead**: Run `bv --robot-next` via Bash to get the next optimal bead to work on.

For per-template calibration ratios, see the Calibration section below.

6. **Calibration**: Read `.pi-flywheel/calibration.json`. When it exists AND `totalBeadsConsidered ≥ 3`, render the top 3 rows sorted by `sampleCount` descending:

   ```
   ── Calibration (last <sinceDays> days, <totalBeadsConsidered> closed beads) ──────
     template          mean    p50     p95     ratio   n
     add-tool          1.8h    1.5h    4.2h    1.4× ▲  12
     add-feature       0.6h    0.5h    1.1h    1.1×    23
     fix-bug           0.4h    0.3h    0.9h    0.9× ▼  18
     (N more templates below n≥3 threshold)
   ```

   Marker rules:
   - `▲` when `ratio > 1.25` (under-estimated — work takes longer than expected)
   - `▼` when `ratio < 0.8` (over-estimated — work finishes faster than expected)
   - No marker when `0.8 ≤ ratio ≤ 1.25` (well-calibrated)

   Render times as hours rounded to one decimal (e.g. `1.8h`) using `meanMinutes / 60`, `medianMinutes / 60`, `p95Minutes / 60`.

   If `lowConfidence: true` rows exist in the top-3, append `(n=K)` suffix and note `*low confidence*` beside the row.

   If calibration data is older than 30 days (compare `generatedAt` to today), append:
   > Calibration data is N days old — run /flywheel-calibrate to refresh

   If `.pi-flywheel/calibration.json` is missing OR `totalBeadsConsidered < 3`: omit the section entirely (do not render an empty header).
