# AGENTS.md

Guidance for sub-agents working in this repository.

## Project Overview

claude-orchestrator is an MCP server that drives a multi-phase development workflow: scan, discover, plan, implement, review. The MCP server runs over stdio (JSON-RPC) from `mcp-server/src/server.ts`.

## Build

```bash
cd mcp-server && npm run build
```

Compiles TypeScript from `mcp-server/src/` to `mcp-server/dist/`.

## Hard Constraints

1. **No `console.log` in MCP server code.** The server uses stdin/stdout for JSON-RPC. Any stdout write corrupts the communication channel. Use `process.stderr.write()` for diagnostics.
2. **Never edit `mcp-server/dist/`.** It is compiled output. Edit sources in `mcp-server/src/` and rebuild.
3. **TypeScript strict mode.** `tsconfig.json` enables `strict: true`. All code must pass strict type checking.
4. **NodeNext module resolution.** Use `.js` extensions in all relative imports (e.g., `import { foo } from "./bar.js"`), even when the source file is `.ts`.
5. **ESM only.** `"type": "module"` in `package.json`. No CommonJS `require()`.
6. **Never write directly to `.pi-orchestrator/checkpoint.json`.** Use `orch_*` MCP tools for state management.
7. **All `exec` calls must include a `timeout`.** No open-ended shell commands.

## Key File Paths

- `mcp-server/src/` — TypeScript source (edit here)
- `mcp-server/dist/` — compiled output (never edit)
- `.pi-orchestrator/` — runtime state directory
- `skills/` — skill `.md` files injected into agent system prompts
- `commands/*.md` — natural language orchestrator commands
- `docs/plans/` — plan artifacts from deep-plan sessions

## Available CLI Tools

- **`br`** — bead tracker CLI: create, list, update status, approve beads.
- **`bv`** — bead visualizer: renders bead status dashboards, dependency graphs.
- **`ccc`** — optional codebase indexing/search tool. Not required; the system falls back gracefully if unavailable.

## Agent Coordination

- Bootstrap your agent-mail session with `macro_start_session` at the start of each task.
- Before modifying any file, request a file reservation via agent-mail.
- Report errors to the team lead via agent-mail with subject `[error] <context>`. Do not silently skip tasks.
- Check your agent-mail inbox at task start for updates or cancellations.

## Code Conventions

- Named exports only (no default exports).
- Types live in `mcp-server/src/types.ts`. Import with `import type { ... }`.
- `ExecFn` type (`mcp-server/src/exec.ts`) wraps all shell command execution.
- Errors throw `new Error(message)` — no custom error classes.
- Use `Promise.allSettled` for parallel operations where partial results are acceptable.
- Async functions preferred over callbacks.

## Testing

No test suite is configured yet. Verify changes by running the build: `cd mcp-server && npm run build`.
