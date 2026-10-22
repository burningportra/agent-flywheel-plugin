---
name: start
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

# Orchestrate: Full Flywheel

Run the agent-flywheel for this project. $ARGUMENTS (optional: initial goal or `--mode single-branch`)

> ## ⚠️ UNIVERSAL RULE 1 — `AskUserQuestion` is the only way to ask the user anything
>
> Present every user decision through `AskUserQuestion` with 2–4 labeled options (use Other for custom input). Prose questions, confirmation waits, and implicit choices are bugs.
>
> Free text in Other that asks for something (a question, an explanation, "eli5", a premortem) is a request, not a choice: answer it in prose first, then show the next menu.
>
> ## UNIVERSAL RULE 2: invoke specialist skills by name when they apply
>
> Invoke named or applicable specialist skills via the `Skill` tool instead of recreating them inline.
>
> ## UNIVERSAL RULE 3: load phase instructions on demand with `flywheel_get_skill`
>
> At each phase boundary — and unconditionally on resume whenever `state.phase !== "idle"` — the **first tool call** for that phase **must** be `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })` before calling `flywheel_plan`, `flywheel_approve_beads`, `flywheel_review`, `flywheel_verify_beads`, `flywheel_grade_outcome`, or `flywheel_advance_wave`:
>
> | Phase (`state.phase`) | Skill name | Sub-file | Steps |
> |-------|-----------|----------|-------|
> | Planning (`planning`) | `agent-flywheel:start_planning` | `_planning.md` | 5, 5.55, 5.6 |
> | Bead creation & approval (`creating_beads`/`refining_beads`) | `agent-flywheel:start_beads` | `_beads.md` | 5.5, 6 |
> | Implementation (`implementing`) | `agent-flywheel:start_implement` | `_implement.md` | 7 |
> | Review & loop (`reviewing`) | `agent-flywheel:start_review` | `_review.md` | 8, 9, 9.25, 9.4 |
> | Wrap-up & post-flywheel (`wrapup`) | `agent-flywheel:start_wrapup` | `_wrapup.md` | 9.5–12 |
> | Reality check | `agent-flywheel:start_reality_check` | `_reality_check.md` | gap analysis |
> | Deslop pass | `agent-flywheel:start_deslop` | `_deslop.md` | Step 9.5 |
> | Saturation suite | `agent-flywheel:start_saturation` | `_saturation.md` | saturation |
> | In-flight resume | `agent-flywheel:start_inflight_prompt` | `_inflight_prompt.md` | auto-swarm |
>
> **Skill-stub recovery:** Pointer commands call `flywheel_get_skill({ name: "agent-flywheel:start" })` first; read `skills/start/_<phase>.md` from disk only if `flywheel_get_skill` errors.
>
> ## UNIVERSAL RULE 4: route tool failures by structured error code
>
> Branch on `result.structuredContent?.data?.error?.code` (`FlywheelErrorCode`) and surface `data.error.hint` in retries and recovery menus.

## Step 0: Opening Ceremony

### 0a. Detect version

Take `VERSION` from `plugin v<version>` in the `flywheel_get_skill` header (`data.pluginVersion`), or read `$PLUGIN_ROOT/mcp-server/package.json` where `PLUGIN_ROOT` is `data.pluginRoot` (fallback `v?`).

### 0.banner: show this first

**Resolve `VERSION` first, then print the banner** in the same turn as Step 0b:

```
░▒▓ CLAUDE // AGENT-FLYWHEEL v<VERSION> ▓▒░
```

### 0.preflight — Captured user input

Capture any prompt beyond `/start <args>` as `USER_INPUT`. Run Steps 0a–0d first, then apply this Step 0e override when `USER_INPUT` is non-empty (multi-paragraph/Markdown/`docs/plans/*.md` = plan; ≤300 chars without headings = goal; longer prose = ambiguous):

- **Active-checkpoint resume (`state.phase !== "idle"`):** When `state.phase !== "idle"` and `USER_INPUT` matches `state.selectedGoal` or continues that saved phase, skip Goal deepening/framing — the **first tool call must be `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })`** (`state.phase = "reviewing"` → `agent-flywheel:start_review`) before calling `flywheel_review` or any phase tool.
- **Plan-shaped:**
  ```
  AskUserQuestion(questions: [{
    question: "I see a plan in your message ('<first 60 chars>…'). What should I do with it?",
    header: "Plan input",
    options: [
      { label: "Use as plan", description: "Register via flywheel_plan and jump to bead creation (Recommended)" },
      { label: "Treat as goal", description: "Use as goal description and run from Step 4" },
      { label: "Discard", description: "Ignore input and show the start menu" }
    ],
    multiSelect: false
  }])
  ```
  - **Use as plan** → write to `docs/plans/<date>-<goal-slug>.md` if inline, register via `planFile`, jump to Step 5.5.
  - **Treat as goal** → call `flywheel_select`, continue at Step 5.
  - **Discard** → show the default Step 0e menu.

- **Goal-shaped:**
  ```
  AskUserQuestion(questions: [{
    question: "I see a goal in your message: '<USER_INPUT>'. Run the flywheel on this?",
    header: "Goal input",
    options: [
      { label: "Yes, full flywheel", description: "Skip discovery, plan and implement this goal (Recommended)" },
      { label: "Refine first", description: "Pick a framing mode (Light / Grill with docs / Full brainstorm)" },
      { label: "Plan only", description: "Generate a plan, stop before implementation" },
      { label: "Discard", description: "Ignore input and show the start menu" }
    ],
    multiSelect: false
  }])
  ```
  Every choice except Discard runs **Goal deepening** on `USER_INPUT` first:
  - **Yes, full flywheel** → call `flywheel_select`, continue at Step 5.
  - **Refine first** → run **Goal framing mode** (`RAW_GOAL` = deepened goal), select, continue at Step 5.
  - **Plan only** → select goal, run Step 5, stop after bead creation.
  - **Discard** → show the default Step 0e menu.

- **Ambiguous** → run **Goal deepening**, then **Goal framing mode** (Recommended default: Grill with docs), then route as goal-shaped.

#### Goal deepening (every goal the user types)

Run once on every user-typed goal (`USER_INPUT`, **Set a goal**, or Other in a goal menu) before Goal framing mode and `flywheel_select`; skip for menu-picked ideas, bead-derived goals, and plans:

1. **Answer four questions** from the goal and Step 0b context: (1) what a top professional would do that the goal omits, (2) rawest material they start from, (3) specific methods/tools, and (4) the outside check (test, benchmark, dataset, metric).
2. **Rewrite the goal** opening with a one-line restatement in the user's words (preserving `data.goalSlug`) plus the raw material, methods, and outside check.
3. **Print the four answers and rewrite**, then ask:

```
AskUserQuestion(questions: [{
  question: "Deepened goal:\n\n<DEEPENED_GOAL>\n\nUse this version? Type your own edit in Other.",
  header: "Deepen",
  options: [
    { label: "Use deepened goal", description: "Plan the rewrite with raw material, methods, and outside check (Recommended)" },
    { label: "Keep my wording", description: "Plan the goal as typed and drop the four answers" }
  ],
  multiSelect: false
}])
```

- **Use deepened goal** → `RAW_GOAL = DEEPENED_GOAL`, save `DEPTH_NOTES`.
- **Keep my wording** → keep typed goal, `DEPTH_NOTES` unset.
- **Other** → use typed text as goal, keep `DEPTH_NOTES`.

`_planning.md` Step 4.5c and the ambition pass reuse `DEPTH_NOTES`; Step 4.6 provides the 6-category interview and **Poteto mode (pstack)** track.

#### Goal framing mode (shared by Set a goal / Refine first / Ambiguous)

```
AskUserQuestion(questions: [{
  question: "How should we refine this goal before planning?\n\nGoal: '<RAW_GOAL>'",
  header: "Framing",
  options: [
    { label: "Light (Phase 0.5 only)", description: "Three pressure-test questions at Step 4.5 (floor / 10x / adjacents)" },
    { label: "Grill with docs (Recommended)", description: "Relentless interview via skills/grill-with-docs — writes brainstorm + ADRs" },
    { label: "Full brainstorm", description: "/brainstorming design dialogue for greenfield specs" },
    { label: "Skip framing", description: "Goal is concrete — call flywheel_select with raw text" }
  ],
  multiSelect: false
}])
```

- **Light (Phase 0.5 only)** → `FRAMING_MODE = light`, select `RAW_GOAL`, run `_planning.md` Step 4.5.
- **Grill with docs (Recommended)** → `FRAMING_MODE = grill`, load `agent-flywheel:grill-with-docs` via `flywheel_get_skill` (fallback `Skill(skill: "agent-flywheel:grill-with-docs")`) with `RAW_GOAL`, `CWD`, `GOAL_SLUG`, `TODAY`. On approval, select `GRILL_ENRICHED_GOAL`, record `GRILL_BRAINSTORM_PATH`, and enter Step 4.5 (aborted returns to Start).
- **Full brainstorm** → `FRAMING_MODE = brainstorm`, invoke `/brainstorming`, select summary or `RAW_GOAL`, run Step 4.5.
- **Skip framing** → `FRAMING_MODE = skip`, select `RAW_GOAL`, apply Step 4.5 skip rules.

**Anti-double-interview rule:** an approved Grill with docs goes directly to Phase 0.5 and never re-enters Goal framing mode in the same cycle.

### 0b. Detect state

Call in parallel alongside 0.banner:

1. **Doctor:** `flywheel_doctor({ cwd })` → cache `data.report` as `DOCTOR_REPORT`, `data.preflightBanner` as `PREFLIGHT_BANNER`, and `data.firstRun` as `IS_FIRST_RUN` (on failure: `null`, `IS_FIRST_RUN = false`, `MCP_DEGRADED = true`).
2. **Observe:** `flywheel_observe({ cwd })` → reads `projectName`, `checkpoint.{phase,selectedGoal}`, `beads.counts.{open,in_progress,blocked,closed}`, `git.{branch,head}`, `agentMail.reachable` (`false` sets `AGENT_MAIL_DOWN = true`), `recentPlans`, and `topErrorCodes`.
3. **CASS memory:** `flywheel_memory({ cwd, operation: "search", query: "session learnings flywheel", history: 0 })` and `flywheel_memory({ cwd, operation: "search", query: "reality-check session learnings gap analysis", history: 0 })`.

If `DOCTOR_REPORT.overall` is `"red"` OR `"yellow"`, the welcome banner marks the warning state and surfaces every yellow or red check.

### 0c. Display the welcome banner

Display one concise welcome message using only the blocks below:

```
 ╔══════════════════════════════════════════════════╗
 ║   agent-flywheel v<VERSION>                      ║
 ║   The Agentic Coding Flywheel                    ║
 ║   Project: <project-name>                        ║
 ║   Branch:  <current-branch> @ <short-sha>        ║
 ║   Beads:   <N open> | <M in-progress> | <B blocked> | <K done> ║
 ╚══════════════════════════════════════════════════╝
```

Show `Beads: none yet` at zero, `MCP: not configured` when degraded, and `Doctor: green ✓` / `yellow ⚠` / `red ✗` / `not run`.

If `DOCTOR_REPORT.overall === "red"` OR `DOCTOR_REPORT.overall === "yellow"`, list each check with `severity` in `{ "yellow", "red" }`:

> **Doctor flagged:**
> - `⚠ <check_name>` — <check detail>
> - `✗ <check_name>` — <check detail>
>
> Yellow checks are non-blocking. Red checks indicate degraded behavior. Run `/agent-flywheel:flywheel-doctor` for details and remediation.

#### Pre-flight issue surfacing (T4.1)

Print a non-null `PREFLIGHT_BANNER` verbatim once above the menu, followed immediately by this gate (skip when null):

```
AskUserQuestion(questions: [{
  question: "Pre-flight issues detected. How to proceed?",
  header: "Pre-flight",
  options: [
    { label: "Run setup now (Recommended)", description: "Launches /agent-flywheel:flywheel-setup" },
    { label: "Continue with degraded", description: "Skip setup; failing checks will degrade" },
    { label: "Show me what's degraded", description: "Print doctor report rows, then re-prompt" }
  ],
  multiSelect: false
}])
```

Display three relevant CASS learnings when three are available (fewer only when memory returned fewer), quoting each learning's first sentence verbatim:

> **From prior sessions:**
> - <top 3 most relevant learnings, each learning's first sentence verbatim>
>
> **Error-code trends:** `<code_1>` — <occurrence count> · **Suggestion:** <session count> sessions since `/agent-flywheel:flywheel-reality-check`.

If `DOCTOR_REPORT.checks` has a yellow `orphaned_worktrees` row mentioning `orphaned worktree`, `stale worktree`, or `locked stale worktree`, ask before the main menu:

```
AskUserQuestion(questions: [{
  question: "Doctor found stale or orphaned worktrees. Clean up before starting?",
  header: "Cleanup",
  options: [
    { label: "Inspect first (Recommended)", description: "List candidate worktrees and lock state first" },
    { label: "Clean up", description: "Run flywheel-cleanup and confirm removals" },
    { label: "Skip", description: "Continue to start menu" }
  ],
  multiSelect: false
}])
```

### 0d. Present the main menu

Take `RECENT_PLAN_PATHS = recentPlans` from `flywheel_observe` and build `RECENT_PLANS_BLOCK`:

```text
Recent plans (mtime desc — copy-paste into Other when picking "Pick up existing plan"):
  • <RECENT_PLAN_PATHS[0]>
```

Set `SWARM_MIX = DOCTOR_REPORT.swarm.label` (fallback `"model-diversified"`). Append once after the menu block: `Glossary: bead=atomic task · plan=grouped beads · flywheel=full loop · NTM=tmux multi-agent · agent-mail=inter-agent inbox · MCP=Model Context Protocol`.

**If a previous session exists** (checkpoint found with non-idle phase):

```
Primary entry points (active session: '<goal>' @ <phase>):
  • Auto-swarm          — in-flight resume with a <SWARM_MIX> swarm (Recommended)
  • Resume session      — continue manually (no swarm)
  • Set a goal          — type a fresh goal in Other
  • Pick up existing plan — type docs/plans/<file>.md in Other
[Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`.]
More (Other/slash): Work on beads · New goal · Reality check · Duel · Simplify pass · Research repo · Audit · Setup · Speed up
```

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Resume '<goal>' from <phase> with a <SWARM_MIX> swarm" },
    { label: "Resume session", description: "Continue '<goal>' manually" },
    { label: "Set a goal", description: "Type a fresh goal in Other" },
    { label: "Pick up existing plan", description: "Type docs/plans/<file>.md in Other (RECENT_PLAN_PATHS) → Step 5.45 (Validate)" }
  ],
  multiSelect: false
}])
```

**If open/in-progress beads exist** but no active session:

```
Primary entry points (<N> open beads):
  • Auto-swarm          — in-flight resume with a <SWARM_MIX> swarm (Recommended)
  • Work on beads       — refine / implement / inspect manually
  • Set a goal          — type a fresh goal in Other
  • Pick up existing plan — type docs/plans/<file>.md in Other
[Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`.]
More (Other/slash): Reality check · Duel · New goal · Simplify pass · Research repo · Audit · Setup · Speed up
```

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Dispatch <N> open beads to a <SWARM_MIX> swarm" },
    { label: "Work on beads", description: "<N> open beads — refine, implement, or inspect" },
    { label: "Set a goal", description: "Type a fresh goal in Other" },
    { label: "Pick up existing plan", description: "Type docs/plans/<file>.md in Other (RECENT_PLAN_PATHS) → Step 5.45 (Validate)" }
  ],
  multiSelect: false
}])
```

**If no beads and no session** (fresh start):

```
Primary entry points:
  • Take the 5-min tour — guided walkthrough [only when IS_FIRST_RUN]
  • Set a goal          — type your goal in Other
  • Pick up existing plan — type docs/plans/<file>.md in Other
  • Scan & discover     — profile the repo and surface ideas
  • Reality check       — /reality-check-for-project gap analysis
[Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`.]
More (Other/slash): Research repo · Simplify pass · Duel · Audit · Setup · Speed up · Quick fix · Auto-swarm
```

When `IS_FIRST_RUN === false`, replace the tour row with `Reality check`:

```
AskUserQuestion(questions: [{
  question: "What would you like to do?",
  header: "Start",
  options: [
    { label: "Take the 5-min tour (Recommended)", description: "Guided tour — skills/start/_tutorial_bead.md" },
    { label: "Set a goal", description: "Type goal in Other" },
    { label: "Pick up existing plan", description: "Type docs/plans/<file>.md in Other (RECENT_PLAN_PATHS) → Step 5.45 (Validate)" },
    { label: "Scan & discover", description: "Profile repo and find improvement opportunities" }
  ],
  multiSelect: false
}])
```

### 0e. Route the user's choice

| Choice | Action |
|--------|--------|
| **Auto-swarm** | Load `skills/start/_inflight_prompt.md` and execute its canonical in-flight route. |
| **Take the 5-min tour** | Load `skills/start/_tutorial_bead.md` (when `IS_FIRST_RUN === true`). |
| **Other** | Match printed menu labels; route a `docs/plans/` or `.md` path as **Pick up existing plan** (`RECENT_PLAN_PATHS`), or unmatched prose as **Set a goal**. |
| **Simplify pass** | Load `skills/start/_deslop.md` and present its mode gate. |
| **Duel** | Invoke `/agent-flywheel:flywheel-duel` (checks `which claude codex gemini`), then resume the phase it returns. |
| **Reality check** | Load `skills/start/_reality_check.md` and present its depth gate. |
| **Resume session** | Run **drift check** below; if clean (or **Force resume**), the first tool call must be `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })` before any phase tool. |
| **Work on beads** | Run **Work-on-beads sub-menu** below before `flywheel_approve_beads`. |
| **New goal / Scan & discover** | Delete checkpoint if New goal; proceed to Step 2. |
| **Set a goal** | Read `<goal>` from Other, run **Goal deepening**, run **Goal framing mode** unless concrete and ≤300 chars, call `flywheel_select`, load `_planning.md`, and continue through Steps 4.5 and 5 in the same turn. |
| **Pick up existing plan** | Validate `<plan-path>`, derive goal, call `flywheel_plan({ planFile: <plan-path>, source: "picked-up-existing-plan" })`, and enter **Step 5.45** before Step 5.5. |
| **Research repo** | Prompt for GitHub URL below, then invoke `/flywheel-research`. |
| **Quick fix / Audit / Setup / Speed up** | Invoke `/flywheel-fix`, `/flywheel-audit`, `/flywheel-setup`, or `/agent-flywheel:flywheel-speedup`. |

#### Work on beads: sub-menu and bootstrap

If `flywheel_approve_beads` returns `missing_prerequisite`, synthesize a default goal from top 3 open beads (`br list --json`), confirm via `AskUserQuestion` (`Use default` / `Custom goal`), call `flywheel_select`, then ask:

```
AskUserQuestion(questions: [{
  question: "<N> open beads. What do you want to do?",
  header: "Beads",
  options: [
    { label: "Implement", description: "Step 6 launch default (Recommended)" },
    { label: "Refine", description: "Step 6 polish default" },
    { label: "Inspect", description: "Show br list + bv graph, then re-show menu" }
  ],
  multiSelect: false
}])
```

#### Resume session: drift check

Compare `git rev-parse HEAD` to `checkpoint.gitHead` and `br list --json` to `checkpoint.activeBeadIds`. If drifted, ask:

```
AskUserQuestion(questions: [{
  question: "Checkpoint drift detected: <summary>. How should I proceed?",
  header: "Drift",
  options: [
    { label: "Start fresh", description: "Discard stale checkpoint (Recommended)" },
    { label: "Inspect first", description: "Show diff, then re-prompt" },
    { label: "Force resume", description: "Resume anyway" }
  ],
  multiSelect: false
}])
```

If no drift (or **Force resume**), and whenever `state.phase !== "idle"`, the **first tool call must be `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })`** (`state.phase = "reviewing"` → `agent-flywheel:start_review`) before calling `flywheel_review` or any phase tool.

#### Research repo — mode selection

```
AskUserQuestion(questions: [{
  question: "Paste the GitHub URL to research:",
  header: "Research",
  options: [
    { label: "Research only", description: "Extract insights — no code changes" },
    { label: "Research + integrate", description: "Create integration plan with beads" }
  ],
  multiSelect: false
}])
```

### 0f. Degraded modes

- **Triage:** `/flywheel-doctor` → `/flywheel-setup` → `/flywheel-healthcheck`.
- **`MCP_DEGRADED`:** Explore agent for Steps 2–5; `br` CLI for Steps 5.5–6; manual review in Step 8.
- **`AGENT_MAIL_DOWN`:** single-agent or skip reservations until reachable.

## Step 5.45: Picked-up-plan stage menu (gated on `state.planSource === "picked-up-existing-plan"`)

When `state.planSource === "picked-up-existing-plan"`, call `flywheel_convergence` for the plan slug and present:

```
AskUserQuestion(questions: [{
  question: "Plan registered: '<plan-path>' (<chars> chars, modified <relative-time>). What does this plan need?",
  header: "Plan",
  options: [
    { label: "Validate against code (Recommended)", description: "Diff plan sections against HEAD and bead-ify only gaps" },
    { label: "Approve and bead-ify", description: "Trust plan as-is — go straight to Step 5.5" },
    { label: "Refine plan first", description: "Edit plan inline before bead-ifying, then re-enter Step 5.45" },
    { label: "Scrap and restart", description: "Discard plan and return to Step 0d" }
  ],
  multiSelect: false
}])
```

- **Validate against code** → classify each section against HEAD (`done`/`partial`/`missing`), ask `Coverage` (`Bead-ify gaps only (Recommended)`, `Bead-ify everything`, `Retire the plan`, `Inspect first`), write gaps to `docs/plans/<original-name>-gaps-<YYYY-MM-DD>.md`, and continue at Step 5.5.
- **Approve and bead-ify** → load `_beads.md` and continue at Step 5.5.
- **Refine plan first** → edit the plan, re-register with `source: "picked-up-existing-plan"`, re-enter Step 5.45.
- **Scrap and restart** → append `## Retired`, clear plan/goal state, return to Step 0d.

## Step 2: Scan and profile the repository

Call `flywheel_profile({ cwd })` (`force: true` to rescan), display key findings, then ask:

```
AskUserQuestion(questions: [{
  question: "Repository profiled. What next?",
  header: "Profile",
  options: [
    { label: "Discover ideas", description: "Find improvement opportunities from profile (Recommended)" },
    { label: "Set a goal", description: "I already know what I want to work on" },
    { label: "Re-scan", description: "Force a fresh profile scan (force: true)" }
  ],
  multiSelect: false
}])
```

- **Discover ideas** → proceed to Step 3.
- **Set a goal** → run **Goal deepening**, **Goal framing mode**, `flywheel_select`, and Steps 4.5–5 in the same turn.
- **Re-scan** → call `flywheel_profile({ cwd, force: true })` and re-prompt.

## Step 3: Discover improvement ideas

Query `flywheel_memory({ cwd, operation: "search", query: "past goals success failure anti-pattern" })`, then ask discovery depth:

```
AskUserQuestion(questions: [{
  question: "How deep should discovery go?",
  header: "Depth",
  options: [
    { label: "Fast (default)", description: "flywheel_discover one-shot — 5-10 ranked ideas (Recommended)" },
    { label: "Deep (idea-wizard)", description: "Invoke /idea-wizard 30→5→15 pipeline" },
    { label: "Duel (dueling-idea-wizards)", description: "Two agents brainstorm and cross-score 0-1000 via ntm" },
    { label: "Triangulated", description: "Run /idea-wizard, then /multi-model-triangulation" }
  ],
  multiSelect: false
}])
```

Call `flywheel_discover({ cwd })` (or pass `/idea-wizard` / `/dueling-idea-wizards --mode=ideas --top=5 --rounds=1` provenance), then present up to 4 top ideas:

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

For custom goals in Other, run **Goal deepening** and **Goal framing mode**, then confirm scope (`Full flywheel` / `Plan only` / `Quick fix`).

## Step 4: Select goal

Call `flywheel_select({ cwd, goal })`.

## Steps 5–12: Phase execution

Apply Universal Rule 3 (`flywheel_get_skill`) at each phase boundary to complete: scan → discover → plan → implement → review → verify → wrap-up → learn → refine.
