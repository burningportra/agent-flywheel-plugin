---
name: flywheel-swarm-status
description: Check the status of running swarm agents and bead progress.
---

Check swarm status.

1. Run `br list --json`, fetch the current Agent Mail identity's inbox, and read the current task list.

2. If $ARGUMENTS contains `--json`, call `flywheel_capabilities({ cwd })` for its `contract_version`. Print one JSON envelope and no surrounding prose:

   ```json
   {"tool":"flywheel_swarm_status","version":"<contract_version>","status":"ok","phase":"<phase>","data":{"beads":[],"inbox":[],"stuck":[],"recommendation":""}}
   ```

   Errors use `status: "error"` and `data.kind: "error"` with `data.error.{code,message,hint,try_this,retryable}`.

3. Otherwise show a bead table with ID, title, status, and update time. Highlight `in_progress` rows and inbox messages from running agents.

4. Flag an `in_progress` bead as stuck when its `updated_at` is older than 30 minutes and its assigned agent is no longer working.

5. Recommend the next action:
   - For a stuck agent, inspect it before suggesting `/agent-flywheel:flywheel-swarm-stop` and a restart.
   - When every swarm bead has finished and completion messages arrived, read `skills/start/_review.md` and execute its Step 8 review flow. The swarm ends only after review and wrap-up.
   - Mid-flight with no stalls, report progress and stay idle or use the cadence from `_implement.md`.
