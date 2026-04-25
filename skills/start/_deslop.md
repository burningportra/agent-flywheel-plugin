# Deslop Pass — `/agent-flywheel:start` → "Deslop pass"

**When to use:** the user invoked `/agent-flywheel:start` and picked **"Deslop pass"** from the Step 0d menu — they want to apply `/simplify-and-refactor-code-isomorphically` to the project as a proof-obligated, isomorphism-preserving refactor pass. This is meaningful on any repo (with or without open beads) and is the canonical "reduce AI-junk without changing behavior" workflow.

**How to use:** read this file, then surface a follow-up `AskUserQuestion` so the user picks the invocation mode (single-pass / fresh-eyes / 5-Codex swarm / iterative). Do NOT pick a mode unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. The slash-named skills referenced below (`/simplify-and-refactor-code-isomorphically`, `/repeatedly-apply-skill`, `/ntm`, `/vibing-with-ntm`) are load-bearing — invoke via the `Skill` tool, do NOT paraphrase.

---

## Step 1: Mode selection (mandatory)

```
AskUserQuestion(questions: [{
  question: "How do you want to apply the deslop pass?",
  header: "Deslop mode",
  options: [
    { label: "Single-pass (Recommended)", description: "One in-process invocation of /simplify-and-refactor-code-isomorphically. Fast; good for small/medium repos or initial exploration." },
    { label: "Single + fresh-eyes", description: "Single-pass, then a verbatim fresh-eyes review prompt to catch any isomorphism violations the first pass introduced." },
    { label: "5-Codex swarm via NTM", description: "Spawn 5+ Codex panes, each tackling a different code area, with Claude (you) as controller doing fresh-eyes review. 5-min looper. Best for large repos." },
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
| 5-Codex swarm | Run §4 |
| Iterative | Run §5 |

---

## Step 2: Single-pass invocation (verbatim prompt)

> ❯ First read ALL of the [AGENTS.md](http://AGENTS.md) file and [README.md](http://README.md) file super carefully and understand ALL of both! Then use your code investigation agent mode to fully understand the code and technical architecture and purpose of the project. Then, I want you to meticulously and exhaustively apply the /simplify-and-refactor-code-isomorphically skill to the project.

Concretely:
1. `Read` AGENTS.md (root) end-to-end.
2. `Read` README.md (root) end-to-end.
3. Spawn an Explore subagent (or use the Explore tool) to map architecture + technical purpose. Capture findings.
4. Invoke the skill via the `Skill` tool: `Skill(skill: "simplify-and-refactor-code-isomorphically")`.
5. Follow the skill's internal protocol (baseline capture → duplication mapping → candidate scoring → isomorphism cards → narrow edits → ledger).

The skill itself owns the proof-of-isomorphism discipline; the flywheel's only job is to invoke it after the agent has loaded project context.

---

## Step 3: Fresh-eyes follow-up (verbatim prompt)

After §2 returns, dispatch this exact prompt (also via `Skill` if it's a registered skill, or as the next user-style message in the same turn):

> ❯ Great, now I want you to carefully read over all of the new code you just wrote and other existing code you just modified with "fresh eyes" looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Carefully fix anything you uncover. Did you actually verify that everything was preserved according to the skill?

The fresh-eyes review is the second-half of the proof obligation — the skill scores its own changes, but a clean re-read catches semantic regressions the candidate-scorer may have missed.

---

## Step 4: 5-Codex swarm via NTM

This mode mirrors the v3.6.0 wave-orchestration pattern but specialised for refactor-not-feature work.

### 4a. Pre-flight (mandatory — same as `_implement.md`)

1. **NTM readiness gate** — re-detect inline (per `_implement.md` Pre-flight at top of Step 7). If misconfigured, surface fix-or-fallback `AskUserQuestion`.
2. **CLI capability check** — `which codex` MUST succeed. If not, fall back to §5 iterative mode (don't silently degrade — surface a `AskUserQuestion` first).
3. **Agent Mail bootstrap** — `macro_start_session` for the coordinator (you). Capture registration token.
4. **Baseline capture (THE proof obligation)** — BEFORE any deslop edits, record:
   - Full test suite green: `rch test` (or stack-appropriate command). Capture pass-count + duration.
   - LOC: `tokei .` or `cloc . --vcs=git`. Snapshot to `.pi-flywheel/deslop-baseline-<sha>.json`.
   - Warnings: `rch build 2>&1 | grep -ic warning` (or stack equivalent).
   - Optional golden artifacts: capture stdout/stderr of any deterministic CLI commands the project ships.
   The skill's ledger compares post-edit numbers to this baseline. **No baseline = no proof = abort.**
5. **Disk-space guard** — `df -h $PWD`. <5GB → run stale-artifact cleanup (`git clean -fdX -- '<build-output-dirs>'` only — never `-fdx`) before spawning.
6. **Tender-daemon spawn** (v3.6.0+) — `node $CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js --session=… --interval=30000 --logfile=.pi-flywheel/tender-events.log --agent=<your-name> &`. Capture PID for shutdown.

### 4b. Spawn the swarm

```bash
SESSION="${NTM_PROJECT}--deslop"
ntm spawn "$NTM_PROJECT" --label deslop --no-user --cod=5 --stagger-mode=smart
```

Pane indices 1–5 are all Codex. Allocate 5 names from `mcp-server/src/adapters/agent-names.ts` via `allocateAgentNames(5, 'deslop-<sha>')`. Each pane gets a distinct **code area assignment** (e.g. "tools/", "adapters/", "tests/", "scripts/", "docs/" — adapt to the repo's structure).

### 4c. Per-pane prompt (Codex-tuned)

For each pane `<N>` ∈ 1..5:

```bash
ntm --robot-send="$SESSION" --panes=<N> --type=cod --msg='## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY)
0a. macro_start_session(human_key=<cwd>, program=codex-cli, model=your-model, task_description="Deslop pane <N>: <area-assignment>"). Your name is <pane-N-name>.
0b. file_reservation_paths on the files inside <area-assignment>/. Refresh every 30 min via renew_file_reservations.
0c. send_message to "<coordinator-name>" subject "[deslop] pane <N> started" with your area assignment.
0d. Re-read AGENTS.md and README.md.

## STEP 1 — APPLY SKILL
Invoke /simplify-and-refactor-code-isomorphically scoped to <area-assignment>/. Follow the skill verbatim — baseline, duplication map, candidates, isomorphism cards, narrow edits, ledger. Do NOT touch files outside your reserved area; coordinate via Agent Mail if you need to.

## STEP 2 — VALIDATE (project-level build mutex — see Step 4d)
flock $PWD/.pi-flywheel/build.lock rch build  # waits for sibling agents
flock $PWD/.pi-flywheel/build.lock rch test
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

Five Codex agents finishing edits simultaneously and all running `rch build` at once will saturate disk + CPU and cause spurious failures. Enforce serialization via `flock`:

```bash
flock $PWD/.pi-flywheel/build.lock rch build
```

Bake the `flock` wrapper into every per-pane prompt's STEP 2 (above). The lock file lives in `.pi-flywheel/` so it auto-cleans with `flywheel-cleanup`. If a pane waits >5 min on the lock, escalate via `/slb` two-person approval before killing.

### 4e. Looper (5-min cadence per user spec)

Invoke the `Skill` tool with `loop`:
```
Skill(skill: "loop", args: "5m tend the deslop swarm; tail .pi-flywheel/tender-events.log; ensure each Codex picks a different code area (no overlap); verify isomorphism claims by spot-checking ledger entries; nudge idle panes via ntm --robot-send; reopen any stalled in_progress beads (in_progress + no commit in 30min + agent absent from list_window_identities)")
```

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

The wrapper handles the loop, fresh-eyes review interleaving, and termination. Pre-conditions §4a items 1, 3, 4 still apply (skip NTM-specific items 2, 5, 6).

---

## Operator decoder (apply while executing the chosen mode)

| Phrase in user's documentation | Concrete action |
|--------------------------------|-----------------|
| "isomorphism cards" | The skill's per-candidate proof-table covering ordering, errors, logs, metrics, side effects, async cancellation, hook identity, serialization, lifecycle. Required before any edit lands. |
| "baseline" | Recorded in §4a item 4 BEFORE any edits. Without it the skill cannot prove preservation. |
| "ledger" | The skill's per-pass record of accepted/rejected candidates + isomorphism-card outcomes. Lives in the project's `.simplify-ledger/` (the skill creates it). Read this AFTER each pass to drive the controller fresh-eyes review. |
| "one lever per commit" | Each accepted candidate = one commit. Do NOT batch. The skill enforces this; the swarm-mode prompt repeats it. |
| "no rewrites, no sed, no drive-by fixes" | Mechanical edits only — `Edit` tool one location at a time. If a candidate requires a rewrite, the skill's risk-scorer should reject it. |
| "deletion without explicit permission" | The skill never deletes files autonomously; it surfaces deletion candidates for the operator to confirm. Surface via `AskUserQuestion`. |
| "pathology catalog" | The skill ships a list of AI-junk patterns (defensive branches for impossible inputs, duplicated wrappers, _v2 files, orphaned helpers, stale types, comments-as-task-plans). It scans for these automatically. |
| "5+ Codex instances on a 5-min /loop" | Implemented in §4 (Codex pane count + looper interval verbatim). |
| "Claude Code as final fresh eyes" | Implemented in §4f (controller fresh-eyes between looper ticks). |

---

## Pre-conditions checklist (TL;DR — applies to ALL modes)

1. AGENTS.md + README.md read end-to-end ✓
2. Code investigation done (Explore agent OR direct read) ✓
3. Baseline captured to `.pi-flywheel/deslop-baseline-<sha>.json` (tests green, LOC, warnings) ✓
4. Skill installed at `~/.claude/skills/simplify-and-refactor-code-isomorphically` (verified by `Skill` tool — failure surfaces a clear "not installed" error) ✓
5. **Swarm mode only:** NTM ready, codex CLI present, tender-daemon spawned, build mutex configured ✓
6. **Iterative mode only:** `/repeatedly-apply-skill` installed at `~/.claude/skills/repeatedly-apply-skill` ✓

---

## Termination / hand-off

- Skill reports "no more candidates worth pursuing" → final fresh-eyes review (per §3) → transition to Step 9.5 wrap-up.
- User interrupts → pause politely; do NOT force-stop swarm panes until user confirms via `AskUserQuestion`.
- Baseline test broken AND no pane responsible (e.g. environmental) → halt all panes via `ntm --robot-send` shutdown_request → diagnose before resuming.
- Build mutex deadlock (>5min wait) → escalate via `/slb` two-person approval before any kill.
- New beads created from deslop findings → enqueue via `flywheel_advance_wave` (v3.6.0); they enter the standard `bv triage` queue.
