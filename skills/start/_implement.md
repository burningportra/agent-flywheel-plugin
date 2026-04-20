# Implementation Phase — Step 7

## Step 7: Implement each bead

### Pre-loop — swarm scaling + stagger

**Agent ratio by open-bead count** (from `br ready --json`). Pick the smallest tier that accommodates your wave:

| Open beads | Claude : Codex : Gemini | Notes |
|-----------|--------------------------|-------|
| < 100     | 1 : 1 : 1                | Single rep each — coordination overhead stays low |
| 100-399   | 3 : 3 : 2                | Standard swarm |
| 400+      | 4 : 4 : 2                | Parallel tracks essential |

Claude owns architecture / complex reasoning, Codex owns fast iteration / testing, Gemini provides a second perspective for docs / review. Cap parallel spawns at the wave's independent-bead count — do not spin up agents with nothing to do.

**Thundering-herd mitigation** — stagger spawns by **30 seconds minimum**. Do NOT spawn all agents simultaneously; they all read AGENTS.md, hit Agent Mail, and query `br ready` at once — piling onto the same frontier bead. Use `run_in_background: true` and wait 30s between each `Agent(...)` call.

**Codex input-buffer quirk** — after the prompt lands in a Codex agent, send Enter TWICE (or append a trailing newline) so the long prompt clears the input buffer.

**Rate-limit management** — if any impl agent reports a rate-limit error (429, "usage limit reached", etc.), invoke `/caam` to switch that model's account. `caam activate <model> <backup-account>` takes <100ms and keeps the wave moving. Don't kill and restart the agent; the wrapper just re-authenticates the current session.

**Structured error branching for monitoring/tool failures.** When a flywheel tool or monitor wrapper returns a structured error, branch on `result.structuredContent?.data?.error?.code` (typed `FlywheelErrorCode`) instead of parsing `error.message` strings:

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

   **If `NTM_AVAILABLE`** (preferred): Use NTM to spawn impl agents into visible tmux panes. This lets the user observe all agents working in real-time. `ntm spawn` takes a project name (which must be a directory under `projects_base`) and uses `--label` for the per-purpose suffix. Use `$NTM_PROJECT` captured in Step 0b (which equals `basename $PWD`):
   ```bash
   SESSION="${NTM_PROJECT}--impl-<goal-slug>"
   # Spawn panes for the wave (scale cc/cod/gmi per the agent ratio table above)
   ntm spawn "$NTM_PROJECT" --label impl-<goal-slug> --cc=<N> --cod=<M> --gmi=<K>
   # Dispatch each bead to a pane
   ntm send "$SESSION" --pane=cc-1 "<bead prompt with STEP 0 Agent Mail bootstrap>"
   ntm send "$SESSION" --pane=cod-1 "<bead prompt with STEP 0 Agent Mail bootstrap>"
   ```
   - Stagger sends by 30 seconds (thundering-herd mitigation still applies).
   - The Agent Mail STEP 0 bootstrap is still MANDATORY in each pane's prompt — NTM handles process lifecycle; Agent Mail handles coordination protocol, file reservations, and audit trail.

   **Monitor loop (MANDATORY — do NOT fire-and-forget).** NTM spawns agents asynchronously; a pane process can live while the agent inside it is idle, crashed, or skipping Agent Mail. You MUST actively monitor until every bead in the wave is closed or force-stopped. Run this loop at ~60-90s cadence (use the `Monitor` tool for best results):

   ```bash
   ntm status   "$SESSION"   # pane health and last-activity timestamps
   ntm activity "$SESSION"   # per-pane agent state (working/idle/crashed)
   ```
   Plus, on each tick:
   - `fetch_inbox(project_key: cwd, agent_name: "<your-name>", include_bodies: false)` — see which agents sent `started` / `bead-closed` / status messages.
   - `git log --oneline --grep="<bead-id>"` per in-flight bead — catches the "agent committed but forgot `br update`" failure mode (see Step 7's proactive-close rule).

   **Agent Mail usage verification.** Bootstrap in the prompt is not enough — confirm each pane's agent actually registered AND is messaging:
   1. After 60s post-spawn, call `list_window_identities` (or `list_contacts`) and confirm a registered identity exists per pane you spawned. A missing identity means the agent skipped `macro_start_session`.
   2. On any missing identity, nudge immediately:
      ```bash
      ntm send "$SESSION" --pane=<pane> "Before any other work, run macro_start_session and send a 'started' message to <coordinator-name>. Do not skip Agent Mail bootstrap — the flywheel cannot track you otherwise."
      ```
   3. If the agent has an identity but hasn't sent a message in >2 min while its bead is still open, it's silently stuck. Treat as idle (escalation below).

   **Nudge escalation per idle pane.** "Idle" = `ntm activity` reports idle OR no Agent Mail traffic in 2 min while bead is open.
   - Nudge 1: `ntm send "$SESSION" --pane=<pane> "Status check — report progress on <bead-id> and any blockers via Agent Mail."`
   - Nudge 2 (2 min later): `ntm send "$SESSION" --pane=<pane> "Still waiting on <bead-id>. If blocked, message <coordinator> with the blocker. If done, run 'br update <bead-id> --status closed'."`
   - Nudge 3 (2 min later): `ntm send "$SESSION" --pane=<pane> "Final nudge. Delivering now or I reassign/close on your behalf."`
   - After 3 nudges with no progress: apply Step 7's idle-agent escalation (verify commit on disk, close bead yourself if commit matches acceptance, otherwise reassign the bead or force-stop the pane via `ntm kill-pane "$SESSION" --pane=<pane>`).

   ⚠ Do NOT use `ntm spawn impl-<goal-slug>` (bare purpose as session name). `ntm` resolves the session name as `projects_base/<session_name>`, and an `impl-<goal-slug>` directory won't exist, so the spawn either fails or lands in the wrong cwd. Always pass the project name as positional arg and the purpose as `--label`.

   **Post-wave bridge to Step 8.** When every bead in the wave is closed (via Agent Mail completion OR proactive close OR force-stop), leave the tmux session alive (user may want to inspect panes) but transition the coordinator to the Step 8 review gate. **Do not skip the AskUserQuestion review prompt just because you watched the panes succeed** — the user still gets "Looks good / Self review / Fresh-eyes" and fresh-eyes review is still run via `Agent()` (NOT NTM — reviewers are short-lived). See `_review.md`.

   **If NTM is unavailable** (fallback): Spawn via the `Agent()` tool as described below.

3. Spawn an implementation agent with team membership. **Agent Mail bootstrap is ALWAYS required** — every impl agent must register, reserve files, and send start/done messages regardless of isolation mode or file overlap. The message trail creates a coordination audit log for debugging, session history, and CASS memory:
   ```
   Agent(
     subagent_type: "general-purpose",
     isolation: "worktree",
     name: "impl-<bead-id>",
     team_name: "impl-<goal-slug>",
     prompt: "
       ## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY — DO THIS BEFORE ANYTHING ELSE)
       Do NOT read any files or run any commands until all 3 sub-steps below are complete.

       0a. Call macro_start_session(
             human_key: '<cwd>',
             program: 'claude-code',
             model: '<model>',
             task_description: 'Implementing bead <id>: <title>')
           Note your assigned agent name.

       0b. Call file_reservation_paths to reserve every file you plan to edit.
           If any file is already reserved, wait 30 seconds and retry up to 3 times.
           If still blocked after 3 retries, send a message to '<coordinator-agent-name>'
           reporting the conflict, then STOP.

       0c. Send a 'started' message to '<coordinator-agent-name>' via send_message
           with subject '[impl] <bead-id> started'.

       0d. **Re-read AGENTS.md end-to-end** (MANDATORY — do not skip even if
           you think you remember it). Agents that skip this produce
           non-idiomatic code and break project conventions. If the repo has
           no AGENTS.md, note that in your started message.

       Only after 0a, 0b, 0c, 0d are ALL complete may you proceed to Step 1.

       ## STEP 0.5 — LOAD MEMORY (if CASS available)
       Call flywheel_memory with operation='search' and query='implementation gotchas <bead-title>'.
       If results returned, review them before starting — they contain lessons from past sessions.

       ## STEP 0.7 — DOMAIN-SKILL LOOKUP (invoke relevant skills BEFORE writing code)
       Scan the bead title + description for domain keywords and invoke the matching skill
       via the Skill tool. Each hit gives you best-practice patterns specific to that stack.

         Bead mentions                            Invoke skill
         -----------------------------------------------------------
         admin, /admin, /api/admin              -> /admin-page-for-nextjs-sites
         A/B test, variant, experiment          -> /ab-testing
         MRR, churn, cohort, customer analytics -> /saas-customer-analytics
         stripe, paypal, checkout, subscription -> /stripe-checkout
         supabase, RLS, drizzle, postgres SaaS  -> /supabase
         tanstack, react-query, react-table     -> /tanstack
         react component, .tsx, JSX             -> /react-component-generator
         og image, twitter card, social preview -> /og-share-images
         TUI, bubble tea, charm, CLI UI         -> /tui-glamorous
         installer, curl|bash, one-liner        -> /installer-workmanship
         CLI automation, atuin, shell history   -> /automating-your-automations
         perf, optimize, bottleneck, p95, p99   -> /extreme-software-optimization
         MCP tool, MCP server                   -> /mcp-server-design
         multi-repo, ru sync                    -> /ru-multi-repo-workflow
         crash, segfault, hang, deadlock        -> /gdb-for-debugging
         playwright, e2e webapp, next.js test   -> /e2e-testing-for-webapps
         fuzz, property-based, crash discovery  -> /testing-fuzzing
         protocol, RFC, conformance             -> /testing-conformance-harnesses
         snapshot, approval, golden output      -> /testing-golden-artifacts
         ML test, oracle-less, metamorphic      -> /testing-metamorphic
         formal proof, lean, rust verification  -> /lean-formal-feedback-loop

       If no keywords match, skip and proceed to STEP 1. Never force a skill invocation on
       an unrelated bead — the lookup is hints, not mandates.

       ## STEP 1 — IMPLEMENT
       <bead title>
       <bead description>
       Acceptance criteria: <criteria>

       ## STEP 2 — VALIDATE (MANDATORY GATES — all must pass before STEP 3)
       Run in order; fix failures before proceeding. Do NOT commit until all pass.

       2a. **Compile + lint gate** — pick the stack's commands:
           - Rust:       cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo fmt --check
           - Go:         go build ./... && go vet ./...
           - TypeScript: npx tsc --noEmit (plus your eslint / biome script)
                         **AND** run the project's full build: `npm run build` (or `pnpm build`,
                         `yarn build`). `tsc --noEmit` only checks source types — it does NOT
                         verify that tsconfig files, output paths, or scripts referenced from
                         `package.json` actually exist. Running `npm run build` catches missing
                         `tsconfig.*.json` files, missing entry points, and broken script chains.
           - Python:     python -m compileall -q . (plus ruff / mypy per project)
           Check package.json / Cargo.toml / Makefile for project-specific scripts first.

       2a.1. **Reference-resolution gate** — if you added or modified any of:
             - `package.json` scripts (commands that reference files: tsconfig paths, entry points, test runners)
             - Shell commands in CI configs (`.github/workflows/*.yml`, `Makefile`)
             - `import`/`require` statements with new paths
             - Relative paths in config files (`tsconfig.json` `extends`/`references`, `vite.config`, etc.)
             Then verify EVERY referenced path exists on disk before committing:
             ```
             # TypeScript example — after adding "build": "tsc && tsc -p tsconfig.scripts.json"
             test -f tsconfig.scripts.json || echo "MISSING: tsconfig.scripts.json"
             ```
             A bead that wires up a new script must also create the files that script references.

       2b. **Test gate** — run the test suite for files you touched (not the whole suite unless fast).

       2c. **UBS gate** (if `ubs` CLI is installed): `ubs <changed-files>`. Treat
           findings as blocking unless clearly out of scope. If `ubs` is not
           available, note that in your completion report and skip this gate.

       ## STEP 2.5 — STORE LEARNINGS
       If you encountered anything non-obvious during implementation — unexpected API behavior,
       tricky edge cases, workarounds for tooling issues, rebase gotchas, or decisions that
       future agents would benefit from knowing — store each as a CASS memory:
       Call flywheel_memory with operation='store' and content describing the learning.
       Prefix with the bead ID for traceability, e.g.:
       'Bead <id>: <concise learning with enough context to be useful standalone>'
       Skip this step if the implementation was straightforward with no surprises.

       ## STEP 3 — COMMIT & CLOSE BEAD
       Create a commit with a descriptive message referencing bead <id>.
       Then mark the bead closed: `br update <bead-id> --status closed`
       (Note: the br CLI uses `closed`, NOT `done`.)
       **IMPORTANT:** Always use the FULL bead ID (e.g. `my-project-k67`),
       not a short alias. The full ID is project-path-dependent — agents
       running from symlinked or alternative paths will fail to resolve
       short IDs. The coordinator MUST substitute the exact ID from `br list`
       into this prompt template before dispatching.
       Verify the close took effect: `br show <bead-id> --json` and confirm
       `'status': 'closed'`. If the status is anything else, retry the update
       once before continuing to STEP 4. Stragglers are a known failure mode
       and the coordinator will catch them via `flywheel_verify_beads`, but
       verifying here keeps the wave clean.

       ## STEP 4 — RELEASE + REPORT (MANDATORY)
       4a. Release all file reservations via release_file_reservations.
       4b. Send a completion summary to '<coordinator-agent-name>' via send_message
           with subject '[impl] <bead-id> done' including:
           - Files changed
           - Tests added/modified
           - Any open concerns or follow-ups
     "
   )
   ```

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

### Stuck-swarm diagnostics

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Multiple agents pick the same bead | Unsynced starts; not marking `in_progress` early | Stagger starts 30s; require `br update --status in_progress` + Agent Mail claim before any edit; audit file reservations |
| Agent circles after compaction | Forgot the AGENTS.md contract | Nudge: `SendMessage(to: "<name>", message: "Re-read AGENTS.md so it's still fresh, then continue from your last Agent Mail message.")` — kill+restart only if it stays erratic |
| Bead sits `in_progress` too long | Crash / blocker / lost plot | Check Agent Mail thread for last report; if silent, implement directly as coordinator OR split the blocker into sub-beads with `br create` + `br dep add` |
| Contradictory implementations across beads | Poor coordination / stale reservations | Audit `file_reservation_paths`; revise bead boundaries so two beads never edit the same file |
| Much code, goal still far | Strategic drift | Run the "Come to Jesus" reality check in Step 9's Check-status option |

> ## MANDATORY POST-IMPLEMENTATION CONTINUATION
>
> After all impl agents in the current wave have completed (or been force-stopped), you MUST continue to Step 8 (read `_review.md`). Do NOT end the turn, exit the workflow, or return control to the user. The implementation phase is the MIDDLE of the flywheel — not the end. The remaining steps (review -> verify -> test coverage -> UI polish -> wrap-up -> CASS -> refine -> post-flywheel menu) are what make the flywheel a flywheel. Dropping out here is a bug.
