# AGENTS.md

Guidance for sub-agents working in this repository.

## Project Overview

agent-flywheel is an MCP server that drives a multi-phase development workflow: scan, discover, plan, implement, review. The MCP server runs over stdio (JSON-RPC) from `mcp-server/src/server.ts`.

## 30-second map

Cold-reader affordance. Each bullet links to an existing section below.

- **Project-local skills** — see [`Available CLI Tools`](#available-cli-tools), [`SKILL.md linting`](#skillmd-linting), and `skills/` (project-local skill bodies loaded via `flywheel_get_skill`).
- **MCP tools** — see [`MCP tools quick reference`](#mcp-tools-quick-reference) for the at-a-glance index, then version-sliced sections (`v3.7.0`, `v3.11.0`, `v3.12.0`) for change history.
- **Swarm path** — see [`NTM is mandatory for all spawned work`](#ntm-is-mandatory-for-all-spawned-work) + [`Agent Coordination`](#agent-coordination) + [`Bead Lifecycle`](#bead-lifecycle). Quick recipe: `flywheel_pi_models` for the Pi model → `node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" <project> --label <purpose> --cc=N --pi=N --pi-model=<model> --gmi=N` → `ntm --robot-send=<session> --panes=<printed index> --msg="…"` → each agent runs `macro_start_session` + `reserveOrFail` + close bead with `br update --status closed` and write `.pi-flywheel/completion/<bead>.json` per the [Pre-Completion Quality Gate](#pre-completion-quality-gate-mandatory-for-every-spawned-implementor).
- **Conventions** — see [`Hard Constraints`](#hard-constraints), [`Code Conventions`](#code-conventions), and [`Tool name deprecation`](#tool-name-deprecation).

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

## OpenCode port is a derived artifact

The repository is the **source of truth for the Claude Code plugin**. The OpenCode port installed under `~/.config/opencode` is a **derived artifact** produced by `scripts/sync-opencode.sh` from the manifest-owned repo sources (`skills/flywheel-*/`, `skills/start/`, the managed `commands/*.md`, the `opencode/` templates and overrides, and `hooks/hooks.json`). Do **not** hand-edit the installed OpenCode targets — change the repo sources and re-run the sync. A hand-edited generated file is detected as `[LOCAL]` divergence, backed up, and overwritten on the next `--write`; it is never a second source of truth. The authoritative ownership boundary is `opencode/manifest.json`; the operator workflow (first sync, update flow, troubleshooting) is `docs/opencode.md`.

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
- `mcp-server/src/model-detection.ts` — shared model tables and provider-aware planner selection; one-caller prompt text lives with its consuming tool
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

## MCP tools quick reference

Current-tool index (HEAD = v3.20.0). One line per tool, alphabetical. Detailed semantics live in the version-sliced sections below; this is the cold-reader affordance.

- **`flywheel_advance_wave`** — close a completed wave, mark beads `closed`, surface `nextWave[]` ready beads. Stage-1 attestation gate: `FW_ATTESTATION_REQUIRED=1` flips warn-only to hard-block on missing/invalid completion evidence.
- **`flywheel_approve_beads({ action })`** — review/approve bead set; actions: `start | polish | reject | advanced | git-diff-review`. Returns quality score + hotspot matrix + 3 or 4-option launch menu.
- **`flywheel_calibrate({ sinceDays? })`** — bead-template effort calibration from closed `br list` rows. Rows are grouped by the `Template: <id>` line the bead-creation builder requires at the top of every new bead; beads without a matching template fall into the `__untemplated__` bucket.
- **`flywheel_convergence({ planSlug })`** — read-only `ConvergenceState` from `.pi-flywheel/plans/<slug>/convergence.json` (multi-signal score + B6 oscillation flag). v3.12.0+. See "MCP tools added in v3.12.0" for B6 semantics.
- **`flywheel_discover`** — surface ranked improvement ideas after a profile pass.
- **`flywheel_doctor`** — health sweep, currently 24 checks (incl. v3.12.0 `convergence_state_validity`, v3.13.0 `outcome_rubric_validity`, v3.18.0 `gemini_model_compat` (since v3.22.0 a gateway-catalog check for gemini-4-argon), `orphan_tender_daemons`, `npm_marketplace_version_drift`, `projects_base_misconfig`, v3.21.0 `pi_cli`). Read-only. Also returns `data.preflightBanner` (rendered string, or null when all critical checks are green) and `data.firstRun`, which `skills/start/SKILL.md` Step 0 prints instead of rebuilding the banner from the rows. `data.report.swarm` holds the lanes a six-pane swarm gets on this host, after the substitution ladder, the `lanes:` switches, and the Gemini model check, as `label` (`cc:pi 2:4` with Gemini off) and `spawnFlags` (`--cc=2 --pi=4`). The Auto-swarm menu prints the label and the in-flight swarm spawns with the flags.
- **`flywheel_emit_codex({ targetDir, pluginRoot? })`** — emit `AGENTS.md` and `.codex/skills/*.md` under a destination inside `cwd`; Claude Code remains the source of truth.
- **`flywheel_get_skill({ name })`** — bundled skill body in one round-trip. Preferred over `Read` for skill lookups.
- **`flywheel_memory({ operation, query?, content? })`** — CASS memory; operations: `search | store | draft_postmortem | draft_solution_doc | refresh_learnings`. The `refresh_learnings` op classifies `docs/solutions/` entries Keep/Update/Consolidate/Replace/Delete.
- **`flywheel_observe`** — single-call session-state snapshot; surfaces hints from missing completion attestations.
- **`flywheel_pi_models({ action, roles?, picks?, refresh? })`** — v3.21.0; `action: "list"` finds the models the user's Pi logins can run plus the live Vercel AI Gateway catalog, ranks frontier models for the deep-plan roles and balanced ones for the implementer, and returns one `AskUserQuestion` payload per role (the implementer's is multi-select); `action: "choose"` validates the answers, runs `pi auth check` per provider, remembers the picks, and returns `data.piModels`.
- **`flywheel_plan({ mode, ambition? })`** — planner; modes: `standard | deep | duel`. Every mode auto-detects `docs/brainstorms/<slug>-<date>.md`. `ambition: "ambitious"` (orthogonal to mode) also requires the ambition charter `docs/brainstorms/<slug>-<date>-ambition.md` from the `_planning.md` Step 5 ambition pass and injects it into every planner prompt.
- **`flywheel_profile`** — repo profile with git-HEAD-keyed cache. Always call first.
- **`flywheel_remediate({ checkName })`** — apply canonical fix for a failing doctor check (per-check mutex, `dry_run` default).
- **`flywheel_rescue({ phase, beadId?, errorEnvelope?, notes? })`** — build a Codex rescue packet and prompt for a stalled plan, implementation, or review phase, materialize its artifact, and store the canonical event in CASS.
- **`flywheel_review`** — 5 fresh-eyes reviewers per risky bead, or duel for p0 / security beads. Headless coordinators finish with `action: "report"`, `findingCount`, and `crashed`; clean reports return exit code 0, findings return `review_headless_findings` with `details.exitCode: 1`, and reviewer crashes use exit code 2.
- **`flywheel_select({ goal })`** — set selected goal and transition to planning phase. Returns `goalSlug` (via `slugifyGoal`) so skills consume it directly instead of re-deriving.
- **`flywheel_verify_beads`** — verify closed beads have valid completion evidence; reads `.pi-flywheel/completion/<id>.json`.
- **`flywheel_synthesize_rubric({ action })`** — v3.13.0; synthesize, validate, edit, or regenerate the cycle-level outcome rubric at `.pi-flywheel/plans/<slug>/rubric.md`. `action: 'skip'` persists the one-cycle grading skip. Called from `_planning.md` Step 5.6.5 after the operator picks Create beads.
- **`flywheel_grade_outcome`** — v3.13.0; spawn a decorrelated grader (codex primary, fresh-CC fallback), parse the verdict against `GraderVerdictSchemaV1`, persist to `.pi-flywheel/plans/<slug>/grading/iteration-<N>.json`. Called from `_wrapup.md` Step 9.5.0 before commit review.
- **`flywheel_approve_beads({ action: 'remediate' })`** — v3.13.0 action; create exactly one bead from a failing-criterion verdict using the §"Remediation Bead Template" body. Called once per failing criterion when the operator picks Iterate at the wrap-up verdict gate.

> **Convention.** When a future MCP tool ships, update both this quick-reference AND the version-sliced section below ("MCP tools added in v<X.Y.Z>"). The quick-ref is an at-a-glance index; the version-sliced sections preserve change history.

## MCP tools added in v3.7.0

- **`flywheel_remediate({ checkName, autoConfirm?, mode? })`** — applies the canonical fix for a failing doctor check. Default mode is `dry_run`; pass `mode: 'execute'` + `autoConfirm: true` to actually mutate. Per-check mutex prevents concurrent calls. Six handlers ship: `agent_mail_liveness`, `checkpoint_validity`, `cli_binary`, `dist_drift`, `mcp_connectivity`, `orphaned_worktrees`. Other doctor checks return `remediation_unavailable` (manual hint surfaced by SKILL.md). Result envelope includes `verifiedGreen: boolean` (re-runs the original probe after apply).
- **`flywheel_calibrate({ cwd, sinceDays? })`** — aggregates `br list --json --status closed` rows by template, computes mean/median/p95 actual vs `EFFORT_TO_MINUTES[template.estimatedEffort]`, and writes `.pi-flywheel/calibration.json`. The live bead-creation builder lists every built-in template id and requires `Template: <id>` near the top of a matching bead description, so new flywheel cycles produce per-template rows. Beads with no matching template remain in the `__untemplated__` count. Git first-commit timestamps provide the preferred start-time proxy, capped at 200 calls per run, and clock-skewed samples are dropped.
- **`flywheel_get_skill({ name: "<plugin>:<skill>" })`** — serves a bundled skill markdown body in one MCP call. Bundle at `mcp-server/dist/skills.bundle.json` (built by `npm run build`). 4-layer drift defense: build-time `check:skills-bundle` CI gate, runtime `manifestSha256` integrity check (falls back to disk on mismatch), per-entry `srcSha256` stale-warn, `FW_SKILL_BUNDLE=off` env-bypass for contributors editing skills live. Returns `{ name, frontmatter, body, source: 'bundle' | 'disk', staleWarn? }`.

### Fast path for skill bodies (PRIMARY)

When loading any flywheel skill — entry-point (`/start`) or sub-phase (`_planning.md`, `_implement.md`, etc.) — **prefer `flywheel_get_skill` over `Read`**. Single MCP round-trip, served from the bundled body, ~10× less context noise than `Read` (no directory listing, no path resolution).

**Skill-stub recovery.** The `Skill` tool returns "already loaded above" and no body when a slash command and a skill register under the same name (e.g. `commands/start.md` and `skills/start/SKILL.md` both resolve to `agent-flywheel:start`): the harness considers the slash expansion to count as that skill's load, so a `Skill(skill: "agent-flywheel:start")` call inside the command collapses to a stub. The four pointer commands (`commands/start.md`, `commands/flywheel-reality-check.md`, `commands/flywheel-speedup.md`, `commands/grill-with-docs.md`) now call `flywheel_get_skill({ name: "agent-flywheel:<skill>" })` as their first action — the MCP call always returns the body in Claude Code and in the OpenCode port, bypassing the same-name dedup. **Do NOT fall back to `Read`** if the Skill tool stubs; call the MCP tool. Examples:

- `/start` returned a stub → `flywheel_get_skill({ name: "agent-flywheel:start" })`
- Phase boundary needs `_planning.md` → `flywheel_get_skill({ name: "agent-flywheel:start_planning" })`
- Same for `start_beads`, `start_implement`, `start_review`, `start_wrapup`, `start_reality_check`, `start_deslop`, `start_saturation`, `start_inflight_prompt`.

`Read` is the disk-fallback path — only use it if the MCP call errors (bundle disabled via `FW_SKILL_BUNDLE=off`, transport down, or skill not in bundle).

## MCP tools added in v3.11.0

The 2026-04-30 3-way duel cohort (`docs/duels/2026-04-30.md`, plan `docs/plans/2026-04-30-duel-winners.md`) shipped a runtime-safety + recovery substrate built around three composable features.

- **`flywheel_observe({ cwd })`** — single-call session-state snapshot. Versioned `FlywheelObserveReport` covering `cwd`, `git.{branch, head, dirty, untracked[]}`, `checkpoint.{exists, phase?, selectedGoal?, planDocument?, activeBeadIds[]?, warnings[]}`, `beads.{initialized, counts, ready[]}`, `agentMail.{reachable, unreadCount?, warning?}`, `ntm.{available, panes[]?, warning?}`, `artifacts.{wizard[], flywheelScratch[]}`, and `hints[]` with `severity: info|warn|red`. Idempotent and non-mutating; doctor probes are cached or short-budgeted (<1.5s total tool runtime); every external probe degrades gracefully (sub-section flagged `unavailable: true` rather than failing the whole call). Hint surface includes missing or invalid completion attestations from the Stage 1 ledger so a forgotten dogfood file is visible at the next `/start` rather than silently rotting.
- **Completion Evidence Attestation (Stage 1).** New module `mcp-server/src/completion-report.ts` exports `CompletionReportSchemaV1` (Zod, `version: 1` additive forever), `readCompletionReport(cwd, beadId)`, `validateCompletionReport(report, bead, { cwd? })`, `formatCompletionEvidenceSummary(report)`, and `writeCompletionReport(cwd, report)`. `flywheel_verify_beads` reads `.pi-flywheel/completion/<beadId>.json` for every closed bead and surfaces `missingEvidence[]` / `invalidEvidence[]`. `flywheel_advance_wave` is the gate — Stage 1 default is warn-only (`needsEvidence: true` on the outcome); set `FW_ATTESTATION_REQUIRED=1` to flip to hard-block returning `attestation_missing` / `attestation_invalid` (2 new structured error codes). The server-built implementer prompts returned by `flywheel_approve_beads(action: "start")` and `flywheel_advance_wave` inject the gate text and a per-bead worked JSON example from `CompletionReportSchemaV1` through `mcp-server/src/adapters/completion-attestation-prompt.ts`. The implementer skills (`skills/flywheel-swarm/SKILL.md`, `commands/flywheel-swarm.md`, `skills/start/_implement.md`) dispatch those prompts unchanged.
- **Lock-aware reservation helper + `RESERVE001` lint rule.** New module `mcp-server/src/agent-mail-helpers.ts` exports `reserveOrFail(paths, opts)` and `releaseReservations(reservationIds)`. `reserveOrFail` wraps `agentMailRPC("file_reservation_paths", ...)` and treats any non-empty `conflicts` array as failure even when `granted` is also populated, with one exponential-backoff retry. `reserveFileReservations()` in `mcp-server/src/agent-mail.ts` routes through this helper. The `RESERVE001` lint rule flags every raw call outside the helper module, and new offenders fail CI.

## MCP tools added in v3.12.0

The 2026-05-06 APR-Pro adoption (`05071af`, `docs/research/research-apr-pro-landed-2026-05-06.md`) shipped multi-signal plan convergence and the B6 oscillation guard inspired by APR-Pro's automated plan reviser pipeline.

- **`flywheel_convergence({ cwd, planSlug })`** — read-only handler that returns the persisted `ConvergenceState` for a plan slug. State path: `.pi-flywheel/plans/<slug>/convergence.json` (per Phase 12 §12.3 — no `.flywheel/` rename). Source: `mcp-server/src/tools/convergence-tool.ts`, registered in `server.ts`. Score is multi-signal (delta-text, file-coverage, dependency-graph stability) per `convergence.ts` `SCORE_VERSION`. Result envelope includes `oscillation.detected: boolean` plus `signFlips`, `revisions`. Plan slug derived via `planSlugFromIdentifier(planPathOrId)`.
- **B6 oscillation guard semantics.** When `signFlips > revisions / 3`, the convergence state flips to `status: "oscillating"`, surfaced via `flywheel_convergence` and the `convergence_state_validity` doctor check. Step 5.45 (picked-up-plan menu) renders the score in the question text only — never arms a default option (per Phase 12 §12.5 + README §Design Philosophy #3, every decision routes through `AskUserQuestion`). Auto-approve at score ≥ 0.90 still routes through the user gate; the kill-switch on `flywheel_advance_wave` consults convergence + oscillation flags but cannot bypass the user.
- **`convergence_state_validity` doctor check.** Probes that the persisted `convergence.json` parses against `ConvergenceStateSchema` and the `signFlips/revisions` invariants are intact. `flywheel_doctor` surfaces it under the standard 11-check sweep (now 12 entries with this addition); severity defaults to yellow on parse failure, red only on schema-required-field violations.
- **NTM pane priority — changed.** v3.12.0 made `--cod=` the default secondary lane after `--cc=`. **Superseded in v3.17.0** by mixed `cc:cod:gem` 1:1:1 as the canonical default; see the "NTM pane priority" section below for the current rule and the substitution ladder.

## MCP tools added in v3.13.0

The 2026-05-08 outcome-grading cycle (`docs/superpowers/specs/2026-05-08-outcome-grading-design.md`, plan `docs/plans/2026-05-08-outcome-grading-synthesized.md`) ports the Anthropic Managed Agents API's "rubric + decorrelated grader + iteration loop" pattern locally — concepts only; no MA API substrate adopted.

- **`flywheel_synthesize_rubric({ cwd, action?, planSlug?, planPath?, editIntent?, force?, reason? })`** — author, validate, edit, regenerate, or skip the cycle-level outcome rubric. Rubric actions write `.pi-flywheel/plans/<slug>/rubric.md` and a sidecar `.rubric.lock` (planContentSha cache). `action` accepts `synthesize | validate | edit | regenerate | skip`. The `skip` action persists `state.outcomeGradingSkipped = true` before returning `rubric_skipped`. It does not require a plan or rubric file. The tool applies `tighten | add | remove` edits deterministically and sends `custom` edits to the LLM. Operator-edited rubrics (`source: 'edited' || 'user'`) are never overwritten without `force=true` (R6 mitigation). Discriminated success kinds: `rubric_synthesized | rubric_preserved | rubric_edited | rubric_validated | rubric_skipped`.
- **`flywheel_grade_outcome({ cwd, planSlug?, force? })`** — spawn a decorrelated grader (codex primary via `codex exec --json --model "${FW_GRADER_MODEL ?? 'gpt-5.5'}"`; fresh-CC fallback via `claude --print` when codex is unavailable). 4-tier `cycleStartSha` recovery ladder protects against missing baselines (state → checkpoint.gitHead → `git log --before=<ts>` → `HEAD~50`); never falls back to `HEAD`. Iteration-cap coercion is server-side: `needs_revision` at `iteration ≥ state.maxOutcomeIterations` is force-coerced to `max_iterations_reached` before the response leaves the tool. ENOSPC / EROFS graceful degrade — verdict returned in-memory with `persistence: 'failed'`. Discriminated success kinds: `grader_verdict | grading_skipped | grading_capped | grading_persistence_failed`.
- **`flywheel_approve_beads({ action: 'remediate', remediation })`** — new action that creates exactly one bead from a failing-criterion verdict using the verbatim §"Remediation Bead Template" body. Increments `state.iterationRound`. T11 (`_wrapup.md` Step 9.5.0 Iterate branch) calls this once per criterion where `verdict.perCriterion[i].status !== 'met'`.
- **`outcome_rubric_validity` doctor check.** Read-only probe of the active plan's `rubric.md`. Severity: green when no rubric / valid rubric (≥3 criteria), yellow when file missing / parse failure, red when criteria array is empty. Hints are verbatim §"Doctor Hints"; remediation routes through the operator-driven Step 5.6.5 rubric gate (auto-rewrite would silently overwrite operator edits).
- **8 new structured error codes** in `mcp-server/src/errors.ts`: `rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`, `grader_unavailable`, `cycle_start_sha_unset`, `outcome_iteration_capped`, `concurrent_grade`. Only `grader_timeout` is `retryable: true` by default.
- **Additive `FlywheelState` fields**: `outcomeRubricPath?`, `outcomeGradingSkipped?`, `outcomeGradingHistory?` (FIFO-capped at last 5), `maxOutcomeIterations?` (bounded `[1,5]` via `getMaxOutcomeIterations`), `cycleStartSha?`, `cycleEndTestOutput?`. v3.11.x and v3.12.x checkpoints continue to load with all six undefined — see `mcp-server/src/__tests__/migration.test.ts` and the frozen v3.12 fixture.

### Outcome grading lifecycle

```
flywheel_select  ─►  state.cycleStartSha = git HEAD          (T13)
flywheel_plan    ─►  plan written to docs/plans/<slug>.md
_planning.md 5.6 ─►  operator picks Create beads
_planning.md 5.6.5 ─► flywheel_synthesize_rubric              (T10)
                       │
                       ├─ Approve  → continue to bead creation
                       ├─ Edit     → action='edit' loop
                       ├─ Regenerate → action='regenerate' force=true
                       └─ Skip rubric → action='skip'
                                          persists state.outcomeGradingSkipped=true
                                          (one-cycle; cleared by next select)

(... bead waves close ...)

_wrapup.md 9.5.0 ─►  flywheel_grade_outcome                  (T11)
                       │
                       ├─ skipped → continue wrap-up
                       ├─ satisfied → continue wrap-up
                       ├─ needs_revision (iter < cap)
                       │    └─ Iterate → flywheel_approve_beads(remediate)
                       │                  one bead per failing criterion
                       │                  state.iterationRound++ → back to Step 6
                       ├─ max_iterations_reached → Accept anyway / Abort
                       │                            (no Iterate)
                       ├─ failed → print explanation + Abort
                       └─ persistence_failed → warn + verdict-aware sub-branch
```

### Distinguishing `flywheel_review` from outcome grading

| Concern | `flywheel_review` | Outcome grading (v3.13.0) |
|---|---|---|
| Scope | Per-bead implementation | Whole-cycle plan-vs-result |
| When | After every bead's commit | Once at wrap-up (Step 9.5.0) |
| Decorrelation | Same model family (CC reviewers) | Codex-primary / fresh-CC fallback (cross-vendor) |
| Output | Reviewer findings + revisions | `GraderVerdictSchemaV1` JSON envelope |
| Iteration loop | Hit-me retries | Iterate ↔ remediate beads, capped at `state.maxOutcomeIterations` |

Both run in the same cycle and complement each other. `flywheel_review` ensures each bead lands cleanly; outcome grading ensures the cycle as a whole achieves what the operator approved at plan-time.

### Env knobs (v3.13.0)

| Env var | Default | Purpose |
|---|---|---|
| `FW_GRADER_MODEL` | `gpt-5.5` | Codex-primary grader model passed to `codex exec --model`. It does not configure the fresh-CC fallback, which is selected by `FW_GRADER_FORCE_CLAUDE=1` or Codex unavailability. |
| `FW_GRADER_TIMEOUT_MS` | `120000` | Per-call grader budget. Surfaced as `grader_timeout` (retryable) on overflow. |
| `FW_GRADER_FORCE_CLAUDE` | unset | When `=1`, skips the codex primary and goes straight to the fresh-CC fallback. Use for environments where codex is intentionally unavailable. |
| `FW_RUBRIC_SYNTH_TIMEOUT_MS` | `60000` | Per-call rubric synthesizer budget. Hard-fails as `rubric_synth_invalid` on overflow. |
| `FW_MAX_OUTCOME_ITERATIONS` | `3` (clamped to `[1,5]`) | Default for `state.maxOutcomeIterations`. Per-cycle override happens via state edits, not a flag. |
| `FW_COMMIT_BATCH_THRESHOLD` | `8` | Commits accumulated since `state.lastBatchReviewSha` before `flywheel_advance_wave` returns `nextStep: batch_review_due` alongside `nextWave`. `0` or unset disables the auto-trigger; existing post-wave gate flow is unchanged. Overridable per session via the `_implement.md` Pre-flight `AskUserQuestion`. |

### FW_GRADER_MODEL safe-default cascade

The outcome grader chooses its model according to this canonical priority cascade:
1. **`FW_GRADER_MODEL` (if set)** — Used for the Codex-primary lane.
2. **`gpt-5.5` (default)** — Used if `FW_GRADER_MODEL` is unset.
3. **`claude --print` (fallback)** — Used if `FW_GRADER_FORCE_CLAUDE=1` or if Codex is unavailable/unhealthy.

This cascade is specific to the outcome grader and is distinct from the NTM pane-provider substitution ladder described in the next section.

State fields added by the fresh-eyes auto-trigger feature (v3.17.0+):

- `state.commitBatchCounter?: number` — commits accumulated since `lastBatchReviewSha`; incremented as impl agents commit; reset to 0 on review dispatch.
- `state.commitBatchThreshold?: number` — per-session threshold (defaults to `FW_COMMIT_BATCH_THRESHOLD`). `0` or unset disables auto-trigger.
- `state.lastBatchReviewSha?: string` — baseline SHA for the next batch-review diff, falling back to `cycleStartSha` before the first review. `flywheel_review(action: "batch_review")` moves it to the end of the range when it hands out the reviewer prompt, so commits made during the review count toward the next one.
- `state.pendingBatchReviews?: string[]` — ranges whose review went out and whose verdict hasn't been applied. `flywheel_advance_wave` files the beads for any of them whose verdict file has landed and reports the rest in `batchReviews.pending`.
- `state.batchReviewSynthesizedBeads?: Record<string, string[]>` — per-range bead IDs (`<from-sha>..<to-sha>` → IDs in finding order) filed from a review's findings. A repeated apply resumes after the last recorded ID, so a finding never gets two beads.

Batch reviews never wait on the operator. Every finding in a verdict becomes a bead, whatever the verdict's status, at priority P0 (critical) through P3 (low), and an unreadable verdict becomes one P1 bead to re-review the range. `batch_review_due` rides along with `nextWave` instead of replacing it, so the swarm keeps working while one reviewer reads the diff.

### Decided policy (v3.13.0)

- **`cycleStartSha` capture point.** `flywheel_select` writes `state.cycleStartSha` at goal-set time (OQ-A resolution). On detached HEAD / no-commits / git-missing, the field stays undefined and the grader's 4-tier ladder fires.
- **Skip-rubric stickiness.** One cycle per skip (OQ-B resolution). `flywheel_synthesize_rubric(action: 'skip')` saves `state.outcomeGradingSkipped = true` before it returns. The next `flywheel_select` clears the flag so the operator gets a fresh prompt at every Step 5.6.5.

## MCP tools added in v3.20.0

- **`flywheel_emit_codex({ cwd, targetDir, pluginRoot? })`** — the existing Codex emitter is now listed in `tools/list` with the same path-safety contract as `tools/emit-codex.ts`. `cwd` and `targetDir` are required. `pluginRoot` is optional and must stay inside `cwd` or match `CLAUDE_PLUGIN_ROOT`.
- **`flywheel_rescue({ cwd, phase, beadId?, errorEnvelope?, notes? })`** — turns the existing `codex-handoff.ts` contract into a callable MCP tool. `phase` accepts `plan`, `impl`, or `review`. The tool reuses an active plan document or writes a phase artifact under `.pi-flywheel/rescue/`, builds a `RescuePacket`, renders a Codex prompt with the existing adapter, and stores the canonical `flywheel-rescue` memory line through `flywheel_memory`.
- **Result contract.** Success returns `data.packet`, `data.codexPrompt`, and `data.memoryLine`. `codexPrompt` includes the two trailing newlines required by the Codex input buffer. Invalid phases return `invalid_input`; artifact, Git, and CASS failures reuse existing structured error codes.
- **Generated aliases.** Every canonical runner now generates its `orch_*` alias from the same registry. `orch_rescue`, `orch_emit_codex`, `orch_doctor`, `orch_convergence`, `orch_synthesize_rubric`, and `orch_grade_outcome` therefore use the canonical runner during the v4.0 deprecation window.

## MCP tools added in v3.21.0

Pi replaces Codex as the second primary lane in deep plan and implementation swarms, by operator decision. Pi runs a model on one of the user's own provider logins (a "direct" route such as `xai/grok-4.7` on a SuperGrok plan) or on the metered Vercel AI Gateway. Which models a plan covers and which gateway models lead both change every few weeks, so the user picks the model each time a Pi lane spawns instead of the plugin pinning one.

- **`flywheel_pi_models({ cwd, action?, roles?, picks?, refresh? })`** — source `mcp-server/src/pi-models.ts` (domain) and `mcp-server/src/tools/pi-models.ts` (handler). Roles are `robustness` and `ergonomics` (deep plan) and `implementer` (swarms).
  - **Gateway data.** `action: "list"` (default) reads the public catalog at `https://ai-gateway.vercel.sh/v1/models` and the CC-BY-4.0 leaderboard at `https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text&format=json`, cached for an hour in `.pi-flywheel/cache/gateway-models.json` (snapshot `version: 2`, with 7-day mean token share and spend share per model name). A failed fetch falls back to the cache with `source.stale: true`; with no cache it returns `missing_prerequisite`. Free, batch, deprecated, stealth, and Anthropic models are dropped, since the Claude lane covers Anthropic, and a dated snapshot (`-1017`) shares its family's usage.
  - **Direct routes.** It runs `pi --list-models`, keeps every provider except the aggregators (`vercel-ai-gateway`, `openrouter`, `opencode`) and `anthropic`, and checks each with `pi auth check --provider <p> --json`, which refreshes an expired OAuth token the way a pane would. A listed model is not proof the plan covers it, so each login's models from the last year (priciest first, up to 10, plus their `-fast`/`-highspeed` variants) get one tool-free probe, `pi -p --no-session --no-approve --no-context-files --no-tools --thinking minimal --model <m> "Reply with exactly: ok"`. Probes run four at a time per login inside a 90-second budget with a 60-second timeout each. Results are cached for a day in `.pi-flywheel/cache/pi-route-probes.json` with any key text redacted; a timeout or a probe the budget cut off stays unknown and runs again next time, and `refresh: true` re-probes everything. Direct models borrow price, release, and usage from their gateway entry (`xai/grok-4.7` ↔ `spacexai/grok-4.7`).
  - **Ranking.** Each lab gets one candidate, logins first, then gateway models for labs no login covers. Within a lab an OAuth login beats an API key, and a model must cost at least half (frontier) or 15% (balanced) of the lab's reference price, which is its most-paid-for model's list price, or its priciest when the leaderboard lists none. Frontier (roles `robustness`, `ergonomics`) also drops flash/mini/nano/lite names, picks the lab's most-paid-for model else its newest, orders labs by that model's list price, and lists only gateway labs people pay for. Balanced (`implementer`) picks the lab's most-used model, else its flagship's speed variant on a login, else its newest model at half the flagship's price or less, orders by token share then recency, and lists only gateway models with usage or released in the last 14 days. `data.candidates` holds both rankings and `data.routes` the logins, working routes, and rejected routes.
  - **Questions.** Each puts the user's last picks for that role first, even ones the ranking leaves out, and gives deep plan's two roles different default labs. The implementer question is multi-select and recommends its top two.
  - **`action: "choose"`** takes `picks` keyed by role, as option labels, `pi --model` values, gateway ids, or model names; the implementer takes up to three, as an array or the comma-separated string a multi-select answer arrives as. An unknown model returns `invalid_input` with `details.suggestions`. It runs `pi auth check` for each chosen provider, writes `.pi-flywheel/pi-models.json` (`version: 2`, an array per role), and returns `data.piModels` (role → `pi --model` value, comma-separated for several implementer models), `data.piReady`, and `data.authDetail`.
- **`swarm-spawn.js`** (`mcp-server/scripts/swarm-spawn.ts` → `mcp-server/src/swarm-spawn.ts`). ntm 1.36.1 has no `pi` lane, so this script runs `ntm spawn --no-user --stagger-mode=smart` for the cc and cod lanes, then adds one `pi --model <model> --thinking high --no-approve` pane per `--pi` count with `tmux split-window`, titled `<session>__pi_<n>` with `remain-on-exit on`. Since v3.22.0 it adds one Pi pane on `vercel-ai-gateway/google/gemini-4-argon` per `--gmi` count too, titled `<session>__pi_gmi_<n>`, because ntm types a `__gmi_<n>` pane as a gemini CLI agent and would respawn it as one. It prints `{ session, panes: [{ lane, index, paneId, model? }], errors }` and exits 1 when any pane failed. Several `--pi-model` values, repeated or comma-separated, alternate across the Pi panes.
- **`pi_cli` doctor check.** Green when `pi` is on PATH and `pi auth check` reports ready for the gateway, a provider behind the user's picks, or a login that passed a probe; yellow otherwise. `swarm_model_ratio` now reports the Claude:Pi:Gemini ratio, and `splitBeadsByProvider` assigns Pi's share to Codex, then Gemini, when Pi isn't ready.
- **Lane switches in `flywheel.config.yaml`.** `lanes: { gemini, codex, pi }` takes booleans, all true by default; Claude runs the coordinator, so it can't be switched off. The loader reads `${XDG_CONFIG_HOME:-~/.config}/agent-flywheel/flywheel.config.yaml`, then the repo-root `flywheel.config.yaml`, and a key set in the repo file wins. `detectCliCapabilities` reports a switched-off lane as `{ available: false, disabled: true }` without probing it, and `splitBeadsByProvider` hands its share down the substitution ladder without a warning and without setting `degraded`. The doctor's row for it (`gemini_cli`, `gemini_model_compat`, `codex_cli`, or `pi_cli`) is green with `disabled: true` (new optional `DoctorCheck` field), so a skill that reads doctor rows treats it as unavailable while the checklist doesn't show it as broken. `swarm_model_ratio` stays green when every primary lane is usable or switched off.
- **Pi implementer prompts use the `am` CLI.** Pi panes load no project MCP servers under `--no-approve`, so `adaptPromptForPi` writes Agent Mail steps as `am macros start-session`, `am file_reservations reserve|release`, and `am mail send` commands.
- **Removed.** `FW_PI_PLANNER_MODEL`, the `vercel-ai-gateway/google/gemini-4-argon` default, and the deep-plan `fresh-perspective` planner. The ergonomics planner's task now covers challenging shared assumptions.
- **Gemini lane on Pi (v3.22.0).** The only Gemini model the plugin runs is `gemini-4-argon` (`CURRENT_GEMINI_MODEL_ID` in `model-detection.ts`), through Pi on the Vercel AI Gateway (`GEMINI_LANE_MODEL` in `pi-models.ts`). The gemini CLI never starts. `detectCliCapabilities` counts the Gemini lane when `pi` is on PATH and `pi auth check --provider vercel-ai-gateway` reports ready, so a Pi lane on a direct login alone doesn't make it ready. `adaptPromptForGemini` (now in `claude-prompt.ts`; `gemini-prompt.ts` is gone) writes the Pi terminal prompt with `--model gemini-4-argon` on its `am` commands. `isLaneEligible` drops every other Gemini model, so `flywheel_pi_models` neither ranks nor accepts one. The doctor's `gemini_cli` row describes the lane on Pi, and `gemini_model_compat` no longer probes `gemini --version`: it is yellow when the gateway catalog cached by `flywheel_pi_models` no longer offers `google/gemini-4-argon` with tool use, and the swarm mix leaves the Gemini lane out while it is.

## NTM is mandatory for all spawned work

**Hard rule.** Every multi-agent spawn — planning fan-out, swarm waves, deslop sweeps, reality-check follow-ups, scrutiny passes, parallel reviewers, ad-hoc "do these N things in parallel" requests — **must go through NTM** (`ntm spawn` + `ntm --robot-send`). No exceptions.

**What is forbidden as a substitute for NTM:**
- Raw `Task`/`Agent` tool calls to fan out implementation work onto multiple Claude subagents.
- Backgrounded `claude --print` / `codex` / `pi` / `gemini` shells launched with `&` or `run_in_background`.
- `tmux new-window` / `tmux split-window` invoked directly (NTM owns pane lifecycle, robot-send addressing, stagger, and stuck-pane recovery).
- Spawning agents through any other orchestrator (custom shell loops, Makefile parallel targets, `xargs -P`, GNU `parallel`) for work that produces code or PRs.

**Why:** NTM provides the canonical pane registry, robot-send addressing (`--type=cc|cod|gem`, or `--panes=<index>`), Agent Mail integration, stuck-pane detection, stagger to avoid cold-boot thundering herd, and the `--no-user` discipline. Bypassing it loses observability, breaks file-reservation handshakes, and produces work the flywheel cannot track or recover.

**Allowed exceptions (narrow):**
- Single-shot research / read-only Q&A subagents that produce no code and no PRs (e.g. `Explore`, `general-purpose` for one-off lookups). These can use the `Task`/`Agent` tool directly.
- Single foreground `Bash` invocations that complete in-band (linter, test, build).
- Codex-rescue / triangulation calls where the codex skill's contract explicitly handles the dispatch.
- Pi panes from `swarm-spawn.js`. ntm 1.36.1 has no `pi` lane (`--pi=1` fails with `unknown flag: --pi`), so the script adds Pi panes to the session `ntm spawn` created, with `tmux split-window`, and prints their indices for `ntm --robot-send --panes=`. NTM still owns the session and every other pane. Add Pi panes through this script rather than with a hand-written `tmux split-window`.

If you find yourself wanting to spawn N>1 coding workers without NTM, stop and load `/ntm` + `/vibing-with-ntm` first. Reviewers: reject PRs whose skill changes introduce non-NTM fan-out for implementation work.

## NTM pane priority

**Canonical rule (Changed in v3.21.0).** Mixed `cc:pi:gem` 1:1:1 — Claude, Pi, and Gemini at equal share — is the default for every swarm spawn. The model-diversified split is the point: three independent reasoners running in parallel surface different failure modes, and the 1:1:1 ratio is what downstream pipelines (Step 9 fresh-eyes, batch synthesis) assume when they reconcile cross-agent votes. Pi took Codex's seat by operator decision. It runs on a model the user picks through `flywheel_pi_models` at spawn time, from their own Pi logins or the Vercel AI Gateway, and several picked models alternate across the Pi panes. The Gemini lane is Pi too, always on `vercel-ai-gateway/google/gemini-4-argon` (v3.22.0), so no swarm, review round, or picker answer ever runs another Gemini model or the gemini CLI.

**Baseline pattern.** ntm 1.36.1 has no `pi` lane, so swarms spawn through `swarm-spawn.js`, which runs `ntm spawn --no-user --stagger-mode=smart` for the cc and cod lanes and adds the Pi and Gemini panes to the same session. A six-pane spawn:

```
node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" <project> --label <purpose> \
  --cc=2 --pi=2 --pi-model=<provider>/<model>[,<provider>/<model>] --gmi=2
```

Address every pane by the `index` the script prints, with `ntm --robot-send --panes=<index>`. There is no `--type=pi`, and `--type=gmi` doesn't reach the Gemini panes: ntm reports Pi and Gemini panes as type `unknown`, so tend them with `tmux capture-pane` and `#{pane_dead}`. Pi and Gemini prompts reach Agent Mail through the `am` CLI because `--no-approve` skips project MCP servers.

Smaller swarms scale the ratio down (e.g. `--cc=1 --pi=1 --gmi=1` for three panes); larger swarms scale it up while keeping each provider's share equal until the substitution ladder fires.

**Substitution ladder when a provider is unavailable.** The doctor's `claude_cli`, `pi_cli`, `gemini_cli`, `codex_cli`, `swarm_model_ratio`, `codex_config_compat`, and `gemini_model_compat` checks together signal which lanes the host can fill. `pi_cli` is green only when `pi` is on PATH and `pi auth check` reports ready for the gateway or one of the user's Pi logins. `gemini_cli` is green only when `pi` is on PATH and the gateway is ready, and `gemini_model_compat` turns yellow when the cached gateway catalog stops offering gemini-4-argon. A lane switched off with `lanes.<name>: false` in `flywheel.config.yaml` reports green with `disabled: true`; the ladder treats it as missing, but the swarm isn't degraded, so a user who switched Gemini off gets `--cc=2 --pi=4` with no warning. The ladder is gmi→pi→cod→cc, applied lane by lane:

1. **Missing `pi` → `cod`.** Codex takes Pi's share. It's the lane Pi replaced and the other non-Claude reasoner with comparable depth.
2. **Missing `gmi` → `pi`**, or `cod` when Pi is missing too.
3. **All three peers unavailable → `cc`** (cc-only is the last-resort floor; it works, but it gives up the cross-agent fresh-eyes signal — operators should treat it as a degraded mode and log it).

A four-pane spawn that loses Gemini becomes `--cc=2 --pi=2`, not `--cc=4`. `flywheel_approve_beads(action: "start")` and `flywheel_advance_wave` apply the same order server-side (`FALLBACK_PRIORITY` in `mcp-server/src/adapters/model-diversity.ts`), so implementation waves spawn the lane counts they return. The operator preference for "pure cc" swarms is the explicit override that lands at step 3 — it is not the default.

**Deep plan exception (v3.21.0).** Deep plan runs one Claude planner (correctness) and two Pi planners (robustness and ergonomics), each on a model the user picks through `flywheel_pi_models` with roles `robustness` and `ergonomics`, so its spawn is `--cc=1 --pi=2`. Without Pi, Codex takes robustness and a second Claude pane takes ergonomics (`--cc=2 --cod=1`). Duel plan, duel review, the planning-workflow review rounds, and deslop keep their Codex lanes.

**Retired rules.**

- The v3.17.0 canonical `cc:cod:gem` 1:1:1 is **retired**. Codex is now the fallback for a missing Pi, not a default lane.
- The v3.12.0 "prefer `--cod=` over `--pi=`" priority and the pre-v3.12.0 "pi over cod" priority are both **retired**.
- The 2026-10-17 deep-plan Pi pane on `vercel-ai-gateway/google/gemini-4-argon` and its `FW_PI_PLANNER_MODEL` override are **retired** in favor of the user-picked models above.

Applies to every swarm spawn and `ntm --robot-send` invocation in this plugin's skills (`skills/start/_planning.md`, `skills/start/_implement.md`, `skills/start/_deslop.md`, `skills/start/_reality_check.md`, `skills/start/_inflight_prompt.md`, `skills/start/SKILL.md`, `skills/flywheel-swarm/SKILL.md`, and any future swarm/orchestrator skill). Reviewers: reject any PR that ships `--cc=N` alone, `--pi=N` alone, or `--cod=N` alone in production swarm code without a substitution-ladder justification tied to a non-green doctor row. PANE001 also rejects `--pi=` and `--gmi=` on a raw `ntm spawn`, which no override marker can fix: ntm has no Pi lane, and its gmi lane starts the gemini CLI.

## Bead Lifecycle

After running an implementation, ALWAYS close the bead and verify the close took effect:

```
br update <bead-id> --status closed
br show <bead-id> --json   # confirm "status": "closed"
```

If the second call shows anything else, retry the update once before reporting completion. The agent-flywheel coordinator additionally calls `flywheel_verify_beads` after each wave to auto-close stragglers that have a matching commit (`git log --grep=<bead-id> -1`), so a missed close is recoverable but not free — verify locally first.

`flywheel_review` reconciles the bead state automatically: `looks-good` is idempotent on already-closed beads, `hit-me` runs a post-close audit, and `skip` returns `already_closed`. Do not skip `flywheel_review` for closed beads — the legacy "spawn reviewers from `git diff <sha>~1 <sha>`" workaround is no longer required.

## Step 9 - Wave-completion gate

Step 9 is a two-stage gate:

1. **`flywheel_verify_beads`** - status reconciliation: closed beads exist in `br`, matching commits are found for stragglers, and completion attestation files are present.
2. **`flywheel_compliance_audit`** (new in v3.14.0) - invokes `/beads-compliance-and-completion-verification` in single-bead-parallel mode to score every closed bead 0-1000 against literal acceptance criteria. Beads scoring below 700 are auto-reopened. See `docs/superpowers/specs/2026-05-08-beads-compliance-integration-design.md`.

Skip via `FW_COMPLIANCE_OVERRIDE=<bead-id-list>` or the in-menu override path.

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

Docs-only diffs: set `ubs.ran=false` with a non-empty `ubs.skippedReason` ("docs-only diff", etc.). Do not silently skip. The per-bead implementer prompt that `flywheel_advance_wave` returned in `nextWave.prompts[]` already carries the gate text and a filled-in JSON example — copy its shape rather than improvising. If you were spawned outside that path, use the schema fields listed in this section directly; the implementer skills (`skills/flywheel-swarm/SKILL.md`, `commands/flywheel-swarm.md`, `skills/start/_implement.md`) point here instead of duplicating the example.

`flywheel_observe.hints[]` surfaces missing/stale attestation files during session recovery (severity `warn` for missing, `red` for invalid), so a forgotten attestation shows up at the next `/start` rather than silently rotting.

## Agent Coordination

- Bootstrap your agent-mail session with `macro_start_session` at the start of each task.
- Before modifying any file, request a file reservation via agent-mail.
- Report errors to the team lead via agent-mail with subject `[error] <context>`. Do not silently skip tasks.
- Check your agent-mail inbox at task start for updates or cancellations.

### Known issue: agent-mail exclusive-reservation enforcement is advisory

`file_reservation_paths(... exclusive=true)` does **not** reject overlapping requests at the server level. When two agents request exclusive reservations on the same path, the second request returns a response with **both** a populated `granted` array (a fresh reservation id with `exclusive: true`) **and** a populated `conflicts` array naming the existing holder. The server tells you about the conflict but issues the reservation anyway. Reproduced 2026-04-27 against agent-mail running at `http://127.0.0.1:8765/mcp` (bead `agent-flywheel-plugin-j0b`).

**Coordinator-side mitigation, mandatory for now:**

1. **Use `reserveOrFail()` from `mcp-server/src/agent-mail-helpers.ts`** (v3.11.0+). This helper wraps `agentMailRPC("file_reservation_paths", ...)` and treats any non-empty `conflicts` array as failure even when `granted` is also populated, with one exponential-backoff retry before failing. `reserveFileReservations()` routes through the same helper. **Do not call `agentMailRPC("file_reservation_paths", ...)` directly**. The `RESERVE001` lint rule (`mcp-server/src/lint/rules/reserve001.ts`) flags every raw call outside the helper module. Use `releaseReservations(reservationIds)` for the symmetric release.
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

The MCP tools were renamed from `orch_*` to `flywheel_*`. The `orch_*` names are preserved as deprecated aliases that dispatch to the same runners, and will be removed in v4.0. Always use the `flywheel_*` names in new code and docs. v3.11.7+ logs a one-shot `orch_deprecation_warned` per alias call with the canonical replacement, so callers can migrate without searching the diff for the rename.

## SKILL.md linting

Changes to any `skills/start/*.md` file (SKILL.md and the `_*.md` sub-skills) must pass `npm run lint:skill` from `mcp-server/`. The linter validates AskUserQuestion call sites, slash-skill references, placeholder definitions, Universal Rule 1 enforcement, and a per-file tone-token ratchet.

Style guide for the prose itself lives at [`docs/skill-style.md`](docs/skill-style.md) — plain sentences over all-caps directives, tool facts stated once, no quotas, rationale in `docs/design/` not skills. The TONE001 rule in `mcp-server/src/lint/rules/tone001.ts` counts the discouraged tokens per file and ratchets the ceiling down over time; a PR that raises any file's count above its baseline fails CI.

- Local: `cd mcp-server && npm run lint:skill`
- Auto-fix safe issues (future): `npm run lint:skill -- --fix` (deferred to v1.1)
- Update baseline after curating findings: `npm run lint:skill:update-baseline`
- Update skill manifest after adding/removing skills: `npm run lint:skill:update-manifest`

CI enforces this on every PR via `.github/workflows/ci.yml` (`lint-skill` job). The job runs `node dist/scripts/lint-skill-dir.js --dir ../skills/start --ci --baseline` and emits PR annotations via the `gha` reporter format.
