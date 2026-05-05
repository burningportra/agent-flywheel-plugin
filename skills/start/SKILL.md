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

> ## ⚠️ UNIVERSAL RULE 3 — load phase instructions on demand (PRIMARY: `flywheel_get_skill`)
>
> Steps 5–12 are stored in separate files to keep this prompt within token limits. When you reach a phase boundary, fetch the corresponding body via the bundled MCP tool — **do not default to `Read`**. Call: `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })`.
>
> | Phase | Skill name | Sub-file (fallback) | Steps |
> |-------|-----------|---------------------|-------|
> | Planning | `agent-flywheel:start_planning` | `_planning.md` | 5, 5.55, 5.6 |
> | Bead creation & approval | `agent-flywheel:start_beads` | `_beads.md` | 5.5, 6 |
> | Implementation | `agent-flywheel:start_implement` | `_implement.md` | 7 |
> | Review & loop | `agent-flywheel:start_review` | `_review.md` | 8, 9, 9.25, 9.4 |
> | Wrap-up & post-flywheel | `agent-flywheel:start_wrapup` | `_wrapup.md` | 9.5, 10, 11, 12 |
> | Reality check | `agent-flywheel:start_reality_check` | `_reality_check.md` | (referenced from _wrapup, _saturation) |
> | Deslop pass | `agent-flywheel:start_deslop` | `_deslop.md` | (Step 9.5 routing) |
> | Saturation suite | `agent-flywheel:start_saturation` | `_saturation.md` | (saturation-pipeline routing) |
> | In-flight resume | `agent-flywheel:start_inflight_prompt` | `_inflight_prompt.md` | (auto-swarm) |
>
> Why MCP-first: one round-trip, served from the bundled body at `mcp-server/dist/skills.bundle.json` with `srcSha256` integrity check + transparent disk fallback. `Read` is two-step (path resolution then file I/O) and burns more context on listing noise.
>
> **Skill-stub recovery.** If invoking the `Skill` tool itself ever returns just the description / pointer text instead of the canonical body (the harness sometimes ack's instead of inlining for already-loaded skills), do NOT fall back to `Read` — call `flywheel_get_skill({ name: "agent-flywheel:start" })` for the entry-point or the relevant `start_<phase>` for sub-phases. Single MCP round-trip, served from the same bundle, no path-resolution noise.
>
> Fetch the body **before** executing that phase. Do NOT guess or improvise — the sub-files contain critical gates, edge-case handling, and `AskUserQuestion` templates.
>
> **Disk fallback.** If `flywheel_get_skill` errors (e.g. `FW_SKILL_BUNDLE=off`, missing bundle, MCP transport down), then `Read skills/start/_<phase>.md` from disk. Existing `Read` references throughout this skill are valid fallbacks — but try MCP first.

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

**Plan detection (run before building the menu).** Glob `docs/plans/*.md` sorted by mtime descending; capture the top 3 as `RECENT_PLAN_PATHS` (relative paths). If none exist, set `RECENT_PLAN_PATHS = []`. This list is surfaced inline in the printed block whenever "Pick up existing plan" is shown so operators can copy-paste a path directly.

Build the menu options dynamically based on detected state:

**If a previous session exists** (checkpoint found with non-idle phase):

Print this block first (per the menu-visibility rule below):

```
Primary entry points (active session: '<goal>' @ <phase>):
  • Auto-swarm          — in-flight resume with 4 pi + 2 cc swarm (Recommended)
  • Resume session      — continue manually (no swarm)
  • Set a goal          — type a fresh goal in Other; appends to existing beads after drift confirm
  • Pick up existing plan — type a path to docs/plans/<file>.md in Other; jumps to bead creation

Recent plans (mtime desc — copy-paste into Other when picking "Pick up existing plan"):
  • <RECENT_PLAN_PATHS[0]>                       (or "(no docs/plans/*.md found)" if empty)
  • <RECENT_PLAN_PATHS[1]>
  • <RECENT_PLAN_PATHS[2]>

More entry points (type the label into "Other" or run the slash command directly):
  • Work on beads       — refine / implement / inspect the open bead set
  • New goal            — discard checkpoint AND existing beads, start over
  • Reality check       — gap-check vs vision via /reality-check-for-project
  • Duel                — /agent-flywheel:flywheel-duel adversarial cross-scoring
  • Simplify pass       — /simplify-and-refactor-code-isomorphically (Deslop)
  • Research repo       — paste a GitHub URL → /flywheel-research
  • Audit               — /agent-flywheel:flywheel-audit
  • Setup               — /agent-flywheel:flywheel-setup
```

Then call:

```
AskUserQuestion(questions: [{
  question: "What would you like to do? (extras above are reachable via Other or slash commands.)",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Universal in-flight resume — 4 cod + 2 cc swarm (pi fallback if Codex unavailable; see AGENTS.md NTM pane priority), 4-min looper, bv-triaged dispatch, stalled-bead recovery, auto code-review on completion. See skills/start/_inflight_prompt.md" },
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
  • Auto-swarm          — in-flight resume with 4 pi + 2 cc swarm (Recommended)
  • Work on beads       — refine / implement / inspect manually
  • Set a goal          — type a fresh goal in Other; appends new beads to the current set
  • Pick up existing plan — type a path to docs/plans/<file>.md in Other; merges into the current bead set

Recent plans (mtime desc — copy-paste into Other when picking "Pick up existing plan"):
  • <RECENT_PLAN_PATHS[0]>                       (or "(no docs/plans/*.md found)" if empty)
  • <RECENT_PLAN_PATHS[1]>
  • <RECENT_PLAN_PATHS[2]>

More entry points (type the label into "Other" or run the slash command directly):
  • Reality check       — gap-check vs vision via /reality-check-for-project
  • Duel                — /agent-flywheel:flywheel-duel adversarial cross-scoring
  • New goal            — discard the open beads and start over
  • Simplify pass       — /simplify-and-refactor-code-isomorphically (Deslop)
  • Research repo       — paste a GitHub URL → /flywheel-research
  • Audit               — /agent-flywheel:flywheel-audit
  • Setup               — /agent-flywheel:flywheel-setup
```

Then call:

```
AskUserQuestion(questions: [{
  question: "What would you like to do? (extras above are reachable via Other or slash commands.)",
  header: "Start",
  options: [
    { label: "Auto-swarm (Recommended)", description: "Universal in-flight resume — 4 cod + 2 cc swarm (pi fallback if Codex unavailable; see AGENTS.md NTM pane priority), 4-min looper, bv-triaged dispatch, stalled-bead recovery, auto code-review on completion. See skills/start/_inflight_prompt.md" },
    { label: "Work on beads", description: "<N> open beads exist — refine, implement, or inspect (manual)" },
    { label: "Set a goal", description: "Type a fresh goal in Other — appends new beads to the existing set without discarding them" },
    { label: "Pick up existing plan", description: "Type a path to docs/plans/<file>.md in Other (or use one of the suggested paths above). Registers via flywheel_plan, then Step 5.45 surfaces (Validate / Approve / Refine / Scrap); validated gaps merge into the current bead set" }
  ],
  multiSelect: false
}])
```

**If no beads and no session** (fresh start):

> **Menu visibility rule (MANDATORY).** `AskUserQuestion` caps at 4 labeled options. Before calling it, print the **full menu** (all top-level + sub-options the routing table can reach in this state) as a visible markdown block so the user can see every entry point at load. Do NOT hide options behind an "Other" sub-menu — surface them. The 4 options inside `AskUserQuestion` are the most-common entry points; the extras (Simplify pass, Duel, Audit, Setup, Auto-swarm, Quick fix) are reachable via the printed block by typing the label into "Other" or by invoking the matching `/flywheel-*` slash command directly. Apply this same rule to the previous-session-exists and open-beads-exist menus above.

Print this block first:

```
Primary entry points:
  • Set a goal          — type your goal in Other; runs /brainstorming if ambiguous, then flywheel_select
  • Pick up existing plan — type a path to docs/plans/<file>.md in Other; jumps straight to bead creation
  • Scan & discover     — profile the repo and surface improvement ideas
  • Reality check       — /reality-check-for-project gap analysis

Recent plans (mtime desc — copy-paste into Other when picking "Pick up existing plan"):
  • <RECENT_PLAN_PATHS[0]>                       (or "(no docs/plans/*.md found)" if empty)
  • <RECENT_PLAN_PATHS[1]>
  • <RECENT_PLAN_PATHS[2]>

More entry points (type the label into "Other" or run the slash command directly):
  • Research repo       — paste a GitHub URL → /flywheel-research
  • Simplify pass       — /simplify-and-refactor-code-isomorphically (Deslop)
  • Duel                — /agent-flywheel:flywheel-duel (adversarial 2-agent ideation)
  • Audit               — /agent-flywheel:flywheel-audit
  • Setup               — /agent-flywheel:flywheel-setup
  • Quick fix           — /agent-flywheel:flywheel-fix
  • Auto-swarm          — in-flight resume; only meaningful with active beads
```

Then call:

```
AskUserQuestion(questions: [{
  question: "What would you like to do? (extras above are reachable via Other or slash commands.)",
  header: "Start",
  options: [
    { label: "Set a goal", description: "Type the goal directly in Other — runs /brainstorming when ambiguous, then flywheel_select. The most direct path when you know what you want to build" },
    { label: "Pick up existing plan", description: "Type a path to docs/plans/<file>.md in Other (or use one of the suggested paths above). Registers via flywheel_plan, surfaces Step 5.45 (Validate against code / Approve / Refine / Scrap) so you bead only the gaps. Skips brainstorming + scan" },
    { label: "Scan & discover", description: "Profile the repo and find improvement opportunities (greenfield default)" },
    { label: "Reality check", description: "Step back and gap-check actual implementation against AGENTS.md/README.md/plan vision — exhaustive 15-20 min /reality-check-for-project pass, optionally convert gaps to beads, optionally run swarm. See skills/start/_reality_check.md" }
  ],
  multiSelect: false
}])
```

**Conditional Recommendation (fresh-start menu only).** Pick the `(Recommended)` row dynamically from this priority chain:

1. **`RECENT_PLAN_PATHS.length > 0`** → "Pick up existing plan (Recommended)" — a ready-to-go plan is the strongest available signal; the operator almost always wants to pick it up.
2. **`HAS_VISION_DOCS === true`** (AGENTS.md or README.md at root, detected by Glob in 0b) → "Reality check (Recommended)" — vision docs exist; gap-check before adding more.
3. **Otherwise (greenfield)** → "Scan & discover (Recommended)" — no docs, no plans; profile first.

"Set a goal" is never auto-Recommended on the fresh-start menu; if the operator already knows their goal, they can pick it directly. This avoids the bias toward "type something" when the project already has structure to lean on.

### 0e. Route the user's choice

> **If `USER_INPUT` was captured in step 0.preflight, use the routing override there instead of this menu.** The default menu below applies only when the user invoked `/start` with no extra prompt content.

| Choice | Action |
|--------|--------|
| **Auto-swarm** | **Read `skills/start/_inflight_prompt.md` end-to-end and execute the verbatim prompt + the operator-decoder table + the 7-item pre-conditions checklist.** This is the canonical in-flight resume path: NTM readiness gate → CLI capability check → disk-space guard → tender-daemon spawn → bead snapshot + stalled-bead reopen → looper schedule → swarm dispatch (4 pi + 2 cc; fall back to 4 cod only if Pi is unavailable, per AGENTS.md NTM pane priority). Do NOT paraphrase the prompt; the slash-named skills (`/ntm`, `/vibing-with-ntm`, `/rch`, `/bv`, `/testing-*`, `/mock-code-finder`, etc.) are load-bearing. |
| **Other** | The user typed a label not in the 4 displayed options — match it (case-insensitive, leading-substring OK) against the printed block surfaced before the `AskUserQuestion` call. Recognized labels per state — fresh-start: `Research repo / Simplify pass / Duel / Audit / Setup / Quick fix / Auto-swarm`. Open-beads-exist: `Reality check / Duel / New goal / Simplify pass / Research repo / Audit / Setup`. Previous-session-exists: `Work on beads / New goal / Reality check / Duel / Simplify pass / Research repo / Audit / Setup`. **Special handling:** if the typed text starts with a path-like token (e.g. `docs/plans/`, ends in `.md`, or matches one of the surfaced `RECENT_PLAN_PATHS`), route as **Pick up existing plan** with the typed text as `<plan-path>`. Otherwise route the matched label through the corresponding row below (do NOT surface another `AskUserQuestion` — the printed block already showed every reachable entry point). If no label matches AND it isn't path-shaped, treat the free-text as a custom goal and route to **Set a goal** with the typed text as `<goal>`. |
| **Simplify pass** (a.k.a. Deslop pass) | Read `skills/start/_deslop.md` end-to-end and surface its mode-selection `AskUserQuestion` (Single-pass / Single + fresh-eyes / 5-Pi swarm — cod fallback if Pi unavailable, per AGENTS.md NTM pane priority / Iterative). Do NOT pick a mode unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. Then execute the matching mode's section verbatim; the canonical skill `/simplify-and-refactor-code-isomorphically` is the engine of every mode, with `/repeatedly-apply-skill`, `/ntm`, `/vibing-with-ntm` orchestrating around it. Baseline capture (tests + LOC + warnings) BEFORE any edits is mandatory — without it the skill cannot prove isomorphism preservation. |
| **Duel** | Invoke `/agent-flywheel:flywheel-duel` (state-aware routing — picks `mode=ideas` for fresh starts, `mode=architecture` when a goal is selected but no plan exists, `mode=reliability\|security` when reviewing risky open beads). Pre-flight (MANDATORY): run `which ntm` + `which claude codex gemini 2>/dev/null` (real binaries behind the `cc/cod/gmi` ntm pane types — do NOT `which cc` literally, it matches `/usr/bin/cc`) — need ntm + ≥2 of {claude, codex, gemini}; on failure, emit a one-line warning and surface a sub-menu offering `Deep (idea-wizard) / Triangulated / Cancel`. After the duel completes, parse `DUELING_WIZARDS_REPORT.md`, stamp `state.planSource = "duel"` (or the discovery equivalent so `_beads.md` Provenance block fires), and continue into the standard goal-selection or plan-approval flow per current phase. Do NOT skip the alignment check at Step 5.55 — duels surface contested decisions the alignment check exists to surface. |
| **Reality check** | Read `skills/start/_reality_check.md` end-to-end and surface its depth-selection `AskUserQuestion` (Reality check only / Reality check + beads / Full pipeline). Do NOT pick a depth unilaterally — per UNIVERSAL RULE 1, this is a labeled-option decision. Then execute the matching section verbatim; the slash-named skill (`/reality-check-for-project`) is load-bearing. Phase 1 (the docs+code+gap-report prompt) typically takes 15–20 minutes — do NOT short-circuit it with a docs-only summary. Bead creation is `br`-only per `/beads-workflow`. |
| **Resume session** | Run the **drift check** below before jumping to the saved phase |
| **Work on beads** | Run the **Work-on-beads sub-menu + bootstrap** below — do NOT call `flywheel_approve_beads` directly |
| **New goal** | Delete checkpoint if exists, proceed to Step 2 |
| **Scan & discover** | Proceed to Step 2 |
| **Set a goal** | Read the typed `<goal>` from the Other field. If empty, prompt for it via a follow-up `AskUserQuestion`. Then: run `/brainstorming` to refine the goal (skip when the goal is already concrete and ≤300 chars per the 0.preflight heuristics), and **in the same turn** call `flywheel_select` (Step 4), read `_planning.md`, and run through Step 4.5 (Phase 0.5) and Step 5's `AskUserQuestion` without pausing for user input — see "Stay-in-turn rule" below. **State-aware behavior:** on previous-session-exists, do NOT delete the checkpoint — append-mode (the new goal sits alongside the existing session). On open-beads-exist, the new beads merge into the existing set. On fresh-start, just proceed normally. |
| **Pick up existing plan** | Read the typed `<plan-path>` from the Other field. Validate: it must exist on disk AND end in `.md`. If invalid, surface a follow-up `AskUserQuestion` listing `RECENT_PLAN_PATHS` as labeled options plus an Other field for a custom path. Once a valid path is in hand: call `flywheel_select` with a synthesized goal derived from the plan's first H1/H2 header (or the filename if no header), then call `flywheel_plan({ planFile: <plan-path>, source: "picked-up-existing-plan" })`. **Do NOT jump straight to Step 5.5** — the picked-up source signal triggers **Step 5.45** (the plan-stage menu) first. Skip Step 2 (profile) and Step 3 (discover) entirely — the plan already represents committed scope. **State-aware behavior:** on previous-session-exists, run the drift check (same one used by Resume session) before registering the new plan; if drift is severe, ask whether to discard the checkpoint first. On open-beads-exist, surface a confirmation that the plan's beads will merge into the existing set (no automatic dedup at this stage — Step 5.5's coverage + dedup sweep will handle it). On fresh-start, just proceed. |
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

## Step 5.45: Picked-up-plan stage menu (gated on `state.planSource === "picked-up-existing-plan"`)

> **When to surface this.** ONLY after `flywheel_plan` returns with `state.planSource === "picked-up-existing-plan"` (set when the Step 0d "Pick up existing plan" route called `flywheel_plan({ planFile, source: "picked-up-existing-plan" })`). Plans coming from /brainstorming, mode=deep, mode=duel, or mode=standard skip this step entirely and flow straight to Step 5.5.
>
> **Why this exists.** A picked-up plan was written hours/days/weeks ago. Bits of it may already be implemented in HEAD. Bits may be stale relative to the current codebase. The default Step 5.5 bead-creation flow assumes the plan is fresh — beading every section blindly wastes work and produces stragglers that get auto-closed by `flywheel_verify_beads` later. Step 5.45 gives the operator four levers BEFORE the bead-set materializes.

After `flywheel_plan` returns successfully (response contains `pickedUp: true`), surface:

```
AskUserQuestion(questions: [{
  question: "Plan registered: '<plan-path>' (<chars> chars, last modified <relative-time>). What does this plan need?",
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

Run a section-vs-file analysis to identify which parts of the plan have already shipped:

1. **Parse plan into sections.** Read `state.planDocument`. Split on `^##\s` and `^###\s` headers; each section becomes a `{ title, body, lineRange }` record.
2. **Extract file claims per section.** For each section, scan the body for backtick-quoted paths (`` `mcp-server/src/foo.ts` ``), explicit "Create:" / "New file:" / "Modify:" directives, and bullet items mentioning paths. Build `<section> → [paths-claimed]`.
3. **Match against git history.** For each claimed path:
   - `git log --oneline --diff-filter=A -- <path>` — if non-empty, the file was ADDED at some point. New-file claims are satisfied.
   - `git log --oneline -- <path>` — if non-empty, the file has commits. Modify claims are partially satisfied.
   - `git log --oneline --grep="<bead-id-shape>"` for any bead IDs the plan section mentions (`claude-orchestrator-XXX`) — if matching commits exist, count it as fully done.
   - Compare commit timestamps to the plan file's mtime: commits AFTER the plan was written are likely the implementation; commits BEFORE are pre-existing context the plan was written against.
4. **Build a coverage table** of `<section> → done | partial | missing`:
   - `done` — all claimed paths have post-mtime commits OR matching bead-id commits.
   - `partial` — some paths have post-mtime commits, others don't.
   - `missing` — no claimed paths show evidence of post-mtime work.
5. **Surface the report and route the next action via `AskUserQuestion`:**

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

   - **"Bead-ify gaps only"** → write a filtered plan to `docs/plans/<original-name>-gaps-<YYYY-MM-DD>.md` containing only the partial/missing sections. Re-call `flywheel_plan({ planFile: <gaps-plan>, source: "picked-up-existing-plan" })`? No — set `state.planDocument` to the gaps file directly, mark the picked-up signal as already-validated (so 5.45 doesn't re-fire), then proceed to Step 5.5.
   - **"Bead-ify everything"** → proceed to Step 5.5 with the original plan unchanged.
   - **"Retire the plan"** → append `## Retired\n\nValidated against HEAD on <YYYY-MM-DD>; all sections shipped.\n` to the plan file, clear `state.planDocument` and `state.planSource`, return to Step 0d.
   - **"Inspect first"** → print the per-section table (one row per section: `<title> | <status> | <commits-found>`), then re-show this 4-option menu.

#### "Approve and bead-ify"

Skip validation. Jump directly to Step 5.5 (load `_beads.md`). The plan's beads materialize as if it had come from /brainstorming.

#### "Refine plan first"

1. Invoke `/superpowers:writing-plans` with the existing plan file as input. The skill returns a refined plan path (typically `docs/plans/<original-name>-refined-<YYYY-MM-DD>.md`).
2. Re-call `flywheel_plan({ planFile: <refined-path>, source: "picked-up-existing-plan" })`.
3. The 5.45 menu re-fires with the refined plan. The operator can pick Validate, Approve, Refine again, or Scrap.

#### "Scrap and restart"

1. Append `## Retired\n\nDiscarded by operator on <YYYY-MM-DD>; reason: scrapped during pick-up.\n` to the plan file (so future Pick-up runs skip it from the `RECENT_PLAN_PATHS` suggestions).
2. Clear `state.planDocument`, `state.planSource`, `state.selectedGoal`.
3. Jump back to Step 0d main menu.

> **One-time gate.** Step 5.45 fires ONCE per `flywheel_plan` registration. After the operator picks any of the 4 options, set `state.planSource = undefined` (or `"picked-up-validated"` if you want to keep telemetry) so re-entering Step 5.5 from the same plan doesn't re-prompt. The Refine path is the only exception — it re-registers the plan with the picked-up source, so 5.45 fires again on the refined plan.

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
