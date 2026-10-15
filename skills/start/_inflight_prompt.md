# Universal In-Flight Prompt — `/agent-flywheel:start` for resuming projects

**When to use:** the user invoked `/agent-flywheel:start` against a project that already has open and/or in-progress beads (and optionally an existing flywheel session). This is the default Recommended option in Step 0d when in-flight state is detected.

**How to use:** read this file, then execute the instructions below verbatim. Do not paraphrase or strip skill references — the slash-named skills (`/ntm`, `/vibing-with-ntm`, `/rch`, `/bv`, `/beads-workflow`, `/testing-*`, `/mock-code-finder`, etc.) are load-bearing and must be invoked via the `Skill` tool when the workflow reaches that step.

---

## The prompt (verbatim)

> ❯ Reread the plugin's own [AGENTS.md](http://AGENTS.md) at `$CLAUDE_PLUGIN_ROOT/AGENTS.md` so its rules are still fresh in your mind. The user project may ship its own `AGENTS.md`; the quality-gate text pasted into pane prompts below comes from the plugin's copy, not the user's.
>
> Then, I need you to use /ntm and /vibing-with-ntm to create a swarm comprising 2 cc instances, 2 cod instances, and 2 gmi instances (the canonical **cc:cod:gem 1:1:1** model-diversified shape per AGENTS.md NTM pane priority; substitution ladder `gmi→cod→pi→cc` reassigns any lane that's unavailable on this host). Make sure also that we don't run out of space by periodically clearing stale build artifacts. And make sure to use rch for all builds/tests (see /rch).
>
> Try to avoid excessive build contention from concurrent builds for the same project by multiple agents within the same project-level swarm. And use your looper tool every 4 minutes to pass fresh instructions to any agents in the swarms in need of further input (i.e., that are idle), guided by bv's (see /bv) triage command for open beads.
>
> Also look for beads that are clearly "stalled out"; that is, marked as being in progress (likely by long-dead agents), with no recent work on them whatsoever, and mark them as being open again.
>
> Keep going until all the beads are done; then transition into using the code review workflow in /vibing-with-ntm and reuse whichever model lanes survived the substitution ladder (cc + cod + gmi by default; cc + cod if gmi was downgraded; cc-only if both cod and gmi were downgraded).
>
> You can also use the various skills with names beginning with the string "testing-" to improve our testing posture (e.g., /testing-perfect-e2e-integration-tests-with-logging-and-no-mocks, /testing-conformance-harnesses, /testing-golden-artifacts, /testing-fuzzing, etc., as relevant and applicable).
>
> And if we are done working on all open or stalled beads, and the review rounds are starting to converge and appear to be saturated (i.e., not many new bugs being found and fixed relative to the effort and token usage), then you can start applying various skills such as /mock-code-finder, /deadlock-finder-and-fixer, /reality-check-for-project, /modes-of-reasoning-project-analysis, /profiling-software-performance, /security-audit-for-saas, and /simplify-and-refactor-code-isomorphically (only to the extent applicable) to helpfully come up with more useful things to do, which you can then create new beads for using br (see /beads-workflow) and execute using /vibing-with-ntm and the existing swarm.

---

## First-empty-tick operator gate (claude-orchestrator-29bt)

Before any auto-dispatch of a review wave, saturation skills, or teardown when the bead queue drains, the loop surfaces this verbatim `AskUserQuestion` so the operator can redirect (Universal Rule 1):

```
AskUserQuestion({
  question: "Bead queue drained (<N> closed this session). What should the swarm do next?",
  header: "Drained",
  options: [
    { label: "Review wave",       description: "Dispatch a fresh-eyes review wave over recent commits via `ntm --robot-send` to the active panes — saturated when ≤1 new bead emerges" },
    { label: "Saturation skills", description: "Run the broader suite (`/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/profiling-software-performance`, `/security-audit-for-saas`, `/simplify-and-refactor-code-isomorphically`) — convert findings into new beads" },
    { label: "Reality check",     description: "Strategic gap-check vs the plugin's AGENTS.md and the user project's README / plan docs — surface vision drift before declaring done. Reads `skills/start/_reality_check.md`" },
    { label: "Wrap up now",       description: "Skip further reviews; tear down (CronDelete, kill tender daemon, optional `ntm kill-session`), commit a release bump if scope warrants, transition to Step 9.5 wrap-up via `_wrapup.md`" }
  ]
})
```

Route the chosen option immediately. Skip the gate only when the user pre-authorized autonomous post-drain flow earlier in the session ("run all the review waves yourself", "don't ask me, just drive it"). The 5-tick teardown fallback below still fires if the operator never answers.

---

## Operator spec (apply while executing the prompt above)

1. **Load the ladder.** Invoke `/ntm` and `/vibing-with-ntm` via the `Skill` tool before any pane spawn. They carry the orchestrator decision tree, OC cards, and stuck-pane ladder.

2. **Resolve readiness.** Run `_implement.md` **Pre-flight: resolve NTM readiness** and reuse its `DOCTOR_REPORT`, `NTM_AVAILABLE`, and `NTM_PROJECT`. Derive the lane shape from the final report's CLI, `swarm_model_ratio`, and model-compatibility rows (treat a non-green row as unavailable; a missing row from an older server as green). Apply the substitution ladder `gmi→cod→pi→cc`. Do not re-call `which` or the doctor. If both `cod` and `gmi` are unavailable and the operator has not approved all-cc, surface the degraded-mode `AskUserQuestion`.

3. **Spawn the swarm.** When the lane shape permits NTM, run `ntm spawn "$NTM_PROJECT" --label inflight-resume --no-user --cc=2 --cod=2 --gmi=2 --stagger-mode=smart` with any ladder substitutions applied. Canonical pane indices are cc=1,2, cod=3,4, gmi=5,6.

4. **Agent Mail bootstrap.** Call `macro_start_session` for the coordinator and capture the registration token. When writing `.pi-flywheel/inflight-briefing.md` for the panes, its STEP 0 tells each agent to reuse NTM's pane identity: if `$NTM_AGENT_NAME` is set, pass it to `macro_start_session` and use the same value for `AGENT_NAME` in git commands; otherwise call `macro_start_session` without `agent_name`, capture the generated name, and note that audit trails will remain split until NTM exports the pane identity.

5. **Quality gate.** Paste the plugin's own gate and attestation sections into each pane's marching-orders message. Read them from `$CLAUDE_PLUGIN_ROOT/AGENTS.md` ("Pre-Completion Quality Gate" and "Completion Evidence Attestation") — the panes have neither that file nor the env var, and the user project's `AGENTS.md` has no gate. Do not point the pane prompts at a bare `AGENTS.md`.

6. **Build mutex.** Each pane prompt's STEP 2 uses the plugin's wrapper, which the coordinator expands before sending: `"$CLAUDE_PLUGIN_ROOT/scripts/build-mutex.sh" rch build` and `"$CLAUDE_PLUGIN_ROOT/scripts/build-mutex.sh" rch test`. The wrapper uses atomic `mkdir` locking under `.pi-flywheel/` and does not need the Linux-only `flock` binary. Repo-relative `scripts/build-mutex.sh` breaks in a user's project.

7. **Disk guard.** Run `df -h $PWD`. Below 5 GB free, remove stale ignored build artifacts via `git clean -fdX -- '<build-output-dirs>'` (respects gitignore). Never run `git clean -fdx` (lowercase x) — that nukes untracked source files.

8. **Use `rch` for build/test.** Invoke `/rch` for the canonical build-runner contract. Each pane's validate-gate command is `rch build` / `rch test` wrapped in the build mutex, not a stack-specific `npm run build` / `cargo test`.

9. **Tender daemon.** Start `node "$CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js" --session="$SESSION" --project="$PWD" --interval=30000 --logfile=.pi-flywheel/tender-events.log --agent="<your-name>" &` and capture its PID. Pass `--project` for compatibility with versions before v3.6.7. The daemon owns the empty-wave counter — see item 12.

10. **Bead snapshot.** Run `br list --json` and `br ready --json`. Reopen stalled in-progress beads under the rule: status=in_progress AND no commit referencing the bead in the last 30 min AND assigned-agent absent from `list_window_identities`. Run `br update <id> --status open` and re-dispatch.

11. **Looper schedule.** Invoke `Skill: loop` with a `4 min` interval and the marching orders: tail `.pi-flywheel/tender-events.log`, poll Agent Mail, run `ntm work triage --by-track` for prioritized work (`bv --robot-triage --json` for parsed form), and dispatch next-bead picks via `ntm assign "$NTM_PROJECT" --auto --strategy=dependency` to idle panes. Reserve ad-hoc `ntm --robot-send` for custom messages. Alternative: spawn `ntm controller "$NTM_PROJECT" --agent-type=cc` in pane 0 — its built-in loop (`--robot-snapshot` → `--robot-attention` → `--robot-tail` → mail check → `--robot-interrupt`) lets the main Claude session exit cleanly; the tender daemon stays running either way.

12. **Queue-drained signal (daemon-owned).** The tender daemon's `runTenderDaemonOnce` tracks consecutive empty-wave ticks: when `beadCounts.open == 0 && .ready == 0 && .inProgress == 0`, it emits a `queue_drained` event carrying a 1-indexed `emptyTickCount`; any non-zero bead count resets the counter. The looper reads the event, surfaces the first-empty-tick operator gate above at `emptyTickCount == 1`, and at `emptyTickCount == 5` (default; ~20 min at the 4-min interval) emits one `PushNotification(message: "Wave drained — 5 consecutive empty ticks. Recommend teardown: CronDelete <id>; kill -TERM $TENDER_PID; ntm kill-session $SESSION", urgency: "normal")`, logs the recommendation, and stops scheduling further iterations. The looper does not execute the teardown — the operator confirms. See `mcp-server/src/tender.ts` for the counter semantics and `src/__tests__/tender-queue-drained.test.ts` for the invariants (first-tick emits, consecutive ticks increment, any reappearing bead resets, snapshots without `beadCounts` leave the counter untouched).

13. **Review workflow.** When all beads close, invoke `/vibing-with-ntm`'s review section and reuse the live swarm panes — do not spawn fresh reviewers.

14. **Saturation.** Convergence rule (per `_implement.md` swarm-wide stop): two review cycles produce ≤1 new actionable finding each. After saturation and ≥80% of original beads closed, surface the reality-check question (default "Yes" — stepping back has highest leverage when agents have been deep in code). Then run `skills/start/_saturation.md`'s unified pipeline (`/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/modes-of-reasoning-project-analysis`, `/profiling-software-performance`, `/security-audit-for-saas`, `/simplify-and-refactor-code-isomorphically`) — each finding becomes a new bead via `br create` and dispatches into the existing swarm via `flywheel_advance_wave`.

15. **Dedicated deslop.** For a focused refactor pass (not saturation-triggered), read `skills/start/_deslop.md` instead.

After items 1–11 pass, dispatch the swarm and enter the monitor loop documented in `_implement.md` Pre-loop / Implementation loop / Post-wave bridge.

### Windows-native fallback (T5.5)

If `process.platform === 'win32'` AND `NTM_AVAILABLE === false` (no tmux on native Windows), the parallel-swarm path is structurally unavailable. Replace the cc:cod:gem 2:2:2 plan (or whatever the ladder degraded to) with sequential bead processing through `Agent()`. Before announcing the dispatch, display:

```
ℹ Windows-native detected without NTM. Auto-swarm will run beads SEQUENTIALLY via Agent()
  rather than in parallel tmux panes. For full parallel swarm, run inside WSL2:
    wsl -e bash -c "cd $(pwd) && claude"
  then re-run /agent-flywheel:start from inside the WSL shell.
```

Then re-frame the rest of the in-flight prompt:

- **Pane spawning** → replaced with serial `Agent()` calls carrying the same marching-orders body (subagent_type matching the original pane type: `cc` panes map to a CC subagent; `cod` and `gmi` panes are not yet built-in subagents and should fall back to `general-purpose`).
- **Concurrency** → drops from 6 concurrent to 1 sequential. The 4-min looper is unnecessary because there's nothing to tend between dispatches — invoke `flywheel_advance_wave` once after each `Agent()` returns rather than scheduling a recurring `loop`.
- **Tender-daemon** → still spawn it (it observes beads + Agent Mail regardless of pane backing) but at the lower 60s interval since there's no pane stall risk to catch.
- **Build mutex** → not needed; sequential dispatch can't deadlock against itself.

All other pre-conditions (Agent Mail bootstrap, provider readiness, disk-space guard, bead snapshot) run unchanged. The pane-type priority rule in item 2 is moot on this branch — there are no panes.

WSL2 is the recommended path for any real swarm work on Windows; the native fallback exists so a Windows operator can still complete a `/start` invocation end-to-end (just slower and serially) without being told to go install tmux first.

---

## Termination / hand-off

- All beads closed AND review converged AND no new beads from saturation skills → `kill -TERM $tender_daemon_pid`, leave NTM session alive, transition to Step 9.5 wrap-up via `_wrapup.md`. Convergence is reached via the first-empty-tick operator gate above, not auto-driven.
- User interrupts via the looper or directly → pause politely; do not force-stop agents until the user confirms.
- Build mutex wait/deadlock detected (`"$CLAUDE_PLUGIN_ROOT/scripts/build-mutex.sh"` warns after ~5 min by default) → escalate via `/slb` two-person approval before killing.
- Daemon emits `queue_drained` with `emptyTickCount == 5` → the looper's one-shot `PushNotification` fires (see item 12). Any reappearing open/ready/in_progress bead resets the counter to 0.
