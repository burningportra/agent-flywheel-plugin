# Simplify Pass — `/agent-flywheel:start` → "Simplify pass" (a.k.a. Deslop pass)

**What this is:** the canonical engine is `/simplify-and-refactor-code-isomorphically`. Each mode below invokes that skill — modes differ in orchestration (number of agents, review gates, iteration count). This file adds the discipline layer (baseline capture, ledger, isomorphism cards) that makes the skill safe to apply at scale.

**When to use:** the user picked "Simplify pass" (or legacy "Deslop pass") from Step 0d/0e — they want `/simplify-and-refactor-code-isomorphically` applied as a proof-obligated, isomorphism-preserving refactor pass. Meaningful on any repo (with or without open beads).

**How to use:** read this file, then surface a follow-up `AskUserQuestion` so the user picks the invocation mode (single-pass / fresh-eyes / 5-Cod swarm — codex-heavy mode is the deslop signature and an explicit override of the v3.21.0 canonical cc:pi:gem 1:1:1; when Codex is unavailable on the host it falls back to gmi, then pi, then cc, per AGENTS.md NTM pane priority / iterative). Do NOT pick a mode unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. The slash-named skills referenced below (`/simplify-and-refactor-code-isomorphically`, `/repeatedly-apply-skill`, `/ntm`, `/vibing-with-ntm`) are load-bearing — invoke via the `Skill` tool, do NOT paraphrase.

---

## Step 1: Mode selection (mandatory)

```
AskUserQuestion(questions: [{
  question: "How do you want to apply the deslop pass?",
  header: "Deslop mode",
  options: [
    { label: "Single-pass (Recommended)", description: "One in-process invocation of /simplify-and-refactor-code-isomorphically. Fast; good for small/medium repos or initial exploration." },
    { label: "Single + fresh-eyes", description: "Single-pass, then a verbatim fresh-eyes review prompt to catch any isomorphism violations the first pass introduced." },
    { label: "5-Cod swarm via NTM", description: "Spawn 5 Codex panes — codex-heavy mode is the deslop signature (per-pane prompts are codex-tuned) and an explicit override of the v3.21.0 cc:pi:gem 1:1:1 canonical. Each pane tackles a different code area; Claude (you) is controller running fresh-eyes review. Falls back to gmi, then pi, then cc when Codex is unavailable on this host, skipping a lane the doctor reports as disabled (see AGENTS.md NTM pane priority). 5-min looper. Best for large repos." },
    { label: "Iterative (10x via /repeatedly-apply-skill)", description: "Solo agent re-applies the skill 10 times with fresh-eyes review between passes. No NTM required. Good for slow-burn cleanup." }
  ],
  multiSelect: false
}])
```

Route on the answer:

| Mode | Action |
|------|--------|
| Single-pass | Run §2 only |
| Single + fresh-eyes | Run §2, then §3 |
| 5-Cod swarm (codex-heavy override) | Run §4 |
| Iterative | Run §5 |

---

## Step 2: Single-pass invocation (verbatim prompt)

> ❯ Read the plugin's own `$CLAUDE_PLUGIN_ROOT/AGENTS.md` and the project's `README.md` end-to-end. Then use your code investigation agent mode to understand the code, the technical architecture, and the project's purpose. Then apply the /simplify-and-refactor-code-isomorphically skill.

Concretely:
1. `Read` the plugin's own `$CLAUDE_PLUGIN_ROOT/AGENTS.md` end-to-end (the project's own `AGENTS.md`, if any, is a separate file).
2. `Read` README.md (root) end-to-end.
3. Spawn an Explore subagent (or use the Explore tool) to map architecture + technical purpose. Capture findings.
4. Invoke the skill via the `Skill` tool: `Skill(skill: "simplify-and-refactor-code-isomorphically")`.
5. Follow the skill's internal protocol (baseline capture → duplication mapping → candidate scoring → isomorphism cards → narrow edits → ledger).

The skill itself owns the proof-of-isomorphism discipline; the flywheel's only job is to invoke it after the agent has loaded project context.

---

## Step 3: Fresh-eyes follow-up (verbatim prompt)

After §2 returns, dispatch this exact prompt (also via `Skill` if it's a registered skill, or as the next user-style message in the same turn):

> ❯ Re-read every file you just wrote or modified with fresh eyes. Look for bugs, missed invariants, and anything that reads as confused. Fix what you find. Did you verify everything was preserved according to the skill?

The fresh-eyes review is the second-half of the proof obligation — the skill scores its own changes, but a clean re-read catches semantic regressions the candidate-scorer may have missed.

---

## Step 4: 5-Codex swarm via NTM (substitution-ladder fallback)

This mode mirrors the v3.6.0 wave-orchestration pattern but specialised for refactor-not-feature work.

### 4a. Pre-flight

1. **Shared swarm pre-conditions.** Execute the **NTM and provider readiness** and **Agent Mail bootstrap** steps in `_inflight_prompt.md`. Its first step executes `_implement.md` **Pre-flight: resolve NTM readiness** and uses the final doctor result. An unavailable result routes to §5 instead of §4b. Skip the in-flight bead snapshot and 4-minute looper because §4e owns deslop supervision.
2. **Deslop lane override.** Require green `codex_cli` and `codex_config_compat` rows for the primary `--cod=5` lane. If no usable Codex pane survives, ask the operator to choose all-cc swarm, §5 iterative mode, or abort.
3. **Baseline capture (THE proof obligation).** BEFORE any deslop edits, record:
   - Full test suite green: `rch test` (or stack-appropriate command). Capture pass-count + duration.
   - LOC: `tokei .` or `cloc . --vcs=git`. Snapshot to `.pi-flywheel/deslop-baseline-<sha>.json`.
   - Warnings: `rch build 2>&1 | grep -ic warning` (or stack equivalent).
   - Optional golden artifacts: capture stdout/stderr of any deterministic CLI commands the project ships.
   The skill's ledger compares post-edit numbers to this baseline. **No baseline = no proof = abort.**
4. **Swarm process guards.** After the lane choice and baseline pass, execute the **Disk-space guard** and **Tender-daemon spawn** steps in `_inflight_prompt.md`.

### 4b. Spawn the swarm

<!-- pane001-override: deslop is codex-heavy by design (see §4c per-pane prompts) -->

```bash
SESSION="${NTM_PROJECT}--deslop"
# Pane-type priority (see AGENTS.md "NTM pane priority"):
#   the v3.21.0 canonical default is mixed cc:pi:gem 1:1:1. Deslop's
#   --cod=5 shape is an explicit override — the per-pane prompts in §4c
#   are codex-tuned (terse preambles, COMPLETION_REPORT block, input-buffer
#   flush), and the deslop discipline depends on Codex's refactor style.
#   When Codex is unavailable, fall back to five Gemini panes, then to
#   Pi panes through swarm-spawn.js (it needs one NTM lane, so one cc
#   pane plus four Pi panes), then to five Claude panes. None of the fallbacks share
#   Codex's COMPLETION_REPORT contract — surface that to the user before
#   the swarm spawns.
ntm spawn "$NTM_PROJECT" --label deslop --no-user --cod=5 --stagger-mode=smart
```

Pane indices 1–5 are all Codex. Allocate 5 names from `mcp-server/src/adapters/agent-names.ts` via `allocateAgentNames(5, 'deslop-<sha>')`. Each pane gets a distinct **code area assignment** (e.g. "tools/", "adapters/", "tests/", "scripts/", "docs/" — adapt to the repo's structure).

### 4c. Per-pane prompt (Codex-tuned)

For each pane `<N>` ∈ 1..5:

```bash
ntm --robot-send="$SESSION" --panes=<N> --type=cod --msg='## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY)
0a. macro_start_session(human_key=<cwd>, program=codex, model=<your model name>, task_description="Deslop pane <N>: <area-assignment>"). Your name is <pane-N-name>.
0b. file_reservation_paths on the files inside <area-assignment>/. Refresh every 30 min via renew_file_reservations.
0c. send_message to "<coordinator-name>" subject "[deslop] pane <N> started" with your area assignment.
0d. Re-read AGENTS.md and README.md.

## STEP 1 — APPLY SKILL
Invoke /simplify-and-refactor-code-isomorphically scoped to <area-assignment>/. Follow the skill verbatim — baseline, duplication map, candidates, isomorphism cards, narrow edits, ledger. Do NOT touch files outside your reserved area; coordinate via Agent Mail if you need to.

## STEP 2 — VALIDATE (project-level build mutex — see Step 4d)
"$CLAUDE_PLUGIN_ROOT/scripts/build-mutex.sh" rch build  # waits for sibling agents
"$CLAUDE_PLUGIN_ROOT/scripts/build-mutex.sh" rch test
Both must pass. If a test that passed at baseline now fails, your edit broke isomorphism — REVERT, do not commit.

## STEP 3 — COMMIT (one lever per commit — skill rule)
Each surviving candidate becomes its own commit: refactor(deslop): <one-line summary> [pane <N>]
Reference the skill ledger entry id in the commit body.

## STEP 4 — RELEASE + REPORT
release_file_reservations.
send_message to "<coordinator-name>" subject "[deslop] pane <N> done" with: candidates considered, accepted, rejected (and why), commits made, baseline-vs-final delta from the ledger. Target ≤15 bullets.

COMPLETION_REPORT format. STOP after report.

' && tmux send-keys -t "$SESSION":0.<N> Enter Enter   # codex input-buffer flush
sleep 30   # stagger
```

### 4d. Project-level build mutex (anti-thundering-herd)

Five Codex agents finishing edits simultaneously and all running `rch build` at once will saturate disk + CPU and cause spurious failures. Enforce serialization via the portable wrapper, which the coordinator expands and bakes into every pane prompt's STEP 2 (above). The wrapper lives inside the plugin, so pane prompts receive the plugin-rooted path, not a repo-relative one:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/build-mutex.sh" rch build
```

The coordinator substitutes `$CLAUDE_PLUGIN_ROOT` in the `--msg` string before sending so the pane sees an absolute path. The wrapper uses an atomic `mkdir` lock under `.pi-flywheel/` and does not need the Linux-only `flock` binary. If a pane waits >5 min on the lock, escalate via `/slb` two-person approval before killing.

### 4e. Supervision (looper default; ntm controller alternative)

**Default — `Skill: loop` (5-min cadence per user spec).** Invoke the `Skill` tool with `loop`:
```
Skill(skill: "loop", args: "5m tend the deslop swarm; tail .pi-flywheel/tender-events.log; ensure each Codex pane picks a different code area (no overlap); verify isomorphism claims by spot-checking ledger entries; nudge idle panes via ntm --robot-send (or ntm assign --auto --strategy=dependency for next-bead picks); reopen any stalled in_progress beads (in_progress + no commit in 30min + agent absent from list_window_identities)")
```

**Alternative — `ntm controller` (opt-in; offload supervision to a dedicated pane).** If the user wants to walk away from the main Claude session, spawn a dedicated coordinator agent in pane 0:
```bash
ntm controller "$SESSION" --agent-type=cc
```
The controller follows ntm's built-in default prompt (`--robot-snapshot` → block on `--robot-attention` → `--robot-tail` → mail check → `--robot-interrupt`). Trade-off: separate context budget, no main-session burn — but the controller is a different agent with its own context, so any Simplify-pass-specific knowledge (which subsystems each pane is reserved for, ledger conventions) must be injected via the custom-prompt template (`{{.Session}}`, `{{.AgentList}}`, `{{.ProjectDir}}`) on launch. If the controller pane dies mid-run, climb the stuck-pane ladder (`--robot-is-working` → `--robot-smart-restart` → escalate to looper fallback). The tender-daemon stays running in either mode.

### 4f. Controller fresh-eyes review (you, the Claude coordinator)

While the swarm grinds, periodically (every other looper tick) read each pane's most recent commit via `git show <sha>` and apply fresh-eyes review per §3. If you spot an isomorphism violation a Codex pane missed, send a `[deslop] pane <N> revert request` message via Agent Mail with the specific finding.

### 4g. Termination

Wave done when: all 5 panes sent `[deslop] pane <N> done` AND no new commits in 10 min AND ledger shows no pending candidates.
- `kill -TERM $tender_daemon_pid`
- `Skill(skill: "loop", args: "stop")` to cancel the looper
- Leave NTM session alive (user may want to inspect)
- Transition to Step 9.5 wrap-up (`_wrapup.md`) for the version bump + commit-summary

---

## Step 5: Iterative mode (`/repeatedly-apply-skill`)

For solo-agent use without NTM. Invoke once via the `Skill` tool:

```
Skill(skill: "repeatedly-apply-skill", args: "10 times: simplify-and-refactor-code-isomorphically; apply fresh-eyes review between each pass")
```

The wrapper handles the loop, fresh-eyes review interleaving, and termination. Before the first pass, run D1's NTM readiness procedure, register the coordinator with Agent Mail, and capture the §4a baseline. Skip the deslop swarm lane, disk, daemon, bead-snapshot, and looper steps.

---

## Termination / hand-off

- Skill reports "no more candidates worth pursuing" → final fresh-eyes review (per §3) → transition to Step 9.5 wrap-up.
- User interrupts → pause politely; do NOT force-stop swarm panes until user confirms via `AskUserQuestion`.
- Baseline test broken AND no pane responsible (e.g. environmental) → halt all panes via `ntm --robot-send` shutdown_request → diagnose before resuming.
- Build mutex wait/deadlock (>5min wait) → escalate via `/slb` two-person approval before any kill.
- New beads created from deslop findings → enqueue via `flywheel_advance_wave` (v3.6.0); they enter the standard `bv triage` queue.
