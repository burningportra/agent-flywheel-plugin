# Implementation Phase — Step 7

## Step 7: Implement each bead

### Pre-flight: NTM readiness gate (MANDATORY — run BEFORE Pre-loop)

`NTM_AVAILABLE` and `NTM_PROJECT` are captured in SKILL.md Step 0b but **not persisted to `checkpoint.json`**. After `/compact`, session resume, or any context reset, they are lost — and the implementation loop below will silently fall through to `Agent()` spawning, which strips the user of visible tmux panes. This is the #1 reason NTM "always gets skipped."

**You MUST re-run the detection inline before choosing a spawn mechanism**, even if you think you remember the earlier result. The detection now **auto-symlinks** nested repos silently — only true ambiguity (name-collision) surfaces an `AskUserQuestion`:

```bash
if ! command -v ntm >/dev/null 2>&1; then
  echo "NTM_AVAILABLE=false reason=cli-missing"
else
  NTM_BASE=$(ntm config show 2>/dev/null | awk -F'"' '/^projects_base/ {print $2}')
  PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
  PROJECT_BASENAME=$(basename "$PROJECT_ROOT")
  TARGET="$NTM_BASE/$PROJECT_BASENAME"

  if [ -z "$NTM_BASE" ]; then
    echo "NTM_AVAILABLE=false reason=no-projects-base"
  elif [ ! -e "$TARGET" ]; then
    # Auto-symlink: nested or sibling repo not yet linked under projects_base.
    # This is the common case (e.g. ~/Documents/GitHub/foo/services/bar — basename=bar
    # not under base=~/Documents/GitHub directly). Silent fix, no user prompt.
    ln -s "$PROJECT_ROOT" "$TARGET" \
      && echo "NTM_AVAILABLE=true project=$PROJECT_BASENAME base=$NTM_BASE action=auto-symlinked" \
      || echo "NTM_AVAILABLE=false reason=symlink-failed target=$TARGET"
  elif [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$PROJECT_ROOT" ]; then
    echo "NTM_AVAILABLE=true project=$PROJECT_BASENAME base=$NTM_BASE action=existing-symlink-ok"
  elif [ "$(realpath "$TARGET" 2>/dev/null)" = "$(realpath "$PROJECT_ROOT" 2>/dev/null)" ]; then
    echo "NTM_AVAILABLE=true project=$PROJECT_BASENAME base=$NTM_BASE action=existing-dir-matches"
  else
    # COLLISION: $TARGET exists but points to a different repo. Do NOT clobber.
    echo "NTM_AVAILABLE=false reason=name-collision target=$TARGET points-to=$(readlink -f "$TARGET" 2>/dev/null) want=$PROJECT_ROOT"
  fi
fi
```

**Decision rule** (no silent fallthrough):

- `NTM_AVAILABLE=true` (any `action=*`) → **you MUST use NTM** for this wave. Record `NTM_PROJECT = $PROJECT_BASENAME` and proceed to the NTM branch in step 2 of the Implementation loop. Do NOT spawn via `Agent()` as a shortcut just because the NTM block is longer — the user's visibility into the wave depends on tmux panes, and skipping NTM here silently degrades the flywheel UX.
- `NTM_AVAILABLE=false reason=cli-missing` → NTM not installed. Spawn via `Agent()` (fallback). No user prompt needed.
- `NTM_AVAILABLE=false reason=no-projects-base` → `ntm config show` returned empty. Surface a one-question fix:
  ```
  AskUserQuestion(questions: [{
    question: "NTM is installed but has no projects_base configured. Set it to the parent of this repo?",
    header: "NTM setup",
    options: [
      { label: "Set + auto-symlink (Recommended)", description: "ntm config set projects_base $(dirname \"$(git rev-parse --show-toplevel)\") and re-run the gate" },
      { label: "Fall back to Agent()", description: "Skip NTM this session — agents run invisibly via Agent() tool" },
      { label: "Run /flywheel-setup", description: "Full setup wizard to configure NTM permanently" }
    ],
    multiSelect: false
  }])
  ```
- `NTM_AVAILABLE=false reason=name-collision` → another repo with the same basename is already linked under `projects_base`. Surface the conflict via `AskUserQuestion` (NEVER auto-clobber — destructive):
  ```
  AskUserQuestion(questions: [{
    question: "NTM has a different repo named '$PROJECT_BASENAME' already at $TARGET (resolves to $points-to). What should I do?",
    header: "NTM name collision",
    options: [
      { label: "Use unique label", description: "Replace target name in the spawn with a project-disambiguating label like '$PROJECT_BASENAME-$(git rev-parse --short HEAD)'" },
      { label: "Replace symlink", description: "rm $TARGET && ln -s $PROJECT_ROOT $TARGET — destroys the link to the OTHER repo, only safe if it's stale" },
      { label: "Fall back to Agent()", description: "Skip NTM this session — agents run invisibly via Agent() tool" }
    ],
    multiSelect: false
  }])
  ```
- `NTM_AVAILABLE=false reason=symlink-failed` → permission error or other filesystem failure. Surface the error verbatim and fall back to `Agent()`.

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
flywheel_advance_wave(cwd, closedBeadIds: [<wave-N bead IDs>])
```
Returns `{ verification, nextWave: { beadIds, prompts: [{beadId, lane, prompt}], complexity } | null, waveComplete }`. If `nextWave` is non-null, dispatch the rendered prompts to NTM panes via `ntm --robot-send`. If `waveComplete: true` and `nextWave: null`, the queue is drained — proceed to Step 8.

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
3. Dispatch prompts via `ntm --robot-send`.
4. Call `ScheduleWakeup(270s, …)` and end the turn.
5. (Wakeup fires) — `tail .pi-flywheel/tender-events.log` → call `flywheel_advance_wave(closedBeadIds)`.
6. Dispatch returned `nextWave.prompts` (or proceed to Step 8 if `waveComplete && nextWave === null`).
7. `kill -TERM $tender_daemon_pid` when the queue drains.

### Pre-loop — swarm scaling + stagger

**Agent ratio by open-bead count** (from `br ready --json`). Pick the smallest tier that accommodates your wave:

| Open beads | Claude : Codex : Gemini | Notes |
|-----------|--------------------------|-------|
| < 100     | 1 : 1 : 1                | Single rep each — coordination overhead stays low |
| 100-399   | 3 : 3 : 2                | Standard swarm |
| 400+      | 4 : 4 : 2                | Parallel tracks essential |

Claude owns architecture / complex reasoning, Codex owns fast iteration / testing, Gemini provides a second perspective for docs / review. Cap parallel spawns at the wave's independent-bead count — do not spin up agents with nothing to do.

The 1:1:1 (and richer) ratios are now actually executed via the model-diversity split in step 7.2 below — not just documented. CLI availability is detected up-front and missing CLIs degrade gracefully with a user-facing warning.

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

   **Model-diversified split (Claude : Codex : Gemini at 1:1:1).** Distribute the wave's beads across the three CLIs so the user gets a second/third model perspective per wave. The split is `floor(N/3)` each plus remainders by priority (claude → codex → gemini).

   1. **Detect CLI availability up-front.** Run `which claude codex gemini` (or call `flywheel_doctor` and read the `claude_cli` / `codex_cli` / `gemini_cli` rows + the `swarm_model_ratio` synthesis). Build a capabilities map. The MCP server exposes `detectCliCapabilities` from `mcp-server/src/adapters/model-diversity.ts` for programmatic callers.

   2. **Compute the lane sizes** from the capabilities map and the wave size N:
      - All three available: `floor(N/3)` each. N=3 → 1 Claude + 1 Codex + 1 Gemini. N=4 → 2C + 1Co + 1G (claude takes the +1). N=5 → 2C + 2Co + 1G. N=14 → 5C + 5Co + 4G.
      - Missing one CLI (e.g. codex absent): redistribute its share to the surviving providers by priority. Wave of 3 with codex missing → 2 Claude + 1 Gemini, plus a degraded-mode warning to the user.
      - All missing: fail loudly — the wave cannot be dispatched. The doctor's `swarm_model_ratio` row will be red.

   3. **Spawn lanes via NTM** with the correct per-model pane counts. Load `/ntm` and `/vibing-with-ntm` first if you haven't — they carry the canonical orchestrator decision tree, stuck-pane ladder, and command surface this section assumes.
      ```bash
      SESSION="${NTM_PROJECT}--impl-<goal-slug>"

      # --no-user omits pane 0 entirely; lanes start at pane index 1.
      # --stagger-mode=smart prevents thundering-herd on simultaneous cold-boot.
      # Pane-type priority (user preference, see AGENTS.md "NTM pane priority"):
      #   prefer `pi` over `cod` as the second lane. Only fall back to `--cod=`
      #   if Pi is unavailable on this host (no Pi CLI / quota exhausted).
      ntm spawn "$NTM_PROJECT" --label impl-<goal-slug> --no-user \
        --cc=<N_claude> --pi=<N_pi> --gem=<N_gemini> --stagger-mode=smart
      ```

      **Pane addressing is numeric** — `cc-1` / `pi-1` / `gem-1` style does NOT work. With `--no-user`, panes are laid out contiguously by spawn order:

      | Lane    | Pane indices                                              |
      |---------|------------------------------------------------------------|
      | Claude  | `1` … `N_claude`                                          |
      | Pi      | `N_claude+1` … `N_claude+N_pi`                            |
      | Gemini  | `N_claude+N_pi+1` … `N_claude+N_pi+N_gemini`              |

      Dispatch via `ntm --robot-send` (NOT `ntm send`). Plain `ntm send` aborts with `Continue anyway? [y/N]` when CASS dedup matches a similar past prompt — silent blocker in orchestrator loops (ntm skill gotcha #3). `--robot-send` is non-interactive by design:
      ```bash
      ntm --robot-send="$SESSION" --panes=1 --type=cc  --msg="<claude-tuned prompt>"
      ntm --robot-send="$SESSION" --panes=$((N_claude+1)) --type=pi  --msg="<pi-tuned prompt>"
      ntm --robot-send="$SESSION" --panes=$((N_claude+N_pi+1)) --type=gem --msg="<gemini-tuned prompt>"
      ```

      ⚠ **Forbidden in automation:** `ntm view` (retiles the user's tmux layout and returns nothing useful) and `ntm dashboard` / `ntm palette` (human-only TUIs). The user can run them; the orchestrator must not.

   4. **Use the per-model prompt adapters** so each pane gets a prompt tuned to its model:
      - `mcp-server/src/adapters/claude-prompt.ts` — baseline scaffold (matches existing Step 7 template).
      - `mcp-server/src/adapters/codex-prompt.ts` — terser preambles + strict structured `COMPLETION_REPORT` block (per `/codex:gpt-5-4-prompting`). Codex panes also need 2 trailing newlines (input-buffer quirk).
      - `mcp-server/src/adapters/gemini-prompt.ts` — explicit role framing + bounded "STOP after report" guard.
      All three adapters share the `BeadDispatchContext` input shape and the `AdaptedPrompt` output shape so the dispatch loop is a single `adaptPromptFor(lane.provider, ctx)` switch.

   5. **Agent Mail names use the adjective+noun pool** from `mcp-server/src/adapters/agent-names.ts`. Call `allocateAgentNames(N, '<wave-id>')` for collision-free assignment across a 14-bead wave (pool capacity = 1600 unique names). Pass the chosen name as `preferred_name` in the agent's STEP 0 `macro_start_session` call. **Never use descriptive role-style names like `research-coordinator`** — the Agent Mail server rejects them; see `feedback_agent_mail_naming.md` in CASS memory.

   6. **Degraded-mode warning.** When the split returns `degraded: true` (one or more CLIs missing), echo the warning to the user before spawning so they know the wave is not the canonical 1:1:1. Also surface it in the wave-completion summary.

   - Stagger sends by 30 seconds (thundering-herd mitigation still applies).
   - The Agent Mail STEP 0 bootstrap is still MANDATORY in each pane's prompt — NTM handles process lifecycle; Agent Mail handles coordination protocol, file reservations, and audit trail.

   **Monitor loop (MANDATORY — do NOT fire-and-forget).** NTM spawns agents asynchronously; a pane process can live while the agent inside it is idle, crashed, or skipping Agent Mail. You MUST actively monitor until every bead in the wave is closed or force-stopped.

   ⚠ **Do NOT use `ntm status` / `ntm activity` / `ntm health` for monitoring.** They read cached timestamps and silently return stale signals (sometimes dated to the epoch / "56 years ago"), so panes appear dead while they're working (or vice versa). Use the `--robot-*` surfaces below — they sample live pane buffers and the provider's actual OAuth/quota state.

   **Bootstrap once** (capture the event cursor):
   ```bash
   ntm --robot-snapshot --robot-format=toon      # note the returned `cursor`
   ```

   **Tend — event-driven, not timer-driven.** Block on the attention feed instead of polling every 60-90s; it wakes on real state changes (attention, action_required, mail_ack_required, rate_limited-cleared):
   ```bash
   ntm --robot-wait "$SESSION" \
       --wait-until=attention,action_required,mail_ack_required \
       --timeout=90s                               # returns sooner if an event fires
   ```

   **On each wake, read the live per-pane truth (run all 4 — inbox is mandatory, not optional):**

   1. `ntm --robot-is-working="$SESSION"` — `working | idle | rate_limited | error | context_low`
   2. `ntm --robot-agent-health="$SESSION"` — OAuth, quota, context-window, account state
   3. `ntm --robot-tail="$SESSION" --panes=<N> --lines=50` — sample the actual pane buffer for any pane flagged idle/error
   4. **Inbox poll (MANDATORY — this is how you observe agent progress):**
      ```
      fetch_inbox(project_key: cwd, agent_name: "<your-name>", include_bodies: false, status: "unread", limit: 50)
      ```
      Then for each new message:
      - `mark_message_read(message_id: <id>)` — so the next poll shows only fresh traffic.
      - If `subject` matches `[impl] <bead-id> done`, run `acknowledge_message(message_id: <id>)` and treat the bead as a candidate for proactive close (verify commit + acceptance, then `br update --status closed`).
      - If `subject` matches `[impl] <bead-id> blocker`, fetch the body via `fetch_topic`, capture into CASS, and decide: nudge for clarification, reassign, or escalate per Step 9's gates.
   5. `git log --oneline --grep="<bead-id>"` per in-flight bead — catches the "agent committed but forgot `br update`" failure mode (see Step 7's proactive-close rule).

   **Tick log (MANDATORY — print this to the user every wake so they have proof of monitoring).** After running the 5 reads above, emit ONE compact line of plain text in the chat (NOT a tool result, actual user-facing output):

   ```
   tick #<N> @ <HH:MM:SS> — panes: <W working / I idle / R rate-limited> · inbox: <K new> [bead-x9q done by Coral, bead-y3r started by Onyx] · commits: <N since last tick>
   ```

   Skip ticks where nothing changed (don't spam), but emit at least one line every 3 ticks so the user can see the orchestrator is alive. If the inbox count is `0 new` for 3 consecutive ticks AND no panes are `working`, suspect Agent Mail breakage — call `health_check` on the agent-mail server before continuing the loop.

   If the event cursor expires, re-run `ntm --robot-snapshot` and continue.

   **Agent Mail usage verification.** Bootstrap in the prompt is not enough — confirm each pane's agent actually registered AND is messaging:
   1. After 60s post-spawn, call `list_window_identities` (or `list_contacts`) and confirm a registered identity exists per pane you spawned. A missing identity means the agent skipped `macro_start_session`.
   2. On any missing identity, nudge immediately (use `--robot-send` to dodge CASS dedup blocking):
      ```bash
      ntm --robot-send="$SESSION" --panes=<pane> --msg="Before any other work, run macro_start_session and send a 'started' message to <coordinator-name>. Do not skip Agent Mail bootstrap — the flywheel cannot track you otherwise."
      ```
   3. If the agent has an identity but hasn't sent a message in >2 min while its bead is still open, it's silently stuck. Treat as idle (escalation below).

   **Nudge escalation per idle pane.** Cross-reference: this is the [orchestrator decision tree from `/vibing-with-ntm`](references/vibing-with-ntm/SKILL.md#orchestrator-decision-tree) — load that skill if you need full operator-card detail (OC-001 rate-limit probe, OC-003 stuck-pane ladder, OC-009 context handoff, OC-016 convergence termination).

   "Idle" = `ntm --robot-is-working` reports `idle` for the pane OR no Agent Mail traffic in 2 min while bead is open. Treat `rate_limited` and `context_low` as separate recovery paths, NOT idle:
   - `rate_limited` → probe reality first (`tmux send-keys -t "$SESSION":<pane> "ping" Enter; sleep 5; ntm --robot-tail="$SESSION" --panes=<pane> --lines=10`); if still limited, rotate via `/caam` or `ntm rotate "$SESSION" --all-limited`. Do not nudge.
   - `context_low` → dispatch handoff-then-restart: save state via Agent Mail, then `ntm --robot-restart-pane="$SESSION" --panes=<N> --restart-bead=<bead-id>` on a fresh pane.

   For a genuinely idle pane (use `--robot-send`, NOT `ntm send` — see CASS-dedup note above):
   - Nudge 1: `ntm --robot-send="$SESSION" --panes=<pane> --msg="Status check — report progress on <bead-id> and any blockers via Agent Mail."`
   - Nudge 2 (2 min later): `ntm --robot-send="$SESSION" --panes=<pane> --msg="Still waiting on <bead-id>. If blocked, message <coordinator> with the blocker. If done, run 'br update <bead-id> --status closed'."`
   - Nudge 3 (2 min later): `ntm --robot-send="$SESSION" --panes=<pane> --msg="Final nudge. Delivering now or I reassign/close on your behalf."`
   - After 3 nudges AND identical `--robot-tail` output for ≥3 ticks, the pane is wedged (CLI likely hung on `/usage`, `/rate-limit-options`, or a confirm dialog). Climb the stuck-pane ladder instead of blind nudging:
     1. `ntm --robot-health-restart-stuck="$SESSION" --stuck-threshold=10m --dry-run` — surfaces which panes are actually stuck.
     2. `ntm --robot-smart-restart="$SESSION" --panes=<N> --prompt="<re-dispatch prompt>"` — graceful; refuses if pane is actually working.
     3. `ntm --robot-smart-restart="$SESSION" --panes=<N> --hard-kill --prompt="..."` — when the CLI is wedged on a dialog.
     4. `ntm --robot-restart-pane="$SESSION" --panes=<N> --restart-bead=<bead-id>` — nuclear (`tmux respawn-pane -k`); works even when the CLI refuses to cooperate.
     Then apply Step 7's idle-agent escalation (verify commit on disk, close bead yourself if commit matches acceptance, otherwise reassign the bead).

   ⚠ Do NOT use `ntm spawn impl-<goal-slug>` (bare purpose as session name). `ntm` resolves the session name as `projects_base/<session_name>`, and an `impl-<goal-slug>` directory won't exist, so the spawn either fails or lands in the wrong cwd. Always pass the project name as positional arg and the purpose as `--label`.

   **Post-wave bridge — call `flywheel_advance_wave` (v3.6.0+).** When every bead in the wave is closed (via Agent Mail completion OR proactive close OR force-stop), do NOT manually re-render the next wave. One call:
   ```
   flywheel_advance_wave(cwd, closedBeadIds: [<wave-N bead IDs>])
   ```
   - If `nextWave: null` and `waveComplete: true` → queue drained. `kill -TERM $tender_daemon_pid`, leave the tmux session alive (user may want to inspect panes), transition to Step 8.
   - If `nextWave.prompts` returned → dispatch them via `ntm --robot-send` to fresh panes (or reuse idle ones via `--robot-restart-pane`), then `ScheduleWakeup(270s, …)` and end the turn. The daemon will keep logging while you're idle.

   **Do not skip the Step 8 AskUserQuestion review prompt just because you watched the panes succeed** — the user still gets "Looks good / Self review / Fresh-eyes" and fresh-eyes review is still run via `Agent()` (NOT NTM — reviewers are short-lived). See `_review.md`.

   **If NTM is unavailable** (fallback): Spawn via the `Agent()` tool as described below.

3. Spawn an implementation agent with team membership. **Agent Mail bootstrap is ALWAYS required** — every impl agent must register, reserve files, and send start/done messages regardless of isolation mode or file overlap. The message trail creates a coordination audit log for debugging, session history, and CASS memory.

   **Before spawning — pre-flight (populate template placeholders).** Fill these in from the bead before dispatch so the agent doesn't spend turns hunting for context. This matches Opus 4.7's "delegate with full upfront context" guidance — the agent is a capable engineer, not a pair programmer to guide line-by-line.

   | Placeholder | How to compute |
   |-------------|----------------|
   | `<complexity>` | One of `simple` / `medium` / `complex` — must match the runtime `BeadComplexity` type in `mcp-server/src/model-routing.ts`. Prefer calling `classifyBeadComplexity()` directly when available; otherwise use the heuristic in the note below. |
   | `<relevant-files>` | Paths the agent will likely edit/read, derived from bead description + dep traversal. List 3-10; the agent can still discover more. |
   | `<prior-art-beads>` | Up to 3 closed bead IDs with similar titles. Use the shell snippet in the note below. |
   | `<thinking-directive>` | `simple` / `medium` → `Respond quickly; don't overthink — this bead is well-scoped.` `complex` → `Think carefully and step-by-step before writing code; this bead is harder than it looks.` |
   | `<completion-length>` | `simple` → `≤5 bullets`; `medium` → `≤10 bullets`; `complex` → `≤20 bullets`. |

   **Complexity heuristic** (when `classifyBeadComplexity()` isn't available): from `br show <bead-id> --json`:
   - 1 file + ≤3 acceptance items + 0 deps → `simple`
   - 2–4 files OR 1 dep → `medium`
   - 5+ files OR multiple deps OR vague acceptance → `complex`

   **Prior-art lookup** (copy-paste-safe, substitute `<keyword>` with a term from the bead title):

   ```bash
   br list --status closed --json | jq -r '.[] | select(.title | test("<keyword>"; "i")) | .id' | head -3
   ```

   Spawn call:
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

       ## STEP 0.8 — DELEGATION POLICY (Opus 4.7 guidance — read before STEP 1)
       From Anthropic's Opus 4.7 best-practices guide, verbatim:
       > "Do not spawn a subagent for work you can complete directly in a
       > single response (e.g., refactoring a function you can already see).
       > Spawn multiple subagents in the same turn when fanning out across
       > items or reading multiple files."

       Concrete rubric for THIS bead:
       - Scoped to 1 file you can see → do the work in place; do NOT spawn
       - Need to read 5+ files → spawn parallel Explore subagents in ONE turn
       - Ambiguous bug / unclear root cause → spawn ONE codex-rescue for second diagnosis
       - Everything else → in-turn work, no subagents

       ## STEP 1 — IMPLEMENT
       <thinking-directive>

       Title: <bead title>
       Description: <bead description>
       Complexity (coordinator-assigned): <complexity>
       Acceptance criteria: <criteria>

       Likely-relevant files (pre-resolved by coordinator — start here, discover more as needed):
       <relevant-files>

       Prior art (closed beads with similar scope — diff them for patterns before writing new code):
       <prior-art-beads>

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
           with subject '[impl] <bead-id> done' (target <completion-length>) including:
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
| Agent circles after compaction | Forgot the AGENTS.md contract | Nudge: `SendMessage(to: "<name>", message: "Re-read AGENTS.md so it's still fresh, then continue from your last Agent Mail message.")` — kill+restart only if it stays erratic |
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

**On "Hand off to Codex"** — build a `RescuePacket` and dispatch via the existing codex prompt adapter. The packet contract lives in `mcp-server/src/codex-handoff.ts`; this section consumes that surface and `mcp-server/src/adapters/codex-prompt.ts` (do NOT edit either):

```ts
import { buildRescuePacket, renderRescuePromptForCodex, formatRescueEventForMemory }
  from '../mcp-server/dist/codex-handoff.js';

// 1. Dump the in-flight diff + last error envelope as the artifact.
//    The artifact path is what Codex reads first — make it concrete.
const artifactPath = `.pi-flywheel/rescue/impl-${beadId}-${Date.now()}.diff`;
fs.writeFileSync(artifactPath, await execStr('git', ['diff', baseSha, 'HEAD']));

const packet = buildRescuePacket({
  phase: 'impl',
  goal: bead.title,
  artifact_path: artifactPath,
  error_code: lastError.code,             // from the prior FlywheelToolError
  hint: lastError.hint ?? '',             // VERBATIM from bead 478 hint contract
  recent_tool_calls: state.recentToolCalls.slice(-10),
  proposed_next_step: 'Apply a minimal fixup; do not rewrite the bead. Run npm run build && tests after the patch.',
});

const adapted = renderRescuePromptForCodex(packet, {
  coordinatorName: '<your-agent-mail-name>',
  projectKey: process.env.NTM_PROJECT,
  rescueAgentName: '<adjective+noun from agent-names pool>',
});

// 2. Invoke /codex:rescue with the rendered prompt body. Use --wait
//    (foreground) so the rescue blocks the wave's progression for this bead.
//    Codex panes need 2 trailing newlines per AdaptedPrompt.trailingNewlines.
```

**Persist the rescue event to CASS** for the doctor's `rescues_last_30d` synthesis:

```
flywheel_memory(operation: "store", content: formatRescueEventForMemory(packet))
```

**On Codex completion:**

- Codex returns a unified diff in its `COMPLETION_REPORT` block. Apply via `git apply --3way` and create a `fixup!` commit referencing the bead. Re-run the impl gate (`npm run build`, tests) before closing.
- If Codex produced a clarifying question, surface it via `AskUserQuestion` and feed the answer back to the original impl agent (or to a fresh one if the stall pane is wedged).
- If Codex itself stalls, do NOT cascade — fall back to "Abort phase" and reassign the bead manually next session.

> ## MANDATORY POST-IMPLEMENTATION CONTINUATION
>
> After all impl agents in the current wave have completed (or been force-stopped), you MUST continue to Step 8 (read `_review.md`). Do NOT end the turn, exit the workflow, or return control to the user. The implementation phase is the MIDDLE of the flywheel — not the end. The remaining steps (review -> verify -> test coverage -> UI polish -> wrap-up -> CASS -> refine -> post-flywheel menu) are what make the flywheel a flywheel. Dropping out here is a bug.
