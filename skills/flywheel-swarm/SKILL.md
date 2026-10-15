---
name: flywheel-swarm
description: Launch a parallel swarm of agents to implement multiple beads simultaneously.
---

Launch a parallel swarm of implementation agents. $ARGUMENTS

> **NTM-first contract (MANDATORY).** All multi-agent fan-out goes through `ntm spawn` + `ntm --robot-send`. Do NOT use raw `Task`/`Agent()`, background CLIs, or direct `tmux` for impl agents. Before spawning anything, invoke the `/vibing-with-ntm` skill — it carries the project-tested marching-orders prompts, work-claim/reservation conventions, and pane-tending loops you don't have time to recreate. The only `Agent()` call permitted in this skill is for fresh-eyes reviewers in Step 9 (short-lived, benefits from subagent isolation).
>
> **NTM-unavailable fallback only.** If `which ntm` fails OR `ntm deps -v` reports a broken stack, surface a one-line warning, ask the user before downgrading, and only then fall back to the `Agent()` form preserved at the bottom of this skill. NTM-unavailable should be a rare, user-acknowledged degradation — never a silent default.

0. **Invoke `/vibing-with-ntm`.** Use the `Skill` tool with `vibing-with-ntm`. Follow its guidance for session bootstrap (NTM project resolution, Agent Mail, beads claim) and pane-tending (looper cadence, stuck-pane ladder, completion polling). The rest of this skill assumes its conventions are loaded.

1. Call `flywheel_approve_beads(action="start", coordinatorName="<current Agent Mail name>")`. Read `data.lanes` and `data.prompts`, then assign `START_DATA = result.structuredContent.data`. It contains one grouped lane assignment and one server-built prompt per ready bead.

2. If `START_DATA.readyCount === 0`, say "No beads are ready for implementation. Run /agent-flywheel:start to create a plan first."

3. Bootstrap Agent Mail, create `swarm-<goal-slug>`, and resolve `$NTM_PROJECT` through the readiness procedure in `_implement.md`. Use the lane counts exactly as returned. The server has already applied provider availability and fallback.

4. Create one task per `START_DATA.prompts[]` record, then spawn the returned counts:
   ```bash
   IMPL_SESSION="${NTM_PROJECT}--impl-<goal-slug>"
   ntm spawn "$NTM_PROJECT" --label impl-<goal-slug> --no-user \
     --cc=<N_cc> --cod=<N_cod> --gmi=<N_gmi> --pi=<N_pi> --stagger-mode=smart
   ```
   Derive each `N_*` from the matching `START_DATA.lanes[].beadIds.length`. With `--no-user`, pane indices start at 1 and follow spawn order `cc`, `cod`, `gmi`, then fallback-only `pi`. Address panes by numeric index. Use `--panes=N`. Singular `--pane=N` broadcasts to every pane, and combining a known index with `--type` can match nothing during startup.

5. Send every prompt unchanged to its assigned pane:
   ```bash
   ntm --robot-send="$IMPL_SESSION" --panes=<numeric-index> --msg="<START_DATA.prompts[i].prompt>"
   ```
   Send each record once in array order. The prompt already contains Agent Mail bootstrap, file reservations, provider-specific instructions, the pre-completion gate, a bead-specific `CompletionReport` JSON example, and trailing newlines. Save each task id, pane index, and `agentName` for tending and restart.

   If `START_DATA.dispatch.degraded` is true, show its warnings before spawning.

6. **Monitor swarm (per `/vibing-with-ntm` tending loop):**
   - Schedule the looper at the cadence set by `/vibing-with-ntm` (typically `ScheduleWakeup(270s, …)`); poll `fetch_inbox` and `ntm --robot-is-working` between wakes. For an operator-readable view of remaining work, `ntm work triage --by-track` wraps `bv` and groups by track; for next-bead dispatch to idle panes, prefer `ntm assign "$NTM_PROJECT" --auto --strategy=dependency` over an ad-hoc `--robot-send`.
   - **Alternative — `ntm controller`:** for long-running swarms, spawn `ntm controller "$NTM_PROJECT" --agent-type=cc` in pane 0 to offload supervision to a dedicated coordinator agent (built-in `--robot-snapshot`/`--robot-attention` loop). Main session can exit cleanly; tender-daemon stays running; recovery via stuck-pane ladder if the controller pane dies.
   - If an agent goes idle without reporting completion, nudge it: `SendMessage(to: "impl-<bead-id>", message: "Please report your current status and any blockers.")`. Escalate per the stuck-pane ladder in `_implement.md` — nudge → context-handoff restart → force-stop.
   - Use `TaskList` to see overall swarm task status; use `ntm --robot-restart-pane` to recycle a wedged pane (preserves bead state via Agent Mail handoff). Prefer `ntm --robot-smart-restart` first — it refuses if the pane is actually working.
   - `TaskStop(task_id: "<id>")` is last resort — only after the stuck-pane ladder is exhausted.

7. As each agent completes:
   - Update task: `TaskUpdate(taskId: "<task-id>", status: "completed")`
   - Shutdown agent: `SendMessage(to: "impl-<bead-id>", message: {"type": "shutdown_request", "reason": "Bead complete."})`
   - Do NOT broadcast shutdown to `"*"` — send to each agent individually.
   - **Do NOT close, kill, or restart the pane here** — the original pane stays alive until wrap-up (Step 9.5 cycle-reset) so the **Self review** path in Step 9 can hand the audit back to the same implementor with full context.

8. Report: "Swarm launched: N agents working on N beads via NTM. Use `/agent-flywheel:flywheel-swarm-status` to monitor progress."

9. **Wave-completion review gate (MANDATORY — do not skip).**
   Once **every** spawned agent has reported back (or been force-stopped), you owe the user the consolidated review prompt — watching panes/agents print "done" is **not** review. Read `skills/start/_review.md` end-to-end and execute its Step 8 flow verbatim:
   - Run §8.0a risky-bead detection on the just-finished beads.
   - Surface the consolidated `AskUserQuestion` (single-bead form for one completion, multi-bead form when multiple finished together) with options **Looks good / Self review / Fresh-eyes** (plus **Duel review** when §8.0a flags risk).
   - Route the chosen option through `flywheel_review` (`action: "looks-good" | "self-review" | "hit-me"`). Fresh-eyes spawns 5 reviewers via `Agent()` (NOT NTM) with the strict Agent Mail bootstrap and disk-write requirement; nudge up to 3× per reviewer if findings don't arrive within 2 minutes; fall back to `docs/reviews/*.md` + `git diff` if inboxes stay empty.

   Do NOT end the turn at Step 8. Continue into the rest of the review/wrap-up cycle (test-coverage sweep 9.25, UI polish 9.4, wrap-up 9.5+) per `_review.md` and `_wrapup.md`. Dropping out after launching a swarm is a known bug — the swarm is the middle of the flywheel, not the end.
