<div align="center">

```
░▒▓ CLAUDE · AGY · OPENCODE // AGENT-FLYWHEEL v3.26.0 ▓▒░
```

**Multi-agent coding flywheel for Claude Code, Google Antigravity (`agy`), and OpenCode.**  
Scan → discover → plan → beads → NTM swarm → review → wrap-up — with atomic checkpoints, pre-code interrogation (`pstack`), SHA-coupled verification ledgers, and adversarial review at every risky seam.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Version](https://img.shields.io/badge/version-3.26.0-blue.svg)](CHANGELOG.md)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-plugin-orange)](https://github.com/anthropics/claude-code)
[![Antigravity Port](https://img.shields.io/badge/Antigravity_(agy)-validated-8A2BE2)](docs/agy.md)
[![OpenCode Port](https://img.shields.io/badge/OpenCode-port-00ADD8)](docs/opencode.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.0-brightgreen)](#installation)
[![CI](https://github.com/burningportra/agent-flywheel-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/burningportra/agent-flywheel-plugin/actions)

<h3>Quick Install</h3>

```bash
curl -sSL https://raw.githubusercontent.com/burningportra/agent-flywheel-plugin/main/install.sh | bash
```

**Or inside Claude Code:**

```bash
/plugin marketplace add burningportra/agent-flywheel-plugin
/plugin install agent-flywheel@agent-flywheel
/reload-plugins
/agent-flywheel:flywheel-setup
```

**Or sync the Antigravity (`agy`) / OpenCode ports from a checkout:**

```bash
bash scripts/sync-agy.sh --write
bash scripts/sync-opencode.sh --write
```

</div>

---

## TL;DR

### The Problem

Coding agents stall halfway. A single agent picks up a feature, loses context, rationalizes skipping tests, leaves half-finished files on disk, and cannot resume cleanly after `/clear` or a crash. Multi-agent fan-out is worse: parallel agents overwrite each other's files, drift from the architectural plan, close issues without proving their code works, and leave zero audit trail when something breaks.

### The Solution

`agent-flywheel` turns multi-agent coding into a deterministic six-phase state machine backed by an MCP server (`25 flywheel_* tools`), a graph issue tracker (`br` + `bv`), a tmux swarm orchestrator (`ntm`), a file-reservation bus (`agent-mail`), and **Poteto (`pstack`) verification gates**. Every user decision routes through a structured menu (`AskUserQuestion` / `ask_question`), every closed bead writes a Zod-validated completion attestation (`.pi-flywheel/completion/<id>.json`), and every verification verdict is cryptographically coupled to its diff via `git patch-id --stable` in `.pi-flywheel/ledger.tsv`.

```
  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ 1. SCAN  ├───►│2.DISCOVER├───►│ 3. PLAN  ├───►│ 4. BEADS ├───►│5. SWARM  ├───►│6. REVIEW │
  └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘
       │               │               │               │               │               │
       └───────────────┴───────────────┴───────────────┴───────────────┴───────────────┘
                                               │
                     Atomic .pi-flywheel/checkpoint.json + .pi-flywheel/ledger.tsv
                   (resumable across sessions; 43 structured FlywheelErrorCode gates)
```

### Why Use `agent-flywheel`?

| Feature | What It Does |
|---|---|
| **Atomic Session Checkpoints** | Persists phase, goal, active beads, and git HEAD to `.pi-flywheel/checkpoint.json` on every step; resumes cleanly across `/clear`, crashes, or machines with automatic drift detection. |
| **Multi-Model NTM Swarms** | Spawns mixed Claude (`--cc`), Pi (`--pi` on frontier/balanced models via Vercel AI Gateway or provider logins), Gemini (`--gmi`), and Antigravity (`--agy`) panes in `tmux` with staggered robot-send dispatch. |
| **File-Reservation Guardrails** | Enforces exclusive Agent Mail file reservations (`reserveOrFail`) before any edit and blocks conflicting commits via a pre-commit guard and `RESERVE001` lint rule. |
| **Poteto (`pstack`) Pre-Code & Verification Gates** | Enforces pre-code research (`/why`), adversarial spec interrogation (`/interrogate`), ADRs (`/architect` + `decisions.tsv`), the **Plan Verification Triad** (`Verify, unit / live / perf`), and `git patch-id --stable` verification ledgers. |
| **Adversarial Duels & Cross-Agent Review** | Routes high-stakes discovery, planning, reality-check, and P0/security reviews through 2-agent cross-scoring (`/dueling-idea-wizards`) and cross-family peer review (`flywheel_review(action: "cross-agent")`). |
| **Multi-Harness Native Ports** | One source of truth in the repo emits validated plugins for **Claude Code**, **Google Antigravity (`agy`)** (`agy plugin validate --strict`), **OpenCode**, and **Codex**. |
| **27-Check Toolchain Doctor & Auto-Remediate** | Diagnoses MCP, Agent Mail, `br`, `bv`, `ntm`, `cm`, `pi`, `agy`, port sync, and model compatibility in `<2s`, with one-tap fixes via `flywheel_remediate`. |

---

## Quick Example

```bash
# 1. Start or resume the flywheel in any git repo
/agent-flywheel:start

# 2. (Optional) Run Poteto (pstack) pre-code gates before planning:
#    /why → /interrogate (docs/specs/<slug>-interrogation.md) → /architect (docs/architecture/<slug>-adr.md)
node scripts/check-plan.mjs docs/plans/2026-10-21-feature--synthesized.md
node scripts/check-bead-verify.mjs docs/plans/2026-10-21-feature--synthesized.md --json

# 3. Polish the bead graph (up to 6 rounds / 2 zero-change rounds) + run bv robot triage
node skills/agent-flywheel/scripts/fw-call.mjs flywheel_approve_beads \
  '{"cwd":".","action":"converge-polish","round":1,"changesMade":0}'

# 4. Spawn a mixed-model NTM swarm (Claude Opus + Pi GLM-5.3 / Muse-Spark + Antigravity lane)
node mcp-server/dist/scripts/swarm-spawn.js my-project --label impl \
  --cc=2:opus --pi=2 --pi-model=zai/glm-5.3 --agy=1:pro

# 5. Supervise in-flight panes with the tender daemon (nudges stalled panes, tracks heartbeats)
node mcp-server/dist/scripts/tender-daemon.js \
  --session=my-project--impl --cwd="$PWD" --project-key="$PWD" --coordinator=BlueLake &

# 6. Stamp SHA/patch-id-coupled verification onto each closed bead (.pi-flywheel/ledger.tsv)
node skills/agent-flywheel/scripts/fw-call.mjs flywheel_approve_beads \
  '{"cwd":".","action":"verify-bead","beadId":"my-project-abc","verdict":"verified","baseSha":"ec96fc1","headSha":"fe4b4be"}'

# 7. Advance the wave (gates on CompletionReportSchemaV1 + patch-id verification in Poteto mode)
node skills/agent-flywheel/scripts/fw-call.mjs flywheel_advance_wave \
  '{"cwd":".","completedBeadIds":["my-project-abc"]}'

# 8. Run cross-agent peer review (picks a model family different from the implementer's)
node skills/agent-flywheel/scripts/fw-call.mjs flywheel_review \
  '{"cwd":".","action":"cross-agent","beadId":"my-project-abc"}'
```

---

## Three Execution Tracks

All three tracks share the same `.pi-flywheel/checkpoint.json` state, `br` bead graph, and NTM swarm dispatcher — you choose the rigor level per cycle from the `/start` menus:

| Seam | Standard Track | High-Stakes Duel Track | Poteto (`pstack`) Track (`poteto: true`) |
|---|---|---|---|
| **Pre-Plan** | Phase 0.5 `/brainstorming` + 4-question goal deepening | `/dueling-idea-wizards --mode=ideas` (2-agent 0–1000 cross-scoring) | `/why` (4 `preCodeResearch` areas) + `/interrogate` (`docs/specs/<slug>-interrogation.md`) + `/architect` (`docs/architecture/<slug>-adr.md` + `decisions.tsv`) |
| **Plan (Step 5)** | `flywheel_plan(mode: "standard" \| "deep")` (Claude + 2 Pi planners) | `flywheel_plan(mode: "duel")` (`--mode=architecture` adversarial synthesis) | `flywheel_plan(mode: "deep", poteto: true, preCodeResearch)` + `scripts/check-plan.mjs` |
| **Beads (Step 6)** | `br create` + `flywheel_approve_beads(action: "start")` | Beads carry `## Provenance` (scores, surviving critique, steelman) | Every bead carries `Verify, unit / live / perf` triad (`scripts/check-bead-verify.mjs`) + `converge-polish` loop |
| **Wave Gate (Step 7)** | `CompletionReportSchemaV1` (`ubs`, `verify[]`, `selfReview`) | Same + provenance context injected into implementer prompt | Hard-gates `flywheel_advance_wave` on `git patch-id --stable` verdict in `.pi-flywheel/ledger.tsv` (`verification_missing`, `verification_failed`, `verification_sha_drift`) |
| **Review (Step 8)** | 5-agent fresh-eyes (`hit-me`) + `converge` loop | 2-agent adversarial duel (`--mode=security\|reliability`) | `cross-agent` decorrelated model-family review + `/interrogate` (Code Judo, Lead Judgment, Comment Sicko) |

---

## Design Philosophy

1. **State lives on disk; the server is stateless.** Every phase boundary writes `.pi-flywheel/checkpoint.json` atomically. Resume across machines, across `/clear`, and across process restarts without losing your place.
2. **Every decision is a labeled question.** `AskUserQuestion` (`ask_question` in Antigravity) is the only sanctioned way to ask the user anything. No implicit *"shall I proceed?"* prose; no silent defaults.
3. **Multi-agent fan-out goes through NTM + Agent Mail.** Raw `Task`/`Agent` fan-out loops, backgrounded `&` shells, and raw `tmux split-window` calls are blocked by review and lint rules (`PANE001`, `RESERVE001`). NTM owns the pane lifecycle; Agent Mail owns file reservations.
4. **Structured errors over string matching.** Every `flywheel_*` tool returns errors as one of **43 typed `FlywheelErrorCode` values** inside a Zod-validated envelope. The coordinator branches on `result.structuredContent.data.error.code`, never on prose.
5. **Verification is SHA-coupled, not narrative.** In Poteto mode (`potetoMode: true` or `FW_VERIFICATION_REQUIRED=1`), a bead cannot advance the wave until `flywheel_approve_beads(action: "verify-bead")` records a `verified` verdict tied to the commit range's `git patch-id --stable`. Rebasing preserves the verdict; editing a file invalidates it (`verification_sha_drift`).
6. **Decorrelated models catch correlated blind spots.** Deep planning fans out across Claude (`correctness`) and two frontier Pi models (`ergonomics`, `robustness`). `flywheel_review(action: "cross-agent")` routes review to a model family different from the implementer's and drafts a self-annealing CASS rule on rejection.

---

## How `agent-flywheel` Compares

| Capability | `agent-flywheel` (v3.26.0) | Raw Claude Code / AGY | Aider / Cline | SWE-agent / OpenHands |
|---|---|---|---|---|
| **Resumable across sessions** | ✅ Atomic `.pi-flywheel/checkpoint.json` | ❌ Context-window bound | ⚠️ Chat history only | ⚠️ Container-bound |
| **Multi-model parallel swarm** | ✅ NTM (`cc` + `pi` + `gmi` + `agy` panes) | ❌ Single-session | ❌ Single-session | ❌ Single-agent |
| **File-conflict prevention** | ✅ Agent Mail `reserveOrFail` + pre-commit guard | ❌ None | ❌ None | ❌ None |
| **Pre-code spec & ADR gates (`pstack`)** | ✅ `/why` + `/interrogate` + `/architect` | ❌ None | ❌ None | ❌ None |
| **SHA-coupled verification ledger** | ✅ `git patch-id --stable` in `ledger.tsv` | ❌ Narrative claims | ❌ Narrative claims | ⚠️ Test exit code only |
| **Adversarial review & cross-family grading** | ✅ Duels + `cross-agent` + `flywheel_grade_outcome` | ❌ Self-review | ❌ None | ❌ None |
| **Structured error contracts** | ✅ 43-code `FlywheelErrorCode` | ❌ Unstructured prose | ❌ Unstructured prose | ❌ Unstructured prose |
| **Dependency graph triage** | ✅ `bv --robot-triage\|next\|plan\|insights` + Cytoscape | ❌ Flat todo list | ❌ None | ❌ None |
| **Toolchain health & auto-remediation** | ✅ 27-check `flywheel_doctor` + `flywheel_remediate` | ❌ Manual | ❌ Manual | ❌ Manual |

**When to use `agent-flywheel`:**
- Multi-file features, refactors, ports, or architectural migrations that span 3–30+ beads across multiple waves.
- High-stakes changes where you want adversarial 3-planner synthesis, pre-code interrogation (`pstack`), and cryptographic proof that every bead's diff was verified.
- Multi-Mac setups where you want to offload a 6-pane swarm to a secondary Mac over SSH (`flywheel_swarm_host`).

**When `agent-flywheel` might be overkill:**
- A 5-line typo or one-file hotfix — use `/agent-flywheel:flywheel-fix` (fast path) or a direct edit instead of the full 6-phase loop.

---

## Installation

### 1. One-Liner Installer (macOS / Linux / WSL2)

```bash
curl -sSL https://raw.githubusercontent.com/burningportra/agent-flywheel-plugin/main/install.sh | bash
```

**Windows (PowerShell 7):**

```powershell
iwr -useb https://raw.githubusercontent.com/burningportra/agent-flywheel-plugin/main/install.ps1 | iex
```

**Verify installer checksums (optional):**
- `install.sh` → `1ef009cdfc67edee0629d8edd6d7adad48d75e1440a9e298244a56cbf706153e`
- `install.ps1` → `0e3883868133f7095477ffe96ede772c8e43604c2dd9b6b87089537f839e87db`

Flags: `--noninteractive` (CI), `--skip-launch`, `--skip-mcp-register`, `--skip-agent-mail`, `--with-opencode`. Logs write to `~/.agent-flywheel/install.log`.

### 2. Manual Install (Homebrew + Claude Code Marketplace)

```bash
# 1. Install Claude Code & required CLIs
brew install anthropic/cc/claude
brew install burningportra/tap/{br,bv,cm,dcg,ntm,agent-mail}

# 2. Start the Agent Mail HTTP coordinator on :8765
nohup am serve-http --port 8765 &

# 3. Inside Claude Code, install the plugin and run setup
/plugin marketplace add burningportra/agent-flywheel-plugin
/plugin install agent-flywheel@agent-flywheel
/reload-plugins
/agent-flywheel:flywheel-setup
```

### 3. Google Antigravity (`agy`) & OpenCode Ports

The repository is the single source of truth. Derived ports are generated and validated from manifest-owned sources (`agy/manifest.json` and `opencode/manifest.json`):

```bash
# Sync and validate the Antigravity (agy) plugin port (53 skills, 3 lifecycle hooks, rules/AGENTS.md <= 24 KB)
bash scripts/sync-agy.sh --write
bash scripts/sync-agy.sh --write --target ~/.gemini/config/plugins/agent-flywheel
agy plugin validate ~/.gemini/antigravity/plugins/agent-flywheel --strict --json

# Sync the OpenCode plugin port
bash scripts/sync-opencode.sh --write
```

See **[docs/agy.md](docs/agy.md)** and **[docs/opencode.md](docs/opencode.md)** for full operator guides.

### 4. From Source (Contributors)

```bash
git clone https://github.com/burningportra/agent-flywheel-plugin.git
cd agent-flywheel-plugin
npm ci --prefix mcp-server
npm run build --prefix mcp-server
claude --plugin-dir .
```

> **Note:** `mcp-server/dist/` and `mcp-server/dist/skills.bundle.json` are committed so the plugin runs immediately after install without a build step. After editing `mcp-server/src/` or `skills/`, run `npm run build --prefix mcp-server` and commit `mcp-server/dist/`.

### What Gets Installed

| Tier | CLI | Purpose | Upstream Repo |
|---|---|---|---|
| **Required** | `br` | Bead tracker (graph issue tracker + ready-frontier) | [Dicklesworthstone/beads_rust](https://github.com/Dicklesworthstone/beads_rust) |
| **Required** | `bv` | Bead visualizer + `--robot-triage\|next\|plan\|insights` | [Dicklesworthstone/beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) |
| **Required** | `agent-mail` (`am`) | Multi-agent HTTP coordination + file reservations (`:8765`) | [Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) |
| **Recommended** | `ntm` | Named-tmux-manager for parallel multi-model swarms | [Dicklesworthstone/ntm](https://github.com/Dicklesworthstone/ntm) |
| **Recommended** | `pi` | Multi-provider coding agent CLI (Vercel AI Gateway, Z.ai, xAI, Meta) | `@mariozechner/pi-coding-agent` |
| **Recommended** | `agy` | Google Antigravity CLI (`agy plugin validate`, `--agy` lane) | Google Antigravity (`agy` ≥ 1.4) |
| **Recommended** | `dcg` | Destructive-command guard | [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) |
| **Recommended** | `cass` / `cm` | Episodic transcript search + persistent procedural memory | [Dicklesworthstone/cass_memory_system](https://github.com/Dicklesworthstone/cass_memory_system) |

---

## Quick Start

1. **Launch the flywheel** in your repository:
   ```text
   /agent-flywheel:start
   ```
   *(First time in a repo? The flywheel offers a skippable, reversible 5-minute guided tour that runs one micro-bead end-to-end.)*
2. **Inspect the pre-flight banner**: Step 0 runs `flywheel_doctor`, `flywheel_observe`, and `flywheel_profile` in parallel (~1.5s) and displays branch, bead counts, Agent Mail, NTM swarm ratio (`cc:pi 2:4`), and any non-green checks.
3. **Pick your entry path** via `AskUserQuestion`:
   - **Scan & discover** → profile the repo and generate ranked improvement ideas (`Standard`, `Deep`, or `Duel`).
   - **Set a goal** → 4-question professional depth pass → Phase 0.5 `/brainstorming` → 3-agent Deep Plan (`Standard`, `Ambitious`, or `Poteto pstack`).
   - **Approve beads & launch swarm** → polish bead graph (`converge-polish`), choose Pi/Claude implementer models, and dispatch waves through NTM.
4. **Review & wrap up** → verify completion attestations (`flywheel_verify_beads`), run compliance audit (`flywheel_compliance_audit`), grade against the cycle rubric (`flywheel_grade_outcome`), audit `.pi-flywheel/ledger.tsv`, bump version, and store learnings to CASS (`docs/solutions/`).

### Diagnostic Triage Chain

| Order | Command | Role | When to Run |
|---|---|---|---|
| **1** | `/agent-flywheel:flywheel-doctor` | Read-only 27-check sweep (~1.5s) | First — always safe, never mutates |
| **2** | `/agent-flywheel:flywheel-setup` | Interactive prerequisite installer & `flywheel_remediate` runner | When doctor surfaces yellow or red checks |
| **3** | `/agent-flywheel:flywheel-healthcheck` | Deep periodic audit (codebase + dependency + bead graph) | Periodically across long-lived projects |

---

## Command & MCP Tool Reference

### Slash Commands (`commands/*.md` / `cmd-*` skills in `agy`)

| Command | Description | Example |
|---|---|---|
| `/agent-flywheel:start` | Start or resume the full 6-phase coding flywheel | `/agent-flywheel:start` |
| `/agent-flywheel:flywheel-doctor` | 27-check read-only diagnostic of every dependency and port | `/agent-flywheel:flywheel-doctor` |
| `/agent-flywheel:flywheel-setup` | Install/configure missing prerequisites and run remediations | `/agent-flywheel:flywheel-setup` |
| `/agent-flywheel:flywheel-status` | Show current phase, bead progress, and Agent Mail inbox | `/agent-flywheel:flywheel-status` |
| `/agent-flywheel:flywheel-swarm` | Launch a parallel NTM swarm on ready beads | `/agent-flywheel:flywheel-swarm` |
| `/agent-flywheel:flywheel-swarm-status` | Inspect running swarm panes, heartbeats, and bead status | `/agent-flywheel:flywheel-swarm-status` |
| `/agent-flywheel:flywheel-swarm-stop` | Gracefully stop swarm panes and release file reservations | `/agent-flywheel:flywheel-swarm-stop` |
| `/agent-flywheel:flywheel-duel` | Run a state-aware `/dueling-idea-wizards` adversarial duel | `/agent-flywheel:flywheel-duel` |
| `/agent-flywheel:flywheel-reality-check` | Vision-vs-code gap analysis (`AGENTS.md` / `README.md` / plans vs code) | `/agent-flywheel:flywheel-reality-check` |
| `/agent-flywheel:flywheel-speedup` | Profile, freeze e2e behavior, optimize or re-architect, and canary under load | `/agent-flywheel:flywheel-speedup` |
| `/agent-flywheel:flywheel-audit` | 4-agent parallel audit for bugs, security, test gaps, and dead code | `/agent-flywheel:flywheel-audit` |
| `/agent-flywheel:flywheel-fix` | Fast-path targeted fix without running the full 6-phase ceremony | `/agent-flywheel:flywheel-fix fix null check in parser` |
| `/agent-flywheel:flywheel-drift-check` | Check whether implementation has drifted from the active plan | `/agent-flywheel:flywheel-drift-check` |
| `/agent-flywheel:flywheel-rollback` | Revert a completed bead's commits and reopen the bead | `/agent-flywheel:flywheel-rollback <bead-id>` |
| `/agent-flywheel:flywheel-cleanup` | Prune orphaned git worktrees and flag stale `WIZARD_*.md` files | `/agent-flywheel:flywheel-cleanup` |
| `/agent-flywheel:flywheel-compound-refresh` | Sweep `docs/solutions/` to Keep / Update / Consolidate / Replace learnings | `/agent-flywheel:flywheel-compound-refresh` |
| `/agent-flywheel:flywheel-research` | Deep architectural research on an external GitHub repository | `/agent-flywheel:flywheel-research owner/repo` |
| `/agent-flywheel:flywheel-scan` | Targeted scan of specific paths or concerns | `/agent-flywheel:flywheel-scan src/auth` |
| `/agent-flywheel:flywheel-refine-skill` | Refine a specific skill from session evidence | `/agent-flywheel:flywheel-refine-skill start` |
| `/agent-flywheel:flywheel-refine-skills` | Review and refine all loaded skills from session evidence | `/agent-flywheel:flywheel-refine-skills` |
| `/agent-flywheel:flywheel-bead-viewer` | Launch the local Cytoscape bead-graph viewer (`http://127.0.0.1`) | `/agent-flywheel:flywheel-bead-viewer` |
| `/agent-flywheel:flywheel-stop` | Stop the active flywheel session and reset checkpoint state | `/agent-flywheel:flywheel-stop` |

### MCP Tools (`25 flywheel_* tools`)

If the MCP server is not mounted directly in your harness, call any tool via the bundled stdio helper [`skills/agent-flywheel/scripts/fw-call.mjs`](skills/agent-flywheel/scripts/fw-call.mjs):

```bash
node skills/agent-flywheel/scripts/fw-call.mjs <tool_name> '<json_args>' [--data | --text | --full]
```

| Tool | Purpose & Key Actions |
|---|---|
| `flywheel_profile` | Repo profile with git-HEAD-keyed cache (`.pi-flywheel/profile-cache.json`). Always call first. |
| `flywheel_observe` | Single-call session snapshot (`git`, `checkpoint`, `beads`, `agentMail`, `ntm`, `recentPlans`, `topErrorCodes`, `attestations`). |
| `flywheel_doctor` | 27-check health sweep + `preflightBanner` + `report.swarm` (`label`, `spawnFlags`, `ratioByLane`). |
| `flywheel_remediate` | One-tap canonical fix for failing doctor checks (`agent_mail_liveness`, `agy_port_sync`, `checkpoint_validity`, `cli_binary`, `codex_config_compat`, `dist_drift`, `mcp_connectivity`, `orphaned_worktrees`). |
| `flywheel_discover` | Surface ranked improvement ideas after a profile pass. |
| `flywheel_select` | Set `selectedGoal`, compute `goalSlug`, and transition to planning. |
| `flywheel_pi_models` | `action: "list" \| "choose"` — probe reachable Pi models + Vercel AI Gateway catalog and persist per-role picks. |
| `flywheel_plan` | `mode: "standard" \| "deep" \| "duel"`, `ambition: "standard" \| "ambitious"`, `poteto?: boolean`, `preCodeResearch?: {...}`. |
| `flywheel_convergence` | Read-only multi-signal plan convergence score + B6 oscillation detection. |
| `flywheel_synthesize_rubric` | `action: "synthesize" \| "validate" \| "edit" \| "regenerate" \| "skip"` — manage `.pi-flywheel/plans/<slug>/rubric.md`. |
| `flywheel_approve_beads` | `action: "start" \| "polish" \| "reject" \| "advanced" \| "git-diff-review" \| "remediate" \| "converge-polish" \| "verify-bead"`. |
| `flywheel_swarm_host` | `action: "list" \| "choose" \| "sync" \| "release"` — offload NTM swarms to another Mac over SSH + rsync. |
| `flywheel_advance_wave` | Close completed wave, enforce Stage-1 attestation + Poteto SHA/patch-id verification gates, surface `nextWave[]`. |
| `flywheel_verify_beads` | Reconcile closed beads against git commits and validate `.pi-flywheel/completion/<id>.json`. |
| `flywheel_compliance_audit` | Audit closed beads against plan requirements (`threshold: 700`); auto-reopens false-closed beads. |
| `flywheel_review` | `action: "hit-me" \| "looks-good" \| "skip" \| "report" \| "batch_review" \| "converge" \| "cross-agent"`. |
| `flywheel_grade_outcome` | Spawn decorrelated grader (`codex` primary, fresh-CC fallback) against `rubric.md` and persist verdict JSON. |
| `flywheel_rescue` | Build a Codex rescue packet (`plan` / `implement` / `review` stall recovery) and log to CASS. |
| `flywheel_memory` | `operation: "search" \| "store" \| "draft_postmortem" \| "draft_solution_doc" \| "refresh_learnings"`. |
| `flywheel_calibrate` | Aggregate closed bead durations by `Template: <id>` and write `.pi-flywheel/calibration.json`. |
| `flywheel_get_skill` | Serve any of the 58 bundled skills or `references/*.md` bodies in one MCP round-trip (`skills.bundle.json`). |
| `flywheel_emit_agy` | `mode: "check" \| "write" \| "prune"` — run `scripts/sync-agy.sh --json` to sync/validate the Antigravity plugin port. |
| `flywheel_emit_codex` | Emit `AGENTS.md` and `.codex/skills/*.md` inside `cwd`. |
| `flywheel_capabilities` | Introspect required/optional input fields and enum values for any `flywheel_*` tool. |
| `flywheel_robot_docs` | Machine-readable tool schemas, error catalog, and workflow graph for autonomous callers. |

---

## Configuration

### Environment Variables

| Variable | Default | Effect |
|---|---|---|
| `FW_LOG_LEVEL` | `warn` | `debug` / `info` / `warn` / `error`. Writes structured JSON lines to stderr only. |
| `FW_ATTESTATION_REQUIRED` | unset (warn-only) | `=1` flips Stage 1 completion-attestation gate in `flywheel_advance_wave` to hard-block (`attestation_missing`, `attestation_invalid`). |
| `FW_VERIFICATION_REQUIRED` | unset (enabled automatically when `potetoMode: true`) | `=1` requires a `git patch-id --stable`-coupled `verified` verdict in `.pi-flywheel/ledger.tsv` before `flywheel_advance_wave` advances (`verification_missing`, `verification_failed`, `verification_sha_drift`). |
| `FW_COMMIT_BATCH_THRESHOLD` | `8` | Number of commits before `flywheel_advance_wave` triggers an automatic mid-wave fresh-eyes `batch_review` (`0` disables). |
| `FW_SKILL_BUNDLE` | `on` | `=off` bypasses `mcp-server/dist/skills.bundle.json` and reads `skills/` directly from disk. |

### `flywheel.config.yaml`

Reads `~/.config/agent-flywheel/flywheel.config.yaml`, then `./flywheel.config.yaml` at the repo root (repo keys win):

```yaml
# Disable any CLI lane you don't use; its share moves down the substitution ladder (gmi -> pi -> cod -> cc)
lanes:
  gemini: false
  codex: true
  pi: true
  agy: true
```

### `.mcp.json` (Claude Code) & `mcp_config.json` (Antigravity `agy`)

```json
{
  "mcpServers": {
    "agent-mail": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    },
    "agent-flywheel": {
      "command": "node",
      "args": ["/absolute/path/to/agent-flywheel-plugin/mcp-server/dist/server.js"],
      "env": {
        "CLAUDE_PLUGIN_ROOT": "/absolute/path/to/agent-flywheel-plugin"
      }
    }
  }
}
```

### Runtime State Files

| Path | Purpose |
|---|---|
| `.pi-flywheel/checkpoint.json` | Atomic session state (`phase`, `selectedGoal`, `potetoMode`, `preCodeResearch`, `activeBeadIds`, `polishRound`, `reviewConvergence`). Never edit by hand. |
| `.pi-flywheel/completion/<beadId>.json` | Per-bead `CompletionReportSchemaV1` attestation (`ubs`, `verify[]`, `selfReview`, `beadClosedVerified`, and optional `verification` patch-id block). |
| `.pi-flywheel/ledger.tsv` | Append-only TSV verification ledger (`recorded_at`, `bead_id`, `verdict`, `base_sha`, `head_sha`, `patch_id`, `verifier`, `evidence`). |
| `.pi-flywheel/plans/<slug>/rubric.md` | Cycle-level outcome rubric (`c1`..`cN`) consumed by `flywheel_grade_outcome`. |
| `.pi-flywheel/plans/<slug>/convergence.json` | Multi-signal plan convergence state + B6 oscillation detector. |
| `.pi-flywheel/pi-models.json` | Persisted Pi model choices per role (`ergonomics`, `robustness`, `implementer`). |
| `decisions.tsv` | Append-only Architecture Decision Record log written by `/architect` in Poteto mode. |
| `docs/specs/<slug>-interrogation.md` | Adversarial spec interrogation artifact required before `flywheel_plan({ poteto: true })`. |
| `docs/architecture/<slug>-adr.md` | ADR artifact required before `flywheel_plan({ poteto: true })`. |
| `docs/plans/` · `docs/duels/` · `docs/solutions/` | Synthesized plans, duel reports, and durable CASS solution documents. |

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                   Harnesses (Single Repo Source of Truth)                     │
│  • Claude Code (.claude-plugin/plugin.json)                                   │
│  • Google Antigravity (`agy`) (agy/manifest.json → scripts/sync-agy.sh)       │
│  • OpenCode (opencode/manifest.json → scripts/sync-opencode.sh)               │
│  • Codex (flywheel_emit_codex → AGENTS.md + .codex/skills/*.md)               │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ stdio JSON-RPC (never stdout logs)
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                 agent-flywheel MCP Server (mcp-server/src/)                   │
│  • 25 flywheel_* tools + 50 input JSON schemas + 58 bundled skill bodies      │
│  • 43 typed FlywheelErrorCode envelopes + atomic .pi-flywheel/checkpoint.json │
│  • Poteto (`pstack`) gates: check-plan.mjs, check-bead-verify.mjs, patch-id   │
│  • bv-runner.ts: `bv --robot-triage | --robot-next | --robot-plan | insights` │
└───────────┬───────────────────────────┬───────────────────────────┬───────────┘
            │                           │                           │
            ▼                           ▼                           ▼
┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────┐
│  Bead Graph & Memory  │   │  NTM Swarm + Tender   │   │  Agent Mail (:8765)   │
│  • br (beads_rust)    │   │  • swarm-spawn.js     │   │  • macro_start_session│
│  • bv (beads_viewer)  │   │  • --cc / --pi /      │   │  • reserveOrFail()    │
│  • cm / cass memory   │   │    --gmi / --agy      │   │  • pre-commit guard   │
│  • ledger.tsv (SHA)   │   │  • tender-daemon.js   │   │  • completion mail    │
└───────────────────────┘   └───────────────────────┘   └───────────────────────┘
```

### Models Used

| Role | Model / Lane |
|---|---|
| **Correctness Plan Agent** | `claude-opus-4-7` (`--cc=1`) |
| **Ergonomics Plan Agent** | Frontier Pi model chosen via `flywheel_pi_models` (`--pi=1`, e.g. `zai/glm-5.3`, `xai/grok-4.7`; `claude-sonnet-4-6` fallback) |
| **Robustness Plan Agent** | Frontier Pi model chosen via `flywheel_pi_models` (`--pi=1`, e.g. `meta/muse-spark-1.3`; `codex` fallback) |
| **Swarm Implementers** | Mixed `--cc=2:opus` + `--pi=2` (alternated balanced Pi models) + `--gmi=2` (`gemini-4-argon` via Pi) + optional `--agy=N[:model[:effort]]` |
| **Cross-Agent & Fresh-Eyes Reviewers** | Decorrelated model family (`flywheel_review(action: "cross-agent")`) or 5-perspective `claude-sonnet-4-6` |

---

## What's New

### v3.26.0 (2026-10-21) — Antigravity (`agy`) Port, Poteto (`pstack`) Mode & Convergence Loops

- **Antigravity (`agy`) Mirror Port & `flywheel_emit_agy`.** `scripts/sync-agy.sh` (`scripts/agy/{sync,rewrite-body,emit-hooks,validate}.mjs`) and `flywheel_emit_agy` render a 53-skill Antigravity plugin (`plugin.json`, `mcp_config.json`, `hooks.json`, condensed `rules/AGENTS.md` ≤ 24 KB) that passes `agy plugin validate --strict --json` with zero findings. Includes `AntigravityAdapter`, `ratioByLane: { cc, pi, gmi, agy }`, `--agy=N[:model[:effort]]` validation (`resolveAgySlug`), and `agy_cli` / `agy_port_sync` / `pstack_plugin` doctor checks ([docs/agy.md](docs/agy.md)).
- **Poteto (`pstack`) Mode & SHA-Coupled Verification Ledger.** `flywheel_plan({ poteto: true, preCodeResearch })` gates planning on `/why` (4 research areas), `/interrogate` (`docs/specs/<slug>-interrogation.md`), and `/architect` (`docs/architecture/<slug>-adr.md` + `decisions.tsv`). Vendored Hybrid Core-6 `pstack` skills (`poteto-mode`, `interrogate`, `architect`, `plan`, `verify`, `why` + `references/*.md`), `scripts/check-plan.mjs`, and `scripts/check-bead-verify.mjs` enforce the Plan Verification Triad (`Verify, unit / live / perf`). `flywheel_approve_beads(action: "verify-bead")` stamps `git patch-id --stable` verdicts into `.pi-flywheel/completion/<id>.json` and `.pi-flywheel/ledger.tsv`, enforced by `flywheel_advance_wave`.
- **Convergence Loops & Durable Operator Skill.** Added `mcp-server/src/bv-runner.ts` (`bv --robot-triage|next|plan|insights`), `flywheel_approve_beads(action: "converge-polish")`, `flywheel_review(action: "converge" | "cross-agent")` with self-annealing CASS rule drafts, and the standalone [`skills/agent-flywheel/SKILL.md`](skills/agent-flywheel/SKILL.md) operator skill + [`fw-call.mjs`](skills/agent-flywheel/scripts/fw-call.mjs) stdio helper.

<details>
<summary>Earlier releases (v3.17.0 – v3.25.2)</summary>

- **v3.25.0 – v3.25.2:** 4-question goal-deepening pass before `flywheel_select`, fault-tolerant `br list` status normalization (`bead-status.ts`), and hermetic doctor unit tests.
- **v3.21.0 – v3.24.0:** `flywheel_pi_models` live Vercel AI Gateway + provider auth probing, `flywheel_swarm_host` multi-Mac SSH/Bonjour swarm offload, and 2.5× `/start` cold-start speedup (`history: 0` on `flywheel_memory`).
- **v3.18.0:** Canonical mixed pane priority + `PANE001` lint rule, `codex_config_compat` auto-remediation, and `gemini_model_compat` doctor probe.
- **v3.17.0:** Automatic mid-wave fresh-eyes `batch_review` triggered every N commits (`FW_COMMIT_BATCH_THRESHOLD=8`).

See **[CHANGELOG.md](CHANGELOG.md)** for the complete version history.

</details>

---

## Troubleshooting

| Symptom / Error Code | Cause | Copy-Paste Fix |
|---|---|---|
| `agy_port_sync` yellow in `flywheel_doctor` | Repo skills/hooks updated since last Antigravity sync | `bash scripts/sync-agy.sh --write` (or `flywheel_remediate({ checkName: "agy_port_sync", mode: "execute", autoConfirm: true })`) |
| `poteto_prerequisite_missing` / `pre_code_research_incomplete` | `flywheel_plan({ poteto: true })` called before `/why`, `/interrogate`, or `/architect` artifacts exist | Write `docs/specs/<slug>-interrogation.md` and `docs/architecture/<slug>-adr.md`, and pass all 4 `preCodeResearch` keys (`codebase`, `gitHistory`, `libraryDocs`, `priorDecisions`) |
| `verification_missing` / `verification_sha_drift` on `flywheel_advance_wave` | Closed bead lacks a `verified` verdict in `.pi-flywheel/ledger.tsv` or its diff changed after verification | Run `node skills/agent-flywheel/scripts/fw-call.mjs flywheel_approve_beads '{"cwd":".","action":"verify-bead","beadId":"<id>","verdict":"verified","baseSha":"<base>","headSha":"<head>"}'` |
| `attestation_missing` / `attestation_invalid` | Closed bead has no valid `.pi-flywheel/completion/<id>.json` | Write the completion JSON matching `CompletionReportSchemaV1` (`mcp-server/src/completion-report.ts`) |
| Banner says `Agent Mail: offline` | `am serve-http` is not running on `127.0.0.1:8765` | `nohup am serve-http --port 8765 &` (verify with `curl -s http://127.0.0.1:8765/health/liveness`) |
| `Resource is temporarily busy ... mailbox activity lock is busy` | Mutating `am doctor` ran while Agent Mail daemon held `.mailbox.activity.lock` | Never delete `.lock` files; run `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })` |
| `dist-drift` or `check:skills-bundle` CI failure | `mcp-server/src/` or `skills/` edited without rebuilding `mcp-server/dist/` | `npm --prefix mcp-server run build && git add mcp-server/dist/` |
| `lint:skill` CI failure (`PANE001`, `RESERVE001`) | Skill markdown violated pane-priority or `reserveOrFail` lint rules | `npm --prefix mcp-server run lint:skill` to inspect; fix the offending `skills/start/*.md` line |
| Banner says `NTM: installed but not configured` | Project directory sits outside `ntm config show` `projects_base` | `ntm config set projects_base "$(dirname "$PWD")"` |

For full debug traces on stderr:

```bash
FW_LOG_LEVEL=debug claude --plugin-dir .
```

---

## Limitations

- **macOS / Linux / WSL2 primary target.** `ntm` relies on `tmux`. On native Windows without WSL2, parallel NTM swarms are unavailable and execution falls back to sequential single-agent dispatch.
- **Claude Code repo is the authoring source of truth.** While the plugin runs natively in Google Antigravity (`agy`) and OpenCode, edits to skills, hooks, or MCP tools must be made in this repository and synced out via `scripts/sync-agy.sh --write` / `scripts/sync-opencode.sh --write` (hand-edits in derived ports are backed up as `[LOCAL]` and overwritten).
- **`--agy` panes are interactive/inspection lanes in NTM.** `swarm-spawn.js` spawns `--agy=N[:model[:effort]]` panes when `ntm` supports `--agy`, but automated wave bead assignment targets `--cc`, `--pi`, and `--gmi` panes.
- **Stateful by design.** Manual commits or branch resets outside the flywheel trigger a drift-resolution menu on the next `/agent-flywheel:start`.
- **Remote Mac swarm offload requires SSH + Keychain token setup.** Offloading `--cc` panes via `flywheel_swarm_host` requires `CLAUDE_CODE_OAUTH_TOKEN` in the remote Mac's `~/.zshenv` (via `claude setup-token`), since SSH sessions cannot read the macOS GUI Keychain.

---

## FAQ

**Q: Do I need `ntm` and `agent-mail` for single-agent work?**  
No. Single-agent flows (`Scan → Plan → Beads → Serial Implement → Review`) work with only `br` and `bv`. `ntm` and `agent-mail` are required only for multi-agent parallel swarms and adversarial duels.

**Q: How do I use `agent-flywheel` inside Google Antigravity (`agy`)?**  
Run `bash scripts/sync-agy.sh --write` and `bash scripts/sync-agy.sh --write --target ~/.gemini/config/plugins/agent-flywheel`. Antigravity loads the `agent-flywheel` plugin (`53 skills`, `AGENTS.md` rules, lifecycle hooks, and MCP server). You can also invoke any `flywheel_*` tool directly via `node skills/agent-flywheel/scripts/fw-call.mjs <tool> '<json>'`.

**Q: What is Poteto (`pstack`) mode and when should I enable it?**  
Poteto mode integrates [Poteto's `pstack`](https://github.com/cursor/plugins/tree/main/pstack) discipline: before planning, you run `/why` (4-area evidence gathering), `/interrogate` (adversarial spec stress-testing), and `/architect` (types/signatures + ADR in `decisions.tsv`). Every bead requires a `Verify, unit / live / perf` triad, and every wave boundary requires a `git patch-id --stable`-coupled verification entry in `.pi-flywheel/ledger.tsv`. Enable it for architectural changes, new subsystems, or high-risk refactors.

**Q: What happens if I rebase my branch after verifying beads in Poteto mode?**  
Nothing breaks. Because `verify-bead` hashes the diff via `git patch-id --stable` (which strips commit SHAs and line numbers), a clean rebase preserves the patch-id and keeps the `verified` status valid. Only an actual code edit to the bead's diff triggers `verification_sha_drift`.

**Q: What happens if I `/clear` or restart my terminal mid-session?**  
All state is persisted in `.pi-flywheel/checkpoint.json` and `.pi-flywheel/ledger.tsv`. Re-running `/agent-flywheel:start` detects the active checkpoint, checks for git drift, and resumes at the exact wave and step where you left off.

**Q: How does `flywheel_review(action: "cross-agent")` prevent rubber-stamping?**  
It inspects the implementer's model family (`claude`, `pi`, `gemini`, or `codex`) from the completion report and generates a peer-review prompt routed to a *different* model family. If a bead was previously rejected (`rejectedReason`), it also synthesizes a `selfAnnealingRule` ready to store in CASS (`flywheel_memory(operation: "store")`).

**Q: Why is `mcp-server/dist/` committed to git?**  
So `/plugin install` and `scripts/sync-agy.sh` work immediately on any machine without a build step. The `dist-drift` and `check:skills-bundle` CI checks fail any PR where `mcp-server/dist/` is out of sync with `mcp-server/src/` or `skills/`.

**Q: How do I roll back a bad bead implementation?**  
Run `/agent-flywheel:flywheel-rollback <bead-id>`. It reverts the bead's commits, reopens the bead in `br`, and updates `.pi-flywheel/checkpoint.json`.

---

## Acknowledgments

`agent-flywheel` orchestrates an upstream CLI ecosystem authored by **Jeffrey Emanuel** ([@Dicklesworthstone](https://github.com/Dicklesworthstone)) alongside **Poteto's [`pstack`](https://github.com/cursor/plugins/tree/main/pstack)** workflow playbooks:

| Upstream Project | Role in `agent-flywheel` | Repository |
|---|---|---|
| **`br` (`beads_rust`)** | Graph issue tracker and ready-work frontier calculation | <https://github.com/Dicklesworthstone/beads_rust> |
| **`bv` (`beads_viewer`)** | Dependency-aware bead triage (`--robot-triage\|next\|plan\|insights`) | <https://github.com/Dicklesworthstone/beads_viewer> |
| **`ntm`** | Named-tmux-manager for multi-pane swarm spawning and `--robot-send` | <https://github.com/Dicklesworthstone/ntm> |
| **`agent-mail` (`mcp_agent_mail_rust`)** | Multi-agent HTTP coordination, messaging, and file reservations | <https://github.com/Dicklesworthstone/mcp_agent_mail_rust> |
| **`dcg` (`destructive_command_guard`)** | Guardrail against destructive shell/git operations | <https://github.com/Dicklesworthstone/destructive_command_guard> |
| **`cass` & `cm`** | Episodic session search and persistent procedural memory | <https://github.com/Dicklesworthstone/cass_memory_system> |
| **`pstack` (Poteto)** | `/poteto-mode`, `/interrogate`, `/architect`, `/why`, `check-plan.mjs`, and verification discipline | <https://github.com/cursor/plugins/tree/main/pstack> |
| **ACFS Stack** | One-shot macOS installer for the full Dicklesworthstone CLI stack | <https://github.com/DavidSchargel/dicklesworthstone-acfs-stack-for-macos> |

---

## About Contributions

*Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.*

---

## License

MIT. See [LICENSE](LICENSE) for full text.

Repository: <https://github.com/burningportra/agent-flywheel-plugin>
