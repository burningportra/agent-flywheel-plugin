---
description: Launch a parallel swarm of agents to implement multiple beads simultaneously.
---

Launch a parallel swarm of implementation agents. $ARGUMENTS

> **NTM-first contract (MANDATORY).** All multi-agent fan-out goes through `ntm spawn` + `ntm --robot-send`. Do NOT use raw `Task`/`Agent()`, background CLIs, or direct `tmux` for impl agents. Before spawning anything, invoke the `/vibing-with-ntm` skill — it carries the project-tested marching-orders prompts, work-claim/reservation conventions, and pane-tending loops you don't have time to recreate. The only `Agent()` call permitted in this skill is for fresh-eyes reviewers in Step 9 (short-lived, benefits from subagent isolation).
>
> **NTM-unavailable fallback only.** If `which ntm` fails OR `ntm deps -v` reports a broken stack, surface a one-line warning, ask the user before downgrading, and only then fall back to an `Agent()` form. NTM-unavailable should be a rare, user-acknowledged degradation — never a silent default.

0. **Invoke `/vibing-with-ntm`.** Use the `Skill` tool with `vibing-with-ntm`. Follow its guidance for session bootstrap (NTM project resolution, Agent Mail, beads claim) and pane-tending (looper cadence, stuck-pane ladder, completion polling). The rest of this command assumes its conventions are loaded.

1. Call `flywheel_approve_beads` with `action: "start"` via the agent-flywheel MCP server. This returns the list of ready beads.

2. If no beads are ready, say "No beads are ready for implementation. Run /agent-flywheel:start to create a plan first."

3. Ask the user: "How many agents should run in parallel? (Recommended: 2-4)"

4. **Setup coordination:**
   - Bootstrap Agent Mail: `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Swarm: <goal>")`
   - Create a team: `TeamCreate(team_name: "swarm-<goal-slug>")`
   - Resolve NTM project: read `projects_base` from `ntm config show` and confirm `$projects_base/$(basename $PWD)` resolves. On miss, follow the symlink/config path from `flywheel-setup` §6 before continuing.
   - Apply the **AGENTS.md NTM pane priority** for swarm composition: prefer **4 pi + 2 cc** when both are healthy; fall back to **4 cod** if Pi is unavailable. Run `which claude codex gemini pi 2>/dev/null` (real binaries behind the `cc/cod/gmi/pi` ntm pane types — do NOT `which cc` literally, it matches `/usr/bin/cc`) and `ntm deps -v` to pick the live mix; never spawn agents whose CLI is missing.

5. For each ready bead (up to the user's limit), create a task and spawn an NTM-backed impl agent:
   - `TaskCreate(subject: "Impl: <bead-id> <title>", status: "in_progress")`
   - Save the task ID
   - Spawn the pane via NTM (per `/vibing-with-ntm` and `/ntm`):
     ```
     ntm spawn "$NTM_PROJECT" --pane-name="impl-<bead-id>" --agent="<cc|cod|pi>"
     ```
   - Send the marching-orders prompt via `ntm --robot-send` (NOT inline `Agent()`):
     ```
     ntm --robot-send="$NTM_PROJECT" --pane-name="impl-<bead-id>" --msg="
       ## Agent Mail Bootstrap
       Call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: '<resolved-model>',
         task_description: 'Implementing bead <id>: <title>')
       Note your assigned agent name for messaging.

       ## File Reservation
       Before editing any files, call file_reservation_paths with the files you plan to modify.
       Release reservations when done: release_file_reservations.

       ## Agent Mail Runtime Safety
       Use the Agent Mail MCP/HTTP tools for inboxes, messages, and reservations. Do NOT run mutating
       `am doctor` commands (`repair`, `archive-normalize`, `reconstruct`, `fix`) and do NOT delete
       `.mailbox.activity.lock` or `storage.sqlite3.activity.lock`. The live `am serve-http` daemon
       intentionally holds those locks. If Agent Mail reports "Resource is temporarily busy" or looks
       unhealthy, stop and message the coordinator; the coordinator should run
       `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })`.

       ## Bead: <id> — <title>
       <description>

       ## Acceptance criteria
       <criteria>

       ## Pre-Completion Quality Gate (MANDATORY — do not skip)
       Before sending the completion message you MUST run, in this order, and fix what
       you find before reporting done:
         1. Invoke the \`/ubs-workflow\` skill scoped to your changed files
            (changed-files mode, not full-repo). Triage every finding: fix, file as a
            new bead with rationale, or explicitly justify ignoring it in your
            completion message. Do not silently drop UBS findings.
         2. Run the repo's verify commands per AGENTS.md (build/test/typecheck/lint
            for the surfaces you touched). If AGENTS.md offloads heavy verification
            to a helper (e.g. \`rch\`), use that — do not skip.
         3. Self-review with fresh eyes: re-read your own diff for regressions,
            unsafe assumptions, missing tests, and edge cases. Fix before completing.
         4. Write \`.pi-flywheel/completion/<bead-id>.json\` matching
            \`CompletionReportSchemaV1\` in \`mcp-server/src/completion-report.ts\`.
            This attestation is the ledger entry that \`flywheel_verify_beads\` reads
            and \`flywheel_advance_wave\` gates on (warn-only by default; hard-block
            when \`FW_ATTESTATION_REQUIRED=1\`). Worked example:

            \`\`\`json
            {
              \"version\": 1,
              \"beadId\": \"<bead-id>\",
              \"agentName\": \"<your-agent-name>\",
              \"paneName\": \"<your-pane-name-or-omit>\",
              \"status\": \"closed\",
              \"changedFiles\": [\"path/relative/to/repo.ts\"],
              \"commits\": [\"<short-sha>\"],
              \"ubs\": { \"ran\": true, \"summary\": \"clean\", \"findingsFixed\": 0, \"deferredBeadIds\": [] },
              \"verify\": [{ \"command\": \"npm test\", \"exitCode\": 0, \"summary\": \"all green\" }],
              \"selfReview\": { \"ran\": true, \"summary\": \"no regressions\" },
              \"beadClosedVerified\": true,
              \"reservationsReleased\": true,
              \"createdAt\": \"<ISO-8601 timestamp>\"
            }
            \`\`\`

            Docs-only diffs: set \`ubs.ran=false\` and a non-empty \`ubs.skippedReason\`.
            Status \`closed\` requires \`beadClosedVerified=true\`. Schema rejects
            absolute paths or \`..\`-traversal in \`changedFiles\`. The schema is
            \`version: 1\` and additive forever — never remove keys.

       Completion messages without evidence of these four steps will be bounced
       back by the coordinator's review gate.

       ## On completion
       Send a completion message to <your-coordinator-name> via send_message that
       includes: (a) UBS result summary (clean / fixed / deferred-with-bead-ids),
       (b) verify command outputs (or the helper handle), (c) one-line self-review
       summary, (d) confirmation that \`.pi-flywheel/completion/<bead-id>.json\` is
       written. Then close the bead per AGENTS.md.
     "
     ```
   **Save each agent's task ID and pane name** — needed for `ntm --robot-restart-pane` and `TaskStop` if they become unresponsive.

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
