---
name: start
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

# Orchestrate: Full Flywheel

Run the agent-flywheel for this project. $ARGUMENTS (optional: initial goal or `--mode single-branch`)

> ## ⚠️ UNIVERSAL RULE 1 — `AskUserQuestion` is the only way to ask the user anything
>
> Present every user decision through `AskUserQuestion` with two to four labeled options. Use the client-provided Other field for custom answers. Prose questions, waits for confirmation, and implicit decisions are bugs.
>
> ## UNIVERSAL RULE 2: invoke specialist skills by name when they apply
>
> Invoke named or applicable specialist skills through the `Skill` tool and follow their bodies instead of recreating them inline.

> ## UNIVERSAL RULE 3: load phase instructions on demand with `flywheel_get_skill`
>
> At each phase boundary, call `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })` before executing that phase.
>
> | Phase | Skill name | Sub-file (fallback) | Steps |
> |-------|-----------|---------------------|-------|
> | Planning | `agent-flywheel:start_planning` | `_planning.md` | 5, 5.55, 5.6 |
> | Bead creation & approval | `agent-flywheel:start_beads` | `_beads.md` | 5.5, 6 |
> | Implementation | `agent-flywheel:start_implement` | `_implement.md` | 7 |
> | Review & loop | `agent-flywheel:start_review` | `_review.md` | 8, 9 (verify + compliance), 9.25, 9.4 |
> | Wrap-up & post-flywheel | `agent-flywheel:start_wrapup` | `_wrapup.md` | 9.5, 10, 11, 12 |
> | Reality check | `agent-flywheel:start_reality_check` | `_reality_check.md` | (referenced from _wrapup, _saturation) |
> | Deslop pass | `agent-flywheel:start_deslop` | `_deslop.md` | (Step 9.5 routing) |
> | Saturation suite | `agent-flywheel:start_saturation` | `_saturation.md` | (saturation-pipeline routing) |
> | In-flight resume | `agent-flywheel:start_inflight_prompt` | `_inflight_prompt.md` | (auto-swarm) |
>
> **Skill-stub recovery.** Pointer commands call `flywheel_get_skill` first, forward `$ARGUMENTS`, and follow the returned body. A same-name `Skill` call can return "already loaded above". Canonical bodies live at the table's skill and sub-file paths. Use `flywheel_get_skill({ name: "agent-flywheel:start" })` for this entry point.
>
> **Disk fallback.** Read `skills/start/_<phase>.md` only when `flywheel_get_skill` errors because the bundle is disabled, missing, or unreachable.

> ## UNIVERSAL RULE 4: route tool failures by structured error code
>
> Branch on `result.structuredContent?.data?.error?.code` (`FlywheelErrorCode`) and render `data.error.hint` in retries, recovery choices, and handoffs. Phase files define their local codes and actions.

## Step 0: Opening Ceremony

### 0a. Detect version

Read the version from `$CLAUDE_PLUGIN_ROOT/mcp-server/package.json`. If that path is unavailable, use the newest cached plugin package:
```bash
{ [ -n "$CLAUDE_PLUGIN_ROOT" ] && cat "$CLAUDE_PLUGIN_ROOT/mcp-server/package.json"; } \
  || ls -t ~/.claude/plugins/cache/agent-flywheel/agent-flywheel/*/mcp-server/package.json 2>/dev/null | head -1 | xargs cat 2>/dev/null
```
Extract the version and read the project name from the working directory's `package.json`, falling back to the directory name. Use `v?` when version resolution fails.

### 0.banner: show this first

**Resolve `VERSION` first, then print the banner.** Step 0a is the only work before this first visible output. Use `v?` when resolution failed; never print a stale hardcoded version.

```
░▒▓ CLAUDE // AGENT-FLYWHEEL v<VERSION> ▓▒░
```

Print the code block, then continue with 0.preflight.

### 0.preflight — Captured user input

Capture any prompt beyond `/start <args>` as `USER_INPUT`. Run Steps 0a–0d before acting on it so the operator sees current state, then use the Step 0e override instead of the default menu.

Classify multi-paragraph input, Markdown sections, file-specific text, or an existing `docs/plans/*.md` path as a plan. Classify up to 300 characters without headings as a goal. Route longer unstructured prose through **Goal framing mode** before `flywheel_select`.

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
  - **Use as plan** → pass a path through `planFile`. Write inline content to `docs/plans/<date>-<goal-slug>.md` first. Continue at Step 5.5.
  - **Treat as goal** → call `flywheel_select` and continue at Step 5.
  - **Discard** → show the default Step 0e menu.

- Goal-shaped:
  ```
  AskUserQuestion(questions: [{
    question: "I see a goal in your message: '<USER_INPUT>'. Run the flywheel on this?",
    header: "Goal input",
    options: [
      { label: "Yes, full flywheel", description: "Skip discovery, plan and implement this goal (Recommended)" },
      { label: "Refine first", description: "Pick a framing mode (Light / Grill with docs / Full brainstorm) before planning" },
      { label: "Plan only", description: "Generate a plan, stop before implementation" },
      { label: "Discard", description: "Ignore the input and show the regular start menu" }
    ],
    multiSelect: false
  }])
  ```
  - **Yes, full flywheel** → call `flywheel_select` and continue at Step 5, including Phase 0.5 when its skip rule does not match.
  - **Refine first** → run **Goal framing mode** with `RAW_GOAL = USER_INPUT`, then select the enriched goal and continue at Step 5.
  - **Plan only** → select the goal, run Step 5, and stop after bead creation.
  - **Discard** → show the default Step 0e menu.

- Ambiguous → always run **Goal framing mode** first (Recommended default: Grill with docs), then route as goal-shaped after refinement.

USER_INPUT still passes through the banner and an explicit menu choice.

#### Goal framing mode (shared by Set a goal / Refine first / Ambiguous)

Use one framing path before `flywheel_select`.

```
AskUserQuestion(questions: [{
  question: "How should we refine this goal before planning?\n\nGoal: '<RAW_GOAL>'",
  header: "Framing",
  options: [
    { label: "Light (Phase 0.5 only)", description: "Skip deep interview; three pressure-test questions at Step 4.5 (floor / 10x / adjacents)" },
    { label: "Grill with docs (Recommended)", description: "Relentless interview via skills/grill-with-docs — writes brainstorm + optional ADRs/glossary, then hands off" },
    { label: "Full brainstorm", description: "/brainstorming design dialogue — best for greenfield product specs / mockups" },
    { label: "Skip framing", description: "Goal is already concrete — call flywheel_select with the raw text" }
  ],
  multiSelect: false
}])
```

Route the selected mode:

- **Light (Phase 0.5 only)** → set `FRAMING_MODE = light`, select `RAW_GOAL`, then run `_planning.md` Step 4.5.
- **Grill with docs (Recommended)** → set `FRAMING_MODE = grill` and load `agent-flywheel:grill-with-docs` through `flywheel_get_skill`, with `Skill(skill: "agent-flywheel:grill-with-docs")` as its fallback. Execute it with `RAW_GOAL`, `CWD`, `GOAL_SLUG`, and `TODAY`. An aborted grill returns to Start. An approved grill selects `GRILL_ENRICHED_GOAL`, records `GRILL_BRAINSTORM_PATH`, and enters Step 4.5, whose complete-brainstorm rule skips the repeated questions.
- **Full brainstorm** → set `FRAMING_MODE = brainstorm`, invoke `/brainstorming`, select its approved goal summary or `RAW_GOAL`, then run Step 4.5 unless the design already answers its three dimensions.
- **Skip framing** → set `FRAMING_MODE = skip`, select `RAW_GOAL`, then apply the normal Step 4.5 skip rules.

**Anti-double-interview rule:** an approved Grill with docs goes directly to Phase 0.5 and never re-enters Goal framing mode in the same cycle.

### 0b. Detect state

Call `flywheel_doctor({ cwd })` before another MCP tool. Cache `data.report` as `DOCTOR_REPORT`, `data.preflightBanner` as `PREFLIGHT_BANNER`, and `data.firstRun` as `IS_FIRST_RUN`. On failure, set the first two values to `null` and `IS_FIRST_RUN = false`.

After the doctor bootstrap, run checks 1-7 in parallel where possible:

1. **MCP tools.** Call `flywheel_profile({ cwd })` and cache a success for Step 2. Set `MCP_DEGRADED = true` on error. Deferred MCP tools make `ToolSearch` unreliable here.
2. **Existing session.** Read `.pi-flywheel/checkpoint.json` when present and note its phase and goal.
3. **Existing beads.** Run `br list --json 2>/dev/null` and count open, in-progress, and closed beads.
4. **Git status.** Run `git log --oneline -1`.
5. **CASS memory.** Search `session learnings flywheel`. Skip an unavailable CASS service.
6. **Agent Mail.** Probe `http://127.0.0.1:8765/health/liveness` with a two-second limit. On failure set `AGENT_MAIL_DOWN = true` and show `Agent Mail: offline`. Single-agent routes remain available.
7. **NTM.** Read `DOCTOR_REPORT.ntm` for display. Before a spawn route, run `_implement.md` **Pre-flight: resolve NTM readiness** to recompute `NTM_AVAILABLE` and `NTM_PROJECT`.

If `DOCTOR_REPORT.overall` is `"red"` OR `"yellow"`, the welcome banner marks the warning state and surfaces every yellow or red check. `IS_FIRST_RUN` is true only when all five server-side signals are absent: no checkpoint, beads, plan markdown, legacy orchestrator state, or project-scoped CASS history.

### 0c. Display the welcome banner

Display one welcome message:

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

Show `Beads: none yet` at zero and `MCP: not configured` when degraded. Add the doctor status:

- `green` → `Doctor: green ✓`
- `yellow` → `Doctor: yellow ⚠`
- `red` → `Doctor: red ✗`
- null / not run → `Doctor: not run`

If `DOCTOR_REPORT.overall === "red"` OR `DOCTOR_REPORT.overall === "yellow"`, list each check with `severity` in `{ "yellow", "red" }`. Use `⚠` for yellow and `✗` for red.

> **Doctor flagged:**
> - `⚠ <check_name>` — <detail>     <!-- yellow rows -->
> - `✗ <check_name>` — <detail>     <!-- red rows -->
> - ...
>
> Yellow checks are non-blocking. Red checks indicate degraded behavior. Run `/agent-flywheel:flywheel-doctor` for details and remediation.

**detail**: the doctor check's concise failure reason.

#### Pre-flight issue surfacing (T4.1)

Print a non-null `PREFLIGHT_BANNER` once above the menu, followed by this gate. A null banner skips the gate.

```
AskUserQuestion(questions: [{
  question: "Pre-flight issues detected. How to proceed?",
  header: "Pre-flight",
  options: [
    { label: "Run setup now (Recommended)", description: "Launches /agent-flywheel:flywheel-setup which detects + batches + verifies" },
    { label: "Continue with degraded",      description: "Skip setup, fall through to the menu — features tied to the failing checks will degrade" },
    { label: "Show me what's degraded",     description: "Print the doctor report row by row, then re-prompt this question" }
  ],
  multiSelect: false
}])
```

**Run setup now** invokes setup and restarts Step 0. **Continue with degraded** opens the main menu. **Show me what's degraded** prints `DOCTOR_REPORT.checks` and repeats this gate.

Display three to five relevant CASS learnings when available:

> **From prior sessions:**
> - <top 3-5 most relevant learnings, anti-patterns, or gotchas>

Search `error-code telemetry`, or read `.pi-flywheel/error-counts.json`, and show the top three nonzero codes:

> **Error-code trends (last 10 sessions):**
> - `<code_1>` — <count> occurrence(s)
> - `<code_2>` — <count> occurrence(s)
> - `<code_3>` — <count> occurrence(s)

Search project-scoped memory for `reality-check session learnings gap analysis`. After at least three sessions, suggest a reality check when none ran in the last seven sessions:

> **Suggestion:** It's been <X> sessions since the last reality-check pass — consider running `/agent-flywheel:flywheel-reality-check` (or pick "Reality check" from the menu) to verify the implementation still matches the project's vision before continuing.

**count**: a telemetry occurrence count. **X**: the number of sessions since the last reality check.

These memory blocks are advisory and disappear when their data is unavailable.

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

**Inspect first** shows `git worktree list --porcelain` and repeats the gate. **Clean up** runs `flywheel-cleanup`. **Skip** opens the main menu. Treat locked stale worktrees as inspect-first unless the operator chooses cleanup.

### 0d. Present the main menu

**Plan detection (run before building the menu).** Glob `docs/plans/*.md` sorted by mtime descending; capture the top 3 as `RECENT_PLAN_PATHS` (relative paths). If none exist, set `RECENT_PLAN_PATHS = []`. This list is surfaced inline in the printed block whenever "Pick up existing plan" is shown so operators can copy-paste a path directly.

Build `RECENT_PLANS_BLOCK` once from that list:

```text
Recent plans (mtime desc — copy-paste into Other when picking "Pick up existing plan"):
  • <RECENT_PLAN_PATHS[0]>                       (or "(no docs/plans/*.md found)" if empty)
  • <RECENT_PLAN_PATHS[1]>
  • <RECENT_PLAN_PATHS[2]>
```

Build the menu options dynamically based on detected state:

After printing the selected state's menu block, append this glossary line once: `Glossary: bead=atomic task · plan=grouped beads · flywheel=full loop · NTM=tmux multi-agent · agent-mail=inter-agent inbox · MCP=Model Context Protocol`.

**If a previous session exists** (checkpoint found with non-idle phase):

Print this block first (per the menu-visibility rule below):

```
Primary entry points (active session: '<goal>' @ <phase>):
  • Auto-swarm          — in-flight resume with cc:cod:gem 2:2:2 swarm (Recommended)
  • Resume session      — continue manually (no swarm)
  • Set a goal          — type a fresh goal in Other; appends to existing beads after drift confirm
  • Pick up existing plan — type a path to docs/plans/<file>.md in Other; jumps to bead creation

[Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`.]

More entry points (type the label into "Other" or run the slash command directly):
  • Work on beads       — refine / implement / inspect the open bead set
  • New goal            — discard checkpoint AND existing beads, start over
  • Reality check       — gap-check vs vision via /reality-check-for-project
  • Duel                — /agent-flywheel:flywheel-duel adversarial cross-scoring
  • Simplify pass       — /simplify-and-refactor-code-isomorphically (Deslop)
  • Research repo       — paste a GitHub URL → /flywheel-research
  • Audit               — /agent-flywheel:flywheel-audit
  • Setup               — /agent-flywheel:flywheel-setup
  • Speed up            — /agent-flywheel:flywheel-speedup (profile → optimize or re-architect → canary)

```

Then call:

```
AskUserQuestion(questions: [{
  question: "What would you like to do? (extras above are reachable via Other or slash commands.)",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Resume '<goal>' from <phase> with the canonical in-flight swarm route in Step 0e" },
    { label: "Resume session", description: "Continue '<goal>' from <phase> phase manually (no swarm)" },
    { label: "Set a goal", description: "Type a fresh goal in Other — appends to the current bead set after a drift confirmation. Does NOT discard the checkpoint" },
    { label: "Pick up existing plan", description: "Type a path to docs/plans/<file>.md in Other (or use one of the suggested paths above). Registers via flywheel_plan, then surfaces Step 5.45 (Validate against code / Approve / Refine / Scrap) so you bead only the gaps" }
  ],
  multiSelect: false
}])
```

**If open/in-progress beads exist** but no active session:

Print this block first (per the menu-visibility rule below):

```
Primary entry points (<N> open beads):
  • Auto-swarm          — in-flight resume with cc:cod:gem 2:2:2 swarm (Recommended)
  • Work on beads       — refine / implement / inspect manually
  • Set a goal          — type a fresh goal in Other; appends new beads to the current set
  • Pick up existing plan — type a path to docs/plans/<file>.md in Other; merges into the current bead set

[Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`.]

More entry points (type the label into "Other" or run the slash command directly):
  • Reality check       — gap-check vs vision via /reality-check-for-project
  • Duel                — /agent-flywheel:flywheel-duel adversarial cross-scoring
  • New goal            — discard the open beads and start over
  • Simplify pass       — /simplify-and-refactor-code-isomorphically (Deslop)
  • Research repo       — paste a GitHub URL → /flywheel-research
  • Audit               — /agent-flywheel:flywheel-audit
  • Setup               — /agent-flywheel:flywheel-setup
  • Speed up            — /agent-flywheel:flywheel-speedup (profile → optimize or re-architect → canary)

```

Then call:

```
AskUserQuestion(questions: [{
  question: "What would you like to do? (extras above are reachable via Other or slash commands.)",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Dispatch the <N> open beads with the canonical in-flight swarm route in Step 0e" },
    { label: "Work on beads", description: "<N> open beads exist — refine, implement, or inspect (manual)" },
    { label: "Set a goal", description: "Type a fresh goal in Other — appends new beads to the existing set without discarding them" },
    { label: "Pick up existing plan", description: "Type a path to docs/plans/<file>.md in Other (or use one of the suggested paths above). Registers via flywheel_plan, then Step 5.45 surfaces (Validate / Approve / Refine / Scrap); validated gaps merge into the current bead set" }
  ],
  multiSelect: false
}])
```

**If no beads and no session** (fresh start):

> **Menu visibility rule.** Before each four-option `AskUserQuestion`, print the state's complete menu. The operator reaches extra entries through Other or their slash commands.

Print this block first (the `• Take the 5-min tour` row appears ONLY when `IS_FIRST_RUN === true` per Step 0b check 9):

```
Primary entry points:
  • Take the 5-min tour — first time? guided tutorial-bead walkthrough  [only when IS_FIRST_RUN]
  • Set a goal          — type your goal in Other; framing mode (Light / Grill with docs / Full brainstorm) if ambiguous, then flywheel_select
  • Pick up existing plan — type a path to docs/plans/<file>.md in Other; jumps straight to bead creation
  • Scan & discover     — profile the repo and surface improvement ideas
  • Reality check       — /reality-check-for-project gap analysis

[Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`.]

More entry points (type the label into "Other" or run the slash command directly):
  • Research repo       — paste a GitHub URL → /flywheel-research
  • Simplify pass       — /simplify-and-refactor-code-isomorphically (Deslop)
  • Duel                — /agent-flywheel:flywheel-duel (adversarial 2-agent ideation)
  • Audit               — /agent-flywheel:flywheel-audit
  • Setup               — /agent-flywheel:flywheel-setup
  • Speed up            — /agent-flywheel:flywheel-speedup (profile → optimize or re-architect → canary)
  • Quick fix           — /agent-flywheel:flywheel-fix
  • Auto-swarm          — in-flight resume; only meaningful with active beads

```

Then call (when `IS_FIRST_RUN === true`, **substitute** the "Take the 5-min tour" row for whichever existing option would otherwise have been Recommended — keep the 4-option cap):

```
AskUserQuestion(questions: [{
  question: "What would you like to do? (extras above are reachable via Other or slash commands.)",
  header: "Start",
  options: [
    // IS_FIRST_RUN === true: this row replaces the lowest-priority Recommended candidate
    { label: "Take the 5-min tour (Recommended)", description: "Guided tour — runs a real micro-bead end-to-end so you see scan → plan → bead → implement → commit fire once. See skills/start/_tutorial_bead.md" },
    { label: "Set a goal", description: "Type the goal directly in Other — framing mode (Light / Grill with docs / Full brainstorm) when ambiguous, then flywheel_select. The most direct path when you know what you want to build" },
    { label: "Pick up existing plan", description: "Type a path to docs/plans/<file>.md in Other (or use one of the suggested paths above). Registers via flywheel_plan, surfaces Step 5.45 (Validate against code / Approve / Refine / Scrap) so you bead only the gaps. Skips brainstorming + scan" },
    { label: "Scan & discover", description: "Profile the repo and find improvement opportunities (greenfield default)" }
  ],
  multiSelect: false
}])
```

When `IS_FIRST_RUN === false`, drop the tutorial row and restore the original 4-option set: `Set a goal`, `Pick up existing plan`, `Scan & discover`, `Reality check`.

Use the server-provided recommendation for the non-tutorial rows. `IS_FIRST_RUN === true` still selects **Take the 5-min tour (Recommended)**.

### 0e. Route the user's choice

> **If `USER_INPUT` was captured in step 0.preflight, use the routing override there instead of this menu.** The default menu below applies only when the user invoked `/start` with no extra prompt content.

| Choice | Action |
|--------|--------|
| **Auto-swarm** | Load `skills/start/_inflight_prompt.md` and execute its canonical in-flight route. |
| **Take the 5-min tour** | Load `skills/start/_tutorial_bead.md`. Surface this route only when `IS_FIRST_RUN === true`. |
| **Other** | Match the printed menu label for the current state. Route a `docs/plans/` or `.md` path as **Pick up existing plan** using `RECENT_PLAN_PATHS`. Route unmatched prose as **Set a goal**. |
| **Simplify pass** (a.k.a. Deslop pass) | Load `skills/start/_deslop.md` and present its mode gate. |
| **Duel** | Invoke `/agent-flywheel:flywheel-duel`, then resume the phase it returns. Its preflight checks `which claude codex gemini`. `which cc` resolves `/usr/bin/cc`, not the Claude lane. |
| **Reality check** | Load `skills/start/_reality_check.md` and present its depth gate. |
| **Resume session** | Run the **drift check** below before jumping to the saved phase |
| **Work on beads** | Run the **Work-on-beads sub-menu + bootstrap** below before `flywheel_approve_beads` |
| **New goal** | Delete checkpoint if exists, proceed to Step 2 |
| **Scan & discover** | Proceed to Step 2 |
| **Set a goal** | Read `<goal>` from Other. Run **Goal framing mode** unless it is concrete and at most 300 characters, then call `flywheel_select`, load `_planning.md`, and continue through Steps 4.5 and 5 in the same turn. Existing sessions append. Open bead sets merge. |
| **Pick up existing plan** | Validate `<plan-path>` as an existing Markdown file, then derive a goal and call `flywheel_plan({ planFile: <plan-path>, source: "picked-up-existing-plan" })`. Enter **Step 5.45** before Step 5.5. Previous sessions run the drift check. Open bead sets confirm that new beads will merge. |
| **Research repo** | Prompt for GitHub URL via the menu below, then invoke `/flywheel-research` |
| **Quick fix** | Invoke `/flywheel-fix` |
| **Audit** | Invoke `/flywheel-audit` |
| **Setup** | Invoke `/flywheel-setup` |
| **Speed up** | Invoke `/agent-flywheel:flywheel-speedup` |

#### Work on beads: sub-menu and bootstrap

`flywheel_approve_beads` requires `state.selectedGoal`. On a fresh session with leftover beads, branch on `result.structuredContent?.data?.error?.code`; if it is `missing_prerequisite`, bootstrap first and only then retry approve.

Apply Universal Rule 4. For this bootstrap:

```ts
const code = result.structuredContent?.data?.error?.code;
if (code === "missing_prerequisite") {
  await synthesizeGoalAndCallSelect(cwd);
  return await flywheel_approve_beads({ cwd, action: "start" });
}
```

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
   - **"Inspect"** → run `br list` and `bv --robot-triage`, falling back to `bv --robot-insights`, then repeat the action sub-menu.

#### Resume session: drift check

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
- Continue without requiring `/flywheel-setup`. Only parallel coordination is degraded.
- Overrides for affected steps only:
  - **Step 7 (impl agents):** Skip STEP 0 (Agent Mail bootstrap) in agent prompts. Agents work without file reservations or messaging — the coordinator monitors via TaskOutput instead of inbox.
  - **Step 5 (deep plan):** Skip Agent Mail bootstrap for plan agents. Agents write plan files to disk; coordinator reads them directly.
- If Agent Mail comes up mid-session, detect it on next parallel spawn and resume normal bootstrapping.

## Step 5.45: Picked-up-plan stage menu (gated on `state.planSource === "picked-up-existing-plan"`)

Surface this menu only after `flywheel_plan({ planFile, source: "picked-up-existing-plan" })` sets `state.planSource === "picked-up-existing-plan"`. Other plan sources continue to Step 5.5.

For `pickedUp: true`, call `flywheel_convergence` with the plan slug. Append a present score and status to the question text. Keep the four options unchanged and let the operator choose without a score-based default.

```
AskUserQuestion(questions: [{
  question: "Plan registered: '<plan-path>' (<chars> chars, last modified <relative-time>)<, score <X.YY> (<status>) when present>. What does this plan need?",
  header: "Plan",
  options: [
    { label: "Validate against code (Recommended)", description: "Section-vs-file-vs-git-log diff: which plan sections are already implemented in HEAD? Bead-ify only the gaps. ~2-5 min" },
    { label: "Approve and bead-ify", description: "Trust the plan as-is — go straight to Step 5.5 (coverage check + br create)" },
    { label: "Refine plan first", description: "Open the plan for inline edits via /superpowers:writing-plans before bead-ifying. Re-enters this menu after refinement" },
    { label: "Scrap and restart", description: "Discard this plan and return to Step 0d. Optionally appends a `## Retired` block to the plan file with today's date so future Pick-up runs skip it" }
  ],
  multiSelect: false
}])
```

### Per-option routing

#### "Validate against code" (Recommended)

Compare every plan section's file and bead claims with the current code and commits newer than the plan. Classify each section as done, partial, or missing, then present the report:

```
AskUserQuestion(questions: [{
  question: "Plan coverage: <D> done / <P> partial / <M> missing. <one-line summary of the gap>. What next?",
  header: "Coverage",
  options: [
    { label: "Bead-ify gaps only (Recommended)", description: "Pre-filter the plan so Step 5.5 only sees the partial + missing sections. <P+M> beads expected" },
    { label: "Bead-ify everything", description: "Ignore the coverage analysis and bead the full plan as-is" },
    { label: "Retire the plan", description: "Coverage shows the plan is fully shipped — append `## Retired` block with today's date and return to Step 0d" },
    { label: "Inspect first", description: "Show the per-section coverage breakdown, then re-prompt" }
  ],
  multiSelect: false
}])
```

- **Bead-ify gaps only** → write partial and missing sections to `docs/plans/<original-name>-gaps-<YYYY-MM-DD>.md`, set it as `state.planDocument`, mark the source validated, and continue at Step 5.5.
- **Bead-ify everything** → continue at Step 5.5 with the original plan.
- **Retire the plan** → append a dated `## Retired` block, clear the plan state, and return to Step 0d.
- **Inspect first** → print `<title> | <status> | <commits-found>` for each section and repeat the menu.

#### "Approve and bead-ify"

Load `_beads.md` and continue at Step 5.5.

#### "Refine plan first"

Invoke `/superpowers:writing-plans` on the plan, then register its result with `source: "picked-up-existing-plan"` so this menu runs again.

#### "Scrap and restart"

Append a dated `## Retired` block, clear `state.planDocument`, `state.planSource`, and `state.selectedGoal`, then return to Step 0d.

> **One-time gate.** Set `state.planSource` to `undefined` or `"picked-up-validated"` after a choice. Refine re-registers the picked-up source and runs this gate again.

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
- **"Set a goal"** → capture the goal (prompt via Other if needed), run **Goal framing mode** (Light / Grill with docs / Full brainstorm; skip only when concrete ≤300 chars), then **stay in the same turn** and call `flywheel_select` (Step 4) + enter Step 4.5 / Step 5 without waiting for user input (see "Stay-in-turn rule" below)
- **"Re-scan"** → call `flywheel_profile` with `force: true`, then return to this menu

#### Stay in turn between steps

After a file write, tool call, or sub-skill, continue to the next tool or `AskUserQuestion` until the phase completes. Framing continues through selection and Steps 4.5–5. A brainstorm artifact continues to Step 5. A plan continues to Step 5.55 or 5.6. Bead approval continues to the Step 6 launch gate.

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

If the user selects "Other" and enters a custom goal, run **Goal framing mode** first (Recommended: Grill with docs when the custom goal is ambiguous or architectural; Light or Skip when already concrete). After framing returns `approved` (or was skipped) and the goal is refined, use `AskUserQuestion` to confirm scope:

```
AskUserQuestion(questions: [{
  question: "Goal refined: '<enriched goal summary>'. How should I scope this?",
  header: "Scope",
  options: [
    { label: "Full flywheel", description: "Deep scan, plan, implement with agents, review" },
    { label: "Plan only", description: "Generate and review a plan, stop before implementation" },
    { label: "Quick fix", description: "Skip planning — use /flywheel-fix for a targeted change" }
  ],
  multiSelect: false
}])
```

- **"Full flywheel"** → proceed to Step 4 with the refined/enriched goal
- **"Plan only"** → proceed through Step 5, then stop after bead creation
- **"Quick fix"** → invoke `/flywheel-fix` with the refined goal instead

## Step 4: Select goal

Once the user chooses, call `flywheel_select` with `cwd` and `goal` set to their choice.

## Steps 5–12: Phase execution

Apply Universal Rule 3 at each phase boundary.

Complete the full cycle: scan → discover → plan → implement → review → verify → wrap-up → learn → refine.
