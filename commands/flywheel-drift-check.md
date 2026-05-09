---
description: Check if the codebase has drifted from the implementation plan.
argument-hint: "[--json] [options]"
---

**First action:** Parse `$ARGUMENTS` for `--json`. Run `br list --json` + `bv --json` + the plan-vs-code comparison either way. If `--json`, assemble a single JSON envelope `{tool:"flywheel_drift_check", version, status, phase, data:{plan_path, on_track[], stale[], blocked[], new_opportunities[]}}`, print it to stdout, and exit (do NOT prompt). Otherwise render the human-friendly drift report and prompt for the polish loop.

Run a strategic drift check. $ARGUMENTS

## --json output schema

When invoked with `--json`, this command emits to stdout a single JSON envelope
classifying every bead against the active plan. The `--json` path skips the
interactive polish-loop prompt — callers must invoke `flywheel_approve_beads`
themselves. Pin the contract shape via `flywheel_capabilities` (`data.contract_version`).

Top-level: `{tool:"flywheel_drift_check", version, status, phase, data}`
Status:    `"ok" | "error"` (errors carry `data.kind:"error"` + `data.error.{code,message,hint,try_this,retryable}`)
`data` keys: `plan_path`, `on_track[]`, `stale[]`, `blocked[]`, `new_opportunities[]`.


1. Read the plan document path from `.pi-flywheel/checkpoint.json` (`planDocument` field). If not found, scan `docs/plans/` for the most recent plan file.

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

7. If yes, call `flywheel_approve_beads` with `action: "polish"` via the agent-flywheel MCP server.
