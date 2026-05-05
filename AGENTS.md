# AGENTS.md

Guidance for sub-agents working in this repository.

## Project Overview

agent-flywheel is an MCP server that drives a multi-phase development workflow: scan, discover, plan, implement, review. The MCP server runs over stdio (JSON-RPC) from `mcp-server/src/server.ts`.

## High-stakes track (dueling-idea-wizards integration)

The flywheel has a **standard track** (single-agent at every phase) and a **high-stakes track** that surfaces adversarial cross-scoring at four seams. Both tracks share the same checkpoint state, beads, and downstream tools — only the generator changes.

The duel is one extra row in the menus the user already sees when running `/agent-flywheel:start`. No CLI flags to remember.

| Seam              | Standard generator                  | Duel-track replacement                                     | Trigger                                                |
|-------------------|-------------------------------------|------------------------------------------------------------|--------------------------------------------------------|
| Step 3 Discover   | `flywheel_discover` / `/idea-wizard`| `/dueling-idea-wizards --mode=ideas`                       | "Duel" row in the discovery-depth menu                 |
| Step 5 Plan       | `flywheel_plan(mode=standard\|deep)`| `flywheel_plan(mode=duel)` → `--mode=architecture`         | "Duel plan" row in the plan-mode menu                  |
| Reality-check     | single-agent gap report             | `--duel` → `--mode=reliability --focus=vision-vs-code drift`| "Duel reality-check" row in `/flywheel-reality-check`  |
| Step 9 Review     | 5-agent fresh-eyes                  | 2-agent `--mode=security\|reliability`                     | Auto-routed for risky beads (p0, security path, etc.)  |

Plus a direct entry point: `/agent-flywheel:flywheel-duel` (state-aware — picks `--mode` from the current phase, routes artifacts into the right `docs/` folder, and chains into `flywheel_discover` / `flywheel_plan` / per-bead review automatically).

**Pre-conditions for any duel.** ntm + ≥2 of {cc, cod, gmi} must be healthy. The doctor's `ntm_binary`, `claude_cli`, `codex_cli`, `gemini_cli`, and `swarm_model_ratio` checks together cover this. Cost: ~20–55 min per run.

**Bead provenance.** Every bead created from a duel-sourced idea or duel-generated plan carries a `## Provenance` block (template in `skills/start/_beads.md` Step 5.5) listing source mode, agent cross-scores (0–1000), the strongest surviving critique that survived the reveal phase, and (if Phase 6.75 ran) a steelman one-liner. Downstream implementers and reviewers inherit the adversarial context without extra prompting — this is the highest-leverage piece of the integration.

**Artifacts.** Duel transcripts (`WIZARD_IDEAS_*.md`, `WIZARD_SCORES_*.md`, `WIZARD_REACTIONS_*.md`, `DUELING_WIZARDS_REPORT.md`) live in the project root by default; the flywheel routes the synthesis report into `docs/discovery/`, `docs/plans/`, `docs/duels/`, or `docs/reviews/` based on phase. `flywheel-cleanup` flags WIZARD_*.md older than 7 days; never auto-deletes — these are the irreplaceable adversarial-debate record.

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

### Fast path for skill bodies (PRIMARY)

When loading any flywheel skill — entry-point (`/start`) or sub-phase (`_planning.md`, `_implement.md`, etc.) — **prefer `flywheel_get_skill` over `Read`**. Single MCP round-trip, served from the bundled body, ~10× less context noise than `Read` (no directory listing, no path resolution).

**Skill-stub recovery.** If invoking the `Skill` tool returns only the frontmatter / pointer text instead of the canonical body (the harness sometimes ack's "skill already loaded — follow it directly" instead of inlining for re-invocations), **do NOT fall back to `Read`**. Call `flywheel_get_skill({ name: "agent-flywheel:<skill>" })` instead. Examples:

- `/start` returned a stub → `flywheel_get_skill({ name: "agent-flywheel:start" })`
- Phase boundary needs `_planning.md` → `flywheel_get_skill({ name: "agent-flywheel:start_planning" })`
- Same for `start_beads`, `start_implement`, `start_review`, `start_wrapup`, `start_reality_check`, `start_deslop`, `start_saturation`, `start_inflight_prompt`.

`Read` is the disk-fallback path — only use it if the MCP call errors (bundle disabled via `FW_SKILL_BUNDLE=off`, transport down, or skill not in bundle).

## MCP tools added in v3.11.0

The 2026-04-30 3-way duel cohort (`docs/duels/2026-04-30.md`, plan `docs/plans/2026-04-30-duel-winners.md`) shipped a runtime-safety + recovery substrate built around three composable features.

- **`flywheel_observe({ cwd })`** — single-call session-state snapshot. Versioned `FlywheelObserveReport` covering `cwd`, `git.{branch, head, dirty, untracked[]}`, `checkpoint.{exists, phase?, selectedGoal?, planDocument?, activeBeadIds[]?, warnings[]}`, `beads.{initialized, counts, ready[]}`, `agentMail.{reachable, unreadCount?, warning?}`, `ntm.{available, panes[]?, warning?}`, `artifacts.{wizard[], flywheelScratch[]}`, and `hints[]` with `severity: info|warn|red`. Idempotent and non-mutating; doctor probes are cached or short-budgeted (<1.5s total tool runtime); every external probe degrades gracefully (sub-section flagged `unavailable: true` rather than failing the whole call). Hint surface includes missing or invalid completion attestations from the Stage 1 ledger so a forgotten dogfood file is visible at the next `/start` rather than silently rotting.
- **Completion Evidence Attestation (Stage 1).** New module `mcp-server/src/completion-report.ts` exports `CompletionReportSchemaV1` (Zod, `version: 1` additive forever), `readCompletionReport(cwd, beadId)`, `validateCompletionReport(report, bead, { cwd? })`, `formatCompletionEvidenceSummary(report)`, and `writeCompletionReport(cwd, report)`. `flywheel_verify_beads` reads `.pi-flywheel/completion/<beadId>.json` for every closed bead and surfaces `missingEvidence[]` / `invalidEvidence[]`. `flywheel_advance_wave` is the gate — Stage 1 default is warn-only (`needsEvidence: true` on the outcome); set `FW_ATTESTATION_REQUIRED=1` to flip to hard-block returning `attestation_missing` / `attestation_invalid` (2 new structured error codes). Implementor prompts in `skills/flywheel-swarm/SKILL.md`, `skills/start/_implement.md`, and `commands/flywheel-swarm.md` carry a worked JSON example.
- **Lock-aware reservation helper + `RESERVE001` lint rule.** New module `mcp-server/src/agent-mail-helpers.ts` exports `reserveOrFail(paths, opts)` and `releaseReservations(reservationIds)`. `reserveOrFail` wraps `agentMailRPC("file_reservation_paths", ...)` and treats any non-empty `conflicts` array as failure even when `granted` is also populated, with one exponential-backoff retry. New lint rule `mcp-server/src/lint/rules/reserve001.ts` flags raw `agentMailRPC("file_reservation_paths")` call sites outside the helper module; the existing single use in `agent-mail.ts:228` is baselined; new offenders fail CI.

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

When spawning NTM panes for the swarm (planning, implement, deslop, etc.), **prefer `--cod=` (and `--type=cod` for `--robot-send`) over `--pi=` / `--type=pi`**. Codex (`cod`) is the default secondary lane after Claude (`cc`); Pi (`pi`) is only a fallback when Codex is unavailable on the host (no Codex CLI, quota exhausted, or the workflow explicitly demands Pi).

**Gemini → Codex fallback.** When the model-diversified split (`cc:cod:gem` 1:1:1) detects that Gemini is missing/quota-exhausted, **reassign Gemini's share to Codex (`--cod=`) before redistributing to Claude or Pi**. Order of substitution for a missing Gemini lane: Codex → Pi → Claude.

Applies to every `ntm spawn` and `ntm --robot-send` invocation in this plugin's skills (`skills/start/_planning.md`, `skills/start/_implement.md`, `skills/start/_deslop.md`, and any future swarm/orchestrator skill). Reviewers: reject PRs that reintroduce `--pi=` / `--type=pi` as the default without a documented Codex-unavailable justification, or that redistribute a missing Gemini lane to anything other than Codex first.

## Bead Lifecycle

After running an implementation, ALWAYS close the bead and verify the close took effect:

```
br update <bead-id> --status closed
br show <bead-id> --json   # confirm "status": "closed"
```

If the second call shows anything else, retry the update once before reporting completion. The agent-flywheel coordinator additionally calls `flywheel_verify_beads` after each wave to auto-close stragglers that have a matching commit (`git log --grep=<bead-id> -1`), so a missed close is recoverable but not free — verify locally first.

`flywheel_review` reconciles the bead state automatically: `looks-good` is idempotent on already-closed beads, `hit-me` runs a post-close audit, and `skip` returns `already_closed`. Do not skip `flywheel_review` for closed beads — the legacy "spawn reviewers from `git diff <sha>~1 <sha>`" workaround is no longer required.

## Pre-Completion Quality Gate (MANDATORY for every spawned implementor)

Before any swarm/NTM agent reports a bead complete (or sends its completion message), it MUST execute, in order:

1. **UBS scan on changed files.** Invoke the `/ubs-workflow` skill in changed-files mode (not full-repo). Every finding must be fixed, filed as a new bead with rationale, or explicitly justified in the completion message. Silently dropping UBS findings is a review-bounce condition.
2. **Repo verify commands.** Run the build/test/typecheck/lint commands relevant to the surfaces touched, per this file's specific rules. If a remote-execution helper (e.g. `rch`) is the canonical path, use it — do not skip with "looks fine locally".
3. **Self-review with fresh eyes.** Re-read your own diff for regressions, unsafe assumptions, missing tests, and edge cases. Fix before sending the completion message.

The completion message itself must include: (a) UBS result summary (`clean` / `fixed N` / `deferred to bead ids …`), (b) verify command outcome (or the helper handle), (c) one-line self-review summary. Coordinator and `flywheel_review` reject completions missing this evidence.

This rule is binding on every NTM-spawned implementor (swarm waves, deslop sweeps, reality-check follow-ups, parallel "do these N things" requests) and is the canonical contract for `skills/flywheel-swarm/SKILL.md`'s marching-orders payload. Do not weaken it inline; if a specific bead truly cannot run UBS or verify (e.g. docs-only diff), say so explicitly in the completion message instead of skipping silently.

### Completion Evidence Attestation (v3.11.0+)

Prose evidence in the completion message is necessary but no longer sufficient. Every implementor MUST also write a versioned `CompletionReport` JSON file to `.pi-flywheel/completion/<beadId>.json` matching `CompletionReportSchemaV1` in `mcp-server/src/completion-report.ts`. This is the durable ledger entry the coordinator reads and gates on:

- `flywheel_verify_beads` reads each closed bead's report and surfaces `missingEvidence[]` / `invalidEvidence[]` in its structured response.
- `flywheel_advance_wave` is the gate. **Stage 1 (default) is warn-only** — it sets `needsEvidence: true` on the outcome, surfaces the count in human text, and still advances. Set `FW_ATTESTATION_REQUIRED=1` in the coordinator's environment to flip to hard-block, returning the structured error code `attestation_missing` or `attestation_invalid` with `error.hint` populated. The default flips to required in a future release once the corpus stabilises.

The schema is `version: 1` and **additive forever** — never remove keys; new fields must be optional. Required shape: `version`, `beadId`, `agentName`, `status` (`closed|blocked|partial`), `changedFiles[]`, `commits[]`, `ubs.{ran, summary, findingsFixed, deferredBeadIds[], skippedReason?}`, `verify[].{command, exitCode, summary}`, `selfReview.{ran, summary}`, `beadClosedVerified`, `createdAt` (ISO-8601). Optional: `paneName`, `reservationsReleased`, `ubs.skippedReason`. Status `closed` requires `beadClosedVerified=true`. `changedFiles` rejects absolute paths and `..`-traversal at the schema layer; `validateCompletionReport(report, bead, { cwd })` adds a path-resolve check as defense-in-depth.

Docs-only diffs: set `ubs.ran=false` with a non-empty `ubs.skippedReason` ("docs-only diff", etc.). Do not silently skip. Implementor prompts in `skills/flywheel-swarm/SKILL.md`, `skills/start/_implement.md`, and `commands/flywheel-swarm.md` carry a worked JSON example — copy that shape rather than improvising.

`flywheel_observe.hints[]` surfaces missing/stale attestation files during session recovery (severity `warn` for missing, `red` for invalid), so a forgotten attestation shows up at the next `/start` rather than silently rotting.

## Agent Coordination

- Bootstrap your agent-mail session with `macro_start_session` at the start of each task.
- Before modifying any file, request a file reservation via agent-mail.
- Report errors to the team lead via agent-mail with subject `[error] <context>`. Do not silently skip tasks.
- Check your agent-mail inbox at task start for updates or cancellations.

### Known issue: agent-mail exclusive-reservation enforcement is advisory

`file_reservation_paths(... exclusive=true)` does **not** reject overlapping requests at the server level. When two agents request exclusive reservations on the same path, the second request returns a response with **both** a populated `granted` array (a fresh reservation id with `exclusive: true`) **and** a populated `conflicts` array naming the existing holder. The server tells you about the conflict but issues the reservation anyway. Reproduced 2026-04-27 against agent-mail running at `http://127.0.0.1:8765/mcp` (bead `agent-flywheel-plugin-j0b`).

**Coordinator-side mitigation, mandatory for now:**

1. **Use `reserveOrFail()` from `mcp-server/src/agent-mail-helpers.ts`** (v3.11.0+). This helper wraps `agentMailRPC("file_reservation_paths", ...)` and treats any non-empty `conflicts` array as failure even when `granted` is also populated, with one exponential-backoff retry before failing. **Do not call `agentMailRPC("file_reservation_paths", ...)` directly** — the `RESERVE001` lint rule (`mcp-server/src/lint/rules/reserve001.ts`) flags raw call sites and the existing single use in `mcp-server/src/agent-mail.ts:228` is baselined; new offenders fail CI. Use `releaseReservations(reservationIds)` for the symmetric release.
2. The pre-commit guard (`/Users/kevtrinh/.mcp_agent_mail_git_mailbox_repo/projects/<slug>/.git/hooks/pre-commit`, installed via `install_precommit_guard`) is the second line of defense — it blocks commits that touch a path reserved by another agent. Do not bypass it.
3. Round-1 of the 2026-04-26 reality-check session showed two agents (RoseFalcon + StormyAnchor) holding exclusive reservations on `mcp-server/scripts/lint-skill.ts` simultaneously. No actual write-conflict materialised that session, but the latent risk is real — the `reserveOrFail()` mitigation above is what closes it from the coordinator side.

This is a server-side bug in mcp-agent-mail; the upstream fix should make the second exclusive request return `granted: []` with the existing holder in `conflicts`. Until that lands, the helper-routed discipline above is load-bearing.

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

### Mutating `am doctor` maintenance and mailbox activity locks

The Rust `am serve-http` runtime intentionally holds `.mailbox.activity.lock` and `storage.sqlite3.activity.lock` for the lifetime of the server. If you run mutating `am doctor` operations while the service is active, you may see:

```
Resource is temporarily busy ... mailbox activity lock is busy ... another Agent Mail runtime or mutating `am doctor` operation is already active
```

Do **not** delete the lock files. Stop the owning service/runtime first, run maintenance, then restart it. The canonical flywheel path is:

```
flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })
```

That remediation stops launchd/systemd/best-effort runtimes, runs `am doctor repair --yes` and `am doctor archive-normalize --yes`, restarts Agent Mail, and verifies `/health/liveness`. NTM swarm agents must not run mutating `am doctor` commands directly; they should report Agent Mail health issues to the coordinator.

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
