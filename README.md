# agent-flywheel

Multi-agent coding flywheel for Claude Code. Implements the Agentic Coding Flywheel: deep planning, parallel execution, and guided review gates - all using Claude Code's native Agent tool, skills, hooks, and MCP servers.

Repository: https://github.com/burningportra/agent-flywheel-plugin

## What it does

agent-flywheel drives a complete development cycle:

1. **Scan** - profiles the repository (languages, frameworks, TODOs, key files)
2. **Discover** - generates ranked improvement ideas based on the codebase
3. **Plan** - creates implementation tasks (beads) with optional deep planning via 3 parallel AI models
4. **Implement** - spawns sub-agents in isolated git worktrees per bead
5. **Review** - fresh-eyes review by 5 parallel agents per bead
6. **Repeat** - loops through all beads with drift checks between rounds

## Installation

Prerequisites: [Claude Code](https://github.com/anthropics/claude-code) (latest) and Node.js 18.18+.

```
/plugin marketplace add burningportra/agent-flywheel-plugin
/plugin install agent-flywheel@agent-flywheel
/reload-plugins
/agent-flywheel:flywheel-setup
```

`/agent-flywheel:flywheel-setup` detects missing tools and offers to install them. If multiple are missing, it offers a one-shot install of the full [ACFS stack](https://github.com/DavidSchargel/dicklesworthstone-acfs-stack-for-macos).

**Required:** [br](https://github.com/Dicklesworthstone/beads_rust) (bead tracker), [bv](https://github.com/Dicklesworthstone/beads_viewer) (bead viewer), [agent-mail](https://github.com/Dicklesworthstone/mcp_agent_mail) (multi-agent coordination)

**Recommended:** [ntm](https://github.com/Dicklesworthstone/ntm) (parallel sessions), [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) (safety guard), [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) (session search), [cm](https://github.com/Dicklesworthstone/cass_memory_system) (agent memory)

## Quick start

```
/agent-flywheel:start
```

That's it. The flywheel scans your repo, proposes improvements, plans, implements, and reviews.

## Command reference

| Command | Description |
|---|---|
| `/agent-flywheel:start` | Full flywheel: scan → plan → implement → review |
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
| `/agent-flywheel:flywheel-doctor` | One-shot diagnostic of toolchain deps (MCP, Agent Mail, br/bv/ntm/cm, node, git, dist-drift, orphaned worktrees, checkpoint) |
| `/agent-flywheel:memory` | Search or store CASS long-term memory |

## Architecture

```
claude --plugin-dir .
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
     │    ├── errors.ts       ← FlywheelErrorCode enum (26 codes) + Zod schemas + FlywheelError class + classifyExecError + sanitizeCause
     │    ├── mutex.ts        ← In-process per-bead/per-cwd mutex (concurrent_write code)
     │    ├── logger.ts       ← Structured stderr logger (createLogger)
     │    ├── profiler.ts     ← Repo profiler; collects file tree, commits, TODOs
     │    ├── scan.ts         ← ccc-based codebase analysis with signal propagation
     │    ├── deep-plan.ts    ← 3-agent deep planning with fault isolation + synthesis
     │    ├── tender.ts       ← SwarmTender: agent health monitoring, nudge budget (maxNudgesPerPoll), auto-escalation
     │    ├── episodic-memory.ts ← draftPostmortem(): synthesizes session-learnings from checkpoint + git + agent-mail + telemetry
     │    ├── plan-simulation.ts ← hotspot matrix: per-file contention scoring across wave beads, swarm vs serial recommendation
     │    ├── bead-templates.ts  ← 16 bead templates with @version pinning; plumbed through deep-plan synthesizer
     │    ├── telemetry.ts    ← FlywheelErrorCode event aggregator; bounded ring buffer + atomic spool to .pi-flywheel/error-counts.json
     │    ├── lint/           ← SKILL.md linter (parser, 6 rules incl. errorCodeReferences, 4 reporters, baseline + manifest)
     │    └── tools/          ← flywheel_profile, flywheel_discover, flywheel_select,
     │                            flywheel_plan, flywheel_approve_beads, flywheel_review,
     │                            flywheel_verify_beads, flywheel_memory,
     │                            flywheel_doctor (11-check toolchain diagnostic)
     └── scripts/
          └── lint-skill.ts   ← standalone CLI; CI runs compiled dist/scripts/lint-skill.js
```

**Key design decisions:**

- **CC Agent tool handles all parallelism** - no subprocess spawning. `Agent(isolation: "worktree")` replaces WorktreePool. `run_in_background: true` replaces SwarmTender polling.
- **MCP server is stateless** - state lives in `.pi-flywheel/checkpoint.json`. The server reads and writes it atomically.
- **Commands drive the conversation** - each `.md` file instructs Claude how to run the flywheel workflow, ask the user questions, and call the MCP tools.
- **agent-mail handles coordination** - file reservations prevent concurrent writes; messaging lets agents report progress.
- **Structured logging via `createLogger`** - all diagnostic output writes JSON lines to stderr (`FW_LOG_LEVEL` controls verbosity). Never touches stdout, keeping the MCP JSON-RPC channel clean.
- **SwarmTender auto-escalation** - `SwarmTender` monitors agent health and automatically nudges stuck agents (up to `maxNudgesPerPoll` per poll cycle, default 3), then kills and emits `onSwarmComplete` after `killWaitMs`. Opt-in via `flywheelAgentName`; backward compatible when unset.
- **Structured error contracts** - every `flywheel_*` tool returns errors as tagged `FlywheelErrorCode` codes (26 codes: `missing_prerequisite`, `invalid_input`, `cli_failure`, `exec_timeout`, `concurrent_write`, `empty_plan`, etc.) inside a Zod-validated envelope. The SKILL.md orchestrator branches on `result.data.error.code` instead of string-matching. `FlywheelError` class threads tagged errors through deep helper frames; `classifyExecError` maps raw exec rejections to the right code. `sanitizeCause` redacts absolute paths before embedding in MCP error content.
- **v3.4.0 observability bundle** - `flywheel_doctor` MCP tool diagnoses 11 toolchain dependencies in one sweep. `plan-simulation.ts` emits a hotspot matrix so waves auto-route to swarm vs coordinator-serial. `episodic-memory.ts`'s `draftPostmortem()` synthesizes a session-learnings entry from checkpoint, git log, agent-mail, and error-code telemetry. `telemetry.ts` aggregates `FlywheelErrorCode` events across sessions via a bounded spool at `.pi-flywheel/error-counts.json`. Bead templates with `@version` pinning (`bead-templates.ts`) standardize bead bodies across deep-plan synthesizer output.

## Tool name deprecation

The MCP tools were renamed from `orch_*` to `flywheel_*`. The `orch_*` names remain registered as deprecated aliases for back-compat with legacy installs and dispatch to the same runners. They will be removed in v4.0; prefer the `flywheel_*` names.

## Models used

| Role | Model |
|---|---|
| Correctness plan agent | claude-opus-4-7 |
| Ergonomics plan agent | claude-sonnet-4-6 |
| Robustness plan agent | codex |
| Swarm implementation agents | claude-haiku-4-5 (lightweight) |
| Review agents | claude-sonnet-4-6 |

## Install from source (contributors)

```bash
git clone https://github.com/burningportra/agent-flywheel-plugin.git
cd agent-flywheel-plugin
npm ci --prefix mcp-server
npm run build --prefix mcp-server
claude --plugin-dir .
```

After editing `mcp-server/src/`, rebuild with `npm run build --prefix mcp-server` and commit the updated `mcp-server/dist/` in the same PR. The `dist-drift` CI job enforces this.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the three-step skill-add loop (skill dir, commands dir, dist rebuild) and the `skills/_template/` scaffold for a 30-minute onboarding.

## License

MIT
