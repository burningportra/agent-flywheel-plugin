> Archived into [docs/research/research-apr-pro-phase-archive-2026-05-06.md] on 2026-05-06.

# Phase 6b: APR-Pro → Agent-Flywheel Ergonomics

> **Scope**: Developer experience improvements — how flywheel users interact with the
> tool, observability, recovery, debuggability, prompt clarity, command surface.
> Sibling: `apr-pro-apply.md` covers technical adoption (convergence math, bundling).

---

## 1. Executive Summary (5 biggest ergonomic wins)

1. **Structured exit codes on every MCP tool call** — today flywheel MCP tools return
   free-text on failure; APR's `{ ok, code, data, hint, meta }` envelope + semantic
   exit codes let callers branch without string-parsing.

2. **`/flywheel-status` convergence panel** — flywheel has no at-a-glance answer to
   "how done is the current plan?"; APR's dashboard shows size trend, change velocity,
   and confidence score in one view.

3. **Step 5.45 menu smart-defaults from convergence signal** — the
   validate/approve/refine/scrap menu currently relies on pure user judgment; gating
   "Approve" on a computed confidence threshold removes cognitive load.

4. **Lazy-refresh `flywheel_observe` with explicit `r` key** — subscribe-style polling
   causes races and context noise; APR's dashboard re-reads disk on demand, which is
   safer and faster.

5. **`/flywheel-doctor` pane introspection modeled on `am doctor`** — swarm panes are a
   black box post-launch; a structured health report (pane alive, last heartbeat, bead
   in-progress, mail pending) makes debugging faster.

---

## 2. DX Improvements

### 2.1 Structured JSON Envelope for All MCP Tools

**Friction removed**: MCP tool failures return unstructured text. Callers (skills,
subagents, the orchestrator) must grep or pattern-match stderr to decide if they should
retry, escalate, or continue. One wrong heuristic silently swallows errors.

**APR's mechanism**: Every `apr robot *` command emits:
```json
{
  "ok": false,
  "code": "validation_failed",
  "data": {},
  "hint": "Plan doc missing required section: ## Beads",
  "meta": { "v": "1.2.2", "ts": "2026-05-05T23:42:00Z" }
}
```
Exit codes are semantic and non-contiguous (0 / 2 / 4 / 8 / 12 / 16), reserving gaps
for future expansion.

**Flywheel surface**: `flywheel_plan`, `flywheel_observe`, `flywheel_advance_wave`,
`flywheel_approve_beads`, `flywheel_doctor` — all MCP tools.

**Concrete UX sketch**:
```json
// flywheel_advance_wave failure today (actual):
"Error: no beads in PENDING state"

// After: structured envelope
{
  "ok": false,
  "code": "no_pending_beads",
  "data": { "wave": 3, "beads_total": 12, "beads_done": 12 },
  "hint": "All beads complete — call flywheel_approve_beads to close wave.",
  "meta": { "v": "3.11.9", "ts": "..." }
}
```

Callers check `.code`, not `.hint`. Skills can `case "$code" in no_pending_beads)`.

**Effort**: Medium — wrapper around existing MCP tool return paths.

---

### 2.2 Convergence Confidence Score in `flywheel_observe`

**Friction removed**: `flywheel_observe` today tells you bead counts and wave number.
It cannot tell you whether the plan is stabilizing or still oscillating. Users must
read all the beads and form their own opinion — slow, error-prone, inconsistent.

**APR's mechanism**: After each round APR computes three signals:
- `output_size_trend` — is the plan growing, shrinking, or flat?
- `change_velocity` — how many lines changed vs prior round?
- `similarity_trend` — cosine/diff_ratio between adjacent rounds

Thresholds: 50 % confidence = "early", 75 % = "converging", 90 % = "done".
At 90 % APR auto-suggests "approve". APR also calls out oscillation (B6 blunder) when
the plan alternates between two states — something velocity alone misses.

**Flywheel surface**: `flywheel_observe` response body + `_review.md` skill.

**Concrete UX sketch** — new `convergence` field in `flywheel_observe` output:
```json
{
  "wave": 4,
  "beads": { "total": 18, "done": 14, "in_progress": 2, "pending": 2 },
  "convergence": {
    "confidence": 0.72,
    "label": "converging",
    "signals": {
      "bead_churn": -0.18,
      "plan_size_delta_pct": 2.1,
      "oscillating": false
    },
    "recommendation": "Continue — 1-2 more waves likely."
  }
}
```

`oscillating: true` triggers a warning banner in the Step 5.45 menu.

**Effort**: Medium — requires persisting wave-over-wave bead state snapshot to disk.

---

### 2.3 Step 5.45 Menu Smart-Defaults (Validate / Approve / Refine / Scrap)

**Friction removed**: The picked-up-plan menu presents four options with equal visual
weight. The user must read the plan, judge quality, then choose. For large plans this
takes minutes and the choice is underdetermined — "refine" and "approve" can both feel
correct at 75 % confidence.

**APR's mechanism**: APR's TUI gates the "next round" button on
`convergence.detected` and dims "approve" when confidence < 75 %. The user can always
override, but the default selection shifts based on computed state.

**Flywheel surface**: `skills/start/_picked_up_plan.md` — Step 5.45.

**Concrete UX sketch** — AskUserQuestion with dynamic default:

```
[Picked-up plan: "Add OAuth2 support"]

Convergence: ██████████░░░░░ 72 % — converging
Beads done: 14 / 18   Oscillating: no

What would you like to do?

  [V] Validate  — run preflight checks only
  [A] Approve   — accept plan, begin implementation   ← default at ≥75%
  [R] Refine    — ask reviewer to revise further
  [S] Scrap     — discard, start new plan

> _
```

At < 50 % confidence, default shifts to `[R] Refine`. At `oscillating: true`, display:
```
  ⚠ Plan is oscillating — scrap or manual edit recommended.
```

**Effort**: Small — convergence data already proposed in 2.2; menu text change only.

---

### 2.4 `/flywheel-doctor` Pane Introspection (`am doctor` analog)

**Friction removed**: After `/flywheel-swarm` launches N panes, the user has no quick
way to know which panes are alive, stuck, or have unread mail without opening each tmux
window. `am doctor` surfaces this in one command.

**APR's mechanism**: `apr status` queries `.sessions/*.pid` files, checks if PIDs are
alive, and reports per-session: alive/dead, last activity timestamp, round in progress.
The robot-mode variant returns JSON so automation can act on it.

**Flywheel surface**: `/flywheel-doctor` skill + `flywheel_doctor` MCP tool.

**Concrete UX sketch** — `/flywheel-doctor` terminal output:

```
FLYWHEEL DOCTOR  —  2026-05-05 23:42 UTC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Swarm panes (NTM):
  cod:3   ✓ ALIVE    last beat 12s ago   bead: B-07 (in-progress)
  cod:4   ✓ ALIVE    last beat  8s ago   bead: B-11 (in-progress)
  cod:5   ✗ DEAD     PID 84221 not found  bead: B-09 (stalled)
  pi:1    ✓ ALIVE    last beat 34s ago   bead: B-14 (in-progress)

Agent-mail inbox:
  cod:3   0 unread
  cod:4   1 unread  ← NEEDS ATTENTION
  cod:5   — (pane dead)
  pi:1    0 unread

Plan convergence: 72 %  (converging)
Wave: 4 of estimated 5-6

Recommended actions:
  1. Re-spawn cod:5  →  /flywheel-swarm --respawn cod:5
  2. Check cod:4 inbox  →  /flywheel-status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

MCP tool variant returns JSON envelope (see 2.1). The `recommended_actions` array is
machine-actionable (action type + args).

**Effort**: Medium — PID tracking + heartbeat writes per pane needed.

---

### 2.5 Prompt Quality Pre-Flight Gate

**Friction removed**: Skills like `_review.md` can be sent to an agent with an
unexpanded template placeholder (e.g. `{{PLAN_DOC}}` left literal) because no
validation step exists between "assemble prompt" and "send to agent". The error
surfaces only in the agent's garbled output, far from the source.

**APR's mechanism**: APR's `build_revision_prompt` function checks for unexpanded
`{{...}}` tokens before sending. Any unfilled placeholder causes an immediate
`validation_failed` exit (code 12), with the specific placeholder named in the hint.

**Flywheel surface**: `flywheel_plan`, skill frontmatter interpolation (any
`{{VARIABLE}}` pattern in `.md` skill files).

**Concrete UX sketch**:
```
PREFLIGHT FAILED: skill "flywheel-review" has unexpanded placeholder
  {{PLAN_DOC}} — did you call flywheel_plan before invoking this skill?

Exit code: validation_failed
Hint: Ensure flywheel_plan result is bound to PLAN_DOC before review.
```

Simple regex over assembled prompt body before dispatch — cheap, deterministic.

**Effort**: Small — one validation helper, called in skill dispatch path.

---

### 2.6 Unified-Diff "Refine" Branch in Step 5.45

**Friction removed**: When the user picks "Refine" in the Step 5.45 menu, the refiner
agent re-reads the whole plan and produces a new full document. The user then has to
visually diff old vs new to understand what changed. This is slow and loses the
rationale for each change.

**APR's mechanism**: APR asks the LLM to emit unified-diff hunks (`-3/+3 context`)
instead of the full revised document. The diff is human-readable, the rationale is
inline, and the patch can be applied deterministically (`patch -p1`).

**Flywheel surface**: `skills/start/_picked_up_plan.md` — the "Refine" branch.

**Concrete UX sketch** — refiner output format:

```
PLAN REFINEMENT — wave 4 → wave 4r
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
@@ -12,6 +12,8 @@ ## Beads
   B-07: Implement token refresh endpoint
+  B-07a: Add rate-limit header parsing (missed in original)
+  B-07b: Write integration test for refresh flow
   B-08: Update auth middleware
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Rationale: Token refresh without rate-limit handling causes 429 storms
           under load — two sub-beads scope the fix explicitly.

Accept this diff? [Y/n]
```

Side benefit: the diff itself is a cheap similarity signal (line count in
`+++`/`---` → bead_churn metric for 2.2).

**Effort**: Small — prompt change to refiner, thin wrapper to apply patch.

---

## 3. Output Formatting Wins

### 3.1 Robot-Mode JSON Envelope (already covered in 2.1)

The full envelope maps to flywheel like this:

| APR field  | Flywheel equivalent                          |
|------------|----------------------------------------------|
| `ok`       | Boolean success on every MCP tool result     |
| `code`     | Semantic string code (not HTTP status int)   |
| `data`     | Existing tool payload — no change needed     |
| `hint`     | Human-readable next step for the caller      |
| `meta.v`   | Plugin semver from `package.json`            |
| `meta.ts`  | ISO timestamp of tool invocation             |

Semantic codes proposed for flywheel:

```
ok                   — success
no_pending_beads     — all beads done or blocked
wave_not_ready       — prerequisite beads incomplete
plan_not_found       — no plan doc at expected path
validation_failed    — pre-flight check failed
pane_dead            — NTM pane no longer alive
mail_unread          — inbox has unread messages blocking progress
convergence_stalled  — oscillation detected, human required
```

### 3.2 `gum`-Styled Terminal Output

APR uses `gum` (Charm CLI) for styled banners, spinners, and choice menus. Flywheel
currently emits raw markdown-in-terminal text that looks good in Claude's chat but
renders as noise in a tmux pane.

Proposed: for slash commands that print to terminal (`/flywheel-status`,
`/flywheel-doctor`, `/flywheel-swarm-status`), emit output styled for 80-column
monospace:

```
╔══════════════════════════════════════════╗
║  FLYWHEEL STATUS  —  wave 4 / ~6         ║
╚══════════════════════════════════════════╝
  Plan        "Add OAuth2 support"
  Confidence  ██████████░░░  72 %
  Beads       ████████████░░░  14 / 18
  Stalled     cod:5 (B-09)
```

Block-drawing characters work in any terminal without a `gum` dependency. Use `gum`
only when available (detect via `command -v gum`), fall back to block chars otherwise.

**Effort**: Small per command — pure string formatting.

### 3.3 Semantic Exit Codes for Slash Commands

Today `/flywheel-doctor` exits 0 regardless of what it finds. Shell callers (CI hooks,
loop scripts) cannot detect "swarm is degraded" without parsing output.

Proposed exit code table (parallel to APR's non-contiguous scheme):

```
0   ok               — all panes alive, no unread mail
2   usage_error      — bad args
4   config_error     — flywheel not initialized
8   pane_dead        — ≥1 pane is dead
12  mail_blocked     — ≥1 pane has unread mail blocking progress
16  convergence_warn — oscillation detected
```

**Effort**: Small — set `$?` at end of skill scripts.

---

## 4. Recovery + Observability

### 4.1 Session Reattach for Long-Running Swarms

**APR's mechanism**: `apr run 5 &` writes PID to `.apr/.sessions/round-5.pid`.
`apr attach apr-round-5` polls that PID and streams output. On death, the PID file is
cleaned up. On `SIGTERM` during recovery, the bad output is renamed `.truncated` (not
left in place — B7 blunder avoided).

**Flywheel analog**: NTM panes are the long-running workers. Today there is no
`/flywheel-attach <pane>` command. A dead pane leaves its bead in `in_progress` state
forever unless the user manually detects and re-spawns it.

**Proposed**: 

1. Each NTM pane writes `~/.flywheel/panes/<slug>.pid` + `last_heartbeat` on a 30s
   interval (cheap `touch` call from within the pane's skill).

2. `/flywheel-doctor` reads these files — dead PID + stale heartbeat (> 2 min) =
   `pane_dead`.

3. `/flywheel-swarm --respawn <slug>` re-spawns the pane, resets the bead to `PENDING`,
   and writes a new PID file.

4. If the bead output is partially written (partial bead completion), rename to
   `.partial` instead of leaving it as complete — mirrors APR's B7 fix.

**Effort**: Medium — heartbeat writes + `/flywheel-swarm --respawn` subcommand.

### 4.2 `flywheel_observe` as Pure Disk Reader

**APR's lesson** (T4 synthesis): dashboard correctness comes from a single shared-state
file written atomically by the worker, read by any number of viewers. The TUI never
calls back into the orchestrator process.

**Current flywheel risk**: `flywheel_observe` may query live agent state via MCP calls,
creating a read-modify-write race if observe and advance_wave overlap.

**Fix**: `flywheel_observe` reads only:
- `~/.flywheel/state/<plan-slug>/beads.json` (atomic-written by `flywheel_advance_wave`)
- `~/.flywheel/panes/<slug>.pid` + `last_heartbeat`
- `~/.flywheel/state/<plan-slug>/convergence.json`

No MCP call to another live tool. If the state file is absent, return
`{ ok: false, code: "plan_not_found" }`.

**Effort**: Small refactor — change reads from live calls to file reads.

### 4.3 Convergence Dashboard (`apr dashboard` analog)

APR's `apr dashboard` shows a full-screen TUI with sparkline trends, round history,
and confidence bands. Flywheel has no equivalent.

**Minimal viable analog** — `/flywheel-status --verbose` banner:

```
FLYWHEEL CONVERGENCE HISTORY
plan: "Add OAuth2 support"  started: 2026-05-04

Wave  Beads-done  Bead-churn  Plan-delta  Confidence
  1       4/18        —           +340 L      12 %
  2       8/18       +2/-1        +120 L      31 %
  3      11/18       +1/-2         +40 L      54 %
  4      14/18       +0/-1         +12 L      72 %  ← current

Oscillating: no   Est. waves remaining: 1-2
```

Each wave row is one line — no external dependencies. Data comes from
`~/.flywheel/state/<slug>/convergence.json` updated per wave.

**Effort**: Small (data) + Small (rendering) — Medium total because state schema
needs to be defined and wired.

---

## 5. Documentation Patterns

### 5.1 Workflow-First README Structure

APR's README leads with a workflow diagram, then a YAML example, then command reference.
Users understand the mental model before they see any flags.

Flywheel's docs (skills/*.md) lead with implementation notes and flag lists. New users
must read 3-4 skill files to understand the bead → wave → plan lifecycle.

**Steal**: Add a `docs/WORKFLOW.md` (or top-level `README.md` section) with:
1. One-paragraph mental model (beads = atomic tasks, waves = parallel batches,
   plan = the spine)
2. ASCII lifecycle diagram (scan → discover → plan → wave loop → approve)
3. Three annotated command examples (start / status / doctor)
4. Link to each skill's own `.md`

Keep skill `.md` files as reference; `WORKFLOW.md` as the entry point.

**Effort**: Small — documentation only.

### 5.2 Convergence Visualization in Skill Output

APR shows convergence trend as part of its round output, not just in the dashboard.
Every `apr run N` terminal output ends with:

```
Convergence: ░░░░████████░░ 54% — still revising
Est. rounds remaining: 3-5
```

**Steal for flywheel**: Every `flywheel_advance_wave` call should append to its
structured output:

```
Wave 4 complete (14/18 beads done)
Convergence: ██████████░░░░ 72% — converging
Est. waves remaining: 1-2
```

One line. Always present. Callers that don't want it ignore it; humans always see it.

**Effort**: Tiny — string append, data comes from convergence.json.

### 5.3 Skills Reference with Input/Output Schemas

APR's `apr robot help` emits a machine-readable API manifest (all commands, their args,
and expected output shape). This makes it trivial to write integrations without reading
source code.

Flywheel has no equivalent — skill inputs/outputs are prose-documented in `.md` files
(if at all).

**Steal**: Add a `flywheel_describe` MCP tool that returns:
```json
{
  "tools": [
    {
      "name": "flywheel_observe",
      "description": "...",
      "inputs": { "plan_slug": "string" },
      "outputs": { "convergence": {...}, "beads": {...} },
      "error_codes": ["plan_not_found", "pane_dead"]
    }
  ]
}
```

Doubles as documentation and as a self-test target (`flywheel_doctor` can call
`flywheel_describe` to verify the plugin is loaded correctly).

**Effort**: Small — JSON manifest, no runtime behavior change.

### 5.4 Annotated YAML Workflow Examples

APR ships `examples/` with fully annotated workflow YAML files. Comments explain what
each field does and what values are valid. New users copy-paste and edit, rather than
reading the schema.

Flywheel's equivalent would be annotated `flywheel.config.yaml` examples:

```yaml
# flywheel.config.yaml — example: monorepo with 3 services
project_name: my-monorepo

# convergence thresholds (default: 50/75/90)
convergence:
  warn_at: 0.50      # show "still early" banner
  approve_at: 0.75   # default Step 5.45 selection becomes Approve
  auto_close_at: 0.90  # optional: auto-approve without user prompt

# NTM pane preferences (cod preferred, pi fallback — see ntm@3f1c23b)
swarm:
  prefer: [cod, pi]
  max_panes: 4
```

**Effort**: Tiny — documentation only.

---

## 6. Priority Matrix

| Proposal | Friction removed | Effort | Ship order |
|---|---|---|---|
| 2.3 Step 5.45 smart-defaults | Decision fatigue at approval gate | Small | 1st (no new data) |
| 3.2 gum-styled output | tmux readability | Small | 1st |
| 2.5 Prompt preflight gate | Silent bad prompts | Small | 1st |
| 2.6 Unified-diff Refine | Slow plan diffing | Small | 2nd |
| 3.3 Semantic exit codes | CI / loop integration | Small | 2nd |
| 5.2 Convergence line in wave output | No visibility after advance | Tiny | 2nd |
| 2.1 JSON envelope | Agent error handling | Medium | 3rd |
| 2.2 Convergence in flywheel_observe | No stability signal | Medium | 3rd |
| 4.2 Observe as disk reader | Race condition | Small | 3rd |
| 2.4 /flywheel-doctor pane introspection | Black-box swarms | Medium | 4th |
| 4.1 Session reattach + respawn | Dead pane stalls | Medium | 4th |
| 4.3 Convergence dashboard | No history view | Medium | 4th |
| 5.3 flywheel_describe manifest | Integration friction | Small | 5th |
| 5.1 WORKFLOW.md | Onboarding confusion | Small | 5th |

---

*Written by Phase 6b (sonnet/ergonomics). Sibling: `apr-pro-apply.md` (opus/technical adoption).*
