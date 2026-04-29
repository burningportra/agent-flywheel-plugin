---
name: start
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

# Orchestrate: Full Flywheel

Run the agent-flywheel for this project. $ARGUMENTS (optional: initial goal or `--mode single-branch`)

> ## ⚠️ UNIVERSAL RULE 1 — `AskUserQuestion` is the only way to ask the user anything
>
> Every user decision in this skill — phase routing, plan refinement, bead approval, launch confirmation, wrap-up choices, recovery branches — MUST be presented via the `AskUserQuestion` tool with concrete labeled options (2–4 per question). Free-text "ask the user…" prompts, "wait for confirmation", "wait for the user's next message", or implicit decision points are bugs. The "Other" field absorbs custom answers when none of the prepared options fit.
>
> If you find yourself about to write text like *"surface this to the user"*, *"propose this to the user"*, *"check with the user"*, or *"only do X if the user confirms"* — STOP and write an `AskUserQuestion` call instead. No exceptions.
>
> ## ⚠️ UNIVERSAL RULE 2 — invoke specialist skills by name when they apply
>
> This SKILL references many specialist skills by slash-name (`/idea-wizard`, `/ubs-workflow`, `/caam`, `/ui-polish`, `/docs-de-slopify`, testing-*, stack-specific skills, etc.). When a step names one, invoke it via the `Skill` tool rather than re-implementing its logic inline. Specialist skills carry project-tested prompts and conventions you don't have time to recreate.
>
> Equally important: if a step does NOT name a skill but you notice one applies to the situation (e.g. a React component bead and `/react-component-generator` exists), invoke it anyway. Skills are hints-with-authority — use them by default, skip only when they clearly don't fit.

> ## ⚠️ UNIVERSAL RULE 3 — load phase instructions on demand
>
> Steps 5–12 are stored in separate files to keep this prompt within token limits. When you reach a phase boundary, **Read** the corresponding file from `skills/start/`:
>
> | Phase | File | Steps |
> |-------|------|-------|
> | Planning | `_planning.md` | 5, 5.55, 5.6 |
> | Bead creation & approval | `_beads.md` | 5.5, 6 |
> | Implementation | `_implement.md` | 7 |
> | Review & loop | `_review.md` | 8, 9, 9.25, 9.4 |
> | Wrap-up & post-flywheel | `_wrapup.md` | 9.5, 10, 11, 12 |
>
> Read the file **before** executing that phase. Do NOT guess or improvise the instructions — the sub-files contain critical gates, edge-case handling, and AskUserQuestion templates.
>
> **Faster path (optional optimization):** instead of `Read`, you can call `flywheel_get_skill({ cwd, name: "agent-flywheel:start_planning" })` (or `start_beads`, `start_implement`, `start_review`, `start_wrapup`) to fetch the body via the bundled MCP tool in one round-trip. Falls back to disk transparently if the bundle is stale or missing. Existing `Read` calls keep working — this is purely an optimization.

## Step 0: Opening Ceremony

### 0.banner — SHOW THIS FIRST, ALWAYS

**Before any tool calls, before any other reads, print the banner.** This is the first visible output of the skill. Use the version from `mcp-server/package.json` (resolve `CLAUDE_PLUGIN_ROOT` or use the find command in Step 0a; default to `unknown` if unreadable — never substitute a stale hardcoded version).

```
░▒▓ CLAUDE // AGENT-FLYWHEEL v<VERSION> ▓▒░
```

Output it as a plain code block so the user always sees the banner even if the rest of the skill fails. Then continue with 0.preflight.

### 0.preflight — Captured user input

If the user's prompt contains anything beyond `/start <args>` — a goal sentence, a pasted plan, a path to a plan file, a directive like "fix X then Y" — capture it as `USER_INPUT` and treat it as a candidate goal or plan. **Do NOT act on it yet. Do NOT skip the welcome banner or Step 0b detection.** Run the full Step 0a–0d flow silently so the user sees current state (existing session, open beads, AM status) before deciding.

Then route in Step 0e instead of showing the default main menu:

**Classification heuristics**:
- **Plan-shaped USER_INPUT** — multi-paragraph, contains `##`/`###` headers, mentions specific files, OR is an existing path matching `docs/plans/*.md` → treat as plan.
- **Goal-shaped USER_INPUT** — ≤300 chars, no markdown headers, reads as one or two sentences → treat as goal.
- **Ambiguous** — long unstructured prose → treat as goal but route through `/brainstorming` to refine first.

**Routing override for Step 0e** (only when USER_INPUT is non-empty):

- Plan-shaped:
  ```
  AskUserQuestion(questions: [{
    question: "I see a plan in your message ('<first 60 chars>…'). What should I do with it?",
    header: "Plan input",
    options: [
      { label: "Use as plan", description: "Register via flywheel_plan and jump to bead creation (Recommended)" },
      { label: "Treat as goal", description: "Use the plan content as the goal description and run the full flywheel from Step 4" },
      { label: "Discard", description: "Ignore the input and show the regular start menu" }
    ],
    multiSelect: false
  }])
  ```
  - "Use as plan" → if USER_INPUT was a file path, call `flywheel_plan` with `planFile`. If it was inline, write it to `docs/plans/<date>-<goal-slug>.md` first, then call `flywheel_plan` with `planFile`. Then jump to Step 5.5.
  - "Treat as goal" → call `flywheel_select` with the input as goal, jump to Step 5.
  - "Discard" → fall back to the default Step 0e menu.

- Goal-shaped:
  ```
  AskUserQuestion(questions: [{
    question: "I see a goal in your message: '<USER_INPUT>'. Run the flywheel on this?",
    header: "Goal input",
    options: [
      { label: "Yes, full flywheel", description: "Skip discovery, plan and implement this goal (Recommended)" },
      { label: "Refine first", description: "Run /brainstorming to clarify scope before planning" },
      { label: "Plan only", description: "Generate a plan, stop before implementation" },
      { label: "Discard", description: "Ignore the input and show the regular start menu" }
    ],
    multiSelect: false
  }])
  ```
  - "Yes, full flywheel" → call `flywheel_select` with USER_INPUT as goal, proceed to Step 5.
  - "Refine first" → invoke `/brainstorming` with the input, then return to Step 4 with the refined goal.
  - "Plan only" → call `flywheel_select`, proceed through Step 5, stop after bead creation.
  - "Discard" → fall back to the default Step 0e menu.

- Ambiguous → always run `/brainstorming` first, then route as goal-shaped after refinement.

**Hard rule**: never act on USER_INPUT directly without first showing the banner and getting an explicit menu choice. The flywheel's gates exist for a reason — pre-prompt content does NOT bypass them.

### 0a. Detect version

Prefer `$CLAUDE_PLUGIN_ROOT/mcp-server/package.json` if the env var is set — that's the canonical plugin root. Otherwise, find it under the plugins cache. The install path is `.../agent-flywheel/agent-flywheel/<VERSION>/mcp-server/package.json`, so use a pattern that matches the interposed version directory and pick the most-recently-modified match:
```bash
{ [ -n "$CLAUDE_PLUGIN_ROOT" ] && cat "$CLAUDE_PLUGIN_ROOT/mcp-server/package.json"; } \
  || ls -t ~/.claude/plugins/cache/agent-flywheel/agent-flywheel/*/mcp-server/package.json 2>/dev/null | head -1 | xargs cat 2>/dev/null
```
Read it and extract the version. Also read the project name from `package.json` in cwd (or use the directory name). If no version can be resolved, render the banner with `v?` rather than inventing a number.

### 0b. Detect state

Gather context silently (do NOT display raw output yet). Run checks 1-8 in parallel where possible:

1. **MCP tools**: Call `flywheel_profile` directly with `cwd` — if the call succeeds, MCP is available (cache the result to avoid a redundant call in Step 2). If the tool is not found or errors, set `MCP_DEGRADED = true`. Do NOT use `ToolSearch` — MCP tools may be deferred and unavailable to ToolSearch at startup.
2. **Existing session**: Read `.pi-flywheel/checkpoint.json` if it exists. Note phase and goal.
3. **Existing beads**: Run `br list --json 2>/dev/null` and count open/in-progress/closed beads.
4. **Git status**: Run `git log --oneline -1` to get latest commit.
5. **CASS memory**: Call `flywheel_memory` with `operation: "search"` and `query: "session learnings flywheel"` to load prior session context. If CASS is unavailable, skip silently.
6. **Agent Mail**: Run `curl -s --max-time 2 http://127.0.0.1:8765/health/liveness` via Bash. If unreachable, set `AGENT_MAIL_DOWN = true` — display `Agent Mail: offline` in the banner and warn before any step that spawns parallel agents. Do NOT block the session or require `/flywheel-setup` — single-agent workflows work fine without it.
7. **NTM**: Run `which ntm 2>/dev/null` via Bash. If not found, set `NTM_AVAILABLE = false` and skip the rest of this check. If found, do NOT declare availability yet — `ntm spawn` requires the current project to live under `projects_base`, and failing that, it will cd into the wrong directory (or fail outright). Run these follow-up checks:

   ```bash
   NTM_BASE=$(ntm config show 2>/dev/null | awk -F'"' '/^projects_base/ {print $2}')
   PROJECT_BASENAME=$(basename "$PWD")
   if [ -n "$NTM_BASE" ] && [ -d "$NTM_BASE/$PROJECT_BASENAME" ]; then
     echo "ntm-ready project=$PROJECT_BASENAME base=$NTM_BASE"
   else
     echo "ntm-misconfigured base=$NTM_BASE project=$PROJECT_BASENAME"
   fi
   ```

   - `ntm-ready` → set `NTM_AVAILABLE = true`, capture `NTM_PROJECT = $PROJECT_BASENAME`, display `NTM: available` in the banner. Preferred mechanism for launching parallel agents (planners and impl agents) — use `ntm spawn <NTM_PROJECT> --label <purpose>` + `ntm send` instead of the `Agent()` tool. Gives the user visible tmux panes they can observe and interact with directly.
   - `ntm-misconfigured` → set `NTM_AVAILABLE = false`, display `NTM: installed but not configured (projects_base=<base>, missing <base>/<PROJECT_BASENAME>)` in the banner, and mention that `/flywheel-setup` can fix it via either `ntm config set projects_base <parent>` or a symlink. Fall back to `Agent()` for this session.
   - Bash error / `NTM_BASE` empty → set `NTM_AVAILABLE = false`, treat like ntm-misconfigured.

   Never set `NTM_AVAILABLE = true` based on `which ntm` alone — the spawn step downstream will silently fail.

8. **Doctor smoke check**: Call `flywheel_doctor` with `cwd`. Cache the returned `DoctorReport` as `DOCTOR_REPORT` for use in the welcome banner (step 0c). If the call fails outright (MCP tool missing, tool error), set `DOCTOR_REPORT = null` and proceed — doctor is advisory, not blocking. If `DOCTOR_REPORT.overall === "red"`, the banner will mark the session as warning-state and surface the failing check names; the user is not blocked, but they should consider running `/agent-flywheel:flywheel-doctor` before continuing.

### 0c. Display the welcome banner

Display a single cohesive welcome message. Example:

```
 ╔══════════════════════════════════════════════════╗
 ║                                                  ║
 ║   agent-flywheel v<VERSION>                      ║
 ║   The Agentic Coding Flywheel                    ║
 ║                                                  ║
 ║   Project: <project-name>                        ║
 ║   Branch:  <current-branch> @ <short-sha>        ║
 ║   Beads:   <N open> | <M in-progress> | <K done> ║
 ║                                                  ║
 ╚══════════════════════════════════════════════════╝
```

If beads is zero, show `Beads: none yet`. If MCP tools are unavailable, show `MCP: not configured` in the banner.

Also append a `Doctor:` line to the banner using `DOCTOR_REPORT.overall` (from step 0b check 8):

- `green` → `Doctor: green ✓`
- `yellow` → `Doctor: yellow ⚠`
- `red` → `Doctor: red ✗`
- null / not run → `Doctor: not run`

If `DOCTOR_REPORT.overall === "red"`, under the banner list every failing check with one line each and include a pointer to the slash command:

> **Doctor flagged:**
> - `<check_name>` — <detail>
> - ...
>
> Run `/agent-flywheel:flywheel-doctor` for the full report and remediation steps.

If CASS returned learnings from prior sessions, display them below the banner:

> **From prior sessions:**
> - <top 3-5 most relevant learnings, anti-patterns, or gotchas>

**Error-code trends (last 10 sessions):** call `flywheel_memory` with `operation: "search"` and `query: "error-code telemetry"` (or read `.pi-flywheel/error-counts.json` directly via `readTelemetry({ cwd })` from `telemetry.ts` when available). If telemetry is non-empty, display the top 3 codes below the CASS learnings block:

> **Error-code trends (last 10 sessions):**
> - `<code_1>` — <count> occurrence(s)
> - `<code_2>` — <count> occurrence(s)
> - `<code_3>` — <count> occurrence(s)

If telemetry is unavailable or empty, skip this block silently. The telemetry is advisory — never gate on it.

**Reality-check freshness suggestion** — call `flywheel_memory` with `operation: "search"` and `query: "reality-check session learnings gap analysis"`. Count distinct prior sessions for THIS project (`cwd`-scoped) and find the most recent reality-check date (look for entries tagged `reality-check-<YYYY-MM-DD>` or with body containing "reality check" / "gap report"). If ≥3 prior flywheel sessions exist AND no reality-check has run in the last 7 sessions (or ever), append below the error-code trends:

> **Suggestion:** It's been <X> sessions since the last reality-check pass — consider running `/agent-flywheel:flywheel-reality-check` (or pick "Reality check" from the menu) to verify the implementation still matches the project's vision before continuing.

Placeholder meanings used in the Step 0c display examples:

- **detail**: One concise failure reason returned by the doctor check.
- **count**: The number of occurrences for the displayed telemetry code.
- **X**: The number of prior flywheel sessions since the last reality-check pass.

This is advisory only — never gate on it. If CASS is unavailable, skip silently.

This gives the user (and the agent-flywheel) context from past runs before making any decisions.

If `DOCTOR_REPORT.checks` contains a yellow `orphaned_worktrees` row whose `message` mentions `orphaned worktree`, `stale worktree`, or `locked stale worktree`, run this cleanup gate before the main menu:

```
AskUserQuestion(questions: [{
  question: "Doctor found stale or orphaned worktrees from prior sessions. Clean up before starting?",
  header: "Cleanup",
  options: [
    { label: "Inspect first (Recommended)", description: "List the candidate worktrees and lock state before removing anything" },
    { label: "Clean up", description: "Run the flywheel-cleanup command and confirm removals in its prompt" },
    { label: "Skip", description: "Continue to the start menu and leave the worktrees untouched" }
  ],
  multiSelect: false
}])
```

Route the choice immediately: **Inspect first** → show `git worktree list --porcelain`, summarize the candidates from the doctor row, then surface this same cleanup gate again; **Clean up** → run the flywheel-cleanup command, then continue to the main menu; **Skip** → continue to the main menu. Locked stale worktrees must be treated as inspect-first candidates unless the user explicitly chooses cleanup.

### 0d. Present the main menu

Build the menu options dynamically based on detected state:

**If a previous session exists** (checkpoint found with non-idle phase):

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Universal in-flight resume — 4 pi + 2 cc swarm (cod fallback if Pi unavailable; see AGENTS.md NTM pane priority), 4-min looper, bv-triaged dispatch, stalled-bead recovery, auto code-review on completion. See skills/start/_inflight_prompt.md" },
    { label: "Resume session", description: "Continue '<goal>' from <phase> phase manually (no swarm)" },
    { label: "Deslop pass", description: "Apply the deslop refactor skill with isomorphism proofs — single-pass, fresh-eyes, 5-Pi swarm (cod fallback if Pi unavailable; see AGENTS.md NTM pane priority), or iterative 10x. See skills/start/_deslop.md" },
    { label: "Other", description: "Work on beads manually, start a new goal, or research an external repo (sub-menu)" }
  ],
  multiSelect: false
}])
```

**If open/in-progress beads exist** but no active session:

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Universal in-flight resume — 4 pi + 2 cc swarm (cod fallback if Pi unavailable; see AGENTS.md NTM pane priority), 4-min looper, bv-triaged dispatch, stalled-bead recovery, auto code-review on completion. See skills/start/_inflight_prompt.md" },
    { label: "Reality check", description: "Step back: gap-check actual implementation against AGENTS.md/README.md/plan vision using the reality-check skill, convert gaps to beads, optionally run swarm. The 'come-to-Jesus' steering pass. See skills/start/_reality_check.md" },
    { label: "Work on beads", description: "<N> open beads exist — refine, implement, or inspect (manual)" },
    { label: "Other", description: "Deslop pass / new goal / research an external repo / audit (sub-menu)" }
  ],
  multiSelect: false
}])
```

**If no beads and no session** (fresh start):

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Scan & discover", description: "Profile the repo and find improvement opportunities" },
    { label: "Set a goal", description: "I already know what I want to build" },
    { label: "Deslop pass", description: "Apply the deslop refactor skill — proof-obligated refactor pass. Meaningful even on a clean repo with no beads. See skills/start/_deslop.md" },
    { label: "Other", description: "Research an external repo or run /flywheel-setup (sub-menu)" }
  ],
  multiSelect: false
}])
```

### 0e. Route the user's choice

> **If `USER_INPUT` was captured in step 0.preflight, use the routing override there instead of this menu.** The default menu below applies only when the user invoked `/start` with no extra prompt content.

| Choice | Action |
|--------|--------|
| **Auto-swarm** | **Read `skills/start/_inflight_prompt.md` end-to-end and execute the verbatim prompt + the operator-decoder table + the 7-item pre-conditions checklist.** This is the canonical in-flight resume path: NTM readiness gate → CLI capability check → disk-space guard → tender-daemon spawn → bead snapshot + stalled-bead reopen → looper schedule → swarm dispatch (4 pi + 2 cc; fall back to 4 cod only if Pi is unavailable, per AGENTS.md NTM pane priority). Do NOT paraphrase the prompt; the slash-named skills (`/ntm`, `/vibing-with-ntm`, `/rch`, `/bv`, `/testing-*`, `/mock-code-finder`, etc.) are load-bearing. |
| **Other** | Surface a follow-up `AskUserQuestion` with the state-appropriate sub-options (per UNIVERSAL RULE 1, never end the turn here). For previous-session-exists state: `Work on beads / New goal / Reality check / Research repo`. For open-beads-exist state: `Deslop pass / New goal / Research repo / Audit`. For fresh-start state: `Reality check / Research repo / Setup`. Reality check is top-level for `open-beads-exist` (where gap analysis matters most); Quick fix is reachable via `/agent-flywheel:flywheel-fix` directly and intentionally not in the sub-menu. Then route the chosen sub-option through the matching row below. |
| **Deslop pass** | Read `skills/start/_deslop.md` end-to-end and surface its mode-selection `AskUserQuestion` (Single-pass / Single + fresh-eyes / 5-Pi swarm — cod fallback if Pi unavailable, per AGENTS.md NTM pane priority / Iterative). Do NOT pick a mode unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. Then execute the matching mode's section verbatim; the slash-named skills (`/simplify-and-refactor-code-isomorphically`, `/repeatedly-apply-skill`, `/ntm`, `/vibing-with-ntm`) are load-bearing. Baseline capture (tests + LOC + warnings) BEFORE any edits is mandatory — without it the skill cannot prove preservation. |
| **Reality check** | Read `skills/start/_reality_check.md` end-to-end and surface its depth-selection `AskUserQuestion` (Reality check only / Reality check + beads / Full pipeline). Do NOT pick a depth unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. Then execute the matching section verbatim; the slash-named skill (`/reality-check-for-project`) is load-bearing. Phase 1 (the docs+code+gap-report prompt) typically takes 15–20 minutes — do NOT short-circuit it with a docs-only summary. Bead creation is `br`-only per `/beads-workflow`. |
| **Resume session** | Run the **drift check** below before jumping to the saved phase |
| **Work on beads** | Run the **Work-on-beads sub-menu + bootstrap** below — do NOT call `flywheel_approve_beads` directly |
| **New goal** | Delete checkpoint if exists, proceed to Step 2 |
| **Scan & discover** | Proceed to Step 2 |
| **Set a goal** | Run `/brainstorming` to refine the goal, then **in the same turn** call `flywheel_select` (Step 4), read `_planning.md`, and run through Step 4.5 (Phase 0.5) and Step 5's `AskUserQuestion` without pausing for user input — see "Stay-in-turn rule" below |
| **Research repo** | Prompt for GitHub URL via the menu below, then invoke `/flywheel-research` |
| **Quick fix** | Invoke `/flywheel-fix` |
| **Audit** | Invoke `/flywheel-audit` |
| **Setup** | Invoke `/flywheel-setup` |

#### Work on beads — sub-menu + bootstrap (MANDATORY)

`flywheel_approve_beads` requires `state.selectedGoal`. On a fresh session with leftover beads, branch on `result.structuredContent?.data?.error?.code`; if it is `missing_prerequisite`, bootstrap first and only then retry approve.

Use structured code branches (`FlywheelErrorCode`) for this and all other tool failures:

```ts
const code = result.structuredContent?.data?.error?.code;
if (code === "missing_prerequisite") {
  await synthesizeGoalAndCallSelect(cwd);
  return await flywheel_approve_beads({ cwd, action: "start" });
}
```

Never parse human-readable error text to route control flow. Route only on structured `data.error.code`.

**Always surface `error.hint` when present.** Every `FlywheelErrorCode` throw site carries a one-sentence recovery action in `result.structuredContent?.data?.error?.hint`. When handling a structured error — whether you route on `code`, retry, or hand off to the user — render the hint inline (e.g. `Hint: <error.hint>`). Do not drop it silently; it is the user's next step.

Bootstrap it before any approve call:

1. **Synthesize a default goal from the existing beads.** Read the top 3 open bead titles from `br list --json` and build a default like `Continue: <title-1>; <title-2>; <title-3>` (truncate at 200 chars).
2. **Confirm or override the goal:**
   ```
   AskUserQuestion(questions: [{
     question: "These beads need a goal label so the agent-flywheel can resume. Use the synthesized default?",
     header: "Goal",
     options: [
       { label: "Use default", description: "'<synthesized goal>' (Recommended)" },
       { label: "Custom goal", description: "Provide a one-line goal in the Other field" }
     ],
     multiSelect: false
   }])
   ```
3. **Call `flywheel_select` with the chosen goal.** This populates `state.selectedGoal` and unblocks every downstream tool.
4. **Then present the action sub-menu:**
   ```
   AskUserQuestion(questions: [{
     question: "<N> open beads. What do you want to do with them?",
     header: "Beads",
     options: [
       { label: "Implement", description: "Jump to Step 6 with launch as the default action (Recommended)" },
       { label: "Refine", description: "Jump to Step 6 with polish as the default action — restructure beads/deps before implementing" },
       { label: "Inspect", description: "Show br list + bv dependency graph, then re-show this menu" }
     ],
     multiSelect: false
   }])
   ```
   - **"Implement"** → jump to Step 6 (read `_beads.md`).
   - **"Refine"** → jump to Step 6 but pre-select the polish path: call `flywheel_approve_beads(action: "polish")` first to enter `refining_beads` phase, then show Step 6's menu so the user can iterate until satisfied.
   - **"Inspect"** → run `br list` + `bv --robot-triage` (or `bv` alone if `--robot-triage` not supported), display, then re-show the action sub-menu.

#### Resume session — drift check (MANDATORY)

Before jumping to the saved phase, compare the checkpoint to reality:

1. `git rev-parse HEAD` → compare to `checkpoint.gitHead`. If they differ, HEAD has moved.
2. `br list --json` → compare bead IDs/statuses to `checkpoint.activeBeadIds` and `checkpoint.beadResults`. If beads listed in checkpoint don't exist (or are all closed when checkpoint says `phase: implementing`), state is stale.

If either check shows drift, present:

```
AskUserQuestion(questions: [{
  question: "Checkpoint drift detected: <summary, e.g. 'HEAD moved 5 commits ahead; 0/8 active beads still open'>. How should I proceed?",
  header: "Drift",
  options: [
    { label: "Start fresh", description: "Discard the stale checkpoint and run the start menu (Recommended)" },
    { label: "Inspect first", description: "Show the diff between checkpoint and reality, then re-prompt" },
    { label: "Force resume", description: "Resume anyway — useful only if you know the checkpoint is still relevant" }
  ],
  multiSelect: false
}])
```

- "Start fresh" → delete `.pi-flywheel/checkpoint.json`, route as if user picked "New goal".
- "Inspect first" → print the diff (`git log <checkpoint.gitHead>..HEAD --oneline` + bead status table), then re-show this menu.
- "Force resume" → load checkpoint, jump to saved phase as before.

If both checks pass (no drift), resume directly without showing the menu.

#### Research repo — mode selection

Use `AskUserQuestion` to collect the URL and mode:

```
AskUserQuestion(questions: [{
  question: "Paste the GitHub URL you want to research:",
  header: "Research",
  options: [
    { label: "Research only", description: "Extract insights and patterns — no code changes" },
    { label: "Research + integrate", description: "Study the repo, then create an integration plan with beads" }
  ],
  multiSelect: false
}])
```

The user pastes the URL in the "Other" field, or picks a mode first and provides the URL when prompted. Then:
- **"Research only"** → invoke `/flywheel-research <url>`.
- **"Research + integrate"** → invoke `/flywheel-research <url> --mode integrate` (the slash command's research skill reads `--mode integrate` to run Phases 8–12 / Major Feature Integration). If the slash command rejects the flag, fall back to invoking `/flywheel-research <url>` and prepend the prompt context "After research, generate an integration plan and create implementation beads."

### 0f. Degraded modes

**Triage chain (canonical order):** when any check below fails, guide the user through the three commands in this order — `/flywheel-doctor` first (read-only snapshot, always safe, cancellable, under 2s), then `/flywheel-setup` (apply fixes for what doctor found — installs binaries, registers MCP, starts Agent Mail, configures hooks), then `/flywheel-healthcheck` (deep periodic audit of codebase + bead graph + dependencies; run on a cadence, not for setup problems). Never recommend `/flywheel-setup` before `/flywheel-doctor` — doctor is the read-only snapshot that tells setup what to fix.

**MCP tools missing** (flywheel_profile call failed or tool not found in step 0b):

- Display in the banner: `MCP: not configured — run /flywheel-doctor for a snapshot, then /flywheel-setup to fix`
- Set `MCP_DEGRADED = true` and apply these overrides for all subsequent steps:
  - **Step 2:** Use Explore subagent only (skip `flywheel_profile`).
  - **Step 3:** Use Explore-derived ideas (skip `flywheel_discover`).
  - **Step 5:** Standard plan only — generate via Explore agent, write to `docs/plans/<date>-<goal-slug>.md` (skip `flywheel_plan`).
  - **Step 5.5:** Create beads with `br create` as normal.
  - **Step 6:** Present beads via `br list`, ask user to confirm manually — no quality score available.
  - **Step 8:** Offer "Looks good" and "Self review" only (skip `flywheel_review`).
  - **Step 10:** Skip `flywheel_memory` — remind user that session learnings were not auto-persisted.

**Agent Mail offline** (`AGENT_MAIL_DOWN = true` from step 0b check 6):

- Display in the banner: `Agent Mail: offline — parallel agents will skip file reservations`
- Do NOT block or require `/flywheel-setup`. All flywheel coordination still works.
- Overrides for affected steps only:
  - **Step 7 (impl agents):** Skip STEP 0 (Agent Mail bootstrap) in agent prompts. Agents work without file reservations or messaging — the coordinator monitors via TaskOutput instead of inbox.
  - **Step 5 (deep plan):** Skip Agent Mail bootstrap for plan agents. Agents write plan files to disk; coordinator reads them directly.
- If Agent Mail comes up mid-session, detect it on next parallel spawn and resume normal bootstrapping.

## Step 2: Scan and profile the repository

Call `flywheel_profile` with `cwd`. The tool uses a git-HEAD-keyed cache — if the repo hasn't changed since the last scan, it returns instantly from cache.

- **Cache hit** (output says "Profile loaded from cache"): Skip the Explore agent — the profile is fresh. Proceed directly to Step 3.
- **Cache miss** (fresh scan): Optionally spawn an Explore agent for deeper analysis if the profile reveals a complex or unfamiliar codebase. For known repos, skip it.
- **Force re-scan**: Pass `force: true` to `flywheel_profile` to bypass the cache (e.g. after major restructuring).

If `MCP_DEGRADED` is true or `flywheel_profile` fails, fall back to an Explore agent for manual profiling.

After profiling completes, briefly display the key findings (languages, frameworks, test setup) then use `AskUserQuestion`:

```
AskUserQuestion(questions: [{
  question: "Repository profiled. What next?",
  header: "Profile",
  options: [
    { label: "Discover ideas", description: "Find improvement opportunities based on the profile (Recommended)" },
    { label: "Set a goal", description: "I already know what I want to work on" },
    { label: "Re-scan", description: "Force a fresh profile scan (force: true)" }
  ],
  multiSelect: false
}])
```

- **"Discover ideas"** → proceed to Step 3
- **"Set a goal"** → run `/brainstorming`, then **stay in the same turn** and call `flywheel_select` (Step 4) + enter Step 4.5 / Step 5 without waiting for user input (see "Stay-in-turn rule" below)
- **"Re-scan"** → call `flywheel_profile` with `force: true`, then return to this menu

#### Stay-in-turn rule (MANDATORY between every step)

Per UNIVERSAL RULE 1, every user decision flows through `AskUserQuestion`. Between steps, never end your turn on prose like "Ready to plan?", "Shall we continue?", or "Let me know when you're ready." Those are implicit decisions the user cannot answer with labeled options — they kick the user out of the flywheel UX.

**Rule:** after writing a file, calling a tool, or invoking a sub-skill, the next thing in your response must be EITHER another tool call (including the next step's `AskUserQuestion`) OR the explicit completion of a phase. Do not end a turn in the middle of a phase.

Concretely:
- After `/brainstorming` returns → same turn: `flywheel_select` → read `_planning.md` → run Step 4.5 questions → Step 5 `AskUserQuestion`.
- After writing the brainstorm artifact in 4.5c → same turn: Step 5 `AskUserQuestion`.
- After `flywheel_plan` returns → same turn: Step 5.55 alignment-check `AskUserQuestion` (or Step 5.6 if alignment already satisfied).
- After `flywheel_approve_beads` returns → same turn: Step 6 launch menu.

If you find yourself writing "Ready to <next step>?" — STOP and call the next `AskUserQuestion` instead.

## Step 3: Discover improvement ideas

Before discovering ideas, query CASS for past goal history: call `flywheel_memory` with `operation: "search"` and `query: "past goals success failure anti-pattern"`. If results are returned, use them to:
- Deprioritize ideas that failed before (unless circumstances changed)
- Boost ideas similar to past successes
- Surface anti-patterns to avoid

**Choose discovery depth** via AskUserQuestion:

```
AskUserQuestion(questions: [{
  question: "How deep should discovery go?",
  header: "Depth",
  options: [
    { label: "Fast (default)", description: "flywheel_discover one-shot — 5-10 ranked ideas (Recommended for repeat cycles)" },
    { label: "Deep (idea-wizard)", description: "Invoke /idea-wizard for the 6-phase 30→5→15 pipeline — matches guide's Phase 5 (Recommended for fresh projects or wide-open cycles)" },
    { label: "Duel (dueling-idea-wizards)", description: "Two agents (cc + cod, plus gmi if available) independently brainstorm, cross-score 0-1000, reveal, and synthesize — adversarial decorrelation; ~20-30 min; needs ntm" },
    { label: "Triangulated", description: "Run /idea-wizard, then /multi-model-triangulation for second-opinion scoring across Codex/Gemini/Grok" }
  ],
  multiSelect: false
}])
```

- **Fast** → continue below with `flywheel_discover`.
- **Deep** → invoke `/idea-wizard` (run phases 2–4: generate 30→5→15 ideas + check overlaps vs open beads; skip phases 5–6 bead creation — the flywheel handles that in Steps 5.5–6), then present the top ideas as goal options and continue with the standard goal-selection menu.
- **Duel** → invoke `/dueling-idea-wizards --mode=ideas --top=5 --rounds=1`. Pre-flight: confirm `ntm deps -v` succeeds and at least 2 of {cc, cod, gmi} are healthy (the duel skill's Phase 1 detection runs this for you; if it returns only 1 agent, fall back to Deep with a one-line warning). After the duel emits `DUELING_WIZARDS_REPORT.md`, parse the report's consensus winners + contested ideas and feed them into `flywheel_discover` with each idea's `provenance` populated (`source: "duel"`, `agentScores`, `contested`, `survivingCritique`). When you present the goal-selection menu, group options under three headers: **Consensus winners** (4 highest combined cross-scores, all `contested: false`), **Contested** (highest combined score with any agent disagreement >300 pts), and surface a "Dead ideas (FYI)" footnote line listing the lowest 3 by title only — NOT in the menu options. Auto-recommend the Duel row when the repo profile signals high uncertainty: README is <500 chars, no clear product direction in the top-of-tree files, or ≥3 contested TODOs in `profile.todos`.
- **Triangulated** → run `/idea-wizard`, then `/multi-model-triangulation` on the top-5 list to surface which ideas all models agree on vs which are one-model bets.

If `MCP_DEGRADED` is false, call `flywheel_discover` with `cwd`.

If `MCP_DEGRADED` is true (or `flywheel_discover` fails), generate improvement ideas from the Explore agent's findings in Step 2: identify code quality issues, missing tests, architectural improvements, and documentation gaps. Rank by estimated impact.

Present the top ideas to the user using `AskUserQuestion`. Include up to 4 top-ranked ideas as options (the "Other" option is automatically provided for custom goals):

```
AskUserQuestion(questions: [{
  question: "Which goal would you like to pursue?",
  header: "Goal",
  options: [
    { label: "<idea 1 short title>", description: "<one-line summary>" },
    { label: "<idea 2 short title>", description: "<one-line summary>" },
    { label: "<idea 3 short title>", description: "<one-line summary>" },
    { label: "<idea 4 short title>", description: "<one-line summary>" }
  ],
  multiSelect: false
}])
```

If the user selects "Other" and enters a custom goal, run the `/brainstorming` skill first to explore intent, constraints, and edge cases before committing to scope. After brainstorming completes and the goal is refined, use `AskUserQuestion` to confirm scope:

```
AskUserQuestion(questions: [{
  question: "Goal refined: '<refined goal from brainstorming>'. How should I scope this?",
  header: "Scope",
  options: [
    { label: "Full flywheel", description: "Deep scan, plan, implement with agents, review" },
    { label: "Plan only", description: "Generate and review a plan, stop before implementation" },
    { label: "Quick fix", description: "Skip planning — use /flywheel-fix for a targeted change" }
  ],
  multiSelect: false
}])
```

- **"Full flywheel"** → proceed to Step 4 with the refined goal
- **"Plan only"** → proceed through Step 5, then stop after bead creation
- **"Quick fix"** → invoke `/flywheel-fix` with the refined goal instead

## Step 4: Select goal

Once the user chooses, call `flywheel_select` with `cwd` and `goal` set to their choice.

## Steps 5–12: Phase execution (load instructions on demand)

Each remaining phase has detailed instructions in a sub-file. **Read the file when you reach that phase.**

| When you reach... | Read this file | What it covers |
|-------------------|----------------|----------------|
| Step 5 (planning) | `skills/start/_planning.md` | Planning mode selection, deep plan orchestration, plan alignment check (5.55), plan-ready gate (5.6) |
| Step 5.5 (bead creation) or Step 6 (approval) | `skills/start/_beads.md` | Bead creation from plan, coverage/dedup checks, quality scoring, launch gate |
| Step 7 (implementation) | `skills/start/_implement.md` | Swarm scaling, agent spawning, Agent Mail bootstrap, validation gates, stuck-swarm diagnostics |
| Step 8 (review) or Step 9 (loop) | `skills/start/_review.md` | Wave-completion gate, review modes, verify beads, test-coverage sweep (9.25), UI polish pass (9.4) |
| Step 9.5 (wrap-up) or later | `skills/start/_wrapup.md` | Commit review, docs update, version bump, rebuild, CASS learnings (10), skill refinement (11), post-flywheel menu (12) |

**Do NOT skip phases or exit the workflow early.** The flywheel's value comes from completing the full cycle: scan → discover → plan → implement → review → verify → wrap-up → learn → refine.
