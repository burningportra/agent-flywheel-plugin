# Implementation Phase — Step 7

## Step 7: Implement each bead

### Pre-flight: resolve NTM readiness

Run this procedure before every NTM spawn decision, including after `/compact` or session resume. It recomputes `NTM_AVAILABLE` and `NTM_PROJECT`; neither value comes from checkpoint state.

1. Call `flywheel_doctor({ cwd })` and cache `data.report` as `DOCTOR_REPORT`.
2. Inspect `ntm_binary`, then `projects_base_misconfig`. For each non-green row, call `flywheel_remediate({ cwd, checkName: "<row name>", mode: "execute", autoConfirm: true })`, then call `flywheel_doctor` again before inspecting the next row. Remediate each row at most once per procedure call.
3. Copy `NTM_AVAILABLE` and `NTM_PROJECT` from the final `DOCTOR_REPORT.ntm`. Treat a missing `ntm` object as `NTM_AVAILABLE=false` with reason `incomplete`. Only `NTM_AVAILABLE=true` permits the NTM branch below; every other result uses the single-agent fallback after surfacing the final doctor hint.

When `DOCTOR_REPORT.ntm.reason === "collision"`, keep the occupied target unchanged and ask how to continue:

  ```
  AskUserQuestion(questions: [{
    question: "NTM project name collision at <target>: it resolves to <resolvedTarget>, not this project. How should this wave continue?",
    header: "NTM collide",
    options: [
      { label: "Fall back to Agent() (Recommended)", description: "Run this wave without NTM and leave the other repository mapping intact" },
      { label: "Run setup", description: "Open /flywheel-setup for safe projects_base guidance" },
      { label: "Stop and inspect", description: "Pause before spawning so the conflicting path can be resolved manually" }
    ],
    multiSelect: false
  }])
  ```

- **Fall back to Agent()** → keep `NTM_AVAILABLE=false` and continue through the existing fallback branch.
- **Run setup** → invoke `/flywheel-setup`, then rerun this readiness procedure from step 1.
- **Stop and inspect** → stop before spawning and print `target` plus `resolvedTarget` from `DOCTOR_REPORT.ntm`.

The remediation handler refuses regular files, directories for another repository, wrong-target symlinks, and dangling symlinks. Never unlink or overwrite the occupied target.

- `NTM_AVAILABLE=true` → use NTM for this wave with `NTM_PROJECT` from the doctor result.
- `NTM_AVAILABLE=false` → use the `Agent()` fallback for this wave unless the collision question stops the workflow.

### Wave-to-wave reliability (v3.6.0+)

Before starting the wave, decide whether you'll babysit the loop in-chat or hand it off to the durable surfaces. Three tools collapse the manual monitor dance into 1–2 calls and let the loop survive `/compact`, idle turns, and the user walking away:

**1. `tender-daemon` — background watcher (survives `/compact`)**

Spawn ONCE per wave, before dispatching impl agents. It polls inbox + `ntm --robot-is-working` every N seconds and appends NDJSON deltas to `.pi-flywheel/tender-events.log`. On resume, you tail the log to reconstruct what happened while you were gone — no state loss when context is reset.

```bash
nohup node $CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js \
  --session=agent-flywheel-plugin--impl-<goal-slug> \
  --project="$PWD" \
  --interval=30000 \
  --logfile=.pi-flywheel/tender-events.log \
  --agent=<your-coordinator-name> \
  > /tmp/tender-daemon.log 2>&1 &
echo "tender_daemon_pid=$!"
```

Event kinds emitted: `tick`, `message_received`, `pane_state_changed`, `rate_limited`, `context_low`, `daemon_stopped`. On wave completion, `kill -TERM <pid>` flushes a `daemon_stopped` event and exits cleanly.

**Tail-on-resume pattern** — when chat re-enters mid-wave, run:
```bash
tail -100 .pi-flywheel/tender-events.log | jq -c '.'
```
to catch up on every state change you missed.

**2. `flywheel_advance_wave` — one-call wave transition**

After every wave completes, instead of: verify-beads → read frontier → render prompts → dispatch (4-step manual dance), call:
```
flywheel_advance_wave(cwd, closedBeadIds: [<wave-N bead IDs>], coordinatorName: "<current Agent Mail name>")
```
Returns `{ verification, nextWave: { beadIds, lanes, prompts, complexity, warnings, degraded } | null, waveComplete }`. If `nextWave` is non-null, spawn from `nextWave.lanes` and send every prompt unchanged via `ntm --robot-send`. If `waveComplete: true` and `nextWave: null`, the queue is drained. Proceed to Step 8.

This is the surface that makes the flywheel actually flywheel. Use it after EVERY wave; do not re-implement the dance manually.

**3. `ScheduleWakeup` — coordinator re-entry**

After dispatching a wave, schedule yourself to re-enter in ~5 min so you don't sit idle:
```
ScheduleWakeup(
  delaySeconds: 270,
  prompt: "Continue v3.6.0 impl wave: tail .pi-flywheel/tender-events.log, check inbox for [impl] *done* messages, call flywheel_advance_wave with newly-closed bead IDs.",
  reason: "Re-enter mid-wave to advance after agents deliver"
)
```
Stays inside cache TTL (270s), survives idle turns. Combine with the tender-daemon for full reliability — daemon writes events to disk, ScheduleWakeup brings you back to read them.

**Putting it together** — recommended wave loop:
1. Spawn NTM panes via `ntm spawn`.
2. Spawn tender-daemon as a single background process.
3. Dispatch prompts via `ntm --robot-send` for first-wave dispatch; for subsequent idle-pane "next bead" picks, prefer `ntm assign "$NTM_PROJECT" --auto --strategy=dependency` (it picks the next ready bead off the `bv` graph and registers the assignment in one call).
4. Call `ScheduleWakeup(270s, …)` and end the turn.
5. (Wakeup fires) — `tail .pi-flywheel/tender-events.log` → optionally `ntm work triage --by-track` for an operator-readable view of remaining work → call `flywheel_advance_wave(closedBeadIds, coordinatorName)`.
6. Dispatch returned `nextWave.prompts` (or proceed to Step 8 if `waveComplete && nextWave === null`).
7. `kill -TERM $tender_daemon_pid` when the queue drains.

**Supervision mode (optional — choose before dispatching).** Before the first ScheduleWakeup, surface this gate:

```
AskUserQuestion(questions: [{
  question: "How should the swarm be supervised between waves?",
  header: "Supervision",
  options: [
    { label: "Looper-based (Recommended)", description: "ScheduleWakeup(270s) keeps coordination in this Claude session. Cache-warm wakes, no second account burn, knows the goal/plan." },
    { label: "ntm controller", description: "Spawn ntm controller \"$NTM_PROJECT\" --agent-type=cc in pane 0 — a dedicated coordinator agent with built-in --robot-snapshot/--robot-attention loop. Main session can exit cleanly. Trade-off: separate context budget, no goal/plan context unless injected via --prompt template." }
  ],
  multiSelect: false
}])
```

- **Looper-based** → continue with the wave loop above.
- **ntm controller** → run `ntm controller "$NTM_PROJECT" --agent-type=cc` (optionally with `--prompt=.pi-flywheel/controller-prompt.md` referencing `{{.Session}}`, `{{.AgentList}}`, `{{.ProjectDir}}` template variables to inject the wave's goal). Tender-daemon still runs. The main session may then either tend alongside or exit; if it exits, the controller drives. If the controller pane dies (`ntm --robot-is-working` returns `gone` AND no Agent Mail traffic for >10 min), climb the stuck-pane ladder (`--robot-smart-restart` → `--robot-smart-restart --hard-kill` → fall back to looper-based supervision).

### Commit-batch fresh-eyes auto-trigger (Pre-flight, v3.17.0+)

Before the first wave dispatches, decide the commit-batch threshold that triggers an auto fresh-eyes review during long impl runs. Surface this gate verbatim:

```
AskUserQuestion(questions: [{
  question: "Set the commit-batch threshold for the auto fresh-eyes review during impl?",
  header: "Batch review",
  options: [
    { label: "Off",          description: "Disable. Only the post-wave gate fires. Same as v3.16.0 behavior" },
    { label: "5 commits",    description: "Tighter cadence — catches issues earlier; more reviewer interrupts" },
    { label: "8 commits (Recommended)", description: "Balanced — large enough to avoid micro-commit noise, small enough to keep reviewer scope bounded" },
    { label: "12 commits",   description: "Looser cadence — fewer interrupts, longer feedback latency" }
  ],
  multiSelect: false
}])
```

Route the answer into `state.commitBatchThreshold`. `Off` sets it to `0` (disables); the others set the integer literally. `FW_COMMIT_BATCH_THRESHOLD` env var is an alternative override path — useful for CI / unattended runs where you don't want to surface the gate. Env beats state on conflict.

The threshold drives the `shouldTriggerBatchReview(state)` check inside `flywheel_advance_wave` (see Step 7.5 below).

### Pre-loop — swarm scaling + stagger

For wave one, `flywheel_approve_beads(action="start")` returns the complete assignment in `data.lanes` and ready-to-send bytes in `data.prompts`. Later waves return the same prompt records in `nextWave.prompts`. Spawn exactly the returned lane counts and send every prompt unchanged. The server owns provider fallback, agent names, adapter selection, the completion gate, and trailing newlines. Keep `--stagger-mode=smart` on the spawn.

**Rate-limit management** — if any impl agent reports a rate-limit error (429, "usage limit reached", etc.), invoke `/caam` to switch that model's account. `caam activate <model> <backup-account>` takes <100ms and keeps the wave moving. Don't kill and restart the agent; the wrapper just re-authenticates the current session.

**Monitoring error codes.** Follow SKILL.md Universal Rule 4. Phase-specific recovery:

```ts
const code = monitorResult.structuredContent?.data?.error?.code;
if (code === "exec_timeout") return retryMonitorTick();
if (code === "exec_aborted") return stopWaveCleanly();
if (code === "cli_failure") return escalateWithHint(monitorResult.structuredContent?.data?.error?.hint);
```

**Destructive-command coordination** — if any impl agent proposes `git reset --hard`, `git push --force`, `DROP TABLE`, `rm -rf`, `kubectl delete`, or similar, invoke `/slb` to require two-person approval. The coordinator is the second party; never let an agent self-approve destructive ops. If `/dcg` is configured as a hook, most of these are already blocked at the harness layer — still confirm via `/slb` for anything slipping through.

**DCG-blocked command workarounds** — when the `/dcg` hook blocks a command, do not try to bypass it. Use the safe equivalent:

| Blocked command                            | Safe alternative                                   | Why it's safer                                     |
|--------------------------------------------|----------------------------------------------------|----------------------------------------------------|
| `rm -rf <dir> && mkdir <dir>`              | `mkdir -p <dir>-$$` (new temp dir with PID suffix) | No deletion; caller points to the new path         |
| `git checkout HEAD -- <path>`              | `git show HEAD:<path> > <path>`                    | Redirect is reversible; no index manipulation      |
| `git reset --hard <sha>`                   | `git stash && git checkout <sha>`                  | Work is preserved in stash                         |
| `git push --force <branch>`                | `git push --force-with-lease <branch>`             | Aborts if remote advanced since last fetch         |
| `DROP TABLE <t>`                           | `ALTER TABLE <t> RENAME TO <t>_deprecated_<date>`  | Recoverable until the rename is cleaned up later   |
| `rm -rf <dir>`                             | `mv <dir> /tmp/trash-$(date +%s)-<dir-basename>`   | Trashed, not deleted; cleaner scripts gc /tmp      |

If none of these fit, escalate to `/slb` with the full command, expected outcome, and recovery plan. Never `--no-verify`, `--dangerously-skip-permissions`, or edit `/dcg` config to unblock a single action — those remove the safety net permanently.

### Implementation loop

Use `TaskCreate` to create a task per bead. For each ready bead:

1. Create a named implementation team if multiple beads are parallelizable:
   ```
   TeamCreate(team_name: "impl-<goal-slug>")
   ```
   > **NOTE:** If a planning team (e.g. `"deep-plan-<slug>"`) is still active from Step 5, you must delete it first via `TeamDelete(team_name: "deep-plan-<slug>")` before creating the impl team. If `TeamDelete` fails because agents are still registered, retire them via Agent Mail `retire_agent` first, then retry `TeamDelete`. Alternatively, reuse the existing planning team by passing its `team_name` to impl agents.

2. **Choose spawn mechanism based on NTM availability.**

   **If `NTM_AVAILABLE`** (preferred), use `$NTM_PROJECT` from the readiness pre-flight and the server-owned wave-one response. Assign `START_DATA = approveResult.structuredContent.data`. It contains `lanes`, `prompts`, and any degraded-mode warnings.

   1a. **Codex config compatibility pre-spawn gate (MANDATORY when lane includes a `cod` pane).** If `DOCTOR_REPORT.checks` shows `codex_config_compat` with severity `yellow` or `red`, surface this gate BEFORE spawning. Skipping it is a known failure mode: cod pane crashes within seconds with `'gpt-5.5-xhigh' model is not supported when using Codex with a ChatGPT account` (verified 2026-05-08).

      ```
      AskUserQuestion(questions: [{
        question: "Doctor flagged codex_config_compat (~/.codex/config.toml model='X' is rejected by ChatGPT-account auth). Apply the fix before spawning?",
        header: "Codex config",
        options: [
          { label: "Apply fix and proceed (Recommended)", description: "Run: flywheel_remediate({checkName: 'codex_config_compat', mode: 'execute', autoConfirm: true}). Idempotent. Then spawn the swarm." },
          { label: "Abort and fix config", description: "Stop before spawning so the incompatible Codex configuration can be corrected without discarding the server-owned lane assignment." },
          { label: "Continue anyway", description: "Spawn cod panes despite known incompatibility — they will crash within seconds." }
        ],
        multiSelect: false
      }])
      ```

   1b. **Gemini model compatibility pre-spawn gate (MANDATORY when lane includes a `gem` pane).** If `DOCTOR_REPORT.checks` shows `gemini_model_compat` with severity `yellow` or `red`, surface this gate BEFORE spawning. The 2026-05-15 reality-check swarm confirmed the gemini CLI rejects models outside the documented allowlist (`gemini-3.1-flash-preview`). The check is provided by bead `claude-orchestrator-37n6` — if the check is missing from `DOCTOR_REPORT.checks` entirely, treat it as `green` (no gate) and continue.

      ```
      AskUserQuestion(questions: [{
        question: "Doctor flagged gemini_model_compat (configured gemini model is outside the documented allowlist). How to handle the gem lane?",
        header: "Gemini",
        options: [
          { label: "Abort and fix config (Recommended)", description: "Stop before spawning so the Gemini configuration can be corrected without discarding the server-owned lane assignment." },
          { label: "Continue anyway", description: "Spawn gem panes despite known incompatibility — they will likely reject the configured model and exit." }
        ],
        multiSelect: false
      }])
      ```

      In looper-driven or `--no-user` runs, apply the recommended remediation automatically. If compatibility stays non-green, stop before spawning and report the doctor row. Never rewrite `data.lanes` by hand.

   2. **Use the returned lane sizes.** For wave one, read `START_DATA.lanes`. Later waves use `nextWave.lanes`. Surface `data.dispatch.warnings` or `nextWave.warnings` before spawning.

   3. **Spawn lanes via NTM** with one pane per returned bead. Set `N_cc`, `N_cod`, `N_gmi`, and `N_pi` from the matching `START_DATA.lanes[].beadIds.length` values. Load `/ntm` and `/vibing-with-ntm` first.
      ```bash
      SESSION="${NTM_PROJECT}--impl-<goal-slug>"

      # --no-user omits pane 0 entirely; lanes start at pane index 1.
      # --stagger-mode=smart prevents thundering-herd on simultaneous cold-boot.
      ntm spawn "$NTM_PROJECT" --label impl-<goal-slug> --no-user \
        --cc=<N_cc> --cod=<N_cod> --gmi=<N_gmi> --pi=<N_pi> --stagger-mode=smart
      ```

      **Pane addressing is numeric** — `cc-1` / `cod-1` / `gmi-1` style does NOT work. With `--no-user`, panes are laid out contiguously by spawn order:

      | Lane    | Pane indices                                              |
      |---------|------------------------------------------------------------|
      | Claude  | `1` … `N_cc`                                              |
      | Codex   | `N_cc+1` … `N_cc+N_cod`                                   |
      | Gemini  | `N_cc+N_cod+1` … `N_cc+N_cod+N_gmi`                      |
      | Pi      | `N_cc+N_cod+N_gmi+1` … `N_cc+N_cod+N_gmi+N_pi`           |

      Dispatch via `ntm --robot-send` (NOT `ntm send`). Plain `ntm send` aborts with `Continue anyway? [y/N]` when CASS dedup matches a similar past prompt — silent blocker in orchestrator loops (ntm skill gotcha #3). `--robot-send` is non-interactive by design:
      ```bash
      ntm --robot-send="$SESSION" --panes=1 --msg="<matching data.prompts[].prompt>"
      ntm --robot-send="$SESSION" --panes=$((N_cc+1)) --msg="<matching data.prompts[].prompt>"
      ntm --robot-send="$SESSION" --panes=$((N_cc+N_cod+1)) --msg="<matching data.prompts[].prompt>"
      ntm --robot-send="$SESSION" --panes=$((N_cc+N_cod+N_gmi+1)) --msg="<matching data.prompts[].prompt>"
      ```

      Send every `START_DATA.prompts[]` record once, in array order, to a pane in its `lane`. Pane spawn uses `gmi`. NTM robot-send's provider filter is `gem`, though numeric `--panes` needs no `--type` filter.

      **Flag note (verified 2026-05-08).** Use `--panes=N` (plural; indices comma-separated). `--pane=N` (singular) is silently broadcast to ALL panes. Combining `--panes=N --type=cc` AND-restricts to zero matches at session-init time before pane-type metadata stabilizes — drop `--type=` when you already know the index from the spawn order.

      ⚠ **Forbidden in automation:** `ntm view` (retiles the user's tmux layout and returns nothing useful) and `ntm dashboard` / `ntm palette` (human-only TUIs). The user can run them; the orchestrator must not.

   4. Send each server-built prompt unchanged. It already contains the provider-specific instructions, Agent Mail identity, completion gate, bead-specific JSON example, and required trailing newlines. If `START_DATA.dispatch.degraded` is true, show its warnings before spawning.

   **Monitor loop (MANDATORY — do NOT fire-and-forget).** NTM spawns agents asynchronously; a pane process can live while the agent inside it is idle, crashed, or skipping Agent Mail. You MUST actively monitor until every bead in the wave is closed or force-stopped.

   **Tend.** Follow the `/vibing-with-ntm` orchestrator decision tree for nudge escalation, stuck-pane ladder, rate-limit probe, context-handoff and convergence termination. The flywheel-specific facts the loop needs on top of that:

   - Capture the cursor once with `ntm --robot-snapshot --robot-format=toon`, then block on `ntm --robot-wait "$SESSION" --wait-until=attention,action_required,mail_ack_required --timeout=90s`. On each wake, cross-reference `ntm --robot-is-working="$SESSION"` with your Agent Mail inbox (`fetch_inbox` + `mark_message_read` + `acknowledge_message` on `[impl] <bead-id> done` subjects), and run `git log --oneline --grep="<bead-id>"` per in-flight bead to catch the "agent committed but forgot `br update`" case.
   - Never use `ntm status` / `ntm activity` / `ntm health` (they read cached timestamps and return stale signals — panes look dead while they're working, or vice versa), `ntm send` (hits the CASS-dedup prompt and silently aborts) or `ntm view` (not a flag). Use `--robot-is-working`, `--robot-agent-health`, `--robot-tail`, `--robot-send`.
   - Print one tick line only when state changes — pane status, inbox count, commits-since-last-tick — so the user can see the orchestrator is alive without the scroll-spam of fixed-interval ticks.
   - About 60 s after spawn, confirm each pane registered an Agent Mail identity (`list_window_identities` or `list_contacts`). A missing identity means the pane skipped `macro_start_session`; nudge it with `--robot-send` so the identity bootstraps.
   - Session-name shape: pass the project as the positional arg and the purpose as `--label` (e.g. `ntm spawn "$NTM_PROJECT" --label impl-<goal-slug>`). A bare purpose as session name would resolve against `projects_base` and either fail or land in the wrong cwd.

   **Post-wave bridge — call `flywheel_advance_wave` (v3.6.0+).** When every bead in the wave is closed (via Agent Mail completion OR proactive close OR force-stop), do NOT manually re-render the next wave. One call:
   ```
   flywheel_advance_wave(cwd, closedBeadIds: [<wave-N bead IDs>], coordinatorName: "<current Agent Mail name>")
   ```
   - If `nextWave: null` and `waveComplete: true` → queue drained. `kill -TERM $tender_daemon_pid`, leave the tmux session alive (user may want to inspect panes), transition to Step 8.
   - If `nextWave.prompts` returned → spawn the counts in `nextWave.lanes` and dispatch every prompt unchanged via `ntm --robot-send` to fresh panes (or reuse idle ones via `--robot-restart-pane`), then `ScheduleWakeup(270s, …)` and end the turn. The daemon will keep logging while you're idle.

   **Do not skip the Step 8 AskUserQuestion review prompt just because you watched the panes succeed** — the user still gets "Looks good / Self review / Fresh-eyes" and fresh-eyes review is still run via `Agent()` (NOT NTM — reviewers are short-lived). See `_review.md`.

   **If NTM is unavailable** (fallback): Spawn via the `Agent()` tool as described below.

3. If NTM is unavailable and the user accepts the fallback, create one isolated `Agent()` worker per returned prompt. Pass `START_DATA.prompts[].prompt` unchanged as the worker prompt and use its `agentName`. The server-built prompt already owns bootstrap, implementation, verification, attestation, close, and reporting instructions.


3. **Auto-capture failures**: If an agent reports a blocker or failure via Agent Mail, automatically store it in CASS:
   ```
   flywheel_memory(operation: "store", content: "Bead <id> (<title>) hit blocker: <failure description>. Resolution: <what fixed it or 'unresolved'>")
   ```
   This ensures future sessions can recall what went wrong and avoid the same pitfall.

4. Mark the bead's task as `in_progress`. If the agent goes idle before reporting back, nudge it:
   ```
   SendMessage(to: "impl-<bead-id>", message: "Please report your current status and any blockers.")
   ```

   **Proactive close (recommended — skip the escalation tree entirely).** Instead of waiting for 2 nudges to diagnose an idle agent, poll `git log --grep="<bead-id>" --oneline -1` every 30s after spawn. As soon as a commit referencing the bead appears AND the agent is idle (per `TaskList`), verify the commit's diff matches the bead's acceptance criteria, then close the bead yourself:
   ```bash
   br update <bead-id> --status closed
   br show <bead-id> --json | jq -r '.[0].status'   # must print "closed"
   ```
   This saves ~60s per bead (no nudge round-trip) and handles the dominant failure mode (agent commits but skips `br update`) without any dialog. Only fall into the idle-agent escalation tree below when the coordinator could NOT verify the commit OR the bead's acceptance is ambiguous.

   **Monitor-script hygiene.** When using the `Monitor` tool to poll for commits/files/bead-closures, the shell loop MUST end with `exit 0` explicitly — a `for i in $(seq ...); do ... break; done` with no trailing statement inherits the exit code of the last iteration's `sleep` command, which can be non-zero on timeout and fires a spurious `script failed (exit 1)` notification. Pattern:
   ```bash
   for i in $(seq 1 90); do
     if condition_met; then echo "DONE"; exit 0; fi
     sleep 15
   done
   echo "timeout"
   exit 0   # <- required; timeout is not a failure
   ```

   **Idle-agent escalation** (fallback when proactive close doesn't apply): After 2 nudges, check `git log --oneline --grep="<bead-id>"` to determine what shape of failure you're in. There are TWO common cases — diagnose first, then act:

   **Case A — Commits exist but bead not closed** (MORE common): The agent did the implementation work and committed, then went idle before calling `br update --status closed`. Verify:
   ```
   br show <bead-id> --json | jq -r '.[0].status'
   ```
   If status is `open` or `in_progress` but a commit referencing the bead exists:
   - Close the bead directly: `br update <bead-id> --status closed`. No replacement agent needed.
   - Skip the nudge — it saves a round-trip.
   - Optionally verify the commit's diff matches the bead's acceptance criteria before closing.

   **Case B — Zero commits since spawning**: The agent stalled before producing any output.
   - Do NOT spawn a replacement agent — it will likely stall the same way.
   - Implement the bead directly as the coordinator.
   - Close the bead: `br update <bead-id> --status closed`.
   - This is faster than multiple failed spawn cycles and produces the same outcome.

5. **Store cross-cutting learnings**: When an agent's completion report mentions something non-obvious (unexpected file renames, rebase conflicts, API quirks, tooling workarounds), store it in CASS:
   ```
   flywheel_memory(operation: "store", content: "Bead <id> (<title>): <learning from agent report>")
   ```
   Don't store routine completions — only surprises or gotchas that would help future sessions.

6. When the agent completes, mark task as `completed`. Send shutdown:
   ```
   SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})
   ```
   > **Important:** Structured shutdown messages CANNOT be broadcast to `"*"`. You must send to each impl agent individually by name. This applies to all structured JSON messages (shutdown_request, plan_approval_request, etc.).

   **If the agent remains idle after shutdown_request** (check via `TaskList` — task still shows as active after 60 seconds):
   - Force-stop with `TaskStop(task_id: "<saved-task-id>")` if the task ID is available.
   - Retire in Agent Mail: `retire_agent(project_key: cwd, agent_name: "<their-agent-mail-name>")`.
   - If still listed in the team, edit `~/.claude/teams/<team>/config.json` to remove from the `"members"` array, then retry `TeamDelete` when ready.

### Step 7.5: Commit-batch fresh-eyes auto-trigger (v3.17.0+)

When the commit threshold fires, branch only on `structuredContent.data.nextStep.kind`:

| `kind` | Action |
|--------|--------|
| `batch_review_due` | Call `flywheel_review(action="batch_review", shaRange="<lastBaselineSha>..<reviewSha>")`. Wait up to 10 minutes for its verdict. |
| `advance_wave` | Call `flywheel_advance_wave`, then dispatch any returned `nextWave.prompts` from `nextWave.lanes`. |
| `needs_attention` | Show the findings and ask **Continue waves / Synthesize beads / Pause to fix / Regress to plan**. |
| `synthesized_beads_pending` | Show `beadIds` and `mapping`, then ask **Approve all / Approve subset / Reject all / Regress to plan**. Use `rollbackSynthesizedBeads` for every rejected id. |

The server advances `lastBatchReviewSha` when it dispatches the review, so commits arriving during review stay outside that window. On review timeout, record `review_timeout`, reset the counter, and resume the post-wave gate.


### Parallel-wave build-artifact races

When multiple impl beads in the same wave all trigger `npm run build` (or equivalent), each rebuilds `dist/` or its output directory. Byte-identical outputs are fine — git only sees one change — but **different commit orderings can confuse `git blame`** (bead B's commit may ship bead A's dist/ and vice versa).

**Recommended pattern:**
- Designate ONE bead per wave as the "build-committer" — only that bead commits `dist/`. Other beads commit src/ only.
- Alternative: defer the `dist/` commit to Step 9.5 wrap-up, where the coordinator runs one final `npm run build` and commits the bumped output alongside the version bump. This is the pattern used by v3.4.0 — clean git log, no cross-bead confusion.

If you observe two beads committing the same `dist/` bytes, note it in the end-of-turn summary but do NOT retroactively squash — the history is accurate and future bisects still land on the correct src/.

### Stuck-swarm diagnostics

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Multiple agents pick the same bead | Unsynced starts; not marking `in_progress` early | Stagger starts 30s; require `br update --status in_progress` + Agent Mail claim before any edit; audit file reservations |
| Agent circles after compaction | Lost its dispatch contract | Nudge: `SendMessage(to: "<name>", message: "Re-read your server-issued implementer prompt, then continue from your last Agent Mail message.")` — kill+restart only if it stays erratic |
| Bead sits `in_progress` too long | Crash / blocker / lost plot | Check Agent Mail thread for last report; if silent, implement directly as coordinator OR split the blocker into sub-beads with `br create` + `br dep add` |
| Contradictory implementations across beads | Poor coordination / stale reservations | Audit `file_reservation_paths`; revise bead boundaries so two beads never edit the same file |
| Much code, goal still far | Strategic drift | Run the "Come to Jesus" reality check in Step 9's Check-status option |

### Codex-rescue handoff on impl-agent stall (per bead `agent-flywheel-plugin-1qn`)

Worker stalls — distinct from `rate_limited` / `context_low` recovery paths above — fire when the same impl bead has hit its retry budget without producing a passing commit. Detect at the **N-1th** retry, not the Nth, so the user has time to choose a different lane:

- An impl agent reported the same `FlywheelErrorCode` (e.g. `cli_failure`, `parse_failure`) on the immediately prior attempt AND the next attempt would be the second retry, **OR**
- The pane has been `idle` per `ntm --robot-is-working` for >5 min after Nudge 2 with zero new commits referencing the bead, **OR**
- A bead has been reassigned twice and the third attempt is about to start.

When any one of these triggers, surface the rescue choice — don't blind-retry:

```
AskUserQuestion(questions: [{
  question: "Bead <id> has stalled (<error_code> twice; hint: <hint from envelope>). How do you want to proceed?",
  header: "Impl stall",
  options: [
    { label: "Retry once more", description: "Spend the final retry on the same lane — sometimes a transient flake clears" },
    { label: "Hand off to Codex (Recommended)", description: "Build a rescue packet from the failing envelope + git diff and invoke the codex-rescue skill" },
    { label: "Abort phase", description: "Stop this bead; mark blocked and move to the next ready bead" },
    { label: "Other", description: "Describe a different recovery path" }
  ],
  multiSelect: false
}])
```

**On "Hand off to Codex"** — call `flywheel_rescue({ cwd, phase: 'impl', beadId, errorEnvelope })` and pass its `codexPrompt` field to the codex-rescue skill (`/codex:rescue --wait` so the rescue blocks the wave's progression for this bead). Store the returned `memoryLine` via `flywheel_memory(operation: "store", content: memoryLine)` so the doctor's `rescues_last_30d` synthesis sees it. `errorEnvelope` is the `structuredContent.data.error` object from the last failing impl-side tool call; the server assembles the diff-based rescue artifact, recent tool calls, and the Codex-tuned prompt rendering.

**On Codex completion:**

- Codex returns a unified diff in its `COMPLETION_REPORT` block. Apply via `git apply --3way` and create a `fixup!` commit referencing the bead. Re-run the impl gate (`npm run build`, tests) before closing.
- If Codex produced a clarifying question, surface it via `AskUserQuestion` and feed the answer back to the original impl agent (or to a fresh one if the stall pane is wedged).
- If Codex itself stalls, do NOT cascade — fall back to "Abort phase" and reassign the bead manually next session.

> ## MANDATORY POST-IMPLEMENTATION CONTINUATION
>
> After all impl agents in the current wave have completed (or been force-stopped), you MUST continue to Step 8 (read `_review.md`). Do NOT end the turn, exit the workflow, or return control to the user. The implementation phase is the MIDDLE of the flywheel — not the end. The remaining steps (review -> verify -> test coverage -> UI polish -> wrap-up -> CASS -> refine -> post-flywheel menu) are what make the flywheel a flywheel. Dropping out here is a bug.
