# AGENTS.md

Guidance for sub-agents working in this repository.

## Project Overview

agent-flywheel is an MCP server that drives a multi-phase development workflow: scan, discover, plan, implement, review. The MCP server runs over stdio (JSON-RPC) from `mcp-server/src/server.ts`.

## Build

```bash
cd mcp-server && npm run build
```

Compiles TypeScript from `mcp-server/src/` to `mcp-server/dist/`.

**`mcp-server/dist/` is committed** so the plugin works immediately after `/plugin install` with no Node build step on the user's machine. If you change anything in `mcp-server/src/`, run `npm run build` and commit the resulting `dist/` changes in the same PR. The `dist-drift` CI job fails any PR where `dist/` is out of sync with `src/`.

## Hard Constraints

1. **No `console.log` in MCP server code.** The server uses stdin/stdout for JSON-RPC. Any stdout write corrupts the communication channel. Use `createLogger(ctx)` from `./logger.js` for all diagnostics — it writes structured JSON to stderr only.
2. **Never edit `mcp-server/dist/`.** It is compiled output. Edit sources in `mcp-server/src/` and rebuild.
3. **TypeScript strict mode.** `tsconfig.json` enables `strict: true`. All code must pass strict type checking.
4. **NodeNext module resolution.** Use `.js` extensions in all relative imports (e.g., `import { foo } from "./bar.js"`), even when the source file is `.ts`.
5. **ESM only.** `"type": "module"` in `package.json`. No CommonJS `require()`.
6. **Never write directly to `.pi-flywheel/checkpoint.json`.** Use `flywheel_*` MCP tools for state management.
7. **All `exec` calls must include a `timeout`.** No open-ended shell commands.
8. **Propagate `signal` through `exec` calls.** When the calling function receives an `AbortSignal`, pass it to every `exec()` call: `exec(cmd, args, { timeout, cwd, signal })`. The `ExecFn` type (from `exec.ts`) accepts `signal?: AbortSignal`.

## Key File Paths

- `mcp-server/src/` — TypeScript source (edit here)
- `mcp-server/dist/` — compiled output (never edit)
- `.pi-flywheel/` — runtime state directory
- `skills/` — skill `.md` files injected into agent system prompts
- `commands/*.md` — natural language flywheel commands
- `docs/plans/` — plan artifacts from deep-plan sessions

## Available CLI Tools

- **`br`** — bead tracker CLI: create, list, update status, approve beads.
- **`bv`** — bead visualizer: renders bead status dashboards, dependency graphs.
- **`ccc`** — optional codebase indexing/search tool. Not required; the system falls back gracefully if unavailable.
- **`npm run bead-viewer`** — (v3.7.0+) read-only browser-based bead-graph visualizer with cycle highlighting + click-to-detail. Hard-bound to `127.0.0.1`. Serves `br list --json` + `br dep list --json` as a Cytoscape graph. Use when `bv` terminal output is hard to scan (>50 nodes).

## MCP tools added in v3.7.0

- **`flywheel_remediate({ checkName, autoConfirm?, mode? })`** — applies the canonical fix for a failing doctor check. Default mode is `dry_run`; pass `mode: 'execute'` + `autoConfirm: true` to actually mutate. Per-check mutex prevents concurrent calls. Five handlers ship: `dist_drift`, `mcp_connectivity`, `agent_mail_liveness`, `orphaned_worktrees`, `checkpoint_validity`. Other doctor checks return `remediation_unavailable` (manual hint surfaced by SKILL.md). Result envelope includes `verifiedGreen: boolean` (re-runs the original probe after apply).
- **`flywheel_calibrate({ cwd, sinceDays? })`** — aggregates `br list --json --status closed` rows by template, computes mean/median/p95 actual vs `EFFORT_TO_MINUTES[template.estimatedEffort]`. Prefers `git log --grep=<bead-id>` first-commit ts as `started_ts` proxy (capped 200/run). Drops clock-skew samples. Writes report to `.pi-flywheel/calibration.json`. **Note (v3.7.0):** `br create` doesn't yet tag beads with their template id, so the report is currently `__untemplated__`-only. See `claude-orchestrator-1v5` for the fix.
- **`flywheel_get_skill({ name: "<plugin>:<skill>" })`** — serves a bundled skill markdown body in one MCP call. Bundle at `mcp-server/dist/skills.bundle.json` (built by `npm run build`). 4-layer drift defense: build-time `check:skills-bundle` CI gate, runtime `manifestSha256` integrity check (falls back to disk on mismatch), per-entry `srcSha256` stale-warn, `FW_SKILL_BUNDLE=off` env-bypass for contributors editing skills live. Returns `{ name, frontmatter, body, source: 'bundle' | 'disk', staleWarn? }`.

## NTM is mandatory for all spawned work

**Hard rule.** Every multi-agent spawn — planning fan-out, swarm waves, deslop sweeps, reality-check follow-ups, scrutiny passes, parallel reviewers, ad-hoc "do these N things in parallel" requests — **must go through NTM** (`ntm spawn` + `ntm --robot-send`). No exceptions.

**What is forbidden as a substitute for NTM:**
- Raw `Task`/`Agent` tool calls to fan out implementation work onto multiple Claude subagents.
- Backgrounded `claude --print` / `codex` / `pi` / `gemini` shells launched with `&` or `run_in_background`.
- `tmux new-window` / `tmux split-window` invoked directly (NTM owns pane lifecycle, robot-send addressing, stagger, and stuck-pane recovery).
- Spawning agents through any other orchestrator (custom shell loops, Makefile parallel targets, `xargs -P`, GNU `parallel`) for work that produces code or PRs.

**Why:** NTM provides the canonical pane registry, robot-send addressing (`--type=cc|pi|cod|gem`), Agent Mail integration, stuck-pane detection, stagger to avoid cold-boot thundering herd, and the `--no-user` discipline. Bypassing it loses observability, breaks file-reservation handshakes, and produces work the flywheel cannot track or recover.

**Allowed exceptions (narrow):**
- Single-shot research / read-only Q&A subagents that produce no code and no PRs (e.g. `Explore`, `general-purpose` for one-off lookups). These can use the `Task`/`Agent` tool directly.
- Single foreground `Bash` invocations that complete in-band (linter, test, build).
- Codex-rescue / triangulation calls where the codex skill's contract explicitly handles the dispatch.

If you find yourself wanting to spawn N>1 coding workers without NTM, stop and load `/ntm` + `/vibing-with-ntm` first. Reviewers: reject PRs whose skill changes introduce non-NTM fan-out for implementation work.

## NTM pane priority

When spawning NTM panes for the swarm (planning, implement, deslop, etc.), **prefer `--pi=` (and `--type=pi` for `--robot-send`) over `--cod=` / `--type=cod`**. Pi is the default secondary lane after Claude (`cc`); Codex (`cod`) is only a fallback when Pi is unavailable on the host (no Pi CLI, quota exhausted, or the workflow explicitly demands Codex).

**Gemini → Pi fallback.** Pi was added to NTM (see [ntm@3f1c23b](https://github.com/burningportra/ntm/commit/3f1c23b61230f98197950335643be7525cf248e5)) as the designated substitute when Gemini is unavailable. When the model-diversified split (`cc:pi:gem` 1:1:1) detects that Gemini is missing/quota-exhausted, **reassign Gemini's share to Pi (`--pi=`) before redistributing to Claude or Codex**. Order of substitution for a missing Gemini lane: Pi → Codex → Claude.

Applies to every `ntm spawn` and `ntm --robot-send` invocation in this plugin's skills (`skills/start/_planning.md`, `skills/start/_implement.md`, `skills/start/_deslop.md`, and any future swarm/orchestrator skill). Reviewers: reject PRs that reintroduce `--cod=` / `--type=cod` as the default without a documented Pi-unavailable justification, or that redistribute a missing Gemini lane to anything other than Pi first.

## Bead Lifecycle

After running an implementation, ALWAYS close the bead and verify the close took effect:

```
br update <bead-id> --status closed
br show <bead-id> --json   # confirm "status": "closed"
```

If the second call shows anything else, retry the update once before reporting completion. The agent-flywheel coordinator additionally calls `flywheel_verify_beads` after each wave to auto-close stragglers that have a matching commit (`git log --grep=<bead-id> -1`), so a missed close is recoverable but not free — verify locally first.

`flywheel_review` reconciles the bead state automatically: `looks-good` is idempotent on already-closed beads, `hit-me` runs a post-close audit, and `skip` returns `already_closed`. Do not skip `flywheel_review` for closed beads — the legacy "spawn reviewers from `git diff <sha>~1 <sha>`" workaround is no longer required.

## Agent Coordination

- Bootstrap your agent-mail session with `macro_start_session` at the start of each task.
- Before modifying any file, request a file reservation via agent-mail.
- Report errors to the team lead via agent-mail with subject `[error] <context>`. Do not silently skip tasks.
- Check your agent-mail inbox at task start for updates or cancellations.

### Known issue: agent-mail exclusive-reservation enforcement is advisory

`file_reservation_paths(... exclusive=true)` does **not** reject overlapping requests at the server level. When two agents request exclusive reservations on the same path, the second request returns a response with **both** a populated `granted` array (a fresh reservation id with `exclusive: true`) **and** a populated `conflicts` array naming the existing holder. The server tells you about the conflict but issues the reservation anyway. Reproduced 2026-04-27 against agent-mail running at `http://127.0.0.1:8765/mcp` (bead `agent-flywheel-plugin-j0b`).

**Coordinator-side mitigation, mandatory for now:**

1. After any `file_reservation_paths` call, inspect the response: if `conflicts` is non-empty, **treat the request as failed even if `granted` is also non-empty**. Do not edit the file. Either wait for the existing TTL to expire, coordinate with the holder via `send_message`, or pick a different file.
2. The pre-commit guard (`/Users/kevtrinh/.mcp_agent_mail_git_mailbox_repo/projects/<slug>/.git/hooks/pre-commit`, installed via `install_precommit_guard`) is the second line of defense — it blocks commits that touch a path reserved by another agent. Do not bypass it.
3. Round-1 of the 2026-04-26 reality-check session showed two agents (RoseFalcon + StormyAnchor) holding exclusive reservations on `mcp-server/scripts/lint-skill.ts` simultaneously. No actual write-conflict materialised that session, but the latent risk is real.

This is a server-side bug in mcp-agent-mail; the upstream fix should make the second exclusive request return `granted: []` with the existing holder in `conflicts`. Until that lands, the conflict-checking discipline above is load-bearing.

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

1. Ensure the agent-mail server is running. The flywheel targets the **Rust port** ([`mcp_agent_mail_rust`](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)) as the primary distribution; start it with `am serve-http` (or `mcp-agent-mail serve` if `am` is not on PATH). Legacy Python fallback: `uv run python -m mcp_agent_mail.cli serve-http` (works because both speak the same HTTP MCP protocol on port 8765).
2. Verify port 8765 is listening: `lsof -i :8765`
3. Test the endpoint: `curl -s http://127.0.0.1:8765/mcp` (also: `curl -s http://127.0.0.1:8765/health/liveness` should return `{"status":"alive"}`).

### Programmatic Health Check

`checkAgentMailHealth()` (exported from `mcp-server/src/agent-mail.ts`) sends a lightweight HEAD request to `http://127.0.0.1:8765/mcp` with a 3-second timeout. It returns:

- `{ reachable: true, transport: "http" }` on success.
- `{ reachable: false, error: "..." }` with an actionable message on failure.

The result is cached for the session on success. On failure, the cache expires after **30 seconds** and triggers a re-check (so a briefly-unreachable server is retried automatically). This function does not block operations that do not need agent-mail; callers decide how to handle an unreachable result.

## Code Conventions

- Named exports only (no default exports).
- Types live in `mcp-server/src/types.ts`. Import with `import type { ... }`.
- `ExecFn` type (`mcp-server/src/exec.ts`) wraps all shell command execution. It accepts `{ timeout, cwd, signal? }` — always pass `signal` when available. Import `ExecFn` only from `exec.ts`; do not redefine it locally.
- Errors: by default, throw `new Error(message)` and return structured envelopes at tool boundaries via `makeFlywheelErrorResult` from `mcp-server/src/errors.ts`. The one permitted custom error class is **`FlywheelError`** (also in `errors.ts`) — it is framework-internal, threads tagged error codes through nested helpers back to the tool boundary, and MUST NOT be subclassed. Do not introduce ad-hoc error classes in feature code.
- Use `FlywheelError` when a tagged error must propagate through 4+ call frames before reaching the tool-return boundary (e.g., deep in `deep-plan.ts` synthesis). For top-level tool handlers in `mcp-server/src/tools/*.ts`, use `return makeFlywheelErrorResult(...)` — it builds the structured envelope the SKILL.md orchestrator branches on via `data.error.code`.
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

## Tool name deprecation

The MCP tools were renamed from `orch_*` to `flywheel_*`. The `orch_*` names are preserved as deprecated aliases that dispatch to the same runners, and will be removed in v4.0. Always use the `flywheel_*` names in new code and docs.

## SKILL.md linting

Changes to `skills/start/SKILL.md` (and any future SKILL.md files) must pass `npm run lint:skill` from `mcp-server/`. The linter validates AskUserQuestion call sites, slash-skill references, placeholder definitions, and Universal Rule 1 enforcement.

- Local: `cd mcp-server && npm run lint:skill`
- Auto-fix safe issues (future): `npm run lint:skill -- --fix` (deferred to v1.1)
- Update baseline after curating findings: `npm run lint:skill:update-baseline`
- Update skill manifest after adding/removing skills: `npm run lint:skill:update-manifest`

CI enforces this on every PR via `.github/workflows/ci.yml` (`lint-skill` job). The job runs `node dist/scripts/lint-skill.js --ci --baseline` and emits PR annotations via the `gha` reporter format.
