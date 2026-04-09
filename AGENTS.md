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

1. **No `console.log` in MCP server code.** The server uses stdin/stdout for JSON-RPC. Any stdout write corrupts the communication channel. Use `createLogger(ctx)` from `./logger.js` for all diagnostics — it writes structured JSON to stderr only.
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

## Agent-Mail Transport

### Transport History

The agent-mail MCP connection type has changed several times:

| Commit | Change | Outcome |
|--------|--------|---------|
| `c12c6be` | Changed type from `url` to `sse` | SSE broke the connection |
| `0a7a8c2` | Reverted to `url` | Restored connectivity |
| `7c08923` | Changed type from `url` to `http` | Current stable transport |

**Current recommended `.mcp.json` configuration:**

```json
{
  "agent-mail": {
    "type": "http",
    "url": "http://127.0.0.1:8765/mcp"
  }
}
```

Do **not** use `"type": "sse"` or `"type": "url"` — use `"http"`.

### Diagnosing Connection Issues

1. Ensure the agent-mail server is running: `npx agent-mail-server`
2. Verify port 8765 is listening: `lsof -i :8765`
3. Test the endpoint: `curl -s http://127.0.0.1:8765/mcp`

### Programmatic Health Check

`checkAgentMailHealth()` (exported from `mcp-server/src/agent-mail.ts`) sends a lightweight HEAD request to `http://127.0.0.1:8765/mcp` with a 3-second timeout. It returns:

- `{ reachable: true, transport: "http" }` on success.
- `{ reachable: false, error: "..." }` with an actionable message on failure.

The result is cached for the session — subsequent calls return the cached value without another network request. This function does not block operations that do not need agent-mail; callers decide how to handle an unreachable result.

## Code Conventions

- Named exports only (no default exports).
- Types live in `mcp-server/src/types.ts`. Import with `import type { ... }`.
- `ExecFn` type (`mcp-server/src/exec.ts`) wraps all shell command execution.
- Errors throw `new Error(message)` — no custom error classes.
- Use `Promise.allSettled` for parallel operations where partial results are acceptable.
- Async functions preferred over callbacks.

## Logging

Use `createLogger(ctx)` from `mcp-server/src/logger.ts` for all diagnostic output. Never use `console.log`, `console.warn`, or `console.error` directly.

```typescript
import { createLogger } from "./logger.js";
const log = createLogger("my-module");

log.info("doing thing");
log.warn("something odd", { detail: value });
log.error("failed", { err: String(err) });
```

Log level is controlled by the `ORCH_LOG_LEVEL` env var (default: `"warn"`). Levels: `debug < info < warn < error`.

## Testing

Vitest is configured. Run tests with:

```bash
cd mcp-server && npm test
```

Test files live in `mcp-server/src/__tests__/`. Follow existing patterns — use `vi.mock` for external deps, `vi.spyOn(process.stderr, 'write')` to capture logger output, `vi.useFakeTimers()` for time-dependent tests. Always add a regression test when fixing a bug.
