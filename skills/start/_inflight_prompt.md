# Universal In-Flight Prompt — `/agent-flywheel:start` for resuming projects

**When to use:** the user invoked `/agent-flywheel:start` against a project that already has open and/or in-progress beads (and optionally an existing flywheel session). This is the **default Recommended option** in Step 0d when in-flight state is detected.

**How to use:** read this file, then execute the instructions below verbatim. Do NOT paraphrase, summarize, or strip skill references — the slash-named skills (`/ntm`, `/vibing-with-ntm`, `/rch`, `/bv`, `/beads-workflow`, `/testing-*`, `/mock-code-finder`, etc.) are load-bearing and must be invoked via the `Skill` tool when the workflow reaches that step.

---

## The prompt (verbatim)

> ❯ Reread [AGENTS.md](http://AGENTS.md) so it's still fresh in your mind.
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

## Operator decoder (apply while executing the prompt above)

| Phrase in prompt | Concrete action |
|------------------|-----------------|
| "use /ntm and /vibing-with-ntm" | Invoke both skills via `Skill` tool BEFORE spawning. They carry the canonical orchestrator decision tree, OC cards, stuck-pane ladder. |
| "swarm comprising 2 cc + 2 cod + 2 gmi" (cc:cod:gem 1:1:1, six panes) | Execute the **Shared swarm pre-conditions** below. When the final result permits NTM, run `ntm spawn $NTM_PROJECT --label inflight-resume --no-user --cc=2 --cod=2 --gmi=2 --stagger-mode=smart` with the lane substitutions it produced. The canonical pane indices are cc=1,2, cod=3,4, and gmi=5,6. |
| "clearing stale build artifacts" | Every 30 min OR when disk free <5GB, run `git clean -fdX -- '<build-output-dirs>'` (respects gitignore, only removes ignored build artifacts). Never run `git clean -fdx` (lowercase x) — that nukes untracked source files. |
| "use rch for all builds/tests (see /rch)" | Invoke `/rch` skill for the canonical build-runner contract. Pass `rch build` / `rch test` to each impl agent's prompt as the validate-gate command instead of a stack-specific `npm run build` / `cargo test`. |
| "avoid excessive build contention" | Implement a project-level build mutex via the portable wrapper: `scripts/build-mutex.sh rch build` and `scripts/build-mutex.sh rch test`. Document this in each impl agent's STEP 2 prompt. The wrapper uses atomic `mkdir` locking and does not require the Linux-only `flock` binary. |
| "use your looper tool every 4 minutes" | **Default:** `Skill: loop` with `4m` interval, prompt = "tail .pi-flywheel/tender-events.log; check inbox; run `ntm work triage --by-track` to see prioritized work; nudge idle panes via `ntm assign "$NTM_PROJECT" --auto --strategy=dependency`; reopen stalled in_progress beads". **Alternative:** spawn `ntm controller "$NTM_PROJECT" --agent-type=cc` in pane 0 — built-in coordinator agent with default `--robot-snapshot` → `--robot-attention` → `--robot-tail` → mail-check → `--robot-interrupt` loop, so the main Claude session can exit cleanly. Custom prompt via `--prompt=<file>` with `{{.Session}}`, `{{.AgentList}}`, `{{.ProjectDir}}` template variables for swarm-specific context. Tender-daemon stays running in either mode. |
| "wave drained → first-empty-tick gate" (claude-orchestrator-29bt) | **Operator gate at `EMPTY_TICKS == 1` (MANDATORY, per UNIVERSAL RULE 1 in `skills/start/SKILL.md`).** Before unilaterally dispatching the next review wave, saturation skills, or teardown, the loop MUST surface an `AskUserQuestion` so the operator can redirect. Concretely, the first iteration that observes `in_progress == 0 AND ready == 0 AND open == 0`: write `EMPTY_TICKS = 1`, then call `AskUserQuestion({ question: "Bead queue drained (<N> closed this session). What should the swarm do next?", header: "Drained", options: [{ label: "Review wave", description: "Dispatch a fresh-eyes review wave over recent commits via `ntm --robot-send` to the active panes — saturated when ≤1 new bead emerges" }, { label: "Saturation skills", description: "Run the broader suite (`/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/profiling-software-performance`, `/security-audit-for-saas`, `/simplify-and-refactor-code-isomorphically`) — convert findings into new beads" }, { label: "Reality check", description: "Strategic gap-check vs AGENTS.md / README.md / plan docs — surface vision drift before declaring done. Reads `skills/start/_reality_check.md`" }, { label: "Wrap up now", description: "Skip further reviews; tear down (CronDelete, kill tender daemon, optional `ntm kill-session`), commit a release bump if scope warrants, transition to Step 9.5 wrap-up via `_wrapup.md`" }] })`. Route the choice immediately and continue the next iteration accordingly. Do NOT silently auto-dispatch review wave-N — the operator must consent at this gate. **Skip the gate** only when the user pre-authorized autonomous post-drainage flow with an explicit instruction earlier in the session ("run all the review waves yourself", "don't ask me, just drive it"). The 5-tick `PushNotification` teardown fallback below still fires as a safety net if the operator never answers. |
| "wave drained → auto-teardown" (P3.2 / 2ox) | **Empty-tick counter:** every subsequent loop iteration (tick 2 onward, after the first-empty-tick gate above has fired), check whether `in_progress == 0 AND ready == 0 AND open == 0` (still a "fully empty wave"). Maintain a counter `EMPTY_TICKS` in the loop's note state (or in `.pi-flywheel/empty-ticks.txt`). Increment on every empty tick; **reset to 0 the moment any ready/in_progress/open bead reappears**. **At `EMPTY_TICKS == 5` (default; ~20 min at 4m interval):** emit a single `PushNotification(message: "Wave drained — 5 consecutive empty ticks. Recommend teardown: CronDelete <id>; kill -TERM $TENDER_PID; ntm kill-session $SESSION", urgency: "normal")`, log the recommendation to `.pi-flywheel/tender-events.log`, and **stop scheduling further loop iterations**. The looper does NOT execute the teardown itself — only the operator confirms. **Override:** if the operator says "keep going" / "wait for more beads" within 30 min, reset `EMPTY_TICKS = 0` and resume scheduling. **Don't false-positive:** a single in-progress long-running bead (e.g., a 30-min impl) is NOT an empty wave — the counter only ticks when the entire bead graph is drained. |
| "guided by bv's triage command" | **Operator-readable:** `ntm work triage --by-track` returns prioritized work grouped by track (the canonical operator-friendly path; wraps `bv` under the hood). **Machine-readable:** `bv --robot-triage --json` for structured output if you need to parse. **Dispatch:** `ntm assign "$NTM_PROJECT" --auto --strategy=dependency` picks the next ready bead off the `bv` graph and registers the assignment to an idle pane — preferred over an ad-hoc `ntm --robot-send` for routine "next bead" selection. Use `--robot-send` only when you want to deliver a specific custom message. |
| "stalled out" beads | Reopen rule: bead status=in_progress AND no commit referencing bead in last 30 min AND assigned-agent absent from `list_window_identities`. Run `br update <id> --status open` and re-dispatch. |
| "code review workflow in /vibing-with-ntm" | When all beads closed, invoke `/vibing-with-ntm` review section. Reuse the live swarm panes — do NOT spawn fresh reviewers. |
| "/testing-* skills" | After review convergence, invoke applicable testing skills to backfill coverage. New work goes through `br create` first. |
| "saturation" | Convergence rule (per `_implement.md` swarm-wide stop): 2 review cycles produce ≤1 new actionable finding each. |
| "saturation reached + ≥80% of original beads closed" | **Hard gate (new in v3.6.5):** before declaring the wave done, surface `AskUserQuestion(question: "Reviews converged + <X>% of original beads closed. Run a strategic reality-check pass before declaring done?", options: [{label: "Yes — run reality-check", desc: "Read skills/start/_reality_check.md, run Phase 1 (gap report against AGENTS.md/README.md), optionally convert findings to new beads"}, {label: "Skip — proceed to saturation skills", desc: "Run the broader saturation suite below without the strategic alignment lens"}, {label: "Skip — proceed to wrap-up", desc: "Findings are clearly minor; jump to Step 9.5"}])`. Default-recommend "Yes" — agents have been deep in code; this is exactly when stepping back has the highest leverage. |
| "more useful things to do" skills | `/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/modes-of-reasoning-project-analysis`, `/profiling-software-performance`, `/security-audit-for-saas`, `/simplify-and-refactor-code-isomorphically`. **Recommended path:** read `skills/start/_saturation.md` end-to-end and run the unified saturation pipeline (orchestrates all skills, deduplicates findings, produces one bead-creation pass). Each finding becomes a new bead via `br create`, dispatched into the existing swarm via `flywheel_advance_wave`. |
| `/simplify-and-refactor-code-isomorphically` (deslop) | After review saturation, if any subsystem has noticeably high LOC-to-behavior ratio or AI-junk patterns (defensive branches for impossible inputs, duplicated wrappers, `_v2` files, orphaned helpers), invoke this skill scoped to the identified subsystem(s). Each candidate becomes a new bead via `br create` so the swarm dispatches it through `flywheel_advance_wave`. For dedicated deslop runs (not saturation-triggered), see `skills/start/_deslop.md` instead. |

---

## Shared swarm pre-conditions (run before dispatch)

1. **NTM and provider readiness.** Execute `_implement.md` **Pre-flight: resolve NTM readiness** and use its final `DOCTOR_REPORT`, `NTM_AVAILABLE`, and `NTM_PROJECT`. An unavailable result ends this swarm branch and takes the procedure's single-agent fallback. The Windows-native branch below provides its platform route. For an NTM spawn, derive the lane shape from the final report's CLI, `swarm_model_ratio`, and model-compatibility rows. Do not call `which` or the doctor again. Treat a requested lane as unavailable when its row is non-green, then apply the AGENTS.md substitution ladder (`gmi→cod→pi→cc`). This `--no-user` flow logs each downgrade without another question. If both `cod` and `gmi` are unavailable and the operator has not approved all-cc, surface the degraded-mode `AskUserQuestion`. Treat a missing compatibility row from an older server as green.
2. **Agent Mail bootstrap.** Run `macro_start_session` for the coordinator and capture the registration token.
   - When writing `.pi-flywheel/inflight-briefing.md` for spawned panes, its STEP 0 must tell agents to reuse NTM's pane identity: if `$NTM_AGENT_NAME` is set, call `macro_start_session(..., agent_name: "$NTM_AGENT_NAME")` and use that same value for `AGENT_NAME` in git commands.
   - If `$NTM_AGENT_NAME` is absent, call `macro_start_session` without `agent_name`, capture the generated name, and note that audit trails will remain split until NTM exports the pane identity. Current `ntm spawn --help` exposes `NTM_SPAWN_*` metadata but no `NTM_AGENT_NAME` / `--agent-name` support.
3. **Disk-space guard.** Run `df -h $PWD`. If free space is below 5GB, remove stale ignored build artifacts before spawning.
4. **Tender-daemon spawn.** Start `node $CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js --session=… --project=$PWD --interval=30000 --logfile=.pi-flywheel/tender-events.log --agent=<your-name> &` and capture its PID. Pass `--project` for compatibility with versions before v3.6.7.
5. **Bead snapshot.** Run `br list --json` and `br ready --json`. Reopen stalled in-progress beads under the rule above.
6. **Looper schedule.** Invoke `Skill: loop` with a `4m` interval and the marching orders from the operator-decoder table.

After all six pass, dispatch the swarm and enter the monitor loop documented in `_implement.md` Pre-loop / Implementation loop / Post-wave bridge.

### Windows-native fallback (T5.5)

If `process.platform === 'win32'` AND `NTM_AVAILABLE === false` (no tmux on native Windows), the parallel-swarm path is structurally unavailable. Replace the cc:cod:gem 2:2:2 plan (or whatever the substitution ladder degraded to) with sequential bead processing through `Agent()`. Before announcing the dispatch, display:

```
ℹ Windows-native detected without NTM. Auto-swarm will run beads SEQUENTIALLY via Agent()
  rather than in parallel tmux panes. For full parallel swarm, run inside WSL2:
    wsl -e bash -c "cd $(pwd) && claude"
  then re-run /agent-flywheel:start from inside the WSL shell.
```

Then re-frame the rest of the in-flight prompt:

- **Pane spawning** → replaced with serial `Agent()` calls carrying the same marching-orders body (subagent_type matching the original pane type: `cc` panes map to a CC subagent; `cod` and `gmi` panes are not yet built-in subagents and should fall back to `general-purpose`).
- **Concurrency** → drops from 6 concurrent to 1 sequential. The 4-min looper is unnecessary because there's nothing to tend between dispatches — invoke `flywheel_advance_wave` once after each `Agent()` returns rather than scheduling a recurring `loop`.
- **Tender-daemon** → still spawn it (it observes Beads + Agent Mail regardless of pane backing) but at the lower 60s interval since there's no pane stall risk to catch.
- **Build mutex** → not needed; sequential dispatch can't deadlock against itself.

All other pre-conditions (Agent Mail bootstrap, provider readiness, disk-space guard, bead snapshot) run unchanged. The pane-type priority rule in the operator-decoder table is moot on this branch — there are no panes.

WSL2 is the recommended path for any real swarm work on Windows; the native fallback exists so a Windows operator can still complete a `/start` invocation end-to-end (just slower and serially) without being told to go install tmux first.

---

## Termination / hand-off

- All beads closed AND review converged AND no new beads from saturation skills → `kill -TERM $tender_daemon_pid`, leave NTM session alive, transition to Step 9.5 wrap-up via `_wrapup.md`. **Convergence is reached via the first-empty-tick operator gate (claude-orchestrator-29bt), not auto-driven.** The loop MUST surface the gate at `EMPTY_TICKS == 1` before unilaterally dispatching review wave / saturation suite / teardown — see the "wave drained → first-empty-tick gate" row in the operator decoder.
- User interrupts via the looper or directly → pause politely; do NOT force-stop agents until user confirms.
- Build mutex wait/deadlock detected (`scripts/build-mutex.sh` warns after ~5min by default) → escalate via `/slb` two-person approval before killing.
- **Wave drained — 5 consecutive empty ticks (P3.2 / 2ox)** → emit one-shot `PushNotification` recommending `CronDelete <id>` + `kill -TERM $TENDER_PID` + `ntm kill-session $SESSION`, then **stop scheduling further loop iterations** until the operator confirms teardown OR explicitly says "keep going". Counter resets the moment any open/ready/in_progress bead reappears. See "wave drained → auto-teardown" row in the operator decoder for the exact tick semantics.
