# Implementation Plan — Robustness Lens: AGY Mirror Plugin, July 2026 Guide Gaps, Deep pstack Integration

**Date:** 2026-10-21
**Goal slug:** `create-an-antigravity-agy-mirror-plugin-close-all-july-2026-`
**Lens:** ROBUSTNESS — performance, scalability, retry logic, timeouts, graceful degradation, observability
**Surfaces in scope:** `mcp-server/src/`, `skills/`, `scripts/sync-agy.sh` (+ `scripts/agy/sync.mjs`), `agy/manifest.json`
**Source brief:** `.pi-flywheel/plans/create-an-antigravity-agy-mirror-plugin-close-all-july-2026-/planner-brief.md`
**Upstream raw material:** cloned `pstack` tree at `~/.gemini/antigravity-cli/brain/3fad1e87-…/scratch/pstack_repo/pstack/` (23 playbooks in `skills/poteto-mode/playbooks/`, 24 `principle-*` skills, 50+ skills total, `skills/poteto-mode/scripts/check-plan.mjs`, `skills/poteto-mode/scripts/orch/orch.ts` + `orch.test.ts`, `agents/comment-sicko.md`), the 2,082-line Complete Flywheel Guide, and the AGY native plugin spec.

---

## Executive summary

This work adds a third harness (Antigravity/`agy`), a fourth swarm lane (`--agy`), a new model family (`xai/grok-4.7`), roughly 47 new bundled skills (23 pstack playbooks + 24 principles), a SHA-keyed verification ledger, an append-only decision trail, and several restored review gates — to a system whose correctness already depends on fragile external processes: `ntm`/`tmux`, `br` (SQLite), Agent Mail (HTTP on :8765), SSH to an offload Mac, the Vercel AI Gateway catalog, and four vendor CLIs. Every one of those dependencies fails in production today, and the codebase survives because it has a consistent, already-proven robustness vocabulary:

- `mcp-server/src/exec.ts` — raw spawn with caller-supplied `timeout` + `AbortSignal` (AGENTS.md Hard Constraints 7–8: every `exec` has a timeout, every `signal` propagates).
- `mcp-server/src/cli-exec.ts` — `resilientExec`: structured `CliExecError`, transient classification (`isTransientBrError`, DB-busy/locked, timeout, signal-kill), bounded retries (default 2 attempts, 500 ms delay, abort-aware sleeps), telemetry hook.
- `mcp-server/src/pi-models.ts` — the gold standard for probing an unreliable external catalog: 90 s total probe budget (`PROBE_BUDGET_MS`), 60 s per-probe timeout, 4-way concurrency, 1 h gateway-catalog cache / 1 d route-probe cache, stale-cache fallback with `source.stale: true`, unknown-on-timeout (never cached as failure).
- `mcp-server/src/tools/doctor.ts` — `runDoctorChecks` with `perCheckTimeoutMs`, `totalBudgetMs`, a `Semaphore` capping concurrency, and graceful per-check degradation (`unavailable: true` sub-sections instead of whole-call failure).
- `mcp-server/src/swarm-host.ts` — SSH exec with per-call timeout +8 s, `ControlMaster=auto` (120 s persist), exactly two retries on exit 255 with connection-dropped stderr, recorded-address fallback when mDNS drops.
- `mcp-server/src/atomic-write.ts` + `scripts/opencode/sync.mjs` — stage → validate → `rename` into place, SHA-256 ownership ledger, `[LOCAL]` divergence detection, `neverOwn` lists. A failed OpenCode sync aborts before any rename; it never leaves a half-written tree.
- `mcp-server/src/skills-bundle.ts` — manifest `manifestSha256` integrity check, per-entry `srcSha256` stale-warn, disk fallback, `FW_SKILL_BUNDLE=off` bypass. The bundle fails *open to disk*, never closed.
- `mcp-server/src/telemetry.ts` — global ring buffer (100 events, not per-code) spooling to `.pi-flywheel/error-counts.json`; `flywheel_observe` surfaces top error codes and missing-attestation hints.
- `mcp-server/src/mutex.ts` + `agent-mail-helpers.ts` (`reserveOrFail`) — per-check remediation mutexes, conflict-as-failure even when `granted` is populated, one exponential-backoff retry.

**The robustness position of this plan is: no new reliability machinery is invented.** Each new surface (AGY sync, `--agy` lane, `agy` model probes, `orch` ledger, `decisions.tsv`, restored gates, `cass`/`rch` integrations, the post-compaction re-read hook) is required to be expressed in the five patterns above, with named timeouts, named retry classes, a named degradation ladder, and a named telemetry/doctor signal. Where the brief's scope would create an unbounded operation — whole-repo Random Exploration, an 80-issue "Lie to Them" mismatch hunt, parallel `arena` fan-out, gateway probing of a new provider — this plan caps it, budgets it, makes it partial-result-tolerant (`Promise.allSettled`, per AGENTS.md Code Conventions), and gives the operator a knob (`FW_*_TIMEOUT_MS`, `FW_*_BUDGET_MS`, lane `disabled: true`) to turn it down or off without a code change.

Three risks dominate and drive the wave ordering:

1. **`sync-agy.sh` writes into `~/.gemini/config/plugins/agent-flywheel/` — a directory another live program (the AGY desktop/CLI) reads.** A torn or partial write there can break the user's AGY install, not just this plugin. This is the highest-blast-radius new code and lands first, behind the OpenCode sync's stage-validate-rename discipline, plus a file lock the OpenCode sync never needed (two flywheel sessions can sync concurrently; AGY can be running while we sync).
2. **The `--agy` lane's failure modes are unknown.** `ntm` 1.36.1 has no `agy` lane (the same reason `swarm-spawn.ts` hand-adds Pi panes via `tmux split-window`); AGY panes will report as tmux type `unknown`, tender them via `tmux capture-pane`/`#{pane_dead}`, and the `agy` CLI's cold-start latency, auth-expiry behaviour, and rate-limit shape on `gemini-4-argon` are unmeasured. The lane must therefore ship *degradation-first*: probe before spawn, substitute down the existing `FALLBACK_PRIORITY` ladder (`gmi→pi→cod→cc` in `adapters/model-diversity.ts`) when the probe fails, and never let a dead AGY pane block a wave.
3. **Load multiplies.** Six-pane swarms already stagger cold boots; adding AGY panes, `arena` parallel candidates, Cross-Agent reviewers, and Random Exploration samplers in the same wave can stampede the gateway (429s), Agent Mail (exclusive-reservation conflicts), and `br`'s SQLite (`database is busy`, already a classified transient). Every new fan-out gets an explicit concurrency cap and a shared deadline, reusing the doctor's `Semaphore` pattern rather than bare `Promise.all`.

Waves are ordered so the observability and budget primitives land before any feature that needs them, and so the three workstreams the brief requires to be parallelisable (`mcp-server` TypeScript, `skills/`, `agy/` sync) touch disjoint files after Wave 0.

---

## Architecture overview

### The reliability contract every new component must satisfy

Each new external interaction is specified in the plan beads below as a five-tuple. A bead that cannot fill in all five is not ready to implement:

| Slot | Question | Existing precedent |
|---|---|---|
| **Deadline** | What is the per-call timeout, the total budget, and the env var that overrides them? | `FW_GRADER_TIMEOUT_MS` (120 s), `FW_RUBRIC_SYNTH_TIMEOUT_MS` (60 s), `PROBE_BUDGET_MS` (90 s) in `pi-models.ts`, doctor `perCheckTimeoutMs`/`totalBudgetMs` |
| **Retry class** | Which failures are transient (retried, how many times, what backoff/jitter), which are permanent (fail fast)? | `isTransientBrError` in `cli-exec.ts`; SSH exit-255 ×2 in `swarm-host.ts`; `reserveOrFail` single retry in `agent-mail-helpers.ts` |
| **Degradation** | When this fails, what does the user still get? Which rung of which ladder? Is `degraded: true` set and a warning surfaced? | `splitBeadsByProvider` substitution ladder; stale gateway cache (`source.stale: true`); bundle→disk fallback; lane `disabled: true` in `flywheel.config.yaml` reporting green in doctor |
| **Observability** | Which `createLogger(ctx)` context, which telemetry error code, which doctor check, which `flywheel_observe` hint? | `createLogger` (stderr only — `console.log` corrupts the MCP stdio channel, Hard Constraint 1); `errors.ts` structured codes with `retryable` flags; 24 existing doctor checks |
| **Bounded load** | What is the concurrency cap, the item cap, the byte cap? What happens at 10× the expected input? | Doctor `Semaphore`; telemetry 100-event global ring; `pi-models` 10-models-per-login cap; `FW_COMMIT_BATCH_THRESHOLD` |

### Component map (new/changed, with their failure domain)

```
                         ┌─────────────────────────────────────────────┐
   repo (source of       │  scripts/sync-agy.sh → scripts/agy/sync.mjs │  writes ~/.gemini/config/plugins/
   truth) ──────────────▶│  agy/manifest.json (ownership ledger)       │  agent-flywheel/ while AGY may be
                         └─────────────────────────────────────────────┘  running → lock + stage + rename

   mcp-server/src/
   ├── adapters/platform/AntigravityAdapter.ts   NEW — HookAdapter for AGY plugin layout
   ├── adapters/platform/detect.ts               PlatformId += 'antigravity'
   ├── adapters/model-diversity.ts               ModelProvider += 'agy'; FALLBACK_PRIORITY extended
   ├── adapters/agy-prompt.ts                    NEW — invoke_subagent/ask_question/define_subagent translation
   ├── swarm-spawn.ts                            --agy panes via tmux split-window (like Pi/gmi panes)
   ├── model-detection.ts                        xai/grok-4.7 tables, pstack role/effort budget matrix
   ├── pi-models.ts (probe engine, reused)       agy route probe: `agy` CLI on gemini-4-argon
   ├── completion-report.ts                      orch ledger verdicts, SHA + git patch-id keying
   ├── gates.ts                                  Random Exploration + Cross-Agent alternation restored
   ├── bead-templates.ts                         hillclimb / runtime-forensics / trace-forensics / bug-fix
   ├── tools/doctor.ts                           + agy_cli, agy_plugin_sync, agy_model_compat, ledger checks
   ├── tools/observe.ts                          + agy sync staleness / ledger hints
   └── decisions log (.pi-flywheel/decisions/<slug>.tsv)  append-only, concurrent-safe

   skills/ (bundled via build-skills-bundle.mjs → flywheel_get_skill)
   ├── 23 pstack playbooks + 24 principles + how/why/sharpen/architect/arena/
   │   create-verification-skill / no-comments / interrogate / blast-radius / unslop / correct
   └── start/_*.md gates: OPERATOR tags, stack-aware validation, rch offload, pcr hook
```

### Cross-cutting design decisions (robustness-specific)

**D1. One deadline helper, no ad-hoc `setTimeout`.** Wave 0 adds `mcp-server/src/deadline.ts` exporting `deadlineFrom(signal, ms)` (composes a caller's `AbortSignal` with a timeout via `AbortSignal.any`, falling back to `AbortSignal.timeout` where already used in `pi-models.ts:887`) and `remainingMs(deadline)`. Every new `exec` call in the AGY/pstack surface takes `{ timeout, cwd, signal }` per Hard Constraint 8. Rationale: today each subsystem hand-rolls timeout composition (`swarm-host` adds 8 s, `pi-models` uses `AbortSignal.timeout`, doctor uses its own budget accounting); three new subsystems copying three different idioms is how a wave ends up with one lane that hangs forever. The helper is ~30 lines, no new dependency.

**D2. Retry only where the operation is idempotent or carries an idempotency key.** Sync writes are idempotent by construction (same source → same SHA → rename is a no-op outcome), so a retry of a *staged* sync step is safe; a retry of the *rename* is guarded by the ledger check. Bead creation from review findings already has the resume-after-last-ID pattern (`state.batchReviewSynthesizedBeads` in `advance-wave.ts`) — the restored gates and `arena` grafting must reuse it, never blind-retry `br create`. LLM/grader spawns are retried only on the existing `grader_timeout`-style transient class, once, because a second full-price run is a cost decision the operator should see.

**D3. All new fan-out is `Promise.allSettled` with a cap and a partial-result contract.** Random Exploration, Cross-Agent review, `arena`, and the mismatch hunt return *what finished within budget* plus an explicit `truncated: { reason: 'budget'|'deadline', dropped: n }` field. This mirrors doctor's "sub-section flagged `unavailable` rather than failing the whole call" and `flywheel_observe`'s degrade-gracefully rule. A fan-out that fails the whole wave because one of eight reviewers timed out is the exact failure this lens exists to prevent.

**D4. Caches are always stale-tolerant, never blocking.** The AGY model listing and `xai/grok-4.7` routing data reuse the `pi-models.ts` two-level cache (`.pi-flywheel/cache/gateway-models.json`, per-scope probe files like the swarm-host `pi-route-probes.<host-slug>.json`). A failed refresh serves the stale snapshot with `source.stale: true`; no cache at all returns `missing_prerequisite` with a hint, matching the existing envelope. Cache writes go through `writeAtomic` so a killed process never leaves a torn JSON that poisons the next session — and the reader must still `safeParse` and treat corrupt cache as absent (precedent: `calibrate-corrupt-cache.test.ts` in the chaos suite).

**D5. Append-only files get append-safe writes and torn-tail recovery.** `decisions.tsv` and the `orch` ledger are written by multiple panes concurrently. Writes are single `appendFile` calls of one complete line/record (POSIX-atomic under `PIPE_BUF`-scale sizes; each record is kept < 2 KB by schema), readers skip a final unterminated/corrupt line rather than failing (precedent: telemetry spool handling, `postmortem-concurrent.test.ts`). No read-modify-write on shared files without the `mutex.ts` lock or `writeAtomic` rename.

**D6. Everything new is observable through doctor + observe + telemetry before it is user-facing.** Each wave adds its doctor check in the same wave as the feature, not after. New error codes are registered in `errors.ts` with correct `retryable` defaults (only timeout-class codes retryable, following the v3.13.0 precedent where only `grader_timeout` was). Log contexts follow `createLogger("<module>")`; nothing writes to stdout.

**D7. Kill switches are configuration, not code.** Every new lane/gate/hook ships with an off switch in the existing config surfaces: `lanes: { agy: false }` in `flywheel.config.yaml` (extending the v3.21.0 `lanes:` mechanism — a switched-off lane reports green with `disabled: true` in doctor and hands its share down the ladder without setting `degraded`), `FW_SKILL_BUNDLE=off`-style env bypasses for the ledger (`FW_ORCH_LEDGER=off`), and `FW_PCR_HOOK=off` for the post-compaction re-read. If AGY misbehaves in the field, the operator disables it in one line and the swarm is back to today's behaviour.

---

## Ordered implementation phases

Beads are numbered `R-<wave>.<n>`. "Files" lists the exact create/modify set; disjoint file sets across beads in the same wave are deliberate, so swarm lanes can reserve files via `reserveOrFail` without conflicts. All TypeScript beads end with `cd mcp-server && npx tsc --noEmit` clean; any bead touching `mcp-server/src/` also runs `npm run build` and commits `dist/` in the same change (dist-drift CI). No bead edits `mcp-server/dist/` directly. No bead uses `console.log`.

---

### Wave 0 — Reliability primitives (blocks everything)

*Goal: the shared deadline/retry/budget vocabulary exists before any feature code needs it. No user-visible behaviour changes.*

#### R-0.1 Deadline + bounded-concurrency helpers
- **Files:** create `mcp-server/src/deadline.ts`; create `mcp-server/src/__tests__/deadline.test.ts`.
- **Spec:** `deadlineFrom(parentSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; remainingMs: () => number; cancel: () => void }` using `AbortSignal.any` when a parent exists; `withConcurrency<T>(items, cap, fn)` — a semaphore-bounded mapper preserving input order, built on the same counting pattern as doctor's internal `Semaphore` (do not export doctor's class; implement the 20-line local version). `cap` is clamped to `[1, 16]`.
- **Verify:** unit tests — parent abort fires child; timeout fires without parent; `remainingMs` monotonic; mapper never exceeds cap under 100 items with randomised delays; mapper propagates abort within one in-flight item.
- **Depends on:** nothing.

#### R-0.2 Env-knob registry entries for the new surface
- **Files:** modify `mcp-server/src/tools/capabilities.ts` (the `flywheel_capabilities` env-var listing referenced by `errors.ts` hints); modify `mcp-server/src/errors.ts` (register new codes, see below).
- **Spec:** document (name, default, purpose) for: `FW_AGY_TIMEOUT_MS` (30 000, per `agy` CLI probe call), `FW_AGY_SPAWN_TIMEOUT_MS` (120 000, pane cold-start wait), `FW_AGY_SYNC_TIMEOUT_MS` (60 000, whole sync run), `FW_ORCH_LEDGER` (`on` default; `off` bypass), `FW_PCR_HOOK` (`on` default), `FW_EXPLORATION_BUDGET_MS` (180 000, Random Exploration + mismatch hunt total), `FW_FANOUT_CONCURRENCY` (4). New error codes in `errors.ts`: `agy_unavailable` (not retryable), `agy_probe_timeout` (retryable — the only retryable AGY code), `agy_sync_diverged` (not retryable; `[LOCAL]` protection tripped), `agy_sync_locked` (retryable after delay), `ledger_invalid` (not retryable), `exploration_budget_exhausted` (not retryable, partial results attached). Each with a `try-this` hint in `errors-try-this.ts` style pointing at the env knob or doctor check.
- **Verify:** `errors.test.ts`-style snapshot that every code has a hint; capabilities listing test if one exists for env vars.
- **Depends on:** nothing (parallel with R-0.1).

#### R-0.3 Telemetry categories for the new surface
- **Files:** modify `mcp-server/src/telemetry.ts` only if a new spool field is required (prefer: none — reuse `recordErrorCode(code, { hashable })` with the R-0.2 codes); otherwise this bead is a test-only bead adding `mcp-server/src/__tests__/chaos/telemetry-agy-codes.test.ts` proving the new codes round-trip through the 100-event ring without evicting unrelated codes under a 500-event burst.
- **Spec:** confirm the global ring cap evicts from the largest bucket (existing v3.4.1 behaviour) so an AGY failure storm cannot flush the session's other error history; if it can, cap per-code ring entries at 20.
- **Depends on:** R-0.2.

---

### Wave 1 — AGY mirror sync (highest blast radius; lands before the lane that depends on it)

*Goal: `agy/manifest.json` + `scripts/sync-agy.sh` emit `~/.gemini/config/plugins/agent-flywheel/` with OpenCode-grade safety, plus the `[LOCAL]` and `--check` contracts. Workstream C (`agy/`, `scripts/`) — disjoint from Waves 2–4 TypeScript except R-1.4.*

#### R-1.1 `agy/manifest.json` — ownership ledger
- **Files:** create `agy/manifest.json`; create `agy/plugin.json` template and `agy/` source tree skeleton (skills/commands/plugin template dirs the manifest enumerates).
- **Spec:** mirror `opencode/manifest.json` shape: `version: 1`, `kind: "antigravity-port-manifest"`, `repoSourceOfTruth: true`, dynamic inventory cross-check (declared `skills[]`/`commands[]` vs live tree; a new managed dir not in the manifest fails `inventory_unclassified`, a removed source fails `inventory_missing` — do not hardcode counts), `ownership.neverOwn` listing the AGY config parents (`plugins`, `plugins/`, the user's other plugin dirs, `~/.gemini/config` itself). Target root is exactly `~/.gemini/config/plugins/agent-flywheel/`; every target path in the manifest is validated to resolve inside that root (reuse the path-safety approach of `mcp-server/src/utils/fs-safety.ts` / `resolveRealpathWithinRoot` — reject `..`, absolute escapes, and symlinked parents).
- **Verify:** `node scripts/agy/sync.mjs --check` against a fixture tree (R-1.3) rejects a manifest entry with `../` escape and a symlinked target parent.
- **Depends on:** nothing in Wave 0 (pure data), but implement after R-1.3's validator exists to be testable; order within wave: R-1.3 validator first in practice.

#### R-1.2 `scripts/agy/sync.mjs` — stage, validate, lock, rename
- **Files:** create `scripts/agy/sync.mjs` (the Node helper; ~600–800 lines modelled on `scripts/opencode/sync.mjs` structure: `collectArtifactSpecs`, `validateOrThrow`, `atomicReplaceFromStage`, `sha256Hex` ledger); create `scripts/sync-agy.sh` (thin wrapper identical in shape to `scripts/sync-opencode.sh`: resolve repo root via `git rev-parse`, require Node 20+, `exec node "$helper" "$@"`).
- **Spec — the sync algorithm, in order:**
  1. **Lock.** Acquire `~/.gemini/config/plugins/agent-flywheel/.flywheel-sync.lock` via `O_EXCL` create containing PID + ISO timestamp. If held by a live PID, exit with `agy_sync_locked` (printed to stderr, exit code 3) — never wait indefinitely; `--wait <s>` optional flag polls at 250 ms up to the given bound. A lock older than 10 min with a dead PID is stale: steal it and log the steal to stderr. Lock is released in a `finally`; a `SIGINT`/`SIGTERM` handler releases it too.
  2. **Stage.** Render every manifest item into a fresh `mkdtemp` staging dir *on the same filesystem as the target* (stage under `~/.gemini/config/plugins/.flywheel-stage-*`, not `$TMPDIR` — cross-device `rename` is not atomic and fails with `EXDEV`). Harness translation (tool-name mapping `invoke_subagent` / `ask_question` / `define_subagent`, per brief) happens here, in staging, never in place.
  3. **Validate the stage** with the R-1.3 validator before any rename (precedent: OpenCode sync comment "BEFORE anything is renamed into place. A failure here aborts without a write."). Validation failure → delete stage, exit non-zero, target untouched.
  4. **Divergence check.** For each item, SHA-256 the live target bytes: match ledger → `OWNED` (safe to replace); absent → `NEW`; mismatch → `[LOCAL]` — **abort the entire sync** with `agy_sync_diverged` listing every diverged path, unless `--force` is passed, in which case each diverged file is first copied to `<path>.flywheel-backup-<ISO timestamp>` (one backup generation only; older backups for the same path are pruned) and the backup paths are printed. Never silently overwrite a `[LOCAL]` file (same contract as the OpenCode port's `[LOCAL]` handling).
  5. **Replace.** Per item, `atomicReplaceFromStage`: rename live → `.previous`, rename staged → live, on failure rename `.previous` back (copy the OpenCode implementation's rollback shape). After all items, write the new ledger (SHA-256 per item) via the same stage+rename so the ledger can never claim ownership of bytes that were not installed.
  6. **Disk-full / interruption safety.** Any `ENOSPC`/`EROFS` during staging aborts before rename. A kill mid-replace leaves at worst one item at `.previous`; the next `--check` run must detect `*.previous` residue and report it as a yellow diagnostic with the restore command, and `--write` must restore-or-replace it before proceeding (idempotent recovery, principle: make operations idempotent).
  7. **`--check` mode** performs steps 2–4 read-only against the live tree (staging in a temp dir that is deleted; no lock acquisition needed for check, but tolerate a held lock by reporting `sync in progress` instead of failing), prints per-item `OWNED|NEW|LOCAL|MISSING` plus a summary line, exit 0 iff no `LOCAL`/`MISSING`. This is the mode CI and the doctor check (R-5.1) call.
  8. **Timeout.** Whole run bounded by `FW_AGY_SYNC_TIMEOUT_MS` via an internal deadline; on expiry, abort before any pending rename, clean the stage, exit 4. Sync of the full manifest (~50 skill dirs) must complete in < 10 s on this machine — it is file copies and hashing only; any network access in sync is a bug.
- **Verify:** R-1.3 tests; manual: run `--write` twice (second run is a no-op reporting all `OWNED`), hand-edit an installed file, `--check` reports `[LOCAL]` and `--write` refuses, `--force` writes a backup then succeeds.
- **Depends on:** R-0.2 (error/exit-code vocabulary), R-1.1, R-1.3.

#### R-1.3 Sync validator + harness-translation unit tests
- **Files:** create `scripts/agy/validate.mjs`, `scripts/agy/transforms.mjs` (tool-name translation), `scripts/agy/__tests__/sync.test.mjs` (or the repo's existing script-test location — follow `mcp-server/src/__tests__/scripts/` precedent if Node's test runner is not already used under `scripts/`; pick whichever the OpenCode sync uses and match it).
- **Spec:** validator checks manifest schema, inventory cross-check, target-root containment, translated output contains no untranslated Claude-only tool names (`AskUserQuestion`, `flywheel_get_skill` raw forms) and no `console.log` in emitted JS. Transforms are pure `string → string` with fixture pairs. Tests cover: path escape rejected; `[LOCAL]` abort leaves target byte-identical; kill-during-stage leaves target untouched; two concurrent `--write` runs — one wins, one exits `agy_sync_locked`, target is the winner's complete tree; corrupt ledger JSON treated as "no ledger" → all items `[LOCAL]`-suspect → abort with hint (fail closed on ownership, open on reading).
- **Depends on:** R-1.1.

#### R-1.4 `AntigravityAdapter` (platform adapter)
- **Files:** create `mcp-server/src/adapters/platform/AntigravityAdapter.ts`; modify `mcp-server/src/adapters/platform/detect.ts` (`PlatformId = 'claude-code' | 'antigravity'`, detection via `AGY_PLUGIN_ROOT`/presence of `~/.gemini/config/plugins`), `mcp-server/src/adapters/platform/index.ts`; create `mcp-server/src/__tests__/adapters/platform/antigravity-adapter.test.ts`.
- **Spec:** implement the existing `HookAdapter` interface (`pluginRoot()`, `installedPluginManifestPath()`, `worktreeScanRoots()`, `validateHooks()`) against the AGY layout. All filesystem probes are synchronous-but-bounded or `stat` with the caller's signal where async; **every method must return a diagnostic, never throw** — a missing/corrupt AGY install is a doctor yellow, not a server crash (precedent: `ClaudeCodeAdapter.validateHooks` returns `DiagnosticResult[]`). `validateHooks` reads the *installed* manifest and compares its version triple against the repo `plugin.json` (skip a side that cannot be located rather than warn, per the existing contract).
- **Verify:** fixture homes: no AGY dir → `missing`; valid install → `installed`; manifest with invalid JSON → diagnostic with hint, no throw.
- **Depends on:** R-1.1 (layout), R-0.1.

---

### Wave 2 — `--agy` lane + model routing (performance- and cost-critical)

*Goal: AGY becomes a first-class swarm lane and `xai/grok-4.7` a first-class routing option, both probe-gated and ladder-degradable. Workstream A (`mcp-server/src/`) — file-disjoint from Wave 1 except `doctor.ts` (Wave 5).*

#### R-2.1 AGY lane capability probe (`detectCliCapabilities` extension)
- **Files:** modify `mcp-server/src/adapters/model-diversity.ts` (`ModelProvider += 'agy'`, `CapabilitiesMap += agy: CliCapability`); modify `mcp-server/src/pi-models.ts` only to export the probe-budget constants if reused (prefer: import `PROBE_BUDGET_MS`-style constants from a shared spot — if extraction is invasive, duplicate the *values* with a comment referencing `pi-models.ts`, do not refactor `pi-models` in this bead).
- **Spec:** probe = `agy --version` (exec, `FW_AGY_TIMEOUT_MS`, signal propagated) + auth readiness (`agy` auth status subcommand or `pi auth check --provider vercel-ai-gateway` when the lane runs `gemini-4-argon` through Pi — match whatever the lane actually spawns in R-2.2, probe exactly that). Probes for all lanes run concurrently under the R-0.1 concurrency cap (4) with a shared 90 s budget copied from `pi-models`; a probe that times out is `available: false, reason: 'probe_timeout'` and is **not cached as permanently unavailable** — cache only successes for 1 h in `.pi-flywheel/cache/agy-route-probes.json` via `writeAtomic`, corrupt cache treated as absent. `lanes: { agy: false }` in `flywheel.config.yaml` → `{ available: false, disabled: true }` without probing (exact v3.21.0 lane-switch semantics). Result feeds `swarmMixFor`/`splitBeadsByProvider`: extend `FALLBACK_PRIORITY` to `agy→gmi→pi→cod→cc` for AGY's share only; a missing AGY never sets out to steal Claude's share, and substitution without `disabled` sets `degraded: true` + a warning string (existing contract).
- **Verify:** fake-`ExecFn` tests: agy absent → ladder substitutes and `degraded`; agy timeout → same, with `agy_probe_timeout` telemetry; `lanes.agy=false` → `disabled: true`, no exec call made; probe cache hit makes zero exec calls.
- **Depends on:** R-0.1, R-0.2.

#### R-2.2 `swarm-spawn.ts` `--agy` panes
- **Files:** modify `mcp-server/src/swarm-spawn.ts` (`SwarmSpawnArgs += agyCount, agyModel`, `SwarmLane += 'agy'`, `parseSwarmSpawnArgs` accepts `--agy=N` and `--agy-model=`); modify `mcp-server/scripts/swarm-spawn.ts` wrapper if it re-declares args (check first; the source of truth is `src/swarm-spawn.ts` per AGENTS.md); create tests in the existing swarm-spawn test file.
- **Spec:** AGY panes are added exactly like Pi/gmi panes — `ntm spawn` creates the session for cc/cod lanes, then `tmux split-window` adds one `agy --model <model>` pane per count, titled `<session>__agy_<n>`, `remain-on-exit on` (ntm has no agy lane; `--agy` on a raw `ntm spawn` must be rejected by the script's arg parser with a clear error — mirror the PANE001 lint stance). Spawn is **staggered** (`--stagger-mode=smart` already handles ntm panes; AGY panes are added sequentially with the pi-pane cadence, not in a burst) and each pane's cold start is awaited with `FW_AGY_SPAWN_TIMEOUT_MS`: poll `tmux capture-pane` for a readiness marker or process liveness at 500 ms intervals. **Partial-spawn contract:** if pane *k* of *n* fails or times out, the result's `errors[]` names it, already-spawned panes stay up (the wave proceeds degraded — the coordinator's dispatch plan from R-2.1 already assigned beads per *available* lane), and the script still exits 1 when any pane failed (existing `SwarmSpawnResult.errors` contract). Never kill the whole session for one dead AGY pane. Pane count is capped at the bead count for the lane (spawning idle panes to satisfy a ratio is waste; `recommendComposition` in `swarm.ts` gets the same cap for agy).
- **Verify:** unit tests on arg parsing + pane-command construction; integration-shaped test with a fake `exec` that fails pane 2 of 3 and asserts panes 1,3 present, `errors` length 1, exit 1. Manual smoke in Wave 5.
- **Depends on:** R-2.1 (the coordinator must know the lane exists before panes are dispatchable), R-0.1.

#### R-2.3 `agy-prompt.ts` adapter (harness translation at dispatch)
- **Files:** create `mcp-server/src/adapters/agy-prompt.ts`; modify `mcp-server/src/adapters/claude-prompt.ts` only to re-export shared prompt fragments if needed (prefer no modify: import from it); tests alongside existing adapter tests.
- **Spec:** `adaptPromptForAgy(prompt, ctx): AdaptedPrompt` translating Claude-harness instructions to AGY primitives: subagent dispatch → `invoke_subagent`, operator questions → `ask_question`, agent definitions → `define_subagent`, Agent Mail steps → `am` CLI commands (AGY panes, like Pi panes under `--no-approve`, load no project MCP servers — copy the `adaptPromptForPi` Agent-Mail-as-CLI approach). The 9-field pstack `ORCH` brief injection (Wave 4, R-4.3) is a parameterised fragment this adapter inserts, not hardcoded text duplicated per adapter. Translation is pure and total: an untranslatable construct degrades to a plain-text instruction plus a `warnings[]` entry — it never throws and never drops a bead's acceptance criteria silently (dropped content is listed in `warnings`, surfaced by the dispatcher).
- **Verify:** golden-fixture tests per translation rule; a test that every `AdaptedPrompt` for agy contains no `AskUserQuestion`/`mcp__` references.
- **Depends on:** R-0.1 (no runtime dep, but keeps prompt work after primitives), parallel with R-2.2.

#### R-2.4 `xai/grok-4.7` routing + pstack effort budgets in `model-detection.ts`
- **Files:** modify `mcp-server/src/model-detection.ts` (provider tables: `xai` prefix, `grok-4.7` + `grok-4.7-xhigh-fast` variants; `DetectedModels` selection honours direct-login routes via the existing `pi-models` direct-route machinery — do not duplicate probing here); modify `mcp-server/src/model-routing.ts` if the role/effort matrix lives there (inspect first; put the matrix where `setup-pstack` role definitions already resolve); tests in existing model-detection test files.
- **Spec:** the pstack role/effort budget matrix (`unlimited/max`, `large/xhigh`, `medium/high`, `small/medium`) becomes data: `ROLE_EFFORT_BUDGETS: Record<PstackRole, { size: 'unlimited'|'large'|'medium'|'small'; effort: 'max'|'xhigh'|'high'|'medium' }>`. Budgets are **ceilings enforced at dispatch**, not prompt suggestions: the dispatcher truncates a role's context pack to its size class (reuse the context-pack builder the deep-plan roles use) and maps effort to the provider's thinking parameter. `grok-4.7-xhigh-fast` is selectable only when a probe (R-2.1 machinery, `xai` direct route) has passed within the cache TTL; otherwise routing silently prefers the next model in the existing preference order and records the substitution in the returned rationale string (`SwarmComposition.rationale` / planner equivalent). No new network calls in `detectAvailableModels` — it stays a pure function of its inputs (existing signature), with probe results passed in.
- **Verify:** table-driven tests: each role resolves to the expected model under (a) all providers present, (b) xai probe failed, (c) gateway-only. A test that an `unlimited` role is the *only* one that receives the untruncated pack.
- **Depends on:** R-2.1.

#### R-2.5 Tender-daemon awareness of AGY panes
- **Files:** modify `mcp-server/src/tender.ts` / `mcp-server/src/tender-daemon.ts` (whichever owns pane-state classification — inspect; the daemon polls ntm + Agent Mail and logs `TenderDaemonEvent`s).
- **Spec:** AGY panes arrive from ntm as type `unknown` (like Pi/gmi panes). The tender must classify by pane *title* (`__agy_<n>`) not ntm type, poll them with the same interval as other panes (no separate faster loop — polling load is O(panes) per interval and the default `DEFAULT_TENDER_DAEMON_INTERVAL_MS` already bounds it), and detect death via `#{pane_dead}` + `capture-pane` tail, emitting the existing stuck/dead event shapes so the coordinator's unsticking flow works unchanged. A pane that is alive but producing no output for the existing stuck-threshold is reported stuck, not killed. Log volume: tender logs are append-only files; AGY pane tails are truncated to the same byte cap as other panes (no unbounded capture-pane dumps).
- **Verify:** tender tests with fixture pane lists including `__agy_1` dead/alive/stuck; log-line length assertion.
- **Depends on:** R-2.2.

---

### Wave 3 — Verification ledger + decision trail (data-integrity critical)

*Goal: pstack's `orch` ledger semantics and `show-me-your-work` decision log become durable, concurrent-safe, SHA-keyed flywheel state. Workstream A, files disjoint from Wave 2 except `completion-report.ts` (owned here) and `advance-wave.ts`.*

#### R-3.1 `orch` verdicts in `completion-report.ts`
- **Files:** modify `mcp-server/src/completion-report.ts`; create `mcp-server/src/__tests__/completion-report-orch.test.ts` (or extend the existing completion-report test file — match existing layout).
- **Spec:** extend the completion evidence with an optional `verification` block (schema stays `version: 1`, **additive forever** per AGENTS.md — new fields optional, v3.11.x reports keep validating): `verification?: { verdict: 'live-ui-verified'|'unit-test-verified'|'type-check-only'|'verifier-blocked'|'verifier-failed'; sha: string; patchId: string; checks: { unit?: {...}; live?: {...}; perf?: {...} } }`. `patchId` is computed with `git patch-id --stable` over the bead's diff (exec with timeout + signal; a diff too large for a single exec — cap at 5 MB captured output, matching exec's practical limits — degrades to `patchId: 'oversize:<sha256-of-diff>'` rather than failing). Validation rules: `closed` status with a `verification` block requires `sha` to equal a commit in `commits[]` when both present (`sha_mismatch` issue code added to `ValidationIssue`); `verifier-blocked` requires a non-empty reason (a blocked verifier is a first-class outcome, not a silent skip — same philosophy as `ubs.skippedReason`). `FW_ORCH_LEDGER=off` → the block is neither required nor validated (kill switch, D7).
- **Verify:** schema tests — old reports (no block) validate; each verdict value round-trips; sha mismatch flagged; oversize-diff path exercised with a stubbed exec.
- **Depends on:** R-0.2.

#### R-3.2 Ledger gate in `advance-wave.ts`
- **Files:** modify `mcp-server/src/tools/advance-wave.ts`; modify `mcp-server/src/tools/verify-beads.ts` if the missing/invalid evidence lists live there (inspect; keep the change in whichever file owns `missingEvidence[]`/`invalidEvidence[]`).
- **Spec:** follow the Stage-1 attestation precedent exactly: default is **warn-only** — `flywheel_advance_wave` surfaces beads whose verification verdict is `type-check-only` or missing as `needsVerification: true` with a count in human text, and still advances. `FW_ATTESTATION_REQUIRED=1` (existing flag) additionally hard-blocks on `verifier-failed` (never on `verifier-blocked` — blocked is environmental, failed is a result). No new flag. The gate reads reports already read by the existing attestation path — **zero extra `br` or git calls per bead** beyond the R-3.1 `patch-id` computed at report-write time by the implementer, not re-computed at gate time (gate stays O(beads) file reads, so a 50-bead wave does not become 50 git invocations).
- **Verify:** advance-wave tests: warn-only default advances with `needsVerification`; required-mode blocks on `verifier-failed` only; ledger-off env bypasses.
- **Depends on:** R-3.1.

#### R-3.3 `check-plan.mjs` port
- **Files:** create `scripts/check-plan.mjs` (adapted from `pstack/skills/poteto-mode/scripts/check-plan.mjs` — keep its rule set: every work box carries `Depends on. / Files. / Build. / You see. / Verify, unit. / Verify, live. / Verify, perf. / Review gate. / Merge.`, the "Tests alone are not sufficient verification" rule, perf boxes carrying `Metric. / Probe. / Baseline. / Rule.`); wire as `npm run check:plan` in `mcp-server/package.json` (or root — match where `lint:skill` lives); tests via fixture plans.
- **Spec — robustness deltas from upstream:** upstream reads the whole file and regex-scans; keep that (plans are < 1 MB by construction) but: exit 2 on unreadable file with the path in the message; CRLF-tolerant (upstream already splits on `/\r?\n/` — keep); fenced-code-aware (upstream already tracks fences — keep); **the `Verify, perf.` box may be `n/a — <reason>`** for docs-only beads, mirroring the UBS docs-only exemption, because requiring a perf probe for a markdown change guarantees the box gets gamed. Runtime is a single pass, O(lines); no file writes. This script is also the *specification* R-3.1's three check kinds (`unit`/`live`/`perf`) mirror — name them identically.
- **Verify:** upstream fixture (a valid plan) exits 0; a plan missing `Verify, live.` exits 1 naming the box and line; docs-only `n/a` perf passes; this plan file itself is not required to pass (it predates the format) but the synthesized downstream plan must.
- **Depends on:** nothing (parallel with R-3.1).

#### R-3.4 Append-only decision trail (`decisions.tsv`)
- **Files:** create `mcp-server/src/decisions.ts` (`appendDecision(cwd, slug, entry)`, `readDecisions(cwd, slug)`); create `mcp-server/src/__tests__/decisions.test.ts`.
- **Spec:** path `.pi-flywheel/decisions/<slug>.tsv` (slug validated against path traversal — reject `/`, `..`, NUL). Entry fields (9-field pstack brief lineage): `ts, bead, agent, decision, rationale, evidence, result, sha, playbook`. Append = one `appendFile` of one TSV line, fields sanitised (tabs/newlines → spaces) so one entry is always exactly one line — this is what makes concurrent appends from multiple panes safe without a lock (D5). Each line < 2 KB enforced by truncating `evidence` with a `…[truncated]` marker. Reader: skips a torn final line (no trailing newline + unparseable) with a `log.warn`, never throws on a corrupt middle line (counts and skips). **Size bound:** at 10 000 lines the writer rotates to `<slug>.tsv.1` (single generation, rename-based) — an overnight autonomous run must not grow an unbounded file in the state dir. The coordinator-facing surface is the `show-me-your-work` skill (Wave 4) calling this module through a tool or a documented CLI entry; do not add a new MCP tool for appends unless a skill needs it — prefer the implementer prompt instructing a small `node` invocation or extend `flywheel_memory` only if it already fits (inspect `memory-tool.ts`; default: no new tool).
- **Verify:** concurrent-append test (50 parallel appends → 50 intact lines); torn-tail test; rotation test; traversal slug rejected.
- **Depends on:** R-0.1.

#### R-3.5 Bead templates: `hillclimb`, `runtime-forensics`, `trace-forensics`, scientific `bug-fix`
- **Files:** modify `mcp-server/src/bead-templates.ts`; tests in the existing bead-templates test file.
- **Spec:** four new templates adapted from the pstack playbooks of the same names. Each template body must include: the effort/size class it expects (from R-2.4's matrix), a `Verify, perf.` line where the playbook is performance-shaped (`hillclimb`, `runtime-forensics`) with `Metric/Probe/Baseline/Rule`, and the `Template: <id>` header the calibration builder requires (so `flywheel_calibrate` buckets them instead of `__untemplated__`). Template rendering stays pure string building — no exec, no I/O — so template cost is O(body size) and cannot fail at runtime except on unknown template id (existing error path).
- **Verify:** snapshot tests per template containing the required headers; calibration grouping test if one exists for built-ins.
- **Depends on:** R-2.4 (effort matrix names), R-3.3 (Verify-box vocabulary).

---

### Wave 4 — Restored gates + pstack skills (load- and context-critical)

*Goal: Random Exploration, Cross-Agent alternation, the Cognitive Operators, interrogation review gates, and the ~47 pstack skills land — each fan-out capped, each context injection budgeted. Workstreams A (`gates.ts`, prompts) and B (`skills/`) in parallel; they meet only at R-4.3's fragment interface.*

#### R-4.1 `gates.ts` — Random Exploration + Cross-Agent alternation restored
- **Files:** modify `mcp-server/src/gates.ts` (currently only `buildFreshEyesPrompt`, 37 lines — this is a near-greenfield addition to an existing file); modify `mcp-server/src/tools/review.ts` for the alternation wiring if review dispatch lives there (inspect first); tests in existing gates/review test files.
- **Spec:** two new prompt builders + one scheduler rule:
  - `buildRandomExplorationPrompt({ seed, scopeFiles, budget })` — samples files for whole-repo exploration **deterministically from a seed** (the wave's head SHA) so a re-run reproduces the same sample and results are comparable; sample size is capped (`min(50, ceil(repoFiles * 0.05))` files, file list obtained from one `git ls-files` exec with timeout — never a recursive fs walk, which on this repo would traverse `mcp-server/.bench-base/` and `dist/`; respect `.gitignore` by construction via `git ls-files`).
  - `buildCrossAgentReviewPrompt(...)` — the peer-review counterpart; the scheduler **alternates** exploration and cross-agent rounds (the July Guide behaviour) rather than running both every wave: round parity from `state.iterationRound` or the batch-review counter, so cost per wave is one gate, not two.
  - Both run under `FW_EXPLORATION_BUDGET_MS` total with `Promise.allSettled` per reviewer (D3): a timed-out explorer yields `verdict: 'verifier-blocked', reason: 'budget'` in ledger vocabulary instead of failing the review. Findings flow into the existing batch-review bead-filing path (every finding becomes a bead, P0–P3 — reuse, including the `batchReviewSynthesizedBeads` resume-after-last-ID idempotency).
- **Verify:** seed-determinism test; cap test on a synthetic 10 000-file listing; alternation test (two consecutive waves pick different gates); one-reviewer-timeout test asserts partial results + wave still completes.
- **Depends on:** R-0.1, R-3.1 (ledger vocabulary).

#### R-4.2 Cognitive Operators + mismatch hunt in `_beads.md`
- **Files:** modify `skills/start/_beads.md` (the 8 named `[OPERATOR: ...]` tags including `overshoot-mismatch-hunt`); any operator whose enforcement is mechanical also gets a lint rule only if Wave 5 capacity allows (default: prompt-level only).
- **Spec — the load-bearing robustness constraint:** the "Lie to Them" mismatch hunt asks for up to 80 candidate issues. Unbounded, that is 80 beads. The skill text must instruct: candidates are **ranked and capped at the top 10 filed beads per wave**, the remainder are written as a single `docs/reviews/<date>-mismatch-hunt.md` artifact list, not beads — bead-filing is the scarce resource (`br` SQLite writes serialise; 80 creates + dependency edges is also 80 rows the operator must triage). Operator prompts carry an explicit output budget ("at most N findings, ranked") so a compliant agent cannot blow the context window of the *receiving* coordinator either. Skill edits must pass `npm run lint:skill` and not raise any file's TONE001 baseline.
- **Verify:** `npm run lint:skill` clean; bead-viewer/calibrate unaffected; the cap text is asserted by a skill-content test if the repo has one (follow `__tests__/skills/start/` precedent).
- **Depends on:** R-3.5 (templates the filed beads use).

#### R-4.3 9-field brief + 24 Principles index in prompt adapters
- **Files:** create `mcp-server/src/adapters/pstack-brief.ts` (the shared fragment builder); modify `mcp-server/src/adapters/claude-prompt.ts`, `mcp-server/src/adapters/codex-prompt.ts`; `agy-prompt.ts` consumes it from R-2.3 (coordinate the exported signature in this bead if R-2.3 landed first — it takes `briefFragment: string` as a parameter, so no file conflict).
- **Spec:** `buildPstackBrief(ctx): string` renders the 9-field ORCH brief (task, playbook, files, verify-unit, verify-live, verify-perf, review-gate, effort-budget, decision-log path) plus a **one-line-per-principle index** of the 24 principles (name + trigger phrase only — the full principle bodies live in their skills and are loaded on demand via `flywheel_get_skill`; injecting 24 full texts into every implementer prompt is a context-window denial-of-service on the swarm's own agents). Hard cap: the brief fragment is ≤ 120 lines / ≤ 6 KB, asserted by test; the effort-budget field comes from R-2.4's matrix so the brief and the dispatcher agree. Rendering is pure; a missing playbook name degrades to `playbook: feature` (the default) with a warning, never a throw.
- **Verify:** size-cap test; per-adapter golden tests showing the fragment present and identical across claude/codex/agy adapters; principles index lists exactly the bundled principle names (cross-checked against the skills bundle manifest in R-4.4 — a renamed principle skill fails this test, which is the point).
- **Depends on:** R-2.4, R-2.3 (interface), R-4.4 (principle names — can be developed against the manifest list before the skill bodies land).

#### R-4.4 Bundle the pstack skills (23 playbooks + 24 principles + generators)
- **Files:** create skill dirs under `skills/` for: the 23 playbooks (as one `poteto-mode` skill with `playbooks/` references if the bundle supports references — inspect `build-skills-bundle.mjs` behaviour first; if references are not bundled, each playbook becomes its own skill dir, matching how the upstream `pstack/skills/` tree is already laid out: `architect`, `arena`, `how`, `why`, `sharpen`, `blast-radius`, `no-comments`, `interrogate`, `unslop`, `correct`, `create-verification-skill`, `create-formal-verification-skill`, `setup-pstack`, `show-me-your-work`, `swarm`, `figure-it-out`, `recall`, `reflect`, the 24 `principle-*`, etc.); modify the bundle builder only if a size/inventory guard is missing (R-4.5); update `opencode/manifest.json` **only** for skills that are also OpenCode-managed (decide per skill; AGY-only skills go in `agy/manifest.json`, not OpenCode's).
- **Spec — context and bundle economics:** the skills bundle is loaded into MCP server memory and served per `flywheel_get_skill` call; 47 new skills at upstream size could double it. Before copying, measure upstream body sizes (`wc -c` the pstack tree); any skill body > 32 KB is trimmed to its operational core with the full text left as a reference file the skill points at (the bundle serves bodies, not reference trees). Provenance: each copied skill gets a header comment naming the upstream path and commit — these files will drift from upstream, and the drift must be visible (precedent: `[LOCAL]` philosophy applied to vendored content). Interrogate's `code-quality-review.md` ("Code Judo") and `lead-judgment.md` (4-bucket) and `no-comments`' Comment Sicko agent (`agents/comment-sicko.md` upstream) land as skill references/agents in whatever form the existing `flywheel_review` fresh-eyes machinery consumes — wire them as named reviewer *personas* in the review rotation, not as a parallel review system.
- **Verify:** `npm run check:skills-bundle` passes; `flywheel_get_skill` returns each new skill from bundle with `source: 'bundle'` and no `staleWarn`; total bundle size delta reported in the PR description with the before/after numbers.
- **Depends on:** R-4.3 (names cross-check), R-1.1 (which skills are AGY-managed).

#### R-4.5 Skills-bundle size/perf guard
- **Files:** modify `mcp-server/scripts/build-skills-bundle.mjs` (or wherever `check:skills-bundle` is implemented — inspect); create bundle-size test.
- **Spec:** `check:skills-bundle` gains a soft budget: warn (not fail) when the bundle exceeds today's size + 50%, fail when any single entry exceeds 64 KB (a single skill that big breaks the "one round-trip, ~10× less context noise than Read" promise of `flywheel_get_skill`). Build time stays linear; the check prints per-entry top-10 sizes so the next vendoring spree sees the cost before CI does. Runtime: `getSkill` already falls back to disk on `manifestSha256` mismatch — add a test that a *corrupt* new entry degrades that one skill to disk while others still serve from bundle (per-entry isolation, extending `bundle-corrupt-fallback.test.ts`).
- **Verify:** chaos tests pass; build with an artificial 65 KB skill fails the check with the skill named.
- **Depends on:** R-4.4.

#### R-4.6 July Guide gap closures with external dependencies (`cass`, `rch`, plan-synthesis diff, Inversion Analysis, `pcr` hook)
- **Files:** modify `skills/flywheel-refine-skill/SKILL.md` (`cass search` integration), `skills/flywheel-research/SKILL.md` (Phase 3 Inversion Analysis), `skills/start/_implement.md` (stack-aware validation + optional `rch exec --` offload), `skills/start/_planning.md` (git-diff + 3-tier agreement in synthesis), hook config for `pcr` (post-compaction `AGENTS.md` re-read — in `hooks/hooks.json` or the platform hook surface the repo already uses; inspect first).
- **Spec — every external call here is optional and fail-open:**
  - `cass search`: wrapped with a hard timeout in the skill text (instruct `timeout 15 cass search …` or the MCP equivalent); on failure/timeout/absent binary, the skill proceeds with an explicit "cass unavailable — continuing without session history" note. `cass` is already documented as optional with graceful fallback; keep it that way.
  - `rch exec --`: opt-in per bead (a bead field or prompt flag), only for build/test commands, with the local command as the automatic fallback on any `rch` non-zero exit or timeout (state the timeout in the prompt: the remote build gets the same budget the local build would). A bead's verification verdict (R-3.1) records *where* it ran (`runner: 'local'|'rch'`) — an `rch`-only pass is not `live-ui-verified`.
  - Plan-synthesis git-diff: one `git diff <range>` exec, output capped (diff stat first; full diff only under a byte cap, else per-file hunks for changed-files list) — synthesis context is the scarcest resource in deep plan and an uncapped diff of a large wave will evict the plan itself.
  - `pcr` hook: must complete in < 2 s, must be **fail-open** (any error → exit 0, log to stderr), must only *read* `AGENTS.md` (bounded: first 400 lines / 32 KB, whichever first — the file grows and the hook runs on every compaction), and is disabled by `FW_PCR_HOOK=off`. A hook that can block or fail compaction is worse than no hook.
- **Verify:** `npm run lint:skill` clean; hook tested by simulating a compaction event with a missing `AGENTS.md` (exit 0) and a 1 MB `AGENTS.md` (reads the bounded prefix, < 2 s).
- **Depends on:** R-3.1 (verdict vocabulary for `rch`), R-0.2 (`FW_PCR_HOOK`).

#### R-4.7 `arena` bounded fan-out
- **Files:** the `arena` skill from R-4.4; if `arena` needs server support, modify `mcp-server/src/tools/plan.ts` (inspect; prefer skill-only over NTM panes per the NTM-mandatory rule — `arena` candidates are coding work, so they go through `swarm-spawn.js` lanes like any swarm, with the AGY lane eligible).
- **Spec:** candidate count capped at 3 (upstream's graft model needs a base + grafts; > 3 candidates multiplies cost linearly for diminishing graft value), each candidate gets the R-2.4 `large/xhigh` budget ceiling, the cross-judge step has its own deadline (`FW_EXPLORATION_BUDGET_MS` shared), and a failed candidate is excluded from grafting with its failure recorded — the arena returns the best *completed* candidate, never waits indefinitely for the slowest. Skill text states the cap and the "pick base, graft strongest parts" order so a degraded 2-candidate arena still works.
- **Verify:** skill lint; a dry-run plan review confirming spawn counts in the skill text match R-2.2's lane flags.
- **Depends on:** R-4.4, R-2.2.

---

### Wave 5 — Observability, doctor coverage, hardening

*Goal: every new failure mode from Waves 1–4 is visible in doctor/observe, recoverable via remediate or a documented manual step, and proven under fault injection. This wave is what makes the previous four operable.*

#### R-5.1 Doctor checks for the new surface
- **Files:** modify `mcp-server/src/tools/doctor.ts` (check count 24 → 28; update `DOCTOR_CHECK_NAMES` and the AGENTS.md-described count in the same PR per repo convention); tests in doctor test files.
- **Spec:** four new checks, each obeying the existing doctor contract (per-check timeout, total budget, semaphore concurrency, degrade to yellow with a hint instead of throwing):
  1. `agy_cli` — `agy` binary on PATH + version probe (`FW_AGY_TIMEOUT_MS`); green-with-`disabled: true` when `lanes.agy: false` (lane-switch semantics).
  2. `agy_plugin_sync` — runs `scripts/sync-agy.sh --check` logic in-process where feasible (import the validator; do not shell out to the script from the MCP server if the logic is importable — if it is not, shell out with timeout + signal and parse the summary line). Yellow on `LOCAL`/`MISSING`/stale, red only when the plugin dir exists but is unreadable/corrupt-ledger. **Must be read-only.**
  3. `agy_model_compat` — the `gemini_model_compat` pattern (v3.22.0) applied to the AGY lane's model: yellow when the cached gateway catalog no longer offers the lane model with tool use; never probes the network from doctor (cached catalog only — doctor's < 1.5 s observe budget and its no-network-probe precedent from `gemini_model_compat`).
  4. `orch_ledger_validity` — the `convergence_state_validity` / `outcome_rubric_validity` pattern: validates recent completion reports' `verification` blocks parse and SHA-keying is intact; yellow on parse failure, red on schema-required violations; skipped-green when `FW_ORCH_LEDGER=off`.
  Each check's `hint` names the remediation (`./scripts/sync-agy.sh --write`, `flywheel_remediate`, or the env knob). Doctor's total sweep must stay within its existing total budget with 28 checks — the four new ones are all local file/binary probes, no network.
- **Verify:** doctor tests per check (green/yellow/red/disabled fixtures); a timing test asserting the full sweep with all fixtures stays under the budget.
- **Depends on:** R-1.2, R-2.1, R-3.1.

#### R-5.2 `flywheel_observe` + remediation integration
- **Files:** modify `mcp-server/src/tools/observe.ts` (hints: AGY plugin sync stale, `[LOCAL]` divergence present, ledger `verifier-blocked` beads ageing, decisions-log rotation due); modify `mcp-server/src/tools/remediate.ts` + `mcp-server/src/tools/remediations/` only for `agy_plugin_sync` if a canonical fix exists (it does: re-run sync — but re-running sync over a `[LOCAL]` divergence is a *destructive* fix, so remediation is `dry_run`-default with the diverged paths listed, `mode: 'execute'` requires the backup behaviour of R-1.2 step 4; per-check mutex via `acquireRemediateLock`).
- **Spec:** observe stays < 1.5 s and non-mutating — the sync check inside observe reads the ledger and compares mtimes/hashes of the manifest items only (no staging, no full render). Hints carry `severity: info|warn|red` per existing convention.
- **Verify:** observe tests with stale/diverged fixtures; remediate dry-run makes zero writes (assert file mtimes unchanged).
- **Depends on:** R-5.1, R-1.2.

#### R-5.3 Chaos + load test suite for the new surface
- **Files:** create under `mcp-server/src/__tests__/chaos/`: `agy-sync-kill-midrun.test.ts`, `agy-sync-concurrent.test.ts`, `agy-probe-timeout.test.ts`, `agy-pane-death.test.ts`, `ledger-concurrent-append.test.ts`, `gateway-stale-cache-agy.test.ts`; create a load test `mcp-server/src/__tests__/load/swarm-fanout-budget.test.ts` (or the repo's perf-test home — inspect; if none, a vitest with generous-but-asserted wall-clock bounds).
- **Spec:** mirror the existing chaos idioms (`doctor-kill-midrun`, `remediate-kill-midrun`, `telemetry-dual-session`, `calibrate-large-dataset`). Faults injected: process killed between stage and rename (target byte-identical); two syncs racing (one `agy_sync_locked`, tree consistent); `agy` binary that sleeps forever (probe times out, ladder substitutes, wave proceeds); AGY pane dying mid-bead (tender emits dead event, bead's reservation released via the existing path); gateway catalog fetch failing with a stale cache present (stale served, `source.stale`); 50 concurrent decision appends (50 intact lines); 200-bead wave through `splitBeadsByProvider` with AGY in the mix (completes < 1 s, counts sum exactly, ratio string correct); Random Exploration over a synthetic 10 000-file repo (sample capped, < budget). Load assertions are *bounds*, not benchmarks: they fail on algorithmic blowups (O(n²), unbounded), not on a slow CI machine — use item-count and call-count assertions (e.g., "≤ 1 `git ls-files` exec", "≤ 4 concurrent probes") as the primary signal, wall-clock only as a coarse backstop.
- **Verify:** `npm test` green including the new files; each test fails when its guard is removed (spot-check by mutation during review).
- **Depends on:** Waves 1–4.

#### R-5.4 Operator documentation + AGENTS.md enforcement table
- **Files:** modify `AGENTS.md` (MCP quick-reference untouched unless a tool changed; add the AGY lane to the NTM pane-priority section as an addendum noting `--agy` goes through `swarm-spawn.js`, never raw `ntm spawn`; add the `/correct` Rule Enforcement Table — Architecture → Types → Lint → Test → Docs — with each rule pointing at its mechanical enforcer from this plan: deadline helper, `check-plan.mjs`, TONE001/`lint:skill`, doctor checks); create `docs/agy.md` (operator runbook modelled on `docs/opencode.md`: first sync, update flow, `[LOCAL]` recovery, `--force` backup behaviour, disabling the lane, reading doctor output).
- **Spec:** docs state the timeout/retry/degradation table from this plan's Architecture section in operator terms (what times out, what retries, what falls back to what, what each doctor yellow means and its one-line fix). No new behaviour in this bead.
- **Verify:** `npm run lint:skill` if any skill touched; docs reviewed against R-5.1 check names (every check has a runbook entry).
- **Depends on:** R-5.1, R-5.2.

#### R-5.5 End-to-end verification + rollout gate
- **Files:** none (verification bead); updates `.pi-flywheel/completion/` evidence per bead via the normal implementer flow.
- **Spec — the full gate, in order:**
  1. `cd mcp-server && npx tsc --noEmit`
  2. `npm run build` (dist committed, dist-drift clean)
  3. `npm test` (including Wave 5 chaos/load)
  4. `npm run check:skills-bundle`
  5. `npm run lint:skill` (any `skills/start/*.md` touched)
  6. `./scripts/sync-agy.sh --check` exit 0 on a clean install; `--write` then `--check` idempotent on the real `~/.gemini/config/plugins/agent-flywheel/`
  7. `node scripts/check-plan.mjs <the synthesized downstream plan>` exit 0
  8. Smoke swarm: one 3-pane wave (`--cc=1 --agy=1 --gmi=1` via `swarm-spawn.js`) completing a trivial bead with a ledger-verified completion report, tender events clean, decisions.tsv entry written.
  9. Degraded smoke: same wave with `agy` binary renamed away — doctor `agy_cli` red/yellow with hint, lane substitutes, wave still completes, `degraded: true` visible to the coordinator.
- **Depends on:** all prior waves.

---

## Testing strategy

**Unit (vitest, existing idioms).** Pure functions first: deadline/concurrency helpers (R-0.1), prompt adapters with golden fixtures (R-2.3, R-4.3), bead templates (R-3.5), routing tables (R-2.4), ledger schema validation (R-3.1), TSV append/read (R-3.4), sync transforms (R-1.3). Every new `ExecFn` consumer is tested with a fake exec — no test spawns a real `agy`, `ntm`, `git`, or network process. Time-dependent tests use `vi.useFakeTimers()` per repo convention; logger assertions use `vi.spyOn(process.stderr, 'write')`.

**Behavioural / gate tests.** `advance-wave` warn-vs-block matrix (R-3.2), lane substitution ladder including the `disabled: true` non-degraded path (R-2.1), alternation + partial-result behaviour of the restored gates (R-4.1), doctor severity fixtures per new check (R-5.1).

**Chaos (fault injection, R-5.3).** The repo's chaos suite is the model: kill-mid-run, concurrent writers, corrupt caches, dual sessions. Each new durable artifact (AGY install tree, ledger, decisions.tsv, probe caches) gets a kill/corrupt/concurrent test proving the *next* run recovers or reports — never silently proceeds on torn state.

**Load (bounded, count-based).** Fan-out and scale tests assert call counts and caps (concurrency ≤ configured, execs per wave bounded, sample sizes capped) rather than wall-clock, so they are stable on CI and still catch O(n²) regressions. The one wall-clock assertion that matters operationally — doctor's total sweep budget and observe's < 1.5 s — is tested with fixtures, following the existing doctor budget tests.

**Skill-side.** `npm run lint:skill` (AskUserQuestion call sites, placeholder definitions, TONE001 ratchet) on every `skills/start/*.md` change; `check:skills-bundle` plus the new size guard on every vendored skill; a content test asserting the mismatch-hunt bead cap text exists (R-4.2) so a future edit cannot silently uncap it.

**Manual verification (Wave 5 smoke).** Two real swarms (healthy + AGY-removed degraded) and one real sync cycle against the operator's actual `~/.gemini` — automated tests use fixture homes and cannot prove the AGY app tolerates the installed plugin; the smoke does, once, before this is declared done.

---

## Acceptance criteria

1. **Sync safety:** `./scripts/sync-agy.sh --check` exits 0 on a clean install and is byte-for-byte read-only; `--write` is idempotent (second run reports all `OWNED`, zero renames); a hand-edited installed file makes `--write` abort with `agy_sync_diverged` and the file untouched; `--force` produces exactly one timestamped backup per diverged file before overwriting; killing sync mid-run never leaves the installed tree in a state `--check` cannot diagnose.
2. **Timeouts:** every new `exec` call site in `mcp-server/src/` passes an explicit `timeout` and forwards `signal` (grep-auditable); each new timeout is overridable via its `FW_*` env var listed in `flywheel_capabilities`; no operation in the new surface can hang a wave indefinitely — the longest single wait is `FW_AGY_SPAWN_TIMEOUT_MS`.
3. **Retries:** retries occur only for the classified transient set (timeout, signal-kill, SSH 255-class, gateway 429/5xx where applicable, `br` DB-busy via existing `resilientExec`) and are bounded (≤ 2 retries, abort-aware); no non-idempotent operation (bead create, ledger append, sync rename) is retried without its idempotency mechanism (resume-after-last-ID, single-line append, SHA ledger).
4. **Graceful degradation:** with the `agy` binary absent, auth expired, or its model delisted from the cached gateway catalog, doctor reports the specific check yellow/red with a hint, `splitBeadsByProvider` substitutes AGY's share down `agy→gmi→pi→cod→cc` with `degraded: true` (or silently when `lanes.agy: false`, reporting `disabled: true`), and a wave completes end-to-end (R-5.5 gate 9). With the gateway unreachable, stale caches serve with `source.stale: true`. With `FW_ORCH_LEDGER=off` or `FW_PCR_HOOK=off`, the respective feature is fully inert.
5. **Bounded load:** Random Exploration samples ≤ `min(50, 5%)` files from one `git ls-files` call; mismatch-hunt files ≤ 10 beads per wave; `arena` spawns ≤ 3 candidates; all new fan-out runs under an explicit concurrency cap (default 4) with `Promise.allSettled` partial results; the pstack brief fragment in every implementer prompt is ≤ 6 KB.
6. **Observability:** each new subsystem logs via `createLogger` to stderr only (zero `console.log` in new code — CI-grep); each new failure class has a registered error code with a hint; doctor covers the AGY lane, AGY sync state, AGY model compatibility, and ledger validity; `flywheel_observe` surfaces stale sync and ageing `verifier-blocked` beads; the full doctor sweep stays within its pre-existing total budget with 28 checks.
7. **Data integrity:** concurrent decision appends (50-way test) produce zero torn lines; a torn final line is skipped with a warning, never a throw; completion reports written before this change (no `verification` block) still validate (`version: 1` additive rule); `advance-wave` performs no per-bead git/br calls beyond the pre-existing attestation reads.
8. **Repo gates:** `npx tsc --noEmit`, `npm run build` (dist in sync), `npm test`, `npm run check:skills-bundle`, `npm run lint:skill` all pass; `node scripts/check-plan.mjs` passes on the synthesized downstream plan.

---

## Risk & mitigation

| # | Risk | Likelihood / impact | Mitigation (bead) |
|---|---|---|---|
| 1 | `sync-agy.sh` corrupts or half-writes the user's live AGY plugin dir; AGY app breaks outside flywheel's control | Medium / **High** | Stage-on-same-filesystem → validate → per-item rename with `.previous` rollback; `[LOCAL]` abort-by-default; `--check` read-only; kill-midrun chaos test proves target integrity (R-1.2, R-5.3) |
| 2 | Two flywheel sessions (or a session + doctor-driven remediate) sync concurrently and interleave renames | Medium / Medium | `O_EXCL` PID lock with stale-steal, `agy_sync_locked` exit, remediate per-check mutex; concurrent-sync chaos test (R-1.2, R-5.3) |
| 3 | `agy` CLI cold start is slow or hangs; waves stall on pane readiness | **High** / Medium | `FW_AGY_SPAWN_TIMEOUT_MS` poll-based readiness, partial-spawn contract (dead pane ≠ dead wave), tender dead-pane detection by title (R-2.2, R-2.5) |
| 4 | `agy`/gateway rate limits (429) under 6-pane + arena + exploration load; retries make it worse | Medium / Medium | Concurrency cap 4 on probes, stagger on spawn, retries bounded with abort-aware delay and only on transient class, budget-truncated fan-outs return partial results instead of retrying to completeness (R-0.1, R-2.1, R-4.1, R-4.7) |
| 5 | Probe storms: every session start re-probes `agy` + `xai` routes, multiplying CLI spawns | Medium / Low | Success-only caching (1 h) via `writeAtomic`, unknown-on-timeout never cached as failure, doctor reads cached catalog only — no network in doctor/observe (R-2.1, R-5.1) |
| 6 | Skills bundle balloons (~47 skills); `flywheel_get_skill` loses its context advantage, MCP server memory grows | **High** / Medium | 32 KB/skill trim-to-core with reference files, 64 KB single-entry hard fail + bundle growth warning in `check:skills-bundle`, principles injected as a one-line index not full texts (R-4.3–R-4.5) |
| 7 | Mismatch hunt / Random Exploration floods `br` with beads and serialised SQLite writes stall the wave | Medium / Medium | Hard cap 10 filed beads/wave, remainder to a markdown artifact; exploration sample cap; alternation so only one restored gate runs per wave (R-4.1, R-4.2) |
| 8 | Concurrent `decisions.tsv` / ledger appends from multiple panes tear lines | Medium / Low | Single-line < 2 KB appends, field sanitisation, torn-tail-tolerant reader, 10 000-line rotation, 50-way concurrent test (R-3.4, R-5.3) |
| 9 | `git patch-id` on large binary-heavy diffs is slow or exec output overflows | Low / Low | Computed once at report-write time (never at gate time), 5 MB output cap with SHA-256 fallback key (R-3.1, R-3.2) |
| 10 | `pcr` post-compaction hook blocks or fails compaction, or re-reads an ever-growing `AGENTS.md` every time | Low / **High** (hook in the critical path) | Fail-open (exit 0 on any error), < 2 s budget, bounded 400-line/32 KB read, `FW_PCR_HOOK=off` (R-4.6) |
| 11 | `rch`/`cass` external dependencies hang or are absent on the operator's machine | Medium / Low | Both opt-in/optional, hard timeouts stated in skill text, automatic local fallback, verdict records where verification ran (R-4.6) |
| 12 | New AGY error storm evicts the telemetry ring, hiding the session's other failures | Low / Low | Global ring already evicts from the largest bucket; R-0.3 test proves AGY bursts cannot flush unrelated codes, per-code cap added if it can |
| 13 | Upstream pstack drifts; vendored copies silently rot | Medium / Low | Provenance header per vendored skill; principles-index test cross-checks bundle names; `flywheel-refine-skills` / `cass` refresh path documented in `docs/agy.md` (R-4.4, R-5.4) |
| 14 | Effort-budget matrix (`unlimited/max`…) inflates cost: an `unlimited` role on a frontier model with an untruncated pack | Medium / Medium | Budgets are dispatcher-enforced ceilings, only `unlimited` roles receive untruncated packs (test-asserted), rationale string records every substitution so spend is auditable (R-2.4) |

---

## Future direction (10×, explicitly not v1)

Per the Phase 0.5 brainstorm, the ambition ceiling — `agent-flywheel` as the canonical multi-harness meta-orchestrator with automatically self-encoding lint rules via `/correct` — is reserved as an appendix, not a v1 requirement. Robustness-shaped future work, in the order it becomes safe to attempt: (1) a sync *daemon* that watches the repo and re-syncs AGY/OpenCode mirrors continuously — only once R-1.2's lock has survived a release of manual use, since a watcher multiplies concurrent-sync pressure; (2) adaptive fan-out budgets that size exploration/arena concurrency from observed gateway 429 rates (a small token-bucket fed by telemetry) — only once R-5.3's count-based load tests give a baseline; (3) ledger-verdict aggregation into `flywheel_calibrate` so `type-check-only` rates per template become a measured quality signal; (4) cross-host AGY lanes (AGY panes on the swarm-host Mac) reusing `makeSshExec` — deferred because it stacks two immature failure domains (SSH offload × new lane) and v1 should only debug one at a time.

---

## Dependency graph (summary)

```
R-0.1 ─┬─▶ R-1.4        R-0.2 ─┬─▶ R-1.2        R-1.1 ─▶ R-1.3 ─▶ R-1.2 ─┐
       ├─▶ R-2.1 ─▶ R-2.2 ─▶ R-2.5             └─▶ R-3.1 ─▶ R-3.2       │
       ├─▶ R-3.4              └─▶ R-2.4 ─▶ R-3.5 ─▶ R-4.2               ├─▶ R-5.1 ─▶ R-5.2 ─┐
       └─▶ R-4.1                    └─▶ R-4.3 ◀─ R-2.3, R-4.4 ─▶ R-4.5  │                     ├─▶ R-5.5
R-3.3 (parallel) ─▶ R-3.5          R-4.6 ◀─ R-3.1, R-0.2   R-4.7 ◀─ R-4.4, R-2.2            │
Waves 1–4 ─────────────────────────────────────────────────────────────┴─▶ R-5.3 ─▶ R-5.4 ──┘
```

Parallelisable after Wave 0: Wave 1 (`scripts/`, `agy/`) ∥ Wave 2 (`mcp-server/src/` lanes/routing) ∥ R-3.3/R-3.4; Wave 4 skills workstream (`skills/`) ∥ Wave 3/4 TypeScript. File reservations via `reserveOrFail` per AGENTS.md; no two beads in a wave share a modify-file except `doctor.ts` (Wave 5 only) and `advance-wave.ts` (R-3.2 only).
