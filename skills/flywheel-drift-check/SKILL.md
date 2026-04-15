---
name: orchestrate-drift-check
description: Check if the codebase has drifted from the implementation plan.
---

Run a strategic drift check. $ARGUMENTS

1. Read the plan document path from `.pi-orchestrator/checkpoint.json` (`planDocument` field). If not found, scan `docs/plans/` for the most recent plan file.

2. Read the current bead statuses: `br list --json` via Bash.

3. Run `bv --json` via Bash for graph analysis (cycles, orphans, bottlenecks).

4. Use Agent(Explore) to compare current code state against the plan:
   - Which planned changes have been implemented?
   - Which are no longer relevant given code changes since the plan was written?
   - Have any new requirements emerged that the plan doesn't cover?

5. Display a drift report:
   ```
   ✅ On track: N beads
   ⚠️  Potentially stale: N beads  
   ❌ Blocked: N beads (dependency issues)
   🔄 New opportunities: (not in original plan)
   ```

6. Ask: "Would you like to update the plan to address the drift? (This will trigger a polish loop)"

7. If yes, call `orch_approve_beads` with `action: "polish"` via the `orchestrator` MCP tool.
