# Universal In-Flight Prompt — `/agent-flywheel:start` for resuming projects

**When to use:** the user invoked `/agent-flywheel:start` against a project that already has open and/or in-progress beads (and optionally an existing flywheel session). This is the **default Recommended option** in Step 0d when in-flight state is detected.

**How to use:** read this file, then execute the instructions below verbatim. Do NOT paraphrase, summarize, or strip skill references — the slash-named skills (`/ntm`, `/vibing-with-ntm`, `/rch`, `/bv`, `/beads-workflow`, `/testing-*`, `/mock-code-finder`, etc.) are load-bearing and must be invoked via the `Skill` tool when the workflow reaches that step.

---

## The prompt (verbatim)

> ❯ Reread [AGENTS.md](http://AGENTS.md) so it's still fresh in your mind.
>
> Then, I need you to use /ntm and /vibing-with-ntm to create a swarm comprising 4 cod instances and 2 cc instances. Make sure also that we don't run out of space by periodically clearing stale build artifacts. And make sure to use rch for all builds/tests (see /rch).
>
> Try to avoid excessive build contention from concurrent builds for the same project by multiple agents within the same project-level swarm. And use your looper tool every 4 minutes to pass fresh instructions to any agents in the swarms in need of further input (i.e., that are idle), guided by bv's (see /bv) triage command for open beads.
>
> Also look for beads that are clearly "stalled out"; that is, marked as being in progress (likely by long-dead agents), with no recent work on them whatsoever, and mark them as being open again.
>
> Keep going until all the beads are done; then transition into using the code review workflow in /vibing-with-ntm and using cc and cod instances from the swarm.
>
> You can also use the various skills with names beginning with the string "testing-" to improve our testing posture (e.g., /testing-perfect-e2e-integration-tests-with-logging-and-no-mocks, /testing-conformance-harnesses, /testing-golden-artifacts, /testing-fuzzing, etc., as relevant and applicable).
>
> And if we are done working on all open or stalled beads, and the review rounds are starting to converge and appear to be saturated (i.e., not many new bugs being found and fixed relative to the effort and token usage), then you can start applying various skills such as /mock-code-finder, /deadlock-finder-and-fixer, /reality-check-for-project, /modes-of-reasoning-project-analysis, /profiling-software-performance, /security-audit-for-saas, and /simplify-and-refactor-code-isomorphically (only to the extent applicable) to helpfully come up with more useful things to do, which you can then create new beads for using br (see /beads-workflow) and execute using /vibing-with-ntm and the existing swarm.

---

## Operator decoder (apply while executing the prompt above)

| Phrase in prompt | Concrete action |
|------------------|-----------------|
| "use /ntm and /vibing-with-ntm" | Invoke both skills via `Skill` tool BEFORE spawning. They carry the canonical orchestrator decision tree, OC cards, stuck-pane ladder. |
| "swarm comprising 4 cod instances and 2 cc instances" | `ntm spawn $NTM_PROJECT --label inflight-resume --no-user --cc=2 --cod=4 --stagger-mode=smart`. Pane indices: cc=1,2  cod=3,4,5,6. Run NTM readiness gate (Step 7 Pre-flight in `_implement.md`) first. |
| "clearing stale build artifacts" | Every 30 min OR when disk free <5GB, run `git clean -fdX -- '<build-output-dirs>'` (respects gitignore, only removes ignored build artifacts). Never run `git clean -fdx` (lowercase x) — that nukes untracked source files. |
| "use rch for all builds/tests (see /rch)" | Invoke `/rch` skill for the canonical build-runner contract. Pass `rch build` / `rch test` to each impl agent's prompt as the validate-gate command instead of a stack-specific `npm run build` / `cargo test`. |
| "avoid excessive build contention" | Implement a project-level build mutex: `flock .pi-flywheel/build.lock rch build` so only one agent compiles at a time. Document this in each impl agent's STEP 2 prompt. |
| "use your looper tool every 4 minutes" | `Skill: loop` with `4m` interval, prompt = "tail .pi-flywheel/tender-events.log; check inbox; nudge idle panes guided by `bv triage`; reopen stalled in_progress beads". |
| "guided by bv's triage command" | `bv --robot-triage` (or `bv triage` if --robot-* unsupported) returns the prioritized open-bead list. Feed top-N beads to idle agents via `ntm --robot-send`. |
| "stalled out" beads | Reopen rule: bead status=in_progress AND no commit referencing bead in last 30 min AND assigned-agent absent from `list_window_identities`. Run `br update <id> --status open` and re-dispatch. |
| "code review workflow in /vibing-with-ntm" | When all beads closed, invoke `/vibing-with-ntm` review section. Reuse the live swarm panes — do NOT spawn fresh reviewers. |
| "/testing-* skills" | After review convergence, invoke applicable testing skills to backfill coverage. New work goes through `br create` first. |
| "saturation" | Convergence rule (per `_implement.md` swarm-wide stop): 2 review cycles produce ≤1 new actionable finding each. |
| "saturation reached + ≥80% of original beads closed" | **Hard gate (new in v3.6.5):** before declaring the wave done, surface `AskUserQuestion(question: "Reviews converged + <X>% of original beads closed. Run a strategic reality-check pass before declaring done?", options: [{label: "Yes — run reality-check", desc: "Read skills/start/_reality_check.md, run Phase 1 (gap report against AGENTS.md/README.md), optionally convert findings to new beads"}, {label: "Skip — proceed to saturation skills", desc: "Run the broader saturation suite below without the strategic alignment lens"}, {label: "Skip — proceed to wrap-up", desc: "Findings are clearly minor; jump to Step 9.5"}])`. Default-recommend "Yes" — agents have been deep in code; this is exactly when stepping back has the highest leverage. |
| "more useful things to do" skills | `/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/modes-of-reasoning-project-analysis`, `/profiling-software-performance`, `/security-audit-for-saas`, `/simplify-and-refactor-code-isomorphically`. **Recommended path:** read `skills/start/_saturation.md` end-to-end and run the unified saturation pipeline (orchestrates all skills, deduplicates findings, produces one bead-creation pass). Each finding becomes a new bead via `br create`, dispatched into the existing swarm via `flywheel_advance_wave`. |
| `/simplify-and-refactor-code-isomorphically` (deslop) | After review saturation, if any subsystem has noticeably high LOC-to-behavior ratio or AI-junk patterns (defensive branches for impossible inputs, duplicated wrappers, `_v2` files, orphaned helpers), invoke this skill scoped to the identified subsystem(s). Each candidate becomes a new bead via `br create` so the swarm dispatches it through `flywheel_advance_wave`. For dedicated deslop runs (not saturation-triggered), see `skills/start/_deslop.md` instead. |

---

## Pre-conditions checklist (run before dispatching the swarm)

1. **NTM readiness gate** — re-detect inline (per `_implement.md` Pre-flight). If misconfigured, surface fix-or-fallback `AskUserQuestion`.
2. **Agent Mail bootstrap** — `macro_start_session` for the coordinator (you). Capture your registration token.
3. **CLI capability check** — `which claude codex` (gemini optional). If `codex` missing, the 4-cod lane collapses; surface a degraded-mode `AskUserQuestion` before proceeding (override default cc:cod ratio? abort? proceed degraded?).
4. **Disk-space guard** — `df -h $PWD`. If <5GB free, run the stale-artifact cleanup BEFORE spawning so agents don't die mid-build.
5. **Tender-daemon spawn** — start `node $CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js --session=… --project=$PWD --interval=30000 --logfile=.pi-flywheel/tender-events.log --agent=<your-name> &` (v3.6.0+; `--project` defaults to `process.cwd()` in v3.6.7+, but pass it explicitly for compatibility). Capture PID for shutdown.
6. **Bead snapshot** — `br list --json` and `br ready --json`. Identify any stalled in-progress beads up front and reopen them per the rule above.
7. **Looper schedule** — invoke `Skill: loop` with `4m` interval and the marching-orders prompt referenced in the operator-decoder table.

After all 7 pass, dispatch the swarm and enter the monitor loop documented in `_implement.md` Pre-loop / Implementation loop / Post-wave bridge.

---

## Termination / hand-off

- All beads closed AND review converged AND no new beads from saturation skills → `kill -TERM $tender_daemon_pid`, leave NTM session alive, transition to Step 9.5 wrap-up via `_wrapup.md`.
- User interrupts via the looper or directly → pause politely; do NOT force-stop agents until user confirms.
- Build mutex deadlock detected (`flock` waits >5min) → escalate via `/slb` two-person approval before killing.
