# Implement each bead

### Resolve NTM readiness

Run this procedure before each NTM spawn decision and after compaction or resume.

1. Call `flywheel_doctor({ cwd })` and keep `data.report` as `DOCTOR_REPORT` and `data.pluginRoot` as `PLUGIN_ROOT` (Claude Code does not export `CLAUDE_PLUGIN_ROOT` to `Bash`).
2. Inspect `ntm_binary`, then `projects_base_misconfig`. For each non-green row, call `flywheel_remediate({ cwd, checkName: "<row name>", mode: "execute", autoConfirm: true })`, then rerun `flywheel_doctor`. Remediate each row once per procedure call.
3. Read `NTM_AVAILABLE` and `NTM_PROJECT` from the final `DOCTOR_REPORT.ntm`. A missing `ntm` object means `NTM_AVAILABLE=false` with reason `incomplete`.

When `DOCTOR_REPORT.ntm.reason === "collision"`, leave the occupied target unchanged and ask how to continue:

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

- **Fall back to Agent().** Keep `NTM_AVAILABLE=false` and use the fallback below.
- **Run setup.** Invoke `/flywheel-setup`, then repeat this procedure.
- **Stop and inspect.** Stop before spawning and print `target` and `resolvedTarget`.

The remediation refuses regular files, directories for another repository, wrong-target symlinks, and dangling symlinks. Never unlink or overwrite the occupied target.

### Set the commit-batch review threshold

Before the first wave, surface this gate verbatim:

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

Store `0`, `5`, `8`, or `12` in `state.commitBatchThreshold`. `FW_COMMIT_BATCH_THRESHOLD` overrides state for unattended runs.

### Choose supervision

Before dispatching, surface this gate:

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

- **Looper-based.** Use the tend cycle below.
- **ntm controller.** Run `ntm controller "$NTM_PROJECT" --agent-type=cc`. You may pass `--prompt=.pi-flywheel/controller-prompt.md` with `{{.Session}}`, `{{.AgentList}}`, and `{{.ProjectDir}}`. Keep the tender daemon running. If the controller is `gone` and Agent Mail has been quiet for more than 10 minutes, try `--robot-smart-restart`, then `--robot-smart-restart --hard-kill`, then return to looper-based supervision.

### Start the durable tend cycle

Start one tender daemon per wave before dispatch (setting `PLUGIN_ROOT` from `data.pluginRoot` returned by `flywheel_doctor` or `flywheel_approve_beads`):

```bash
PLUGIN_ROOT="<data.pluginRoot>"
nohup node "$PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js" \
  --session=agent-flywheel-plugin--impl-<goal-slug> \
  --project="$PWD" \
  --interval=30000 \
  --logfile=.pi-flywheel/tender-events.log \
  --agent=<your-coordinator-name> \
  > /tmp/tender-daemon.log 2>&1 &
echo "tender_daemon_pid=$!"
```

The daemon records inbox and pane-state changes in `.pi-flywheel/tender-events.log`. After resume, read the last 100 events before acting.

After dispatch, schedule re-entry:

```
ScheduleWakeup(
  delaySeconds: 270,
  prompt: "Continue impl wave: tail .pi-flywheel/tender-events.log, check inbox for [impl] *done* messages, and call flywheel_advance_wave with newly closed bead IDs.",
  reason: "Re-enter mid-wave to advance after agents deliver"
)
```

During each tend cycle:

1. Capture state with `ntm --robot-snapshot --robot-format=toon`, then block on `ntm --robot-wait "$SESSION" --wait-until=attention,action_required,mail_ack_required --timeout=90s`.
2. Cross-check `ntm --robot-is-working="$SESSION"` with Agent Mail and `git log --oneline --grep="<full-bead-id>"`. Read and acknowledge `[impl] <full-bead-id> done` messages.
3. About 60 seconds after spawn, confirm each pane registered an Agent Mail identity. Nudge a missing identity with `ntm --robot-send`. ntm can't classify Pi panes, so check each one with `tmux capture-pane -p -t <paneId>` and `tmux display-message -p -t <paneId> '#{pane_dead}'`.
4. Print a tick only when pane state, inbox count, or commits change. Alert only for a pane that holds an assigned bead and sits idle with uncommitted changes, or whose process is dead (`#{pane_dead}`). An idle pane with no assignment is expected, so stay silent about it.
5. Call `ScheduleWakeup(270s, …)` and end the turn while work continues.

> **Tend-cycle note**: `br list` (no flags) shows only `open` and `in_progress`. To check this cycle's completion count, use `br list --status closed --json`. Without it, commits next to 0 closed beads look like implementers skipping the close.

Use `--robot-is-working`, `--robot-agent-health`, `--robot-tail`, and `--robot-send` for live state. `ntm status`, `ntm activity`, and `ntm health` use cached timestamps. `ntm view`, `ntm dashboard`, and `ntm palette` are human interfaces and do not belong in automation.

Pass the project as the positional argument and the purpose through `--label`. A purpose-only session name resolves against `projects_base` and can select the wrong directory.

Leave `.mailbox.activity.lock` and `storage.sqlite3.activity.lock` to their owning Agent Mail runtime. Report liveness problems to the coordinator, who can run `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })`.

Every monitor shell loop must end with `exit 0`, including its timeout path:

```bash
for i in $(seq 1 90); do
  if condition_met; then echo "DONE"; exit 0; fi
  sleep 15
done
echo "timeout"
exit 0
```

### Dispatch the wave

Load `/ntm` and `/vibing-with-ntm` first, before any gate below. Follow `/vibing-with-ntm` for nudge escalation, the stuck-pane ladder, rate-limit probes, context handoff, and convergence termination.

Before writing a check command (type check, test run, lint) into the lane orders, run it once yourself and confirm it examined more than zero items, such as the tsc file count from `--listFiles` or pytest's collected count. Every lane copies the command, so a check that looks at nothing makes every lane report "clean".

When `_offload.md` moved the swarm to another Mac, its `$RUN` rules apply to every pane command in this file.

For wave one, reuse the `approveResult` returned by `_beads.md`. Only call `flywheel_approve_beads(action="start", coordinatorName="<current Agent Mail name>")` when no launch response exists. Assign `approveResult.structuredContent.data` to `START_DATA`; it contains `data.lanes` and `data.prompts`. Later waves use `nextWave.lanes` and `nextWave.prompts`. The server owns provider fallback, agent names, adapter selection, the completion gate, and trailing newlines.

Use `TaskCreate` once per prompt. If several prompts can run in parallel, use `TeamCreate(team_name: "impl-<goal-slug>")`. Reuse an existing planning team or retire its agents and delete it first.

Follow SKILL.md Universal Rule 4 for monitoring errors:

```ts
const code = monitorResult.structuredContent?.data?.error?.code;
if (code === "exec_timeout") return retryMonitorTick();
if (code === "exec_aborted") return stopWaveCleanly();
if (code === "cli_failure") return escalateWithHint(monitorResult.structuredContent?.data?.error?.hint);
```

If a returned lane includes Codex and `codex_config_compat` is non-green, surface this gate:

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

If a returned lane includes Gemini and `gemini_model_compat` is non-green, surface this gate:

```
AskUserQuestion(questions: [{
  question: "Doctor flagged gemini_model_compat: the cached Vercel AI Gateway catalog no longer offers gemini-4-argon, the only model the Gemini lane runs. How to handle the Gemini lane?",
  header: "Gemini",
  options: [
    { label: "Abort and refresh (Recommended)", description: "Stop before spawning, refresh the catalog with flywheel_pi_models({ cwd, action: \"list\", refresh: true }), and rerun the doctor without discarding the server-owned lane assignment." },
    { label: "Continue anyway", description: "Spawn the Gemini panes anyway — Pi exits if the gateway rejects gemini-4-argon." }
  ],
  multiSelect: false
}])
```

In unattended runs, apply the recommended remediation. Stop if compatibility stays non-green. Never rewrite the returned lanes by hand.

When `NTM_AVAILABLE=true`, count the panes per lane from the returned lanes: `N_cc`, `N_pi`, `N_gmi`, and `N_cod`. Codex lanes appear only when Pi or Gemini fell back. Before asking for Pi models, let the operator choose whether to swarm via Claude + Antigravity (`--cc` + `--agy`) or optionally include Pi (`--pi`):

```
AskUserQuestion(questions: [{
  question: "Which agent lanes should this wave's swarm run?",
  header: "Swarm lanes",
  options: [
    { label: "Claude + AGY (Recommended)", description: "Spawn Claude (--cc) + Antigravity (--agy) panes — remap non-cc shares to --agy and skip Pi setup" },
    { label: "Claude + AGY + Pi (optional Pi)", description: "Keep Pi lanes active (--pi=<N_pi>), route Gemini share to --agy/--gmi, and pick Pi models" },
    { label: "Claude only (--cc)", description: "Run all wave beads on Claude (--cc) panes" }
  ],
  multiSelect: false
}])
```

- **Claude + AGY (Recommended):** Set `N_agy = N_pi + N_gmi`, `N_pi = 0`, `N_gmi = 0` (if `DOCTOR_REPORT` shows `agy_cli` unavailable, fold into `N_cc` instead). Skip `flywheel_pi_models` and send `pi`/`gmi` prompt records to the spawned `agy` panes by printed `index`.
- **Claude + AGY + Pi (optional Pi):** Keep `N_pi` above 0 (moving `N_gmi` to `N_agy` when `agy_cli` is green) and run the `flywheel_pi_models` selection below.
- **Claude only (--cc):** Fold all non-`cc` counts into `N_cc` (`N_pi = 0`, `N_gmi = 0`, `N_agy = 0`, `N_cod = 0`).

When `N_pi` is above 0, ask which models the Pi panes run, because the models a login can run and the gateway's top models both change every few weeks:

1. Call `flywheel_pi_models({ cwd, action: "list", roles: ["implementer"] })` and pass `data.questions[0]` to `AskUserQuestion` unchanged. It is multi-select, and its first options are the user's last picks.
2. Call `flywheel_pi_models({ cwd, action: "choose", picks: { implementer: "<answer>" } })` with the answer string unchanged, and set `PI_IMPL_MODEL` from `data.piModels.implementer`. It holds one model, or a comma-separated list that `swarm-spawn.js` alternates across the Pi panes. An `invalid_input` result lists close ids in `error.details.suggestions`; ask again with those. If `list` fails or `piReady` is false, tell the user that the Pi lanes can't start and stop before spawning.

When `N_cc` is above 0, also ask which model the Claude panes run and pass it as `--cc=<N_cc>:<model>`. Without the `:<model>` suffix they start on the CLI default, which can be a generation behind the coordinator. After spawning, read each pane's footer with `tmux capture-pane -p -t <paneId>` and confirm its model. To change a running Claude pane's model, send `/model <id>` then `/clear`. To change a Pi pane, run `tmux respawn-pane -k -t <paneId> -c <repo> "pi --model <id> --thinking high --no-approve"`.

ntm 1.36.1 has no `pi` lane, so `swarm-spawn.js` runs `ntm spawn` for the cc, cod, and agy lanes and adds the Pi panes to the same session with tmux. It runs the gmi panes as Pi on `gemini-4-argon`, since ntm's gmi lane starts the gemini CLI:

```bash
SESSION="${NTM_PROJECT}--impl-<goal-slug>"
node "${PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" "$NTM_PROJECT" --label impl-<goal-slug> \
  --cc=<N_cc> --pi=<N_pi> --pi-model="$PI_IMPL_MODEL" --pi-name=impl --gmi=<N_gmi> --cod=<N_cod> --agy=<N_agy>
```

Drop `--pi` and `--pi-model` when `N_pi` is 0, and drop `--agy` when `N_agy` is 0. The script prints `{ session, panes: [{ lane, index, paneId, model? }], errors }`. A non-zero exit lists what failed in `errors`; tell the user and give the prompts that have no pane to `Agent()` workers as in the fallback below.

The five lanes the script takes are `--cc` (Claude), `--agy` (Antigravity), `--pi` (optional Pi on the picked models), `--gmi` (Pi on gemini-4-argon), and `--cod` (Codex). Pass `--agy=<N_agy>[:<model>[:<effort>]]` when `DOCTOR_REPORT`'s `agy_cli` row is green. `agy models` prints only effort-suffixed slugs such as `gemini-4-argon-high`, so pass that slug or a model plus effort (`--agy=3:gemini-4-argon:high`), which the script joins into the slug. When **Claude + AGY** was selected, send the wave's `pi` and `gmi` prompt records to the `agy` panes by printed `index`.

Process prompt records in array order. Send each record unchanged (pass the full `data.prompts[].prompt` string verbatim, including the `.pi-flywheel/completion/<bead>.json` gate — never summarize or paraphrase) to the next unused pane whose `lane` matches the record's `lane`, by that pane's `index`:

```bash
ntm --robot-send="$SESSION" --panes=<index of the next unused pane in this lane> --msg="<matching data.prompts[].prompt>"
```

Ensure the wave's tender daemon (`node "$PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js" --session="$SESSION" ...` under "Start the durable tend cycle" above) is started right before or immediately after dispatching panes.

Use `--panes=N` with numeric indices. `--pane=N` (singular) is silently broadcast to ALL panes. Don't add `--type`: ntm reports Pi panes as type `unknown`, and pane metadata may not exist yet during startup. Pi and gmi prompts reach Agent Mail through the `am` CLI because Pi panes run with `--no-approve` and load no project MCP servers.

Use `ntm --robot-send`; `ntm send` can abort at the CASS dedup prompt. Surface `data.dispatch.warnings` or `nextWave.warnings` before spawning.

When `NTM_AVAILABLE=false` and the user accepts the fallback, create one isolated `Agent()` worker per returned prompt. Pass the prompt unchanged and use its `agentName`.

If an agent hits a rate limit, invoke `/caam` to switch that model's account without restarting the pane.

### Apply destructive-command safeguards

If an agent proposes a destructive operation, invoke `/slb` for two-person approval. The coordinator is the second party.

When `/dcg` blocks a command, use the corresponding safe operation:

| Blocked command | Safe alternative | Reason |
|-----------------|------------------|--------|
| `rm -rf <dir> && mkdir <dir>` | `mkdir -p <dir>-$$` | Create a new temporary directory. |
| `git checkout HEAD -- <path>` | `git show HEAD:<path> > <path>` | Preserve the index and name the source revision. |
| `git reset --hard <sha>` | `git diff -- <paths> > <scratch>/undo.patch && git apply -R <scratch>/undo.patch` | Undo only your own edits without stash or a branch switch. |
| `git push --force <branch>` | `git push --force-with-lease <branch>` | Refuse to overwrite an unseen remote update. |
| `DROP TABLE <t>` | `ALTER TABLE <t> RENAME TO <t>_deprecated_<date>` | Keep the table recoverable. |
| `rm -rf <dir>` | `mv <dir> /tmp/trash-$(date +%s)-<dir-basename>` | Move the target to temporary storage. |

If no row applies, send `/slb` the command, expected outcome, and recovery plan. Keep harness safety enabled.

The repo's AGENTS.md "never" list (for example stash, hard reset, branch switch) overrides this table. Copy that list into every lane order.

When a permission check denies a pane setup (for example a pane started with permission prompts off), tell the user the permission mode of the panes already running and let them decide. Don't reuse those panes to reach the same state.

### Tend, close, and advance

Mark each dispatched bead `in_progress`. Use full bead ids. The terminal status is `closed`, not `done`. `br update` accepts `--notes`, not `--reason`; `br close` accepts `--reason`.

Store a blocker in CASS when it occurs. Store a completion learning only when it records an API quirk, rename, conflict, or workaround.

If a commit references a bead that is still open or `in_progress`, wait until `TaskList` shows its worker idle. Verify that the diff meets the bead's acceptance criteria, then close and verify the bead:

```bash
br update <full-bead-id> --status closed
br show <full-bead-id> --json | jq -r '.[0].status'
```

This is the only commit-exists close path. If there is no commit after two nudges, implement the bead directly as coordinator instead of spawning a replacement.

After completion, mark the task completed and send the worker a `shutdown_request` by name. Structured shutdown messages cannot be broadcast to `"*"`. If `TaskList` still shows the task active after 60 seconds, use its saved task id with `TaskStop`, retire the Agent Mail identity, and remove a stale team member before `TeamDelete`.

When every bead in the wave is closed or force-stopped, call:

```
flywheel_advance_wave(cwd, closedBeadIds: [<wave-N full bead IDs>], coordinatorName: "<current Agent Mail name>")
```

- If `nextWave.prompts` exists, dispatch the returned prompts from `nextWave.lanes`, call `ScheduleWakeup(270s, …)`, and end the turn.
- If `nextWave` is null and `waveComplete` is true, finish any batch review below first. Then stop the tender daemon with `kill -TERM $tender_daemon_pid`, leave the tmux session available for inspection, and continue to Step 8 in `_review.md`.

### Verification gate

On the Poteto mode track, or when the coordinator runs with `FW_VERIFICATION_REQUIRED=1`, `flywheel_advance_wave` checks every closed bead's completion report before it builds the next wave. A bead passes when its `verification.verdict` is `verified` and the patch id of its commits on HEAD still matches the verified one, so a rebase that keeps the diff passes and any edit after verification does not. The response's `verificationGate` lists the beads it checked and any it carried across a rebase. Otherwise the call returns one of these codes, with every failing bead in `error.details.failures`:

| Code | Meaning | Next step |
|------|---------|-----------|
| `verification_failed` | The verifier recorded a failing verdict. | Send the bead back to its implementer, then verify again. |
| `verification_sha_drift` | The bead's code changed after verification, or its verified commits left HEAD. | Have the verifier rerun the Verify commands at HEAD and call `verify-bead` again. |
| `verification_missing` | No verifier has recorded a verdict. | Run `_beads.md` **Independent verification** for the bead. |

The gate appends each stale or rebase-carried verdict to `.pi-flywheel/ledger.tsv`. Fix every listed bead, then call `flywheel_advance_wave` again with the same `closedBeadIds`.

When a failed verification or rejected review shows a mistake an agent could repeat, store it as a rule: `flywheel_memory({ cwd, operation: "store", content: "<when it happens, what went wrong, what to do instead>" })`. `flywheel_review(action: "cross-agent")` drafts one in `data.selfAnnealingRule` when you pass `rejectedReason`. Later cycles find them with `flywheel_memory({ cwd, operation: "search", query })`.

### Handle commit-batch review steps

Review findings always become beads, and nothing in this loop asks the user. Beads filed from a review belong to the goal, so dispatch them with the rest of the ready queue.

| Signal | Action |
|--------|--------|
| `nextStep.kind` is `batch_review_due` on a `flywheel_advance_wave` result | Dispatch `nextWave.prompts` as usual. Then call `flywheel_review(action="batch_review", shaRange=<nextStep.shaRange>)` and give its `prompt` to one reviewer: a pane with no bead in flight, else an `Agent(subagent_type="general-purpose")` that only writes the verdict file. |
| A `[batch-review] <range> verdict ready` message | Call `flywheel_review(action="batch_review", shaRange="<range>")` again. It files one bead per finding at a priority set by its severity, or one re-review bead for an unreadable verdict, and returns `nextStep.kind` `advance_wave`. |
| `advance_wave` | Call `flywheel_advance_wave` with the last closed wave, then dispatch any returned `nextWave.prompts` from `nextWave.lanes`. |

`flywheel_advance_wave` also files the beads for a verdict that lands before you call back, and lists ranges still waiting on a reviewer in `batchReviews.pending`. A review that never reports holds nothing up. If the queue drains while a range is pending, wait for its verdict before Step 8, because its beads are the next wave.

### Serialize generated build output

When several beads build the same generated directory, designate one bead as the build committer. Other beads commit source only. The coordinator can instead commit one final build at wrap-up. If two beads commit identical generated bytes, record it without rewriting history.

### Recover a stalled bead

Use this fallback table after the normal `/vibing-with-ntm` nudge and restart sequence:

| Symptom | Action |
|---------|--------|
| Multiple agents select one bead | Stagger starts, require the `in_progress` claim before edits, and audit reservations. |
| An agent loses its dispatch after compaction | Send its server-issued prompt again, then continue from its last Agent Mail message. |
| A bead stays `in_progress` | Read its Agent Mail thread. Apply the single commit-exists path above or implement it directly. |
| Beads conflict | Audit reservations and split shared file ownership. |
| Commits no longer serve the goal | Run the Step 9 reality check. |

Before the final retry, offer Codex rescue when the same error code repeats, a pane remains idle for more than five minutes after the second nudge with no bead commit, or a third reassignment is about to start:

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

For the Codex route, call `flywheel_rescue({ cwd, phase: "impl", beadId, errorEnvelope })`, send `codexPrompt` to `/codex:rescue --wait`, and store `memoryLine` with `flywheel_memory`. Apply a returned diff with `git apply --3way`, create a `fixup!` commit that references the bead, and rerun the implementation gates. Route a clarifying question through `AskUserQuestion`. If Codex also stalls, abort and leave the bead for manual reassignment.

After the wave finishes, continue in the same turn to Step 8 in `_review.md` and surface its **Looks good / Self review / Fresh-eyes** question.
