# agent-flywheel

Multi-agent coding flywheel for Claude Code. Implements the Agentic Coding Flywheel: deep planning, parallel execution, and guided review gates — all using Claude Code's native Agent tool, skills, hooks, and MCP servers.

## What it does

agent-flywheel drives a complete development cycle:

1. **Scan** — profiles the repository (languages, frameworks, TODOs, key files)
2. **Discover** — generates ranked improvement ideas based on the codebase
3. **Plan** — creates implementation tasks (beads) with optional deep planning via 3 parallel AI models
4. **Implement** — spawns sub-agents in isolated git worktrees per bead
5. **Review** — fresh-eyes review by 5 parallel agents per bead
6. **Repeat** — loops through all beads with drift checks between rounds

## Prerequisites

- [Claude Code](https://github.com/anthropics/claude-code) (latest)
- [br](https://github.com/burningportra/br) — bead tracker CLI
- [bv](https://github.com/burningportra/bv) — bead visualizer CLI
- [agent-mail](https://github.com/burningportra/agent-mail) — multi-agent coordination server

```bash
# Install br and bv (example)
brew install br bv

# Start agent-mail
uv run python -m mcp_agent_mail.cli serve-http
```

## Installation

```bash
claude --plugin-dir ./agent-flywheel
```

Or install permanently:

```bash
# Add to your Claude Code settings
claude settings plugins add ./agent-flywheel
```

## Build the MCP server

```bash
cd mcp-server
npm install
npm run build
```

## Quick start

```bash
# 1. Set up prerequisites
/agent-flywheel:flywheel-setup

# 2. Run the full flywheel
/agent-flywheel:flywheel

# 3. Check status
/agent-flywheel:flywheel-status
```

## Command reference

| Command | Description |
|---|---|
| `/agent-flywheel:flywheel` | Full flywheel: scan → plan → implement → review |
| `/agent-flywheel:flywheel-stop` | Stop session and reset state |
| `/agent-flywheel:flywheel-status` | Show bead progress, inbox messages, next steps |
| `/agent-flywheel:flywheel-setup` | Check and install prerequisites |
| `/agent-flywheel:flywheel-cleanup` | Remove orphaned git worktrees |
| `/agent-flywheel:flywheel-swarm` | Launch parallel swarm of implementation agents |
| `/agent-flywheel:flywheel-swarm-status` | Check swarm health and agent messages |
| `/agent-flywheel:flywheel-swarm-stop` | Stop all swarm agents |
| `/agent-flywheel:flywheel-research` | Deep research on an external GitHub repo |
| `/agent-flywheel:flywheel-drift-check` | Check if code has drifted from plan |
| `/agent-flywheel:flywheel-rollback` | Roll back a completed bead |
| `/agent-flywheel:flywheel-fix` | Fast-path targeted fix (no full flywheel) |
| `/agent-flywheel:flywheel-audit` | 4-agent codebase audit (bugs/security/tests/dead code) |
| `/agent-flywheel:flywheel-scan` | Targeted scan of specific paths or concerns |
| `/agent-flywheel:flywheel-refine-skills` | Improve all skills from session evidence |
| `/agent-flywheel:flywheel-refine-skill` | Refine a specific skill |
| `/agent-flywheel:flywheel-tool-feedback` | Submit feedback on agent-flywheel behavior |
| `/agent-flywheel:flywheel-healthcheck` | Full dependency and codebase health check |
| `/agent-flywheel:memory` | Search or store CASS long-term memory |

## Architecture

```
claude --plugin-dir ./agent-flywheel
│
├── commands/*.md          ← Natural language instructions for Claude
├── skills/frontend-design/ ← Injected into agent system prompts
├── hooks/hooks.json        ← SessionStart: restore notice
│
├── .mcp.json
│    ├── agent-mail (http)  ← Coordination: messaging, file reservations
│    └── agent-flywheel (stdio) ← State machine + br/bv/git CLI glue
│
└── mcp-server/
     ├── src/                 ← TypeScript MCP server
     │    ├── server.ts       ← 8 MCP tools registered
     │    ├── state.ts        ← Load/save OrchestratorState via checkpoint
     │    ├── checkpoint.ts   ← Atomic disk persistence
     │    ├── beads.ts        ← br CLI wrapper + verifyBeadsClosed reconciliation
     │    ├── agent-mail.ts   ← agent-mail JSON-RPC client + checkAgentMailHealth()
     │    ├── exec.ts         ← ExecFn type; shell exec with timeout + AbortSignal
     │    ├── logger.ts       ← Structured stderr logger (createLogger)
     │    ├── profiler.ts     ← Repo profiler; collects file tree, commits, TODOs
     │    ├── scan.ts         ← ccc-based codebase analysis with signal propagation
     │    ├── deep-plan.ts    ← 3-agent deep planning with fault isolation + synthesis
     │    ├── tender.ts       ← SwarmTender: agent health monitoring, nudge budget (maxNudgesPerPoll), auto-escalation
     │    ├── lint/           ← SKILL.md linter (parser, 5 rules, 4 reporters, baseline + manifest)
     │    └── tools/          ← flywheel_profile, flywheel_discover, flywheel_select,
     │                            flywheel_plan, flywheel_approve_beads, flywheel_review,
     │                            flywheel_verify_beads, flywheel_memory
     └── scripts/
          └── lint-skill.ts   ← standalone CLI; CI runs compiled dist/scripts/lint-skill.js
```

**Key design decisions:**

- **CC Agent tool handles all parallelism** — no subprocess spawning. `Agent(isolation: "worktree")` replaces WorktreePool. `run_in_background: true` replaces SwarmTender polling.
- **MCP server is stateless** — state lives in `.pi-flywheel/checkpoint.json`. The server reads and writes it atomically.
- **Commands drive the conversation** — each `.md` file instructs Claude how to run the flywheel workflow, ask the user questions, and call the MCP tools.
- **agent-mail handles coordination** — file reservations prevent concurrent writes; messaging lets agents report progress.
- **Structured logging via `createLogger`** — all diagnostic output writes JSON lines to stderr (`FW_LOG_LEVEL` controls verbosity). Never touches stdout, keeping the MCP JSON-RPC channel clean.
- **SwarmTender auto-escalation** — `SwarmTender` monitors agent health and automatically nudges stuck agents (up to `maxNudgesPerPoll` per poll cycle, default 3), then kills and emits `onSwarmComplete` after `killWaitMs`. Opt-in via `flywheelAgentName`; backward compatible when unset.

## Models used

| Role | Model |
|---|---|
| Correctness plan agent | claude-opus-4-6 |
| Ergonomics plan agent | claude-sonnet-4-6 |
| Robustness plan agent | codex |
| Swarm implementation agents | claude-haiku-4-5 (lightweight) |
| Review agents | claude-sonnet-4-6 |

## License

MIT
