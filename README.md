<div align="center">

```
░▒▓ CLAUDE // AGENT-FLYWHEEL v3.11.4 ▓▒░
```

**Multi-agent coding flywheel for Claude Code.**
Scan → discover → plan → implement → review — with checkpoints, gates, and adversarial review at every seam.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Version](https://img.shields.io/badge/version-3.11.4-blue.svg)](#)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-plugin-orange)](https://github.com/anthropics/claude-code)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-brightgreen)](#)
[![CI](https://github.com/burningportra/agent-flywheel-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/burningportra/agent-flywheel-plugin/actions)

</div>

```bash
/plugin marketplace add burningportra/agent-flywheel-plugin
/plugin install agent-flywheel@agent-flywheel
/reload-plugins
/agent-flywheel:flywheel-setup
```

Then `/agent-flywheel:start` and you're off.

---

## TL;DR

### The problem

Coding agents stall halfway. They pick up a task, lose context, hit a rate limit, leave half-finished work, skip the review pass that would catch their own bugs, and cannot resume cleanly across sessions. Multi-agent fan-out is worse — agents trample each other's files, lose track of which work is in flight, and there's no audit trail when something goes wrong.

### The solution

A six-phase loop with state on disk, gates between every step, and adversarial review at the risky seams. Every user decision flows through `AskUserQuestion` (no implicit choices). Every multi-agent fan-out goes through NTM + Agent Mail (no raw tmux, no `&` background shells). Every closed bead carries a versioned **Completion Evidence** attestation in `.pi-flywheel/completion/<beadId>.json` that the coordinator validates before advancing the wave.

```
scan ──> discover ──> plan ──> implement ──> review ──> wrap-up
  │         │           │          │            │           │
  └─────────┴───── checkpoint after every step ─┴───────────┘
            (drift check on resume; structured-error routing)
```

### Why use it?

| | agent-flywheel | Raw Claude Code | Aider / Cline | SWE-agent / OpenHands |
|---|---|---|---|---|
| Resumable across sessions | ✅ atomic checkpoint | ✗ context-window-bound | partial (chat history) | partial |
| Multi-agent swarm | ✅ NTM + Agent Mail | ✗ | ✗ | partial (single-agent) |
| File-reservation conflict prevention | ✅ pre-commit guard | ✗ | ✗ | ✗ |
| Adversarial review (duels) | ✅ 2-agent cross-scoring | ✗ | ✗ | ✗ |
| Structured error contracts | ✅ 36-code FlywheelErrorCode | ✗ string parsing | ✗ | ✗ |
| Completion attestation ledger | ✅ Zod-validated JSON | ✗ | ✗ | ✗ |
| Bead-graph dependency view | ✅ `bv` + Cytoscape viewer | ✗ | ✗ | ✗ |
| Auto-recovery (stalled beads, drift) | ✅ tender daemon + 4-min looper | ✗ | ✗ | partial |
| Doctor / setup / healthcheck triage | ✅ 17-check sweep | ✗ | ✗ | ✗ |

---

## Quick example

```bash
# In a Claude Code session, in any git repo:
/agent-flywheel:start

# Banner + state detection. If beads are open, you get the resume menu.
# Otherwise you see a fresh-start menu:
#
#   1. Scan & discover  ← profile + ranked ideas
#   2. Set a goal       ← brainstorm + plan + implement
#   3. Deslop pass      ← isomorphism-preserving refactor
#   4. Duel             ← adversarial 2-agent ideation

# Pick "Set a goal". Type the goal. Pick "Full flywheel".
# The flywheel runs /brainstorming, generates a plan via 3 parallel
# models (claude-opus, claude-sonnet, codex), splits it into beads,
# and asks you to approve.

# After approval, the swarm spawns:
ntm spawn agent-flywheel --label impl --pi=4 --cc=2 --stagger-mode=smart

# Each pane gets a marching-orders message via Agent Mail. The
# tender daemon nudges stalled panes. When all beads close,
# `flywheel_review` spawns 5 fresh-eyes reviewers per risky bead
# (or 2-agent adversarial duel for p0 / security-path beads).

# Wrap-up commits CHANGELOG entries, bumps the version, rebuilds
# dist/, and writes a postmortem entry to docs/solutions/.
```

---

## Design philosophy

1. **State lives on disk; the server is stateless.** Every phase boundary writes `.pi-flywheel/checkpoint.json` atomically. The MCP server reads it and writes it; nothing else holds session state. Resume across machines, across `/clear`, across crashes.

2. **One lever per commit.** Refactors land as isomorphism-preserving Edits (the `simplify-and-refactor-code-isomorphically` skill enforces this). Reviewers can bisect.

3. **Every decision is a labeled question.** `AskUserQuestion` is the only sanctioned way to ask the user anything. No implicit "shall I proceed?" prose. No silent choices.

4. **Multi-agent fan-out is mandatory through NTM.** Raw `Task`/`Agent` calls for fan-out, backgrounded shells, and `tmux split-window` are review-bounce conditions. NTM provides the canonical pane registry, Agent Mail integration, stuck-pane detection, and stagger.

5. **Structured errors over string matching.** Every `flywheel_*` tool returns errors as tagged `FlywheelErrorCode` codes (36 of them) inside a Zod-validated envelope. The orchestrator branches on `result.data.error.code`, never on human-readable text.

6. **Adversarial review at risky seams.** Discovery, planning, reality-check, and review can all be routed through `/dueling-idea-wizards`: two independent agents (Claude + Codex, optionally + Gemini) brainstorm separately, cross-score 0–1000, reveal, and synthesize. Beads created from a duel carry a `## Provenance` block downstream.

7. **Completion is evidence-backed, not narrative.** Every closed bead writes a `CompletionReportSchemaV1` JSON file with UBS results, verify-command exitCodes, self-review summary, and bead-close verification. `flywheel_advance_wave` gates on it (Stage 1 warn-only by default; flip `FW_ATTESTATION_REQUIRED=1` for hard-block).

---

## What's new in v3.11.0 (2026-04-30)

The duel-winner runtime safety substrate. Three composable features, all behind feature flags so existing installs continue working:

- **`flywheel_observe({ cwd })`** — single-call session-state snapshot. One MCP round-trip returns checkpoint state, bead counts, agent-mail reachability, NTM pane state, wizard artifacts, and graded `hints[]` (info/warn/red). Idempotent, non-mutating, sub-1.5s budget.
- **Completion Evidence Attestation (Stage 1)** — versioned `CompletionReportSchemaV1` ledger at `.pi-flywheel/completion/<beadId>.json`. Coordinator validates every closed bead before advancing the wave. Set `FW_ATTESTATION_REQUIRED=1` to flip from warn-only to hard-block.
- **Lock-aware reservation helper + `RESERVE001` lint rule** — `reserveOrFail()` in `mcp-server/src/agent-mail-helpers.ts` treats any non-empty `conflicts` array as failure (works around the upstream agent-mail advisory-enforcement bug). The `RESERVE001` lint rule fails CI on raw `agentMailRPC("file_reservation_paths")` call sites.

Earlier highlights: `flywheel_doctor` (v3.4) · bead templates with effort tiers (v3.4) · `flywheel_remediate` one-tap doctor fixes (v3.7) · `flywheel_calibrate` per-template duration aggregator (v3.7) · `flywheel_get_skill` bundled skill loader with 4-layer drift defense (v3.7) · read-only bead-graph viewer with cycle highlighting (v3.7).

---

## Installation

### Recommended: Claude Code plugin marketplace

```bash
/plugin marketplace add burningportra/agent-flywheel-plugin
/plugin install agent-flywheel@agent-flywheel
/reload-plugins
/agent-flywheel:flywheel-setup
```

`/flywheel-setup` detects missing CLIs and offers a one-shot install. If a lot is missing it can install the full ACFS stack via Homebrew.

### From source (contributors)

```bash
git clone https://github.com/burningportra/agent-flywheel-plugin.git
cd agent-flywheel-plugin
npm ci --prefix mcp-server
npm run build --prefix mcp-server
claude --plugin-dir .
```

After editing `mcp-server/src/`, rebuild with `npm run build --prefix mcp-server` and commit the updated `mcp-server/dist/` in the same PR. The `dist-drift` CI job enforces this.

### Required CLIs

| CLI | Purpose | Source |
|---|---|---|
| `br` | Bead tracker (issue graph) | [Dicklesworthstone/beads_rust](https://github.com/Dicklesworthstone/beads_rust) |
| `bv` | Bead visualizer + dependency triage | [Dicklesworthstone/beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) |
| `agent-mail` | Multi-agent coordination over HTTP | [Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) (Rust port — primary; [Python build](https://github.com/Dicklesworthstone/mcp_agent_mail) still works on the same transport) |

### Recommended CLIs

| CLI | Purpose | Source |
|---|---|---|
| `ntm` | Parallel tmux-pane orchestration | [Dicklesworthstone/ntm](https://github.com/Dicklesworthstone/ntm) |
| `dcg` | Destructive-command guard | [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) |
| `cass` | Session search across past agent runs | [Dicklesworthstone/coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search) |
| `cm` | Persistent CASS memory | [Dicklesworthstone/cass_memory_system](https://github.com/Dicklesworthstone/cass_memory_system) |
| `jsm` | Skill-marketplace manager | (used by sibling skills) |

Prerequisites: [Claude Code](https://github.com/anthropics/claude-code) (latest) and Node.js ≥ 18.18.

---

## Quick start

```
/agent-flywheel:start
```

The flywheel will:
1. Print a banner with version, branch, bead counts, Agent-Mail and NTM status.
2. Run a 2-second `flywheel_doctor` smoke check.
3. Show a state-aware menu (resume / fresh-start / open-beads).
4. Route through scan → discover → plan → implement → review based on your pick.

Stuck? Run the diagnostic triage chain:

| Order | Command | Role | Run when |
|---|---|---|---|
| 1 | `/agent-flywheel:flywheel-doctor` | Read-only snapshot, 17 checks, ~2s | First — always safe |
| 2 | `/agent-flywheel:flywheel-setup` | Apply fixes (install / register / configure) | Only if doctor is yellow / red |
| 3 | `/agent-flywheel:flywheel-healthcheck` | Deep periodic audit (codebase + dep graph) | Periodically; not for setup problems |

---

## Command reference

| Command | Description |
|---|---|
| `/agent-flywheel:start` | Full flywheel: scan → plan → implement → review |
| `/agent-flywheel:flywheel-stop` | Stop session and reset state |
| `/agent-flywheel:flywheel-status` | Bead progress, inbox messages, next steps |
| `/agent-flywheel:flywheel-setup` | Check and install prerequisites |
| `/agent-flywheel:flywheel-cleanup` | Remove orphaned git worktrees |
| `/agent-flywheel:flywheel-swarm` | Launch parallel swarm of implementation agents |
| `/agent-flywheel:flywheel-swarm-status` | Swarm health and agent messages |
| `/agent-flywheel:flywheel-swarm-stop` | Stop all swarm agents |
| `/agent-flywheel:flywheel-research` | Deep research on an external GitHub repo |
| `/agent-flywheel:flywheel-drift-check` | Has the code drifted from the plan? |
| `/agent-flywheel:flywheel-rollback` | Roll back a completed bead |
| `/agent-flywheel:flywheel-fix` | Fast-path targeted fix (no full flywheel) |
| `/agent-flywheel:flywheel-audit` | 4-agent codebase audit (bugs/security/tests/dead code) |
| `/agent-flywheel:flywheel-scan` | Targeted scan of specific paths or concerns |
| `/agent-flywheel:flywheel-refine-skills` | Improve all skills from session evidence |
| `/agent-flywheel:flywheel-refine-skill` | Refine a specific skill |
| `/agent-flywheel:flywheel-tool-feedback` | Submit feedback on agent-flywheel behavior |
| `/agent-flywheel:flywheel-healthcheck` | Full dependency and codebase health check |
| `/agent-flywheel:flywheel-doctor` | One-shot diagnostic of toolchain dependencies |
| `/agent-flywheel:flywheel-duel` | State-aware adversarial duel — wraps `/dueling-idea-wizards` |
| `/agent-flywheel:flywheel-reality-check` | Gap analysis: AGENTS.md / README / plan vs actual code |
| `/agent-flywheel:memory` | Search or store CASS long-term memory |
| `npm run bead-viewer` | Open the read-only bead-graph viewer (Cytoscape, `127.0.0.1`) |

### High-stakes track

The flywheel surfaces `/dueling-idea-wizards` as one extra row in the menus you already see when running `/agent-flywheel:start`:

| Seam | Trigger | What happens |
|---|---|---|
| **Discover** (Step 3) | "Duel" row in the depth menu | Two agents independently brainstorm 5 ideas each, cross-score 0–1000, reveal, synthesize. Consensus winners + contested ideas land in the goal-selection menu with provenance attached. |
| **Plan** (Step 5) | "Duel plan" row in the plan-mode menu | `--mode=architecture`. The synthesized plan goes into `docs/plans/<date>-<slug>-duel.md` with an "Adversarial review" section. |
| **Reality check** | "Duel reality-check" row in `/flywheel-reality-check` | Two agents independently produce gap reports vs. AGENTS.md / README / plans, cross-rate severity. Consensus gaps become beads; contested gaps surface to you. |
| **Review** (Step 9) | Auto-routed for risky beads (p0, security path, breaking change) | `--mode=security|reliability`. Non-risky beads keep the standard 5-agent fresh-eyes review. |

Pre-conditions: ntm + ≥ 2 of {cc, cod, gmi} healthy (run `/flywheel-doctor` to verify). Cost: ~20–55 min per duel.

---

## Configuration

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `FW_LOG_LEVEL` | `warn` | `debug` / `info` / `warn` / `error`. Logs are JSON-per-line on stderr. |
| `FW_ATTESTATION_REQUIRED` | unset (warn-only) | `=1` flips Stage 1 completion-attestation gate to hard-block. |
| `FW_SKILL_BUNDLE` | on | `=off` bypasses the bundled skills loader (forces disk reads — useful when editing skills live). |
| `ORCH_LOG_LEVEL` | `warn` | Same as `FW_LOG_LEVEL`; legacy alias. |

### Runtime files

| Path | Purpose |
|---|---|
| `.pi-flywheel/checkpoint.json` | Atomic session state. Never edit directly — use `flywheel_*` tools. |
| `.pi-flywheel/error-counts.json` | Telemetry spool for `FlywheelErrorCode` aggregation. |
| `.pi-flywheel/completion/<beadId>.json` | Per-bead completion attestation (v3.11.0+). |
| `.pi-flywheel/profile-cache.json` | Repo-profile cache, keyed on git HEAD. |
| `.pi-flywheel/tender-events.log` | Tender-daemon event log (NDJSON). |
| `docs/plans/` | Plan artifacts from deep-plan + duel-plan sessions. |
| `docs/duels/` | Duel synthesis reports. |
| `docs/solutions/` | Distilled session learnings (durable memory). |

### .mcp.json

```json
{
  "agent-mail": {
    "type": "http",
    "url": "http://127.0.0.1:8765/mcp"
  },
  "agent-flywheel": {
    "type": "stdio",
    "command": "node",
    "args": ["./mcp-server/dist/server.js"]
  }
}
```

Do not use `"type": "sse"` or `"type": "url"` for agent-mail — use `"http"`.

---

## Architecture

```
claude --plugin-dir .
│
├── commands/*.md          ← Natural-language slash commands (24)
├── skills/*/SKILL.md      ← 40 skills + 9 phase sub-files (start/_*.md)
├── hooks/hooks.json       ← SessionStart banner + tool checks
│
├── .mcp.json
│    ├── agent-mail (http) ── coordination: messaging, file reservations
│    └── agent-flywheel (stdio) ── state machine + br/bv/git CLI glue
│
└── mcp-server/
     ├── src/                          ← TypeScript (strict, NodeNext, ESM)
     │    ├── server.ts                ← MCP tool registration
     │    ├── tools/                   ← 14 flywheel_* tools
     │    │    ├── observe.ts          ← session-state snapshot (v3.11)
     │    │    ├── doctor.ts           ← 17-check toolchain probe
     │    │    ├── remediate.ts        ← one-tap doctor fixes
     │    │    ├── advance-wave.ts     ← wave gating + attestation read
     │    │    ├── verify-beads.ts     ← bead-close reconciliation
     │    │    └── …
     │    ├── checkpoint.ts            ← atomic state persistence
     │    ├── beads.ts                 ← br CLI wrapper
     │    ├── agent-mail.ts            ← agent-mail JSON-RPC client
     │    ├── agent-mail-helpers.ts    ← reserveOrFail (v3.11)
     │    ├── completion-report.ts     ← Zod schema + read/validate (v3.11)
     │    ├── tender.ts + tender-daemon.ts ← swarm health monitor
     │    ├── deep-plan.ts             ← 3-agent parallel planning
     │    ├── plan-simulation.ts       ← swarm-vs-serial routing
     │    ├── episodic-memory.ts       ← postmortem + learnings synthesis
     │    ├── lint/                    ← SKILL.md linter (6 rules incl. RESERVE001)
     │    ├── errors.ts                ← FlywheelErrorCode + envelope + errMsg helper
     │    └── skills-bundle.ts         ← bundled skill loader, 4-layer drift defense
     ├── dist/                         ← compiled output (committed; dist-drift CI gates it)
     └── scripts/
          ├── lint-skill.ts
          ├── build-skills-bundle.ts
          ├── check-skills-bundle.ts
          └── bead-viewer.ts           ← read-only Cytoscape graph (127.0.0.1)
```

---

## Models used

| Role | Model |
|---|---|
| Correctness plan agent | `claude-opus-4-7` |
| Ergonomics plan agent | `claude-sonnet-4-6` |
| Robustness plan agent | `codex` |
| Swarm implementation agents | `claude-haiku-4-5` (lightweight) |
| Review agents | `claude-sonnet-4-6` |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Banner says `MCP: not configured` | Plugin install incomplete | `/agent-flywheel:flywheel-doctor` → `/agent-flywheel:flywheel-setup` |
| Banner says `Agent Mail: offline` | `am serve-http` not running | `am serve-http` (or `mcp-agent-mail serve` if `am` not on PATH); legacy fallback: `uv run python -m mcp_agent_mail.cli serve-http` |
| Banner says `NTM: installed but not configured` | Project not under `ntm config show` `projects_base` | Either `ntm config set projects_base <parent-dir>` or symlink your project under the existing base |
| `dist-drift` CI failure | `mcp-server/src/` edited without rebuilding `dist/` | `npm run build --prefix mcp-server && git add mcp-server/dist/` |
| `lint:skill` CI failure | New AskUserQuestion / slash reference / placeholder issue in a SKILL.md | `npm run lint:skill --prefix mcp-server` locally; fix or `npm run lint:skill:update-baseline` |
| Swarm agents idle / stuck | Tender daemon not running | Check `.pi-flywheel/tender-events.log`; restart with `node mcp-server/dist/scripts/tender-daemon.js --session=<...>` |
| `flywheel_advance_wave` returns `attestation_missing` | A closed bead has no `.pi-flywheel/completion/<id>.json` | Implementor must write the report (template in `skills/start/_implement.md`); or set `FW_ATTESTATION_REQUIRED=` (unset) for warn-only |
| Repeated agent-mail file-reservation conflicts | Upstream advisory-enforcement bug | Use `reserveOrFail()` from `mcp-server/src/agent-mail-helpers.ts` — never call `agentMailRPC("file_reservation_paths")` directly (`RESERVE001` lint rule enforces this) |
| `Resource is temporarily busy ... mailbox activity lock is busy` from `am doctor` | The live Agent Mail daemon holds `.mailbox.activity.lock` | Run `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })`; do not delete lock files. Claude/Pi hooks block mutating `am doctor` commands from swarm panes. |

For deeper traces:

```bash
FW_LOG_LEVEL=debug claude --plugin-dir .
```

Logs go to stderr as one JSON object per line. Stdout is reserved for the MCP JSON-RPC channel — never use `console.log` in `mcp-server/src/` (the project's `createLogger(ctx)` writes to stderr only).

---

## Limitations

- **macOS-first ecosystem.** The recommended CLIs (`br`, `bv`, `ntm`, etc.) all run on Linux too, but the install path through the [ACFS stack](https://github.com/DavidSchargel/dicklesworthstone-acfs-stack-for-macos) is mac-tuned. Linux users compile from source.
- **Requires Claude Code.** Not provider-agnostic. Codex emission is supported via `flywheel_emit_codex`, but Claude Code is the source of truth.
- **Stateful by design.** `.pi-flywheel/checkpoint.json` is the session anchor. If you do work in the repo without flywheel awareness (manual commits, branch surgery), the next `/start` will surface a drift menu — that's the contract, not a bug.
- **Multi-agent fan-out depends on NTM.** Without NTM, parallelism falls back to single-agent serial. Single-agent flows still work but lose the swarm speed-up.
- **Heavy dependency tree.** A full install pulls br + bv + ntm + agent-mail + dcg + cass + cm. `/flywheel-setup` and the ACFS stack make this one command, but it's still a real install footprint.
- **Adversarial duels need ≥ 2 healthy CLIs.** `/dueling-idea-wizards` requires Claude + at least one of {Codex, Gemini}. With only Claude available, the flywheel offers a "Deep" or "Triangulated" fallback row instead.
- **Built for solo / small-team flow.** Compound engineering across many concurrent humans isn't the design center. The bead graph is the coordination surface, not Git PR review.

---

## FAQ

**Q: Do I need ntm and Agent Mail to use this?**
No — single-agent flows work without them. NTM and Agent Mail are required for parallel swarms (`/flywheel-swarm`) and recommended for everything else. The doctor will tell you what's missing in `<2s`.

**Q: What happens if I `/clear` mid-session?**
Nothing breaks. State is on disk in `.pi-flywheel/checkpoint.json`. Re-run `/agent-flywheel:start` and you'll get the resume menu with a drift check.

**Q: Can I use this with Codex instead of Claude Code?**
Partially. The MCP tools work, but the source of truth is Claude Code. For Codex you can emit a Codex-native skill bundle via `flywheel_emit_codex(cwd, targetDir)`, which writes `AGENTS.md` + `.codex/skills/<name>.md`. Round-trip drift-tested.

**Q: How does the flywheel decide when to use a duel vs. standard generator?**
Phase-aware. Discovery, planning, and reality-check have an explicit "Duel" row in their menus. Review auto-routes to a duel for risky beads (priority p0, security path, breaking change). Everywhere else uses the standard single-agent or 5-agent path.

**Q: Why so many CLIs?**
Each one is a load-bearing specialist. `br` is the bead graph, `bv` is the dependency triage, `ntm` is the pane registry, `agent-mail` is the file-reservation bus. We orchestrate them rather than reinvent any of them. Credit for all of these belongs to [Jeffrey Emanuel (Dicklesworthstone)](https://github.com/Dicklesworthstone) — see Acknowledgments.

**Q: Is the `dist/` commit really intentional?**
Yes. The MCP server runs immediately after `/plugin install` with no Node build step on the user's machine. The `dist-drift` CI job ensures `mcp-server/dist/` always matches `mcp-server/src/`.

**Q: What's the difference between `flywheel-doctor`, `flywheel-setup`, and `flywheel-healthcheck`?**
`doctor` is a 2-second read-only snapshot — run first, always safe. `setup` is the apply-fixes step — only run if doctor is yellow/red. `healthcheck` is a deep periodic audit (codebase + dep graph + bead graph) — run on a cadence, not for setup problems.

**Q: How do I roll back a bad bead?**
`/agent-flywheel:flywheel-rollback <bead-id>`. Reverts the bead's commits, re-opens the bead, and updates the checkpoint.

---

## Acknowledgments

agent-flywheel sits on top of an ecosystem of upstream tools authored by **Jeffrey Emanuel** ([@Dicklesworthstone](https://github.com/Dicklesworthstone)). The flywheel orchestrates them; it doesn't replace them.

| Tool | Role | Repo |
|---|---|---|
| **br** (`beads_rust`) | Issue tracker as a graph; ready-work computation | <https://github.com/Dicklesworthstone/beads_rust> |
| **bv** (`beads_viewer`) | Dependency-aware bead triage and dashboards | <https://github.com/Dicklesworthstone/beads_viewer> |
| **ntm** | Named-tmux-manager — parallel pane orchestration with robot-send addressing | <https://github.com/Dicklesworthstone/ntm> |
| **agent-mail** (`mcp_agent_mail_rust`) | Multi-agent coordination over HTTP — file reservations, messaging, pre-commit guard | <https://github.com/Dicklesworthstone/mcp_agent_mail_rust> |
| **agent-mail (legacy)** | Python build of the same protocol | <https://github.com/Dicklesworthstone/mcp_agent_mail> |
| **dcg** (`destructive_command_guard`) | Two-person rule for destructive commands | <https://github.com/Dicklesworthstone/destructive_command_guard> |
| **cass** (`coding_agent_session_search`) | Search every past agent session by transcript | <https://github.com/Dicklesworthstone/coding_agent_session_search> |
| **cm** (`cass_memory_system`) | Persistent procedural memory for agents | <https://github.com/Dicklesworthstone/cass_memory_system> |
| **ACFS stack** | One-shot installer for the full mac-side ecosystem | <https://github.com/DavidSchargel/dicklesworthstone-acfs-stack-for-macos> |

Without these, the flywheel is just a state machine with nothing to coordinate. With them, it's a coding swarm that observes, reserves, retries, and learns.

---

## Using agent-flywheel with Codex

agent-flywheel's skills can be emitted in Codex native format (`AGENTS.md` + `.codex/skills/<name>.md`) via the `flywheel_emit_codex` MCP tool. Point it at any destination directory inside your project; skill source files are never modified, and the round-trip is drift-tested. The emitter is single-target by design — for runtimes other than Codex, keep Claude Code as the source of truth.

```
flywheel_emit_codex(cwd: "/path/to/project", targetDir: ".")
```

---

## Tool name deprecation

The MCP tools were renamed from `orch_*` to `flywheel_*`. The `orch_*` names remain registered as deprecated aliases for back-compat with legacy installs and dispatch to the same runners. They will be removed in v4.0; prefer the `flywheel_*` names in new code and docs.

---

## About Contributions

*Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.*

---

## License

MIT. See [LICENSE](LICENSE) (or the repo root) for the full text.

Repository: <https://github.com/burningportra/agent-flywheel-plugin>
