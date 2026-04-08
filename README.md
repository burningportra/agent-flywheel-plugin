# claude-orchestrator

Multi-agent coding orchestrator for Claude Code. Implements the Agentic Coding Flywheel: deep planning, parallel execution, and guided review gates — all using Claude Code's native Agent tool, skills, hooks, and MCP servers.

## What it does

claude-orchestrator drives a complete development cycle:

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
claude --plugin-dir ./claude-orchestrator
```

Or install permanently:

```bash
# Add to your Claude Code settings
claude settings plugins add ./claude-orchestrator
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
/claude-orchestrator:orchestrate-setup

# 2. Run the full flywheel
/claude-orchestrator:orchestrate

# 3. Check status
/claude-orchestrator:orchestrate-status
```

## Command reference

| Command | Description |
|---|---|
| `/claude-orchestrator:orchestrate` | Full flywheel: scan → plan → implement → review |
| `/claude-orchestrator:orchestrate-stop` | Stop session and reset state |
| `/claude-orchestrator:orchestrate-status` | Show bead progress, inbox messages, next steps |
| `/claude-orchestrator:orchestrate-setup` | Check and install prerequisites |
| `/claude-orchestrator:orchestrate-cleanup` | Remove orphaned git worktrees |
| `/claude-orchestrator:orchestrate-swarm` | Launch parallel swarm of implementation agents |
| `/claude-orchestrator:orchestrate-swarm-status` | Check swarm health and agent messages |
| `/claude-orchestrator:orchestrate-swarm-stop` | Stop all swarm agents |
| `/claude-orchestrator:orchestrate-research` | Deep research on an external GitHub repo |
| `/claude-orchestrator:orchestrate-drift-check` | Check if code has drifted from plan |
| `/claude-orchestrator:orchestrate-rollback` | Roll back a completed bead |
| `/claude-orchestrator:orchestrate-fix` | Fast-path targeted fix (no full flywheel) |
| `/claude-orchestrator:orchestrate-audit` | 4-agent codebase audit (bugs/security/tests/dead code) |
| `/claude-orchestrator:orchestrate-scan` | Targeted scan of specific paths or concerns |
| `/claude-orchestrator:orchestrate-refine-skills` | Improve all skills from session evidence |
| `/claude-orchestrator:orchestrate-refine-skill` | Refine a specific skill |
| `/claude-orchestrator:orchestrate-tool-feedback` | Submit feedback on orchestrator behavior |
| `/claude-orchestrator:orchestrate-healthcheck` | Full dependency and codebase health check |
| `/claude-orchestrator:memory` | Search or store CASS long-term memory |

## Architecture

```
claude --plugin-dir ./claude-orchestrator
│
├── commands/*.md          ← Natural language instructions for Claude
├── skills/frontend-design/ ← Injected into agent system prompts
├── hooks/hooks.json        ← SessionStart: restore notice
│
├── .mcp.json
│    ├── agent-mail (url)   ← Coordination: messaging, file reservations
│    └── orchestrator (stdio) ← State machine + br/bv/git CLI glue
│
└── mcp-server/src/         ← TypeScript MCP server
     ├── server.ts           ← 7 MCP tools registered
     ├── state.ts            ← Load/save OrchestratorState via checkpoint
     ├── checkpoint.ts       ← Atomic disk persistence
     ├── beads.ts            ← br CLI wrapper
     ├── agent-mail.ts       ← agent-mail JSON-RPC client
     └── tools/              ← orch_profile, orch_discover, orch_select,
                                orch_plan, orch_approve_beads, orch_review,
                                orch_memory
```

**Key design decisions:**

- **CC Agent tool handles all parallelism** — no subprocess spawning. `Agent(isolation: "worktree")` replaces WorktreePool. `run_in_background: true` replaces SwarmTender polling.
- **MCP server is stateless** — state lives in `.pi-orchestrator/checkpoint.json`. The server reads and writes it atomically.
- **Commands drive the conversation** — each `.md` file instructs Claude how to orchestrate the workflow, ask the user questions, and call the MCP tools.
- **agent-mail handles coordination** — file reservations prevent concurrent writes; messaging lets agents report progress.

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
