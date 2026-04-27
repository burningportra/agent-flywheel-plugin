# Reality Check Pass — `/agent-flywheel:start` → "Reality check"

**When to use:** the user invoked `/agent-flywheel:start` and picked **"Reality check"** from the Step 0e "Other" sub-menu — they want to step back, honestly assess the gap between the project's vision (AGENTS.md / README.md / plan docs) and what's actually implemented, then convert every gap into beads, optionally executing them via the existing NTM swarm pattern.

This is the canonical "come-to-Jesus" pass after days or weeks of bead work. It's a *steering mechanism* (not just an audit): the agent has been knee-deep in the code and is best positioned to articulate the real state from the trenches.

**How to use:** read this file, then surface a follow-up `AskUserQuestion` so the user picks the depth (reality-check only / reality-check + beads / reality-check + beads + swarm). Do NOT pick a depth unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. The slash-named skill (`/reality-check-for-project`) is load-bearing; invoke via the `Skill` tool, do NOT paraphrase its prompts. Bead creation must use `br` only (per `/beads-workflow`).

---

## Step 1: Depth selection (mandatory)

```
AskUserQuestion(questions: [{
  question: "How deep should the reality check go?",
  header: "Reality check",
  options: [
    { label: "Reality check only", description: "Run §2 — agent reads docs + investigates code + applies /reality-check-for-project exhaustively. Stop after the gap report. Best when you want to read the findings and decide manually." },
    { label: "Reality check + beads", description: "Run §2, then §3 — convert every gap into a granular self-contained bead graph via br, with comments capturing background/reasoning. Stops before implementation. (Recommended)" },
    { label: "Full pipeline (check + beads + swarm)", description: "Run §2, then §3, then §4 — execute the gap-closure beads via NTM swarm (3 cod + 3 cc, 3-min looper). Best when you want to walk away and let it run." }
  ],
  multiSelect: false
}])
```

Route on the answer:

| Mode | Action |
|------|--------|
| Reality check only | Run §2, then route to Step 9.5 wrap-up (`_wrapup.md`) |
| Reality check + beads | Run §2, then §3, then route to Step 6 launch menu (`_beads.md`) |
| Full pipeline | Run §2, then §3, then §4 |

**The phases are sequential and gated.** Do NOT run them in parallel — Phase 2 depends on the gap report from Phase 1, and Phase 3 depends on the beads from Phase 2.

---

## Step 2: Phase 1 — exhaustive reality check (verbatim prompt)

Dispatch this exact prompt to the working agent (you, in the current turn, OR an Explore subagent if the project is large enough that loading both docs and the code investigation will blow context):

> ❯ First read ALL of the [AGENTS.md](http://AGENTS.md) file and [README.md](http://README.md) file super carefully and understand ALL of both! Then use your code investigation agent mode to fully understand the code and technical architecture and purpose of the project. THEN apply /reality-check-for-project here in an exhaustive way.

Concretely:
1. `Read` AGENTS.md (root) end-to-end.
2. `Read` README.md (root) end-to-end.
3. `Glob` for any other markdown plan/spec docs (`docs/plans/*.md`, `docs/*.md`, `*.md` at root) and read them too — the reality-check skill's Variant A asks for "every markdown plan/spec document".
4. Spawn an Explore subagent (or use the Explore tool) to map architecture, technical purpose, and what's *actually* implemented vs aspirational. Capture findings.
5. Invoke the skill via the `Skill` tool: `Skill(skill: "reality-check-for-project")`.
6. Follow the skill's internal protocol — Phase 1 (Reality Check Question) — exhaustively. The output is a brutally honest gap report: what works end-to-end, what's stubbed, what's documented but unimplemented, what's implemented but doesn't actually deliver the vision.

**Time-budget note:** this phase typically takes 15–20 minutes for a non-trivial project. Do NOT rush it. Do NOT short-circuit with a summary of the docs without code investigation — code = ground truth, docs = measuring stick. The whole value of this skill is the gap *between* them.

When Phase 1 returns, surface the gap report to the user. Then **persist the report as a CASS learning** (mandatory — the gap report is high-value session intelligence; future sessions need to know the historical drift patterns of this project):

```
flywheel_memory(operation: "store", cwd, content: {
  type: "reality-check-gap-report",
  date: "<YYYY-MM-DD>",
  goal: "<state.selectedGoal or 'standalone reality-check'>",
  gaps: [
    { area: "<subsystem>", aspirational: "<what docs promise>", actual: "<what code does>", severity: "high|med|low" },
    ...
  ],
  summary: "<one-paragraph executive summary of the report>"
})
```

Capture the returned `entryId` — it will be referenced from each gap-closure bead in §3. If `flywheel_memory` is unavailable (degraded MCP), fall back to writing `docs/reality-checks/<YYYY-MM-DD>-gap-report.md` with the same shape and reference the file path from beads instead.

Then transition to Step 3 (or stop here if mode = "Reality check only").

---

## Step 3: Phase 2 — gap-closure plan → granular bead graph (verbatim prompt)

Dispatch this exact prompt next (same turn — per the Stay-in-turn rule in `SKILL.md`):

> ❯ I need you to help me fix this. That is, making all the things that are unimplemented but which SHOULD have been implemented according to the beads and markdown plan. Figure out exactly what needs to be done to get us over the goal line with a finished, polished, reliable, performant project in line with the vision described earlier.
>
> OK so please take ALL of that and elaborate on it and use it to create a comprehensive and granular set of beads for all this with tasks, subtasks, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the overarching goals of the project.).
>
> The beads should be so detailed that we never need to consult back to the original markdown plan document. Remember to ONLY use the `br` tool to create and modify the beads and add the dependencies.

Concretely:
1. The agent designs the bead graph from the gap report (tasks, subtasks, dependencies).
2. **All bead creation uses `br create` only.** No editing JSON files directly. No other tracking systems. Per `/beads-workflow`, `br` is the single source of truth.
3. Each bead's body includes background, reasoning/justification, considerations — verbose enough that the bead alone tells future-you what to do without re-reading any plan doc.
4. Dependencies are declared via `br dep add <child> <parent>`.
5. **Tagging convention (mandatory, new in v3.6.5):** every gap-closure bead gets the tag `reality-check-<YYYY-MM-DD>` matching the date of the Phase 1 run. Apply via `br tag add <bead-id> reality-check-<YYYY-MM-DD>` (or `br create --tag reality-check-<YYYY-MM-DD>` if the create command supports tag flags). Also reference the CASS `entryId` captured in §2 in the bead body's "Background" section so future agents can trace the gap back to its source. The tag makes downstream tooling work:
   - `br list --tag reality-check-<YYYY-MM-DD>` → see all beads from one round.
   - `bv --robot-triage --filter-tag reality-check-*` → triage all reality-check beads across rounds.
   - `flywheel-status` and the post-flywheel summary surface "X beads from reality-check round on <date>".
6. After creation, run `bv --robot-triage` (or `bv triage`) to validate the graph is well-formed and surface any obvious cycles or orphans.

When Phase 2 returns, the user has a fully self-contained bead graph representing every gap-closure task. Surface a summary (count of beads created, tag applied, dependency graph stats) to the user. Then transition to Step 4 (full-pipeline mode) or Step 6 launch menu (reality-check + beads mode).

---

## Step 4: Phase 3 — execute gap-closure beads via NTM swarm (verbatim prompt)

Only run this section in **"Full pipeline"** mode. Dispatch this exact prompt:

> ❯ First read ALL of the [AGENTS.md](http://AGENTS.md) file and [README.md](http://README.md) file super carefully and understand ALL of both! Then use your code investigation agent mode to fully understand the code and technical architecture and purpose of the project.
>
> THEN: start systematically and methodically and meticulously and diligently executing those remaining beads tasks that you created in the optimal logical order!
>
> Don't forget to mark beads as you work on them. Use the /ntm swarm and /vibing-with-ntm skills to implement things in the optimal way according to /bv; launch 3 codex and 3 claude code instances to do this and use your looping feature to check in on the swarm every 3 minutes and feed more instructions to any idle agents.

### 4a. Pre-flight (mandatory — same as `_implement.md`)

1. **NTM readiness gate** — re-detect inline (per `_implement.md` Pre-flight at top of Step 7). If misconfigured, surface fix-or-fallback `AskUserQuestion`.
2. **CLI capability check** — `which codex` AND `which claude` MUST succeed. If `codex` missing, the 3-cod lane collapses; surface a degraded-mode `AskUserQuestion` (override default 3:3 ratio? abort? proceed degraded?).
3. **Agent Mail bootstrap** — `macro_start_session` for the coordinator (you). Capture registration token.
4. **Disk-space guard** — `df -h $PWD`. <5GB → run stale-artifact cleanup (`git clean -fdX -- '<build-output-dirs>'` only — never `-fdx`) before spawning.
5. **Tender-daemon spawn** — `node $CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/tender-daemon.js --session=… --interval=30000 --logfile=.pi-flywheel/tender-events.log --agent=<your-name> &`. Capture PID for shutdown.
6. **Bead snapshot** — `br list --json` and `br ready --json`. Identify any stalled in-progress beads up front and reopen per the rule in `_inflight_prompt.md` (in_progress + no commit in 30min + agent absent from `list_window_identities`).
7. **Build mutex documented** — every impl agent's STEP 2 prompt must use `scripts/build-mutex.sh rch build` so the 6 panes don't compile simultaneously. Do not use bare `flock`; macOS does not ship it.

### 4b. Spawn the swarm

`ntm spawn $NTM_PROJECT --label reality-check-closure --no-user --cc=3 --cod=3 --stagger-mode=smart`. Pane indices: cc=1,2,3  cod=4,5,6.

### 4c. Looper schedule

`Skill: loop` with **3-minute** interval (note: shorter than the inflight-resume's 4-min cadence — reality-check closure tends to surface bead-graph issues that benefit from faster nudging). Looper prompt:

> tail .pi-flywheel/tender-events.log; check inbox via macro_start_session; nudge idle panes guided by `bv --robot-triage`; reopen stalled in_progress beads; if all open beads are in_progress AND no commits in 10min, escalate to user via AskUserQuestion.

### 4d. Monitor loop

Enter the canonical monitor loop documented in `_implement.md` Pre-loop / Implementation loop / Post-wave bridge. Use the operator-decoder table from `_inflight_prompt.md` for translating swarm-state phrases to actions ("stalled out", "build contention", "saturation", etc.).

---

## Termination / hand-off

- All gap-closure beads closed AND review converged → `kill -TERM $tender_daemon_pid`, leave NTM session alive, transition to Step 9.5 wrap-up via `_wrapup.md`.
- User interrupts via the looper or directly → pause politely; do NOT force-stop agents until user confirms.
- New gaps surfaced mid-execution (Phase 3 implementation reveals more aspirational-vs-real divergence) → run another `Skill: reality-check-for-project` Phase 5 (refinement round). Do NOT silently expand scope; surface via `AskUserQuestion` first.
- Build mutex wait/deadlock detected (`scripts/build-mutex.sh` waits >5min) → escalate via `/slb` two-person approval before killing.
