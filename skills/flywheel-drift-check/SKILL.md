---
name: flywheel-drift-check
description: Check if the codebase has drifted from the implementation plan.
---

Run a strategic drift check. $ARGUMENTS

**First action:** Parse `$ARGUMENTS` for `--json`. Run `br list --json` + `bv --json` + the plan-vs-code comparison either way. If `--json`, assemble a single JSON envelope `{tool:"flywheel_drift_check", version, status, phase, data:{plan_path, on_track[], stale[], blocked[], new_opportunities[]}}`, print it to stdout, and exit (do NOT prompt). Otherwise render the human-friendly drift report and prompt for the polish loop.

## --json output schema

When invoked with `--json`, this skill emits to stdout a single JSON envelope classifying every bead against the active plan. The `--json` path skips the interactive polish-loop prompt — callers must invoke `flywheel_approve_beads` themselves. Pin the contract shape via `flywheel_capabilities` (`data.contract_version`).

- Top-level: `{tool:"flywheel_drift_check", version, status, phase, data}`
- Status: `"ok" | "error"` (errors carry `data.kind:"error"` + `data.error.{code,message,hint,try_this,retryable}`)
- `data` keys: `plan_path`, `on_track[]`, `stale[]`, `blocked[]`, `new_opportunities[]`.

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

6. **If drift is significant** (≥3 stale or new-opportunity beads), surface a follow-up via `AskUserQuestion`:

   ```
   AskUserQuestion(questions: [{
     question: "Significant drift detected (<N> stale + <M> new-opportunity beads). What do you want to do?",
     header: "Drift",
     options: [
       { label: "Polish-loop the plan", description: "Call flywheel_approve_beads(action: 'polish') and refine bead graph in place (Recommended for tactical drift)" },
       { label: "Run full reality-check", description: "Drift-check is the lightweight version; reality-check is the deep strategic pass — invoke /agent-flywheel:flywheel-reality-check (or read skills/start/_reality_check.md). Best when drift suggests a vision-vs-implementation gap, not just bead-graph staleness." },
       { label: "Ignore — log and continue", description: "Acknowledge drift but proceed without changes" }
     ],
     multiSelect: false
   }])
   ```

7. Route on the answer:
   - **"Polish-loop the plan"** → call `flywheel_approve_beads` with `action: "polish"` via the agent-flywheel MCP server.
   - **"Run full reality-check"** → invoke the reality-check slash command or read `skills/start/_reality_check.md` and execute its depth-selection flow.
   - **"Ignore"** → log and exit.

For minor drift (<3 affected beads), skip the follow-up and just ask the original "polish?" question — the lightweight path is sufficient.
