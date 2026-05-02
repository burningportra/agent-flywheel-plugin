# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.11.3] - 2026-05-02

### Changed

- **Reality check promoted to top-level on every `/agent-flywheel:start` menu.** The 3-prompt sequence in `skills/start/_reality_check.md` (read AGENTS.md + README.md → code investigation → exhaustive `/reality-check-for-project` → granular `br` bead graph → optional NTM swarm) was already wired but lived only in the `open-beads-exist` menu and the `Other` sub-menu of the other two states. v3.11.3 surfaces it on the `previous-session-exists` and `fresh-start` menus too. On fresh-start it is the **Recommended** option whenever the repo has either `AGENTS.md` or `README.md` at root (the gap-vs-vision baseline that makes the pass meaningful); on greenfield repos with neither, "Scan & discover" remains Recommended. Deslop pass moves to the `Other` sub-menu on the previous-session and fresh-start states; it remains top-level on `open-beads-exist`. Reality check is no longer duplicated in any `Other` sub-menu now that it is top-level everywhere.

## [3.11.2] - 2026-05-02

### Fixed

- **Hook paths leaked stderr on every Bash call.** `hooks/hooks.json` referenced `node hooks/agent-mail-guard.js` and `node hooks/startup.js` as relative paths, which Claude Code resolves against the project's cwd, not the plugin install dir. When the project lacked a `hooks/` directory the PreToolUse:Bash entry produced a `MODULE_NOT_FOUND` on every Bash tool call (the sister Stop / SubagentStop / SessionStart entries swallowed it via `2>/dev/null || true`, but PreToolUse:Bash did not). All four hook commands now use `"${CLAUDE_PLUGIN_ROOT}/hooks/..."` with consistent error suppression.

## [3.11.1] - 2026-05-02

### Fixed

- **Agent Mail activity-lock repair path.** `agent_mail_liveness` remediation now performs the safe service-aware sequence for `Resource is temporarily busy ... mailbox activity lock is busy`: stop the supervised Agent Mail runtime, run `am doctor repair --yes`, run `am doctor archive-normalize --yes`, restart Agent Mail, and verify `/health/liveness`. The handler restarts the service in a `finally` path so a failed repair does not leave Agent Mail down.
- **NTM swarm guardrails for Agent Mail maintenance.** Claude hooks and a Pi project extension now block mutating `am doctor` commands and activity-lock deletion from swarm panes, while Stop/SubagentStop/session-shutdown hooks best-effort release file reservations when an agent identity is available. Swarm prompts and provider adapters tell implementors to report Agent Mail health issues to the coordinator instead of racing the daemon.

### Changed

- **Doctor and troubleshooting docs.** `/flywheel-doctor`, `AGENTS.md`, `README.md`, and swarm marching orders now point to `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })` as the canonical fix and explicitly warn not to delete Agent Mail lock files.

## [3.11.0] - 2026-04-30

Runtime-safety + recovery substrate from the 2026-04-30 3-way duel cohort (`docs/duels/2026-04-30.md`, plan `docs/plans/2026-04-30-duel-winners.md`). Three composable features land together: a durable JSON ledger for completion evidence, a single-call session-state snapshot, and a coordinator-side helper that closes the v3.10.x file-reservation conflict-handling gap.

### Added

- **Completion Evidence Attestation (Stage 1).** New module `mcp-server/src/completion-report.ts` (T1, `6fd5e10`) exports `CompletionReportSchemaV1` — versioned Zod schema with `version: 1` and an additive-forever evolution rule (never remove keys; new fields must be optional). Required shape covers `beadId`, `agentName`, `status` (`closed|blocked|partial`), `changedFiles[]`, `commits[]`, `ubs.{ran, summary, findingsFixed, deferredBeadIds[], skippedReason?}`, `verify[].{command, exitCode, summary}`, `selfReview.{ran, summary}`, `beadClosedVerified`, `createdAt`. Helpers `readCompletionReport` / `validateCompletionReport` / `formatCompletionEvidenceSummary` / `writeCompletionReport` provide the read/parse/render path. Path traversal is rejected at two layers: schema-level refine on absolute paths and `..`-traversal, plus a cwd-resolve check in the validator as defense-in-depth. 21 unit tests cover the 5 acceptance cases (valid full report, docs-only UBS skip with reason, missing verify, closed-without-verification invariant, path-escape) plus 16 defensive cases.
- **Coordinator validation gate.** `flywheel_verify_beads` (T2, `24c5b89`) reads `.pi-flywheel/completion/<beadId>.json` for every closed bead and returns `missingEvidence: string[]` + `invalidEvidence: InvalidEvidenceEntry[]` in `VerifyBeadsOutcome`. Stragglers (open + no commit) skip the check — no implementor has claimed completion yet. `flywheel_advance_wave` is the gate. **Stage 1 default is warn-only** — sets `needsEvidence: true` on the outcome and surfaces the count in the human text without blocking. Set `FW_ATTESTATION_REQUIRED=1` in the coordinator's environment to flip to hard-block, returning the new structured error codes `attestation_missing` or `attestation_invalid` with populated `error.hint`. Default flips to required in a future release once the corpus stabilises (per PI2 reveal-phase concession in the duel that day-one hard-blocking would break in-flight workflows). 30 new tests cover the gate; `FLYWHEEL_ERROR_CODES` is now 38 total (was 36).
- **Implementor prompt updates.** Pre-Completion Quality Gate marching-orders block (T3, `8a7f02e`) now requires step (4) "write `.pi-flywheel/completion/<beadId>.json` matching `CompletionReportSchemaV1`" with a worked JSON example. Synchronised structurally identically across `skills/flywheel-swarm/SKILL.md`, `commands/flywheel-swarm.md`, and `skills/start/_implement.md` (new STEP 3.5 — WRITE COMPLETION ATTESTATION) per the duel's Command/Skill Drift critique. Each block includes docs-only guidance (`ubs.ran=false` + non-empty `ubs.skippedReason`), the `status=closed` requires `beadClosedVerified=true` invariant, and the `version: 1` additive-forever reminder.
- **Lock-aware reservation helper.** New module `mcp-server/src/agent-mail-helpers.ts` (T4, `13837ac`) exports `reserveOrFail(paths, opts)` and `releaseReservations(reservationIds)`. `reserveOrFail` wraps `agentMailRPC("file_reservation_paths", ...)` and treats any non-empty `conflicts` array as failure even when `granted` is also populated — codifies the AGENTS.md "Known issue" mitigation that has lived as advisory prose since the 2026-04-26 reality-check. One exponential-backoff retry before failing; symmetric `releaseReservations` for the release path.
- **`RESERVE001` lint rule.** New rule `mcp-server/src/lint/rules/reserve001.ts` (T5, `88e65f5`) flags direct `agentMailRPC("file_reservation_paths", ...)` calls outside the `agent-mail-helpers.ts` module. The existing single use in `mcp-server/src/agent-mail.ts:228` is baselined in `.lintskill-baseline.json`; new offenders fail the `lint:skill` CI gate.
- **`flywheel_observe` MCP tool.** New tool `mcp-server/src/tools/observe.ts` (T6, `f7c4b56`; T7 attestation integration, `fadb251`). Single-call session-state snapshot returning a versioned `FlywheelObserveReport` covering `cwd`, `git`, `checkpoint`, `beads`, `agentMail`, `ntm`, `artifacts`, and `hints[]` with `severity: info|warn|red`. Hard rules from the duel: idempotent, non-mutating, sub-1.5s total tool runtime, every external probe degrades gracefully (`unavailable: true` rather than failing the whole call). Doctor probes are cached or short-budgeted. Hint surface includes missing or invalid completion attestation files (severity `warn` for missing, `red` for invalid) so a forgotten dogfood JSON shows up at the next `/start` rather than silently rotting. Replaces the 6-tool-call recovery archaeology that the duel originated from (`git status` + `git log` + `ls .pi-flywheel/` + `cat checkpoint.json` + `tmux list-panes` + `tmux capture-pane`).

### Changed

- **`AGENTS.md` Pre-Completion Quality Gate.** New "Completion Evidence Attestation (v3.11.0+)" subsection codifies the JSON-ledger requirement as a binding contract; prose evidence in the completion message remains necessary but no longer sufficient.
- **`AGENTS.md` Known issue (file reservations).** Coordinator-side mitigation now points at `reserveOrFail()` as the canonical helper instead of advisory prose; `RESERVE001` lint rule names the enforcement mechanism.
- **`AGENTS.md` MCP tools section.** New "MCP tools added in v3.11.0" entry documents `flywheel_observe`, the attestation Stage 1 module, and the reservation helper + lint rule.
- **`mcp-server/dist/skills.bundle.json`** rebuilt with new `manifestSha256` after the v3.11.0 documentation pass.

### Known issues (carried forward)

- `live-flywheel.test.ts › lint-skill --ci --baseline` canary still failing on pre-existing `skills/start/SKILL.md` lint findings (unclosed code fence at line 26, AUQ001 5-option overflow at lines 240/257/274). Unchanged from v3.10.x; tracked separately.

## [3.10.2] - 2026-04-30

### Fixed

- **Duel pre-flight false-negative.** `cc/cod/gmi` are ntm pane-type labels, not local binary names — the underlying CLIs are `claude`, `codex`, `gemini`. Previous pre-flight scripts ran `which cc` (matches `/usr/bin/cc`, the C compiler) and `which cod` / `which gmi` (always missing), so `/agent-flywheel:flywheel-duel` aborted with `DUEL_BLOCKED reason=insufficient-agents` even when all three CLIs were healthy via ntm. Pre-flight now checks `claude`, `codex`, `gemini` directly across `skills/flywheel-duel/SKILL.md`, `skills/start/{SKILL,_planning,_review}.md`, `skills/flywheel-swarm/SKILL.md`, `commands/flywheel-{swarm,duel,reality-check}.md`, and the duel-plan instruction string emitted by `mcp-server/src/tools/plan.ts`. Doctor's `claude_cli` / `codex_cli` / `gemini_cli` checks were already correct and are unchanged.

## [3.10.1] - 2026-04-30

### Changed

- **Wave-1 deslop pass.** 5-pane NTM swarm (FoggyRabbit / SilverReef / StormyRaven / RoseLark / WhiteCedar) applied `/simplify-and-refactor-code-isomorphically` across `mcp-server/src/tools/`, `mcp-server/src/` infra, `mcp-server/src/` domain, `mcp-server/scripts/` + `src/lint/`, and `skills/` + `commands/`. Six narrow isomorphism-preserving levers landed; tests at 1492 passing held; net -94 LOC across regenerated `dist/`.
  - `share ok tool result helper` (pane 1) — collapses 4 copies of the success-envelope idiom in `mcp-server/src/tools/{advance-wave,plan,review,verify-beads}.ts` into `tools/shared.ts`.
  - `share newest mtime walker` (pane 1) — dedup between `tools/doctor.ts` and `tools/remediations/dist_drift.ts`.
  - `use FlywheelError for clone safety` (pane 2) — replaces the only ad-hoc `Error` subclass (`CloneSafetyError`) with a `FlywheelError` factory while keeping the class as a backwards-compat alias; aligns with AGENTS.md error contract.
  - `share python docstring detection` (pane 3) — extracts `findPyDocstringLines()` from `todo-scanner.ts` (-37 LOC).
  - `centralize lint reporter helpers` (pane 4) — shared `visibleFindings` / `severityLabel` / `countBySeverity` across 4 reporters.
  - `tighten healthcheck prose` (pane 5) — markdown-only deslop in `commands/flywheel-healthcheck.md` and `skills/flywheel-healthcheck/SKILL.md`.

### Known issues (carried forward)

- `live-flywheel.test.ts › lint-skill --ci --baseline` canary still failing on pre-existing `skills/start/SKILL.md` lint findings — separate issue, not deslop-induced.

## [3.10.0] - 2026-04-30

### Added

- **Pre-Completion Quality Gate for swarm implementors.** Every NTM-spawned implementor pane now receives a `## Pre-Completion Quality Gate` block in its `ntm --robot-send` marching-orders payload (`skills/flywheel-swarm/SKILL.md` Step 5) requiring, in order: (1) `/ubs-workflow` scoped to changed files with explicit triage of every finding (fix / new bead / justify), (2) repo verify commands per AGENTS.md (build/test/typecheck/lint or canonical helper like `rch`), (3) self-review with fresh eyes. Completion messages must carry UBS result + verify outcome + one-line self-review summary, or the coordinator's review gate bounces them.
- **Durable AGENTS.md contract.** New `Pre-Completion Quality Gate` section in `AGENTS.md` codifies the same three-step rule as a repo-wide binding contract for every NTM-spawned implementor (swarm waves, deslop sweeps, reality-check follow-ups, ad-hoc parallel work). Anchors the swarm skill's marching-orders payload so future skill rewrites cannot weaken the gate silently.

## [3.9.3] - 2026-04-30

### Changed

- **`/start` skill body loading: MCP-first.** UNIVERSAL RULE 3 in `skills/start/SKILL.md` promoted `flywheel_get_skill` from "optional optimization" to PRIMARY path, with `Read` as disk-fallback only. Sub-skill table expanded to all 10 bundled `agent-flywheel:start*` entries (`start_planning`, `start_beads`, `start_implement`, `start_review`, `start_wrapup`, `start_reality_check`, `start_deslop`, `start_saturation`, `start_inflight_prompt`).
- **Skill-stub recovery rule.** When the harness returns just the frontmatter / pointer text instead of the canonical body (the "skill already loaded — follow it directly" ack), agents now call `flywheel_get_skill` for a single MCP round-trip instead of falling back to `Read`. Documented in both `skills/start/SKILL.md` UNIVERSAL RULE 3 and `AGENTS.md` "Fast path for skill bodies (PRIMARY)" section.

## [3.8.1] - 2026-04-29

### Fixed

- **`flywheel_doctor` mcp_connectivity false positive on plugin installs.** The check was a structural proxy that looked for `cwd/mcp-server/dist/server.js`, which doesn't exist when users run via the installed plugin (the dist lives under `~/.claude/plugins/...`). It now uses `import.meta.url` proof-of-life: if the doctor code is running, MCP is connected by definition. Reports `green` with `"server responded (plugin install)"` or `"server responded (local checkout)"` based on running module location. Source/dist drift remains a separate check (`dist_drift`). ([mcp-server/src/tools/doctor.ts:329-380](mcp-server/src/tools/doctor.ts:329))

## [3.8.0] - 2026-04-28

### Added — High-stakes track (`/dueling-idea-wizards` integration)

Surfaces the global `/dueling-idea-wizards` skill as one extra row in the menus the user already sees in `/agent-flywheel:start`. Adversarial 2-agent (cc + cod, plus gmi when available) cross-scoring is now a first-class generator at four seams: discovery, planning, reality-check, and review-of-risky-beads. Single-agent paths remain default; the duel is opt-in.

- **Step 3 Discover menu** — new `Duel (dueling-idea-wizards)` row alongside Fast / Deep / Triangulated. Two agents independently brainstorm 5 ideas each, cross-score 0–1000, reveal, and synthesize. Results feed `flywheel_discover` with `provenance.source = "duel"` per idea; selection menu groups options under **Consensus winners** / **Contested** / "Dead ideas (FYI)".
- **Step 5 Plan menu** — new `Duel plan` row alongside Standard / Deep / Triangulated / planning-workflow. `flywheel_plan(mode="duel")` returns the verbatim `/dueling-idea-wizards --mode=architecture --top=3 --rounds=1 --focus="<goal>"` invocation, sets `state.planSource = "duel"`, and synthesizes into `docs/plans/<date>-<slug>-duel.md` with an "Adversarial review" section.
- **`/flywheel-reality-check` `--duel` flag / depth-menu row** — `--mode=reliability --focus="vision-vs-code drift"`. Consensus gaps become beads with `provenance.source = "reality-check-duel"`; contested gaps surface to the user via `AskUserQuestion` for explicit decision.
- **Step 9 Review** — risky-bead heuristic (priority p0, security/auth/crypto/secret/permission/migration/breaking-change keywords, partial impl, contested upstream provenance) auto-routes to a 2-agent `/dueling-idea-wizards --mode=security|reliability` review against the bead's diff. Non-risky beads keep the existing 5-agent fresh-eyes review.

**Cross-cutting plumbing:**

- New `IdeaProvenance` type (`mcp-server/src/types.ts`) with `source`, `runAt`, `agentScores`, `contested`, `survivingCritique`, `steelman` fields. `CandidateIdea.provenance?` and `FlywheelState.planSource?` added; `PlanArgs.mode` extended to `"standard" | "deep" | "duel"`.
- `flywheel_discover` (`mcp-server/src/tools/discover.ts`) surfaces `duelIdeas` / `contestedIdeas` counts, agent cross-scores, and the surviving-critique line in the rendered idea list. Returns the `provenance` object in structured content for downstream tools.
- `flywheel_plan` (`mcp-server/src/tools/plan.ts`) gains a `mode="duel"` branch returning a `duel_plan_spawn` payload with the exact `/dueling-idea-wizards` invocation, brainstorm-artifact handoff, and pre-flight gate documentation.
- Bead provenance template (`skills/start/_beads.md` Step 5.5) — every bead created from a duel-sourced idea or plan carries a `## Provenance` block with agent cross-scores, the strongest surviving critique, and (if Phase 6.75 ran) a steelman one-liner. Downstream implementers and reviewers inherit the adversarial context without extra prompting.
- New `/agent-flywheel:flywheel-duel` direct entry point (`commands/flywheel-duel.md` + `skills/flywheel-duel/SKILL.md`) — state-aware: picks `--mode` from `state.phase`, routes the `DUELING_WIZARDS_REPORT.md` synthesis into the right `docs/` subfolder, and chains into `flywheel_discover` / `flywheel_plan` / per-bead review automatically.
- `/flywheel-status` detects `WIZARD_*.md` artifacts and surfaces the inferred duel phase (ideation / cross-scoring / reveal / complete) plus stale-artifact age.
- `/flywheel-doctor` documents how the existing `ntm_binary` + `claude_cli` + `codex_cli` + `gemini_cli` + `swarm_model_ratio` checks together cover duel-readiness (no new probe needed).
- `/flywheel-healthcheck` flags `WIZARD_*.md` and `DUELING_WIZARDS_REPORT.md` older than 7 days for review (never auto-deletes — these contain irreplaceable adversarial-debate transcripts).
- `/idea-wizard` SKILL.md adds a "When to escalate to a duel" decision rule (high-stakes architecture, contested code, no obvious right answer, blue-sky exploration).
- `AGENTS.md` + `README.md` document the high-stakes track with a 4-seam table.

**Pre-conditions for any duel.** ntm + ≥2 of {cc, cod, gmi} healthy. Cost: ~20–55 min per run. If only 1 CLI is available, the duel skill aborts in Phase 1 detection and the flywheel falls back to single-agent paths automatically.

## [3.7.2] - 2026-04-28

### Changed

- **`/planning-workflow` integrated into `_planning.md` Step 5 planning modes.** Added `"planning-workflow"` as a fourth planning mode option (alongside Standard, Deep, Triangulated). When selected, invokes `/planning-workflow` for the exact review prompt, then runs 4-5 sequential Codex review rounds via NTM (`ntm spawn --type=cod`), integrating revisions with `ultrathink` between rounds. Also wired into the Step 5.6 "Refine plan" path as a Codex-via-NTM alternative to the internal Opus agent.
- **`/idea-wizard` and `/xf` references corrected in `SKILL.md` Step 3.** Removed the erroneous "Market-validated" discovery depth option (which called `xf` with `site:x.com` — a web search operator invalid for the local archive CLI). Clarified the "Deep" path: runs idea-wizard phases 2–4 only (idea generation + overlap check); phases 5–6 (bead creation) are skipped since the flywheel handles that in Steps 5.5–6.

## [3.7.1] - 2026-04-27

### Fixed

- **doctor `--help` fallback for binaries without `--version` (a91647e).** `checkBinary` in `mcp-server/src/tools/doctor.ts` now retries with `--help` when `--version` exits non-zero before declaring the CLI yellow. Previously, working `ntm` installs surfaced as `yellow` (`ntm --version returned code 1`) because ntm doesn't expose `--version`. Two regression tests added covering the fallback-success and both-fail paths.
- **synthesizer tags beads with `Template: <id>` for calibration (06984da, claude-orchestrator-1v5).** `mcp-server/src/br-parser.ts` now extracts `Template: <id>` (and optional `Template: <id>@<version>`) from bead descriptions into a first-class `template` field. `mcp-server/src/prompts.ts` and `deep-plan.ts` instruct synthesized bead bodies to include a machine-readable `Template:` line for template-backed beads. Closes the v3.7.0 known issue where `flywheel_calibrate` only saw `__untemplated__` rows because `br create` doesn't natively tag beads. Acceptance: next 10 flywheel-driven beads will populate per-template aggregates.

## [3.7.0] - 2026-04-27

### Added — Ergonomic four-pack (18 beads, 4 waves, all closed in one session)

A unified ergonomic initiative spanning 4 features. Goal-shaped via `/start`, deep-planned by 3 perspective agents (correctness/ergonomics/robustness) into a synthesized plan, decomposed into 18 atomic beads with explicit dependency graph, executed in 4 waves with file-overlap analysis driving parallel-vs-serial decisions per wave.

**Feature 1 — inline doctor remediation.** New `flywheel_remediate({ checkName: DoctorCheckName, autoConfirm?, mode? })` MCP tool with a `Record<DoctorCheckName, RemediationHandler | null>` registry and `assertExhaustive(_: never)` exhaustiveness gate (compile-time TS error if a `DoctorCheckName` is added without a matching handler entry). Default mode is `dry_run`; mutating handlers refuse `mode: 'execute'` without `autoConfirm: true`. Per-check mutex via `mcp-server/src/mutex.ts` prevents concurrent runs (concurrent caller returns `remediate_already_running`). Five handlers ship in v3.7.0: `dist_drift` (rebuild dist), `mcp_connectivity` (verify build artifacts), `agent_mail_liveness` (instruct + verify; intentionally non-mutating since spawning a detached subprocess from MCP context is unsafe), `orphaned_worktrees` (enumerate + per-entry remove with `autoConfirm` gate), `checkpoint_validity` (move to `.bak` then re-validate). Every handler ships a `verifyProbe` that re-runs the original doctor check after the fix; result envelope includes `verifiedGreen: boolean` so shell-exit-zero ≠ "check is green". `skills/flywheel-doctor/SKILL.md` was rewritten to render an inline AskUserQuestion next to each failing check row (per the ergonomics-perspective friction-fix), not at the report bottom. CASS log line documented for future "time-to-healthy" rollups.

**Feature 2 — plan estimation calibration.** New `EstimatedEffort` type union (`'S' | 'M' | 'L' | 'XL'`) + `EFFORT_TO_MINUTES` map (`30 / 90 / 240 / 720`) + optional `estimatedEffort?: EstimatedEffort` field on `BeadTemplate`. All 15 built-in bead templates backfilled with appropriate effort tiers. New `flywheel_calibrate({ cwd, sinceDays? = 90 })` MCP tool parses `br list --json --status closed`, applies the `sinceDays` filter, and prefers `git log --grep=<bead-id> -1 --format=%aI --reverse` as the `started_ts` proxy (capped at 200 git calls per run; falls back to `created_ts` with `proxy_started: false` tag past the cap). Drops samples where `closed_ts < started_ts` (clock skew). Buckets pre-template beads under `__untemplated__` separately. Writes report to `.pi-flywheel/calibration.json`. `/flywheel-status` renders the per-template table with `▲` (ratio > 1.25, under-estimated) / `▼` (ratio < 0.8, over-estimated) markers; gates on `totalBeadsConsidered ≥ 3` to avoid cold-repo noise; per-row `n < 5` flagged `lowConfidence`. Deep-plan synthesizer prompt (`mcp-server/src/deep-plan-synthesis.ts`) splices the top-5 high-confidence rows so future planners self-calibrate without bead mutation (per Q5 alignment-check decision: prompt-injection only).

**Feature 3 — skill markdown precompilation.** New build step `mcp-server/scripts/build-skills-bundle.ts` walks all `skills/**/SKILL.md` (38 files) + `skills/start/_*.md` (9 files), parses frontmatter via the existing `unified` + `remark-parse` stack (zero new runtime deps), atomic-writes (`tmp → fsync → rename`) to `mcp-server/dist/skills.bundle.json` with per-entry `srcSha256` + aggregate `manifestSha256`. Caps enforced: 5 MiB total, 200 KiB per entry; build fails over cap with actionable error. Companion `check-skills-bundle.ts` is the CI gate (re-walks source, compares hashes, exits non-zero on drift). Both wired into `npm run build` chain. New `flywheel_get_skill({ name: "<plugin>:<skill>" })` MCP tool serves the bundled body in one round-trip with 4-layer drift defense: (1) build-time CI check, (2) runtime `manifestSha256` integrity (falls back to disk on mismatch + emits `bundle_integrity_failed` log), (3) per-entry `srcSha256` stale-warn (still serves the bundle entry, sets `staleWarn: true` in response — stability over liveness in production), (4) `FW_SKILL_BUNDLE=off` env-bypass for contributors editing skills live. Returns `{ name, frontmatter, body, source: 'bundle' | 'disk', staleWarn? }`. The orchestrator session-start path still uses `Read` for skill files in v3.7.0 (explicit non-goal #11); a follow-up will replace those calls.

**Feature 4 — read-only web bead-graph visualizer.** New `mcp-server/scripts/bead-viewer.ts` is a Node CLI using only `node:http` + `node:fs/promises` + `node:child_process` (zero new runtime deps; Cytoscape loaded via CDN with `crossorigin="anonymous"` SRI). Default bind: `127.0.0.1:0` (ephemeral OS-assigned port; URL printed on startup). Override: `--port N`. Hard refusal at startup if `process.env.FW_VIEWER_BIND` is anything other than a loopback alias. Caps from the robustness-perspective threat model: 16 concurrent connections, 30 req/s/IP rate limit, 2000 nodes max (banner shown when truncated), 60s per-connection timeout, parent-pid watch (exits within 2s of parent SIGKILL). Routes are read-only: `GET /` (static HTML shell), `GET /assets/*` (sandboxed under fixed root, path-traversal returns 403), `GET /api/graph` (consumes `br list --json` + `br dep list --json` via `child_process.execFile`, runs through new pure `mcp-server/src/bead-graph.ts` `buildBeadGraph` + Tarjan SCC for cycle detection with deterministic ordering), `GET /api/bead/:id` (single bead via `br show`). **Bead bodies served as JSON only — never inlined into HTML** (XSS defense; JSDOM regression test in `chaos/viewer-xss.test.ts` injects `<script>__pwn=1</script>` and asserts `window.__pwn === undefined` after render). Auto-opens browser via `open` / `xdg-open` / `start` (`--no-open` to skip). New slash command: `/agent-flywheel:flywheel-bead-viewer`. New npm script: `npm run bead-viewer`.

**Cross-cutting:**
- 7 new `FlywheelErrorCode`s: `remediation_unavailable`, `remediation_requires_confirm`, `remediation_failed`, `remediate_already_running`, `bundle_integrity_failed`, `bundle_stale`, `viewer_port_in_use`. Each gets `DEFAULT_HINTS` + `DEFAULT_RETRYABLE` entries (29 → 36 codes total).
- New shared `mcp-server/src/br-parser.ts` (zod-validated `br list --json` row schema) used by both `flywheel_calibrate` and the bead-viewer's data layer.
- New pure `mcp-server/src/calibration-store.ts` exports `computeDurationStats(durationsMinutes: number[]): DurationStats` (mean/median/p95/min/max; handles empty/single/large in <100ms for 5k samples).
- New pure `mcp-server/src/bead-graph.ts` exports `buildBeadGraph(listJson, depJson): BeadGraph` with Tarjan SCC (deterministic ordering, sorted by smallest id within each cycle).
- New `mcp-server/src/skills-bundle.ts` exports `loadSkillsBundle(bundlePath?)` + `getSkill(name, opts?)` with module-scope cache, integrity invalidation, disk fallback.
- 7 new vitest test files (T15-T18): `tools/remediate.test.ts` + 4 chaos files (kill-midrun, concurrent, fix-but-still-broken, headless), `calibration-store.test.ts` + `tools/calibrate.test.ts` + 4 chaos files, `skills-bundle.test.ts` + `tools/get-skill.test.ts` + 4 chaos files (corrupt-fallback, stale-warns, not-found, bypass-env), `bead-graph.test.ts` + 5 chaos files (xss, port-collision, bind-localhost, path-traversal, parent-death). Net: ~80 new tests across the suite. `jsdom` + `@types/jsdom` added to `devDependencies` for the XSS regression test.

### Process notes from this release

- 3-perspective deep-plan (Opus correctness / Sonnet ergonomics / Opus robustness) synthesized into a single 422-line plan resolved 5 unresolved tensions (U1-U5) with explicit reasoning. Synthesis's plan-acknowledgment block ("what each perspective does best") was high-signal — kept it as a release-process pattern.
- Empirical pre-alignment verification caught 4 numeric inaccuracies in the synthesized plan (10 vs 12 tools, 15 vs 9 templates, 29 vs ~25 error codes, 47 vs unspecified bundle file count) AND surfaced the load-bearing **G1 gap** (all 49 pre-existing closed beads are `__untemplated__` because `br create` doesn't tag beads with their template id) BEFORE shipping. G1 filed as `claude-orchestrator-1v5` for follow-up.
- Wave-0 had a worktree-isolation bug: Agent() `isolation: "worktree"` parameter does NOT actually create git worktrees (verified via `git worktree list`). Agents worked in shared cwd; `git add -A` swept across agents. T4's bead-graph.ts ended up in T5's commit. Fixed for waves 1-3 by switching every impl agent prompt to use explicit `git add <files>` per the bead's documented file list (and a "STOP if you see other agents' files modified" rule). Held cleanly through 13 wave-1/2/3 commits. Worktree-isolation bug worth a separate investigation.
- Agent Mail (Rust port `mcp_agent_mail_rust@0.2.48`) had `durability_state: corrupt` on the development host this session. `macro_start_session` returned a transient DB error. Workaround: skip Agent Mail bootstrap for impl agents (they spawned via Agent() not NTM, so the messaging integration was unused anyway). Coordinator (this session) used direct HTTP JSON-RPC for the few Agent Mail calls that did run (`register_agent`, `install_precommit_guard`).
- `install_precommit_guard` set `core.hooksPath` to a stale `/Volumes/1tb/Projects/claude-orchestrator/.git/hooks` path (the project's old name before rename to `agent-flywheel`). Hook fired on every commit with `guard could not locate archive for project '/Volumes/1tb/Projects/agent-flywheel'`. Resolved locally via `git config --unset core.hooksPath`. Tracked as a separate follow-up.
- Reality-check pass (post-wave) confirmed 4-of-4 features deliver as designed; only G1 (calibration data) is materially gapped. Gap report persisted to CASS as `b-mohznk9q-v8z40a`.

## [3.6.11] - 2026-04-27

### Changed

- **Agent Mail: Rust port (`mcp_agent_mail_rust`) is now the primary distribution.** Upstream rewrote agent-mail in Rust as a standalone binary (`mcp-agent-mail` server + `am` operator/robot CLI) that ships pre-built — no `uv` / `python3` required to install or run. The Rust port is wire-compatible with the legacy Python build on the same `http://127.0.0.1:8765/mcp` HTTP transport with the same MCP tool names, so all runtime integration (`mcp-server/src/agent-mail.ts`, `gates.ts`, `tender.ts`, `swarm.ts`, `tools/doctor.ts`, `.mcp.json`) works untouched. This release flips the **install / detect / start / docs** path to Rust-first, with the Python build retained as a labeled fallback for existing installs:
  - `commands/flywheel-setup.md` + `skills/flywheel-setup/SKILL.md`: §0 ACFS-stack probe now checks `command -v mcp-agent-mail || command -v am` first; the Python `python3 -c "import mcp_agent_mail"` probe is the documented fallback. Stack-script prerequisite line drops `uv` / `python3` from the *required* set (still optional for cass/cm). §5 install path uses `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail_rust/main/install.sh?$(date +%s)" | bash` and the auto-start command is `nohup am serve-http > /dev/null 2>&1 &` (or `nohup mcp-agent-mail serve > /dev/null 2>&1 &` if `am` is missing); the legacy `nohup uv run python -m mcp_agent_mail.cli serve-http &` path is retained behind a clearly-labeled "Legacy Python installed" branch with a migrate-to-Rust nudge.
  - `skills/flywheel-doctor/SKILL.md`: `agent_mail_liveness` remediation hint now suggests `am serve-http` first, `mcp-agent-mail serve` second, Python last.
  - `AGENTS.md`: "Diagnosing Connection Issues" section replaces `npx agent-mail-server` with the Rust binaries and adds the `/health/liveness` probe alongside `/mcp`.
  - `README.md` + `CONTRIBUTING.md`: Required-tools / optional-tools rows now link to `mcp_agent_mail_rust` with the legacy Python build noted as still-supported on the same transport.

  No code in `mcp-server/src/**` was touched, no schema changed, and no `.mcp.json` rewrite is needed — operators with a working Python install keep working until they choose to migrate. The startup-hook line `Agent Mail: NOT RUNNING (start with: am)` already pointed at the Rust CLI.

## [3.6.10] - 2026-04-26

### Fixed

- `skills/start/SKILL.md` frontmatter `name:` field was `flywheel` but the skill is invoked as `agent-flywheel:start` (directory-derived). The mismatch caused Claude Code's `Skill` tool to load the body as a "pointer/stub" rather than the canonical instructions — operators saw `Successfully loaded skill` followed by Claude reverting to manually `find`-ing the file. Frontmatter now reads `name: start`, matching the directory and the slash-command invocation. Per `superpowers:writing-skills`, the `name:` field MUST equal the parent directory name exactly; this had been latent for several releases. No content changes — only the frontmatter `name`.

## [3.6.9] - 2026-04-26

### Changed

- **NTM pane priority — auto-swarm and friends now spawn `pi` by default.** v3.6.8 flipped the deep-plan/impl/deslop spawn skills but missed the canonical `/agent-flywheel:start` auto-swarm prompt and several other surfaces, so the Step 0d "Auto-swarm (Recommended)" option still showed `4 cod + 2 cc` to users. This release flips the remaining surfaces:
  - `skills/start/_inflight_prompt.md`: verbatim auto-swarm prompt + operator-decoder row now say `4 pi + 2 cc` (`--cc=2 --pi=4`); fallback to `--cod=4` documented inline.
  - `skills/start/SKILL.md`: Step 0d menu labels (both menus), routing-matrix Auto-swarm row, and Deslop-pass row updated to mention pi-first with cod fallback.
  - `skills/start/_reality_check.md`: `--cc=3 --cod=3` spawn flipped to `--cc=3 --pi=3`; "Full pipeline" depth label and the verbatim user prompt now say `3 pi + 3 cc` / `3 pi and 3 claude code instances`.
  - `skills/start/_saturation.md`: "existing 4 cod + 2 cc agents" + "Re-spawn swarm" / "Spawn smaller swarm" option labels updated.
  - `skills/start/_deslop.md`: Step 4 heading flipped to "5-Pi swarm via NTM (Codex fallback)"; Step 1 mode menu, route table, and pathology-catalog table-row reference all updated.
  - `skills/flywheel-reality-check/SKILL.md` + `commands/flywheel-reality-check.md`: "Full pipeline" descriptions now mention `3 pi + 3 cc` with the standard fallback pointer.

  Every flipped surface includes the same fallback note ("only fall back to cod if Pi is unavailable on this host") so degraded-host operators still know the escape hatch. The AGENTS.md `## NTM pane priority` section added in v3.6.8 remains the single source of truth reviewers should cite when rejecting cod-default regressions.

## [3.6.8] - 2026-04-26

### Changed

- **NTM pane priority — prefer `pi` over `cod`.** Swarm-spawning skills now default to Pi as the secondary lane after Claude (`cc`); Codex is only a fallback when Pi is unavailable on the host. Updated `skills/start/_planning.md` (deep-plan triad: `cc` + `pi` + `gmi`), `skills/start/_implement.md` (impl swarm: `--cc=` + `--pi=` + `--gem=`), and `skills/start/_deslop.md` (`--pi=5`). Added a top-level `## NTM pane priority` convention to `AGENTS.md` so reviewers reject regressions that reintroduce `--cod=` / `--type=cod` as the default.
- `.claude-plugin/plugin.json` version bumped from `3.6.5` → `3.6.8` to re-align with `mcp-server/package.json` (had drifted by two patch releases).

## [3.6.7] - 2026-04-26

Six reality-check beads from the v3.6.6 round closed in the same session — three rounds of right-sized auto-swarms (1 cc + 2 cod) executed `v8n`, `vc3`, `x6v`, `j0b`, `0e1`, `kxp`. All under macOS-portable build mutex shipped this round.

### Added

- `scripts/build-mutex.sh`: portable build mutex shell wrapper (bead `agent-flywheel-plugin-x6v`). Replaces the briefing's `flock` reference, which silently failed on macOS (no `flock` binary). The wrapper uses `mkdir`-based atomic locking with a cleanup trap, plus an `flock` fast-path when available. New regression test at `mcp-server/src/__tests__/build-mutex-script.test.ts` exercises it on Darwin. `skills/start/_inflight_prompt.md` operator-decoder table and `.pi-flywheel/inflight-briefing.md` template both updated to call the wrapper.
- `mcp-server/src/tools/doctor.ts` orphan-worktree check (bead `agent-flywheel-plugin-vc3`): doctor now detects stale flywheel worktrees (HEAD on main + dir untouched >3 days) and surfaces them via `flywheel_doctor`. `/agent-flywheel:start` Step 0d shows an `AskUserQuestion` to clean them up at session start when any are detected.

### Fixed

- `mcp-server/scripts/tender-daemon.ts` (bead `agent-flywheel-plugin-v8n`): `--project` now defaults to `process.cwd()` when omitted, so the example invocation in `skills/start/_inflight_prompt.md` works without an explicit `--project=` flag. The example was also updated to include the flag for clarity. First spawn during today's session FAILED on the original example; this fix removes that footgun.
- `mcp-server/src/tools/doctor.ts` `rescues_last_30d` probe (bead `agent-flywheel-plugin-kxp`): the v3.4.0 telemetry feature regressed when `cm` 0.2.3 changed its search syntax. Doctor now falls back to reading `.pi-flywheel/error-counts.json` directly when `cm` exec fails, and emits a `[INFO]` line instead of a `[WARN]` when the fallback succeeds. Regression test stubs `cm` to non-zero and verifies the local fallback. `npm test`: 91 files / 1329 tests / 1 skipped.

### Changed

- `skills/start/_inflight_prompt.md` STEP 0 + `.pi-flywheel/inflight-briefing.md` template (bead `agent-flywheel-plugin-0e1`): when `NTM_AGENT_NAME` is present in the pane environment, briefing's `macro_start_session` now reuses that name as `agent_name`, AND uses the same value for `AGENT_NAME` in git commands. This eliminates the dual-identity-per-pane audit-trail confusion (today's session produced `RoseFalcon`/`StormyAnchor`/`MistyLynx`/`SilverDune`/`EmeraldRiver`/`PearlForest` alongside the NTM-side `PearlDog`/`HazyFinch`/etc). Forward-compatible: NTM does not currently export `NTM_AGENT_NAME`, but the briefing handles its absence cleanly and the change activates as soon as NTM grows that surface.

### Documentation

- `AGENTS.md` Agent Mail section (bead `agent-flywheel-plugin-j0b`): documents the Agent Mail exclusive-reservation enforcement gap. Two distinct identities can hold concurrent `exclusive` reservations on the same path; ntm status renders both. Until the upstream fix lands in `mcp-agent-mail`, coordinators should treat `exclusive` reservations as advisory and rely on worktree isolation as the primary collision-prevention mechanism. Bead body links to the reproduction methodology.

### Removed

- 9 orphan worktrees + 9 stale branches from this session's two NTM swarms (rounds 2 and 3) plus prior session leftovers; cherry-picked all 6 closed-bead commits to main before deletion.

### Reality-check round 2026-04-26 progress

| Severity | Bead | Status this session | Cherry-picked |
|----------|------|--------------------|---------------|
| HIGH | `agent-flywheel-plugin-paj` | open (strategic-deferred) | — |
| HIGH | `agent-flywheel-plugin-wcp` | open (strategic-deferred) | — |
| HIGH | `agent-flywheel-plugin-x6v` | **closed** | `69891fd` |
| MEDIUM | `agent-flywheel-plugin-v8n` | **closed** | `9b118ac` |
| MEDIUM | `agent-flywheel-plugin-j0b` | **closed** | `5563a53` |
| MEDIUM | `agent-flywheel-plugin-0e1` | **closed** | `ca4fe7b` |
| MEDIUM | `agent-flywheel-plugin-vc3` | **closed** | `fad3eac` |
| MEDIUM | `agent-flywheel-plugin-kxp` | **closed** | `9ae3613` |
| LOW | `agent-flywheel-plugin-u3r` | open | — |
| LOW | `agent-flywheel-plugin-pbz` | open | — |
| LOW | `agent-flywheel-plugin-z60` | open | — |
| LOW | `agent-flywheel-plugin-lbm` | open | — |
| LOW | `agent-flywheel-plugin-2ph` | open | — |

Strategic decisions on `paj` (parallelism architecture) and `wcp` (single-branch model) require human direction and remain deferred. The 5 LOW doc-cleanup beads (`u3r`/`pbz`/`z60`/`lbm`/`2ph`) parallelize well and can ship as a single round in a future session.

## [3.6.6] - 2026-04-26

Lint-skill portability fix, NTM-pane preservation during self-review, PLACE001/SLASH001 prose cleanup, plus a 13-bead reality-check round filed under `reality-check-2026-04-26`.

### Fixed

- `mcp-server/scripts/lint-skill.ts` + `mcp-server/src/lint/baseline.ts`: baseline file paths now stored repo-relative instead of absolute, so a baseline generated in worktree A applies cleanly in worktree B or a fresh clone (bead `agent-flywheel-plugin-lss`). `generateBaseline` and `applyBaseline` accept an optional `repoRoot` and normalize entry/finding `file` fields to POSIX paths relative to it; the CLI threads `repoRoot` (already computed via `findRepoRoot`) into both calls. New regression test at `mcp-server/src/__tests__/lint/baseline-portable.test.ts` covers helper shape, unit-level cross-worktree match, the legacy-mismatch regression guard, end-to-end `--update-baseline` producing only repo-relative paths, baseline applying when CLI is invoked from a tmp working dir, and a checked-in-baseline guard (9 assertions). Regenerated `mcp-server/.lintskill-baseline.json` from 8 entries to 9: the prior baseline was generated against a stale SKILL.md from a deleted worktree and never actually demoted findings in the current tree.

### Changed

- `skills/start/SKILL.md`: PLACE001/SLASH001 prose cleanup (bead `agent-flywheel-plugin-ns2`). Stripped leftover placeholder text and corrected slash-command-form references to the canonical `/start` style. `npm run lint:skill` from a fresh worktree now produces zero live warnings; the 9 baseline-allow entries are documented decisions only.
- `mcp-server/src/gates.ts` + `skills/start/_review.md`: `runGuidedGates`'s self-review action now explicitly preserves live NTM panes. The audit gets dispatched back to the same pane that authored the diff via `ntm --robot-send` (NOT `ntm send`, which CASS-deduplicates and silently aborts), and the gate forbids pane teardown for the duration. Adds `preserveNtmPanes: true` to the gate's details object so downstream consumers know not to issue `--hard-kill` / `--robot-restart-pane` against responsive panes during this round. Pane teardown belongs to wrap-up's cycle-reset, not self-review. Includes the recovery ladder for genuinely-dead panes: `--robot-is-working` returning `gone` AND Agent Mail silent >10 min AND stuck-pane ladder exhausted, then fall back to coordinator-side `git diff` review of that bead's files only, never touching other panes.

### Reality-check round 2026-04-26 (13 follow-up beads filed)

Post-wave reality-check pass (per the new v3.6.5 saturation gate) surfaced 13 vision-vs-reality gaps now tracked in `br` under label `reality-check-2026-04-26` (CASS entry `b-mogiksz8-0dbnbx`):

| Severity | Bead | Topic |
|----------|------|-------|
| HIGH | `agent-flywheel-plugin-paj` | Reconcile README "CC Agent tool handles all parallelism" claim with SKILL.md ntm-routing |
| HIGH | `agent-flywheel-plugin-wcp` | Reconcile complete-guide single-branch git model with `--worktrees` usage in SKILL.md |
| HIGH | `agent-flywheel-plugin-x6v` | Briefing template build-mutex (`flock`) silently fails on macOS; agents currently improvise via Ruby File#flock or Perl fcntl |
| MEDIUM | `agent-flywheel-plugin-v8n` | `_inflight_prompt.md` tender-daemon example missing required `--project=<cwd>` flag |
| MEDIUM | `agent-flywheel-plugin-j0b` | Agent Mail allows two identities to hold the same exclusive file reservation (display bug or actual cross-identity conflict) |
| MEDIUM | `agent-flywheel-plugin-0e1` | Each ntm pane registers two Agent Mail identities (NTM-side + in-pane `macro_start_session`); confusing audit trails |
| MEDIUM | `agent-flywheel-plugin-vc3` | Auto-detect + offer cleanup of orphaned ntm worktrees at session start (today's session start found 6 orphans never cleaned) |
| MEDIUM | `agent-flywheel-plugin-kxp` | Doctor `rescues_last_30d` check fails: cm search path broken; v3.4.0 telemetry feature regression |
| LOW | `agent-flywheel-plugin-u3r` | ntm assignment tracker doesn't reflect bead state changes (Stats: Working 0 / Completed 0 even after closure) |
| LOW | `agent-flywheel-plugin-pbz` | README Models table doesn't match SKILL.md actual model routing |
| LOW | `agent-flywheel-plugin-z60` | `docs/gap-analysis-flywheel-guide.md` falsely advertises 100% coverage; stale snapshot needs refresh-or-archive |
| LOW | `agent-flywheel-plugin-lbm` | Document that auto-swarm `/loop` coordinator pulse is session-only (CronCreate dies with Claude session) |
| LOW | `agent-flywheel-plugin-2ph` | Verify `flywheel_emit_codex` tool exists or remove README claim |

### Cleanup

- Removed 9 orphan git worktrees (6 locked `.claude/worktrees/agent-*` from prior sessions with dead PIDs 85533/55915, 3 `.ntm/worktrees/agent-flywheel-plugin--inflight-2604/*` from today's just-merged session) and their 9 corresponding branches. Preserved one trivial `package-lock.json` delta from `agent-a0ee0425` as `stash@{0}` rather than discarding outright. Today's swarm landed 2 cherry-picked commits onto main (`458bba5` ns2, `844738c` lss) before branch deletion.

## [3.6.5] - 2026-04-26

Reality-check becomes a first-class flywheel surface — top-level menu option, slash command, auto-trigger at saturation, pre-wrap gate, CASS-driven freshness suggestion, drift-check escalation path, dedicated saturation pipeline, mandatory bead tagging, doctor advisory.

### Added

- `skills/start/_reality_check.md`: dedicated on-ramp for `/reality-check-for-project` — the canonical "come-to-Jesus" gap-analysis pass for long-running multi-agent projects. Surfaces a mandatory depth-selection `AskUserQuestion` (Reality check only / Reality check + beads / Full pipeline = check + beads + 3 cod × 3 cc swarm with 3-min looper), then executes the matching section verbatim. Phase 1 prompt is the user's frozen template ("First read ALL of the AGENTS.md file and README.md file super carefully…THEN apply /reality-check-for-project here in an exhaustive way") — agent reads docs end-to-end, runs Explore for code investigation, then invokes the skill exhaustively. Phase 2 prompt converts every gap into a granular self-contained bead graph via `br` only (per `/beads-workflow`), with detailed comments capturing background/reasoning/considerations so future-self never re-reads the plan doc. Phase 3 (full pipeline only) executes the gap-closure beads via NTM swarm. Inherits the canonical pre-flight checklist from `_implement.md` and the operator-decoder table from `_inflight_prompt.md`. **CASS capture** of the gap report is mandatory after Phase 1 (high-value session intelligence); each bead created in Phase 2 is tagged `reality-check-<YYYY-MM-DD>` and references the CASS `entryId` for traceability.
- `skills/start/_saturation.md`: unified saturation pipeline orchestrating `/reality-check-for-project` (strategic lens) + `/mock-code-finder`, `/deadlock-finder-and-fixer`, `/profiling-software-performance`, `/security-audit-for-saas`, `/modes-of-reasoning-project-analysis`, `/simplify-and-refactor-code-isomorphically` (tactical lenses). Auto-triggered at convergence + ≥80% bead closure. Findings deduplicated to a shared scratchpad, then a single bead-creation pass tags everything `saturation-<date>` + `lens-<skill>` for downstream filtering. Reality-check findings scope the tactical lenses for higher signal.
- `skills/flywheel-reality-check/SKILL.md` + `commands/flywheel-reality-check.md`: dedicated slash command `/agent-flywheel:flywheel-reality-check` — direct entry point that bypasses the `/start` menu. Both files are thin pointers to `skills/start/_reality_check.md` (single-source-of-truth pattern from v3.6.3).
- `skills/start/_wrapup.md` Step 9.45: pre-wrap reality-check gate. Before declaring the cycle done, agents now offer a one-question alignment check (Skip / Quick check / Full pass). Catches the silent failure mode where every bead closes but the aggregate doesn't deliver. Skipped automatically if <3 beads closed this session OR a reality-check already ran.
- `skills/start/SKILL.md` Step 0c: CASS-driven reality-check freshness suggestion in the welcome banner. If ≥3 prior sessions exist for this project AND no reality-check has run in the last 7 sessions, the banner appends a one-line nudge to invoke `/agent-flywheel:flywheel-reality-check`. Advisory only — never gates.
- `skills/flywheel-doctor/SKILL.md`: documented agent-side advisory check for reality-check freshness (queries CASS for last `reality-check-*` tagged entry; surfaces `[INFO] reality_check_freshness — last reality-check: <X> sessions ago` if stale). Will eventually graduate to a proper check in `mcp-server/src/tools/doctor.ts`; documented as advisory until then.
- `skills/flywheel-drift-check/SKILL.md`: when significant drift is detected (≥3 stale or new-opportunity beads), the skill now surfaces a follow-up `AskUserQuestion` offering "Run full reality-check" alongside the original "polish-loop the plan" path. Drift-check is the lightweight tactical version; reality-check is the deep strategic version.

### Changed

- `skills/start/SKILL.md` Step 0d: **Reality check is now top-level** (not under "Other") in the `open-beads-exist` menu — the state where gap analysis matters most. "Deslop pass" moved to that state's "Other" sub-menu (still reachable). Other states unchanged: previous-session-exists keeps Reality check under "Other", fresh-start keeps it under "Other".
- `skills/start/_inflight_prompt.md` operator-decoder table: new hard rule at saturation. When 2 review cycles converge AND ≥80% of original beads are closed, agents now MUST surface `AskUserQuestion` offering "Yes — run reality-check / Skip — proceed to saturation skills / Skip — proceed to wrap-up". The "more useful things to do" row now points at `_saturation.md` for the unified pipeline rather than ad-hoc invocation of each skill.

### Wholistic integration map

| Surface | Reality-check entry point |
|---------|--------------------------|
| `/agent-flywheel:start` open-beads-exist menu | Top-level option #2 |
| `/agent-flywheel:start` other menus | "Other" sub-menu option |
| `/agent-flywheel:flywheel-reality-check` | Direct slash command (new) |
| Welcome banner (`SKILL.md` 0c) | Freshness suggestion if stale |
| Saturation in `_inflight_prompt.md` | Hard gate at convergence |
| `_saturation.md` (new) | Strategic lens in unified pipeline |
| Pre-wrap (`_wrapup.md` Step 9.45) | One-question alignment gate |
| `/agent-flywheel:flywheel-drift-check` | Escalation path on significant drift |
| `/agent-flywheel:flywheel-doctor` | Freshness advisory check |
| Bead tagging | `reality-check-<YYYY-MM-DD>` mandatory |
| CASS persistence | Mandatory gap-report capture |


## [3.6.4] - 2026-04-25

### Changed

- **NTM readiness gate auto-symlinks nested repos silently.** Previously, any project whose basename wasn't already a top-level entry under NTM `projects_base` (the common case for nested layouts like `~/Documents/GitHub/foo/services/bar`) surfaced an `AskUserQuestion` with three options. Now: if `$TARGET` doesn't exist, the gate runs `ln -s "$PROJECT_ROOT" "$TARGET"` directly and emits `action=auto-symlinked`. Only true ambiguity (name-collision with a different repo OR `ntm config` has no `projects_base` set) still surfaces `AskUserQuestion` — destructive cases never auto-clobber.
- Detection now uses `git rev-parse --show-toplevel` instead of `$PWD` so it works correctly when invoked from a subdirectory of the project. Symlink-or-no-collision check uses `realpath` for accurate identity comparison.
- Updated in both `skills/start/_implement.md` (canonical implementation with full edge cases) and `skills/start/_planning.md` (quick reference cross-linked to `_implement.md`).

## [3.6.3] - 2026-04-25

### Fixed

- **Critical: `commands/start.md` was a stale verbatim duplicate of `skills/start/SKILL.md`** that diverged across every release since v3.5.4. When users typed `/agent-flywheel:start`, Claude Code loaded the slash-command file (`commands/start.md` ~ 415 LOC) — NOT the skill file — and served menus from before v3.6.0. Visible symptom: users saw the old 4-option fresh-start menu with `Quick fix` instead of `Auto-swarm (Recommended)` and `Deslop pass`. Banner correctly read `v3.6.2`, masking the bug. Fixed by replacing `commands/start.md` with a thin pointer (~34 LOC) that delegates to the canonical skill via the `Skill` tool. Single source of truth eliminates drift permanently.
- Audit: of all 21 `commands/*.md` files, only `start` was a full duplicate (cmd:skill line ratio 0.06 vs all others ≥ 0.83). `flywheel-doctor` and `flywheel-compound-refresh` are already healthy thin pointers (ratios 0.10 / 0.18). No other slash-commands exhibit this drift pattern.

## [3.6.2] - 2026-04-24

### Added

- `skills/start/_deslop.md`: dedicated on-ramp for `/simplify-and-refactor-code-isomorphically` — the user's elaborate 98-file proof-obligated refactor skill. Surfaces a mandatory mode-selection `AskUserQuestion` (Single-pass / Single + fresh-eyes / 5-Codex swarm via NTM / Iterative 10x via `/repeatedly-apply-skill`), then routes to the matching section. Swarm mode mirrors the v3.6.0 wave pattern: NTM readiness gate → CLI capability check → baseline capture (tests + LOC + warnings) → tender-daemon spawn → 5 Codex panes via `ntm spawn $NTM_PROJECT --label deslop --no-user --cod=5 --stagger-mode=smart` → 5-min looper → controller fresh-eyes review between ticks → termination via `kill -TERM $tender_daemon_pid`. Includes project-level build mutex (`flock $PWD/.pi-flywheel/build.lock`) so the 5 panes don't all `rch build` simultaneously, plus an operator-decoder table mapping each phrase from the user's documentation to a concrete action (isomorphism cards, ledger, one-lever-per-commit, no-rewrites/no-sed, deletion-with-permission, pathology catalog).
- `skills/start/SKILL.md`: new "Deslop pass" option in all three Step 0d menus (previous-session-exists, open-beads-exist, fresh-start). Placed AFTER "Auto-swarm" so the recommended ordering stays Auto-swarm → Resume → Deslop → Work-on-beads → New goal. Step 0e routing entry surfaces the mode-selection AskUserQuestion before dispatch (per UNIVERSAL RULE 1) and flags `/simplify-and-refactor-code-isomorphically`, `/repeatedly-apply-skill`, `/ntm`, `/vibing-with-ntm` as load-bearing — no paraphrasing.
- `skills/start/_inflight_prompt.md` saturation-skills list: added `/simplify-and-refactor-code-isomorphically` so deslop is auto-considered when reviews converge mid-wave alongside `/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/modes-of-reasoning-project-analysis`, `/profiling-software-performance`, `/security-audit-for-saas`. Operator-decoder gained a dedicated row for the deslop trigger condition (high LOC-to-behavior ratio or AI-junk patterns in a subsystem) and points dedicated runs at `_deslop.md` instead.

## [3.6.1] - 2026-04-24

### Added

- `skills/start/_inflight_prompt.md`: canonical "Universal in-flight prompt" for `/agent-flywheel:start` against projects with existing open / in-progress beads. Prescribes a 4 cod + 2 cc swarm via `/ntm` + `/vibing-with-ntm`, `rch`-driven builds, project-level build mutex (`flock .pi-flywheel/build.lock`), 4-min looper for nudging idle panes, `bv triage`-guided dispatch, stalled-bead reopen rule (in_progress + no commit in 30min + agent absent from `list_window_identities` → reopen), auto code-review handoff on completion, `/testing-*` family for coverage backfill, and saturation-trigger for `/mock-code-finder`, `/deadlock-finder-and-fixer`, `/reality-check-for-project`, `/modes-of-reasoning-project-analysis`, `/profiling-software-performance`, `/security-audit-for-saas`. Includes operator-decoder table mapping each phrase in the verbatim prompt to a concrete action and a 7-item pre-conditions checklist (NTM readiness gate → Agent Mail bootstrap → CLI cap check → disk-space guard → tender-daemon spawn → bead snapshot + reopen → looper schedule).
- `skills/start/SKILL.md`: new "Auto-swarm (Recommended)" option in both Step 0d menus (previous-session-exists AND open-beads-exist) plus a new routing-table row in Step 0e that loads `_inflight_prompt.md` end-to-end. Slash-named skills are flagged load-bearing — do NOT paraphrase.

## [3.6.0] - 2026-04-24

Wave-to-wave reliability — the flywheel now actually flywheels without LLM-in-the-loop babysitting. Three new surfaces collapse the manual monitor dance and let the loop survive `/compact`, idle turns, and the user walking away.

### Added

- **`flywheel_advance_wave` MCP tool** (`mcp-server/src/tools/advance-wave.ts`, 193 LOC + 256 LOC tests, 9 passing). Single call that takes the wave's closed bead IDs, runs `verifyBeadsClosed` to auto-close any stragglers with matching commits, reads `br ready --json` for the next frontier, and renders per-lane dispatch prompts (round-robin `cc → cod → gem`) using the existing claude/codex/gemini prompt adapters. Returns `{ verification, nextWave: { beadIds, prompts, complexity } | null, waveComplete }`. Replaces the fragile 4-step manual dance (verify → frontier → render → dispatch). Full suite remains green: 1315 tests / 89 files.
- **`tender-daemon` background watcher** (`mcp-server/src/tender-daemon.ts` + `mcp-server/scripts/tender-daemon.ts` entry, 458 LOC + 133 LOC tests, 3 passing). Standalone Node script spawnable via `nohup ... &`. CLI args: `--session`, `--project`, `--interval`, `--logfile`, `--agent`, `--ntm-timeout`. Polls inbox + `ntm --robot-is-working` + `ntm --robot-agent-health`, diffs against in-memory snapshot, appends NDJSON deltas (`tick`, `message_received`, `pane_state_changed`, `rate_limited`, `context_low`) to `.pi-flywheel/tender-events.log`. SIGTERM/SIGINT path emits `daemon_stopped` event and flushes log. Lets the coordinator reconstruct mid-wave state on resume by tailing the log — no state loss across `/compact`.
- **`ScheduleWakeup` wiring in `_implement.md`**: documented post-wave pattern that schedules coordinator re-entry at 270s (inside cache TTL) so the loop continues even when the chat goes idle. Combined with the tender-daemon, gives full survive-everything reliability.
- New "Wave-to-wave reliability" section in `skills/start/_implement.md` documenting the recommended wave loop (spawn → daemon → dispatch → ScheduleWakeup → wake → advance_wave → repeat) and the tail-on-resume pattern.

### Dogfooded

This release was built using the flywheel itself in team mode: 2-pane NTM session (`agent-flywheel-plugin--v360-reliability`), Agent Mail coordination via `OliveDune` (cc) and `CobaltLynx` (cod), with `RedBear` as the coordinator. Background poller verified completion via NDJSON tick log every 30s. The build process was the proof of monitoring — see commits `35b4f3f` (advance-wave) and `cff80aa` (tender-daemon).

## [3.5.4] - 2026-04-24

### Fixed

- `skills/start/_implement.md` and `skills/start/_planning.md` monitor loops: hoisted `fetch_inbox` from a trailing bullet into a first-class step (call #4 of 5 in the wake sequence) and added explicit handling rules for `[impl] <bead-id> done` / `blocker` and `[plan] <perspective> delivered` / `blocker` subjects. Each unread message must now be `mark_message_read`-ed and (for completion messages) `acknowledge_message`-ed so the next poll surfaces only fresh traffic.
- Added MANDATORY "Tick log" requirement: after every wake cycle, the coordinator must print one user-visible line summarising panes/inbox/commits (or panes/inbox/plans for deep-plan). This gives the user proof that inbox monitoring is actually happening — previously the orchestrator could technically poll without ever surfacing what it observed. Includes a 3-tick zero-inbox heuristic that triggers a `health_check` on the agent-mail server to catch silent breakage.

## [3.5.3] - 2026-04-24

### Fixed

- `skills/start/_implement.md` Step 7: added a mandatory "Pre-flight: NTM readiness gate" that re-runs the NTM detection inline before the implementation loop begins. Previous behaviour relied on `NTM_AVAILABLE` / `NTM_PROJECT` captured in SKILL.md Step 0b — but those variables are not persisted to `checkpoint.json`, so after `/compact` or any session resume they were lost and the loop silently fell through to `Agent()` spawning, stripping the user of visible tmux panes. The gate now forces re-detection, and the decision rule explicitly forbids falling back to `Agent()` when NTM is available just because the NTM block is longer.
- `skills/start/_planning.md` Deep plan mode: mirrored the NTM readiness gate so deep-plan orchestration also re-detects NTM inline rather than relying on in-turn state that vanishes on resume. Misconfigured NTM (installed but no symlink under `projects_base`) now surfaces a fix-or-fallback `AskUserQuestion` instead of silently skipping.

## [3.5.2] - 2026-04-24

### Fixed

- `skills/start/_planning.md` Phase 0.5 (step 4.5c): rewrote the end of the brainstorm-artifact step. Previous wording ("Surface the artifact path in your next turn") read as "end turn, wait for user" — after writing `docs/brainstorms/…md` the agent would stop and force the user back to free-text. Now explicitly requires proceeding to Step 5's `AskUserQuestion` in the SAME response, with an anti-pattern callout flagging "Written to `<path>`. Ready to plan?" as a UX break.
- `skills/start/SKILL.md` Step 0e routing table: the "Set a goal" row now explicitly requires in-turn progression through Step 4 → Step 4.5 → Step 5 without waiting for user input between sub-skill and the next `AskUserQuestion`.

### Added

- `skills/start/SKILL.md`: new MANDATORY "Stay-in-turn rule" subsection covering every step transition. Four concrete same-turn examples (after `/brainstorming`, after 4.5c artifact write, after `flywheel_plan`, after `flywheel_approve_beads`) plus a detector rule — any draft sentence matching "Ready to <next step>?" must be replaced with the next `AskUserQuestion` call. Enforces UNIVERSAL RULE 1 at every decision point.

## [3.5.1] - 2026-04-24

### Fixed

- `skills/start/_planning.md` and `skills/start/_implement.md`: NTM pane addressing. Previous `--pane=cc-1` / `cod-1` / `gem-1` / `gmi-1` syntax was invalid — NTM addresses panes by numeric index. Replaced with explicit index formulas (`--panes=1`, `--panes=$((N_claude+1))`, etc.) and a pane→lane mapping table.
- Orchestrator dispatch and nudge loops now use `ntm --robot-send` instead of `ntm send`. Plain `ntm send` silently aborts with `Continue anyway? [y/N]` when CASS dedup matches a similar past prompt — a silent blocker in orchestrator loops (ntm skill gotcha #3). `--robot-send` is non-interactive by design.
- Rate-limit probe `ntm --robot-tail` invocation now includes required `--panes=<N>` and `--lines=<N>` args (previously a bare `ntm --robot-tail` which returns nothing useful).
- Added `--no-user` + `--stagger-mode=smart` to NTM spawn commands in both deep-plan and impl flows; cleaner pane numbering and prevents thundering-herd on simultaneous cold-boot.

### Added

- Cross-references from `_planning.md` and `_implement.md` to the `/ntm` and `/vibing-with-ntm` skills so future orchestrators load their canonical decision trees and operator cards (OC-001, OC-003, OC-009, OC-016) instead of re-deriving logic.
- Swarm-wide convergence-stop rule in `_planning.md` — if `--robot-wait` returns no events for 2 cycles AND no planners delivered AND plan files unchanged, dispatch one ship-or-surface nudge then hard-stop via `ntm swarm stop` and proceed to synthesis with partial plans.
- Explicit "forbidden in automation" note for `ntm view`, `ntm dashboard`, and `ntm palette` (TUI-only surfaces).
- `reference_stop_review_gate_hook_cold_boot.md` memory capturing the upstream openai-codex plugin Stop-hook JSON.parse bug and its cold-boot cause, so future sessions diagnose it in seconds instead of re-investigating.

### Security

- `flywheel_doctor` gained a `codex_config_compat` check: parses `~/.codex/config.toml` for a top-level `model = "..."` line and emits a yellow row when the configured model is in the known-incompatible set (`gpt-5*`, `gpt-5-codex`, `o4-mini`) for the `codex app-server` JSON-RPC transport. Catches misconfigurations that silently break every flywheel→codex handoff before the next session blows up on them.

## [3.5.0] - 2026-04-23

### Added

- `flywheel_emit_codex` MCP tool and `emit/codex.ts`: single-target Codex format emitter that walks `skills/<name>/SKILL.md` and writes `<targetDir>/AGENTS.md` + `<targetDir>/.codex/skills/<name>.md`. Includes a fixed Claude→Codex tool-translation table; deliberately not generalised into a multi-target registry.
- `flywheel_refresh_learnings` operation (and bead `bve` algorithm in `refresh-learnings.ts`): periodic sweep of `docs/solutions/` that scores 5-vector overlap and classifies each group as Keep / Update / Consolidate / Replace / Delete. Read-only — caller decides what to archive.
- `docs/solutions/` durable learning store paired with CASS via `entry_id`; new `flywheel_memory` operation `draft_solution_doc` synthesizes the markdown and the wrap-up skill writes it.
- Per-phase Codex-rescue handoff packet at stall-N-1: writes a self-contained prompt to `.pi-flywheel/codex-rescue-<phase>-<sha>.md` so a Codex agent can pick up where Claude stalled.
- Swarm-agent model diversity (Claude/Codex/Gemini at 1:1:1 via NTM) in `adapters/model-diversity.ts`; new doctor checks `claude_cli`, `codex_cli`, `gemini_cli`, `swarm_model_ratio`, `rescues_last_30d`.
- `Phase 0.5 brainstorm` step in `skills/start/_planning.md`: AskUserQuestion-driven 3-question pressure-test between discover and plan.
- Actual-modified-files collision detection in `coordination.ts`: per-worker `git diff --name-only` reconciles against the declared `Files:` list.
- Line-ending normalization (BOM + CRLF → LF) at all markdown / yaml / json read boundaries via `utils/text-normalize.ts`.
- Path-safety, clone-safety, and fs-safety modules (`utils/path-safety.ts`, `utils/clone-safety.ts`, `utils/fs-safety.ts`) — guarded primitives for the three classes of footgun audited in CE phase 4.
- `CONTRIBUTING.md` + `skills/_template/SKILL.md` scaffold for ~30-min new-skill onboarding.
- Triage chain documentation (doctor → setup → healthcheck) collapsing the naming ambiguity.
- 1600-name adjective+noun agent-name pool with FNV-1a hashing in `adapters/agent-names.ts`.
- Pre-commit hook requiring `AGENT_NAME` env var so co-authored swarm commits stay traceable.

### Changed

- Every `FlywheelError` throw site (and ~37 `DoctorCheck` sites) now carries an actionable `hint` remediation sentence instead of an error-code echo. Backed by a new regression test (`doctor-hint-quality.test.ts`).
- `flywheel_review` gained a mode matrix (autofix / report-only / headless / interactive) selectable per invocation.
- `FLYWHEEL_MANAGED_DIRS` no longer statically includes `mcp-server/dist`; the new `getFlywheelManagedDirs(cwd)` adds it ONLY when cwd is the plugin repo (CLAUDE_PLUGIN_ROOT match OR `mcp-server/package.json` declares `name: agent-flywheel-mcp`). Prevents `flywheel_doctor --autofix` from clobbering a consumer project's own `mcp-server/dist`.
- `FlywheelErrorCode` enum expanded from 26 to 29 codes (collision `iy4`, review-mode `f0j`, refresh-sweep `bve`).

### Security

- `flywheel_emit_codex` now validates `pluginRoot` via a new `resolvePluginRoot` helper: realpaths the input and rejects anything outside `cwd` or `CLAUDE_PLUGIN_ROOT`. Closes the unrestricted-fs-read path that would have let a prompt-injected call exfiltrate any `<host-path>/skills/` tree.
- Frontmatter loader warns on unclosed `---` fences in SKILL.md (avoids silent body-as-frontmatter parse on malformed input).

### Fixed

- `coordination.ts` git-rev-parse and git-diff failure throws now include actionable hints.
- v3.4.1 carryover: 5 P1 release-gate items from R1 (post-mortem checkpoint stale handling, telemetry summary in swarm-status, hotspot-row caps, sanitiseCause path-redaction edges, README mode-guide stub).

### Tests

- 919 passing (v3.4.0 baseline) to 1187 passing (+268 new tests).

## [3.4.0] - 2026-04-21

### Added

- `flywheel_doctor` MCP tool and `/agent-flywheel:flywheel-doctor` slash command: one-shot diagnostic of 11 toolchain dependencies (MCP connectivity, Agent Mail, br/bv/ntm/cm binaries, node, git, dist-drift, orphaned worktrees, checkpoint validity) with green/yellow/red severities and structured remediation hints.
- Shared-write hotspot matrix in `plan-simulation.ts`: computes per-file contention across a wave's beads, recommends coordinator-serial vs swarm mode, surfaced in `flywheel_approve_beads` with a 4-option launch menu.
- Post-mortem draft engine in `episodic-memory.ts`: synthesizes session-learnings markdown from checkpoint, git log, agent-mail inbox, and error-code telemetry. Surfaced via `flywheel_memory` operation `draft_postmortem`. Always user-gated; never auto-commits to CASS.
- Error-code telemetry aggregator in `telemetry.ts`: tracks `FlywheelErrorCode` occurrences across sessions via bounded ring buffer, atomic spool writes to `.pi-flywheel/error-counts.json`, dual-session merge.
- Bead-template library (`bead-templates.ts`) with `@version` pinning: 16 templates spanning foundation gates, test coverage, refactor patterns, and new-MCP-tool / new-skill scaffolds. Plumbed through deep-plan synthesizer (`template: "<id>@<version>"` hints) and expanded at approve time.
- 10 new `FlywheelErrorCode` entries: `doctor_check_failed`, `doctor_partial_report`, `hotspot_parse_failure`, `hotspot_bead_body_unparseable`, `postmortem_empty_session`, `postmortem_checkpoint_stale`, `template_not_found`, `template_placeholder_missing`, `template_expansion_failed`, `telemetry_store_failed`.
- `AbortSignal` threading through `resilientExec` in `cli-exec.ts`: abortable sleep and pre/post-attempt short-circuit.
- `bootstrapCoordinator()` helper in `agent-mail.ts`: auto-sets `contact_policy=auto` for claude-code coordinators so planner first-message calls are not blocked.
- `sanitizeCause()` helper in `errors.ts`: redacts absolute paths and caps output at 200 chars before embedding in MCP structured error content.
- Regression and chaos test harness (`__tests__/chaos/`, `__tests__/regression/`): 7 scenario files covering doctor mid-sweep abort, missing CLI degradation, already-closed-bead parse regression, monitor-loop hygiene, dual-session telemetry flush, concurrent post-mortem drafts, and prose-only hotspot provenance.
- SKILL.md touch points in `skills/start/`: Step 0b doctor smoke check, Step 0c error-code trends banner, Step 6 hotspot matrix display with 4-option menu, Step 10.0 post-mortem draft gate, Step 10.5 telemetry flush.

### Changed

- `PostmortemDraft.warnings[]` replaces hard throws for empty-session and stale-checkpoint paths; post-mortem tool returns `status: 'ok'` with warnings embedded.
- `HotspotMatrixSchema.rows` bounded to `.max(500)` to prevent attacker-crafted plans from DoSing the Zod validator.
- `BeadTemplate` interface gained a required `version: number` field; `ExpandTemplateResult` error branch switched from free-form strings to `FlywheelErrorCode` + `detail`.
- `FlywheelErrorCode` enum expanded from 16 to 26 codes.

### Fixed

- Renamed `doctor_partial_result` to `doctor_partial_report` and `hotspot_input_unreliable` to `hotspot_bead_body_unparseable` (fresh-eyes fix-up from bead R1).
- Added JSDoc selection rule distinguishing `BeadTemplate` (in-process library) from `BeadTemplateContract` (MCP wire boundary).

### Tests

- 740 passing (v3.3.0 baseline) to 919 passing (+179 new tests).

## [3.3.0] - 2026-04-20

### Added

- `errors.ts`: `FlywheelErrorCode` enum with 16 codes, Zod-backed error envelope schema, `FlywheelError` class, and `classifyExecError` for mapping raw exec rejections to typed codes.
- `AbortSignal` propagation through `exec.ts` (`ExecFn` type) and all shell-exec call sites.
- Structured error returns across all `flywheel_*` MCP tools: `approve.ts`, `verify-beads.ts`, `discover.ts`, `select.ts`, `review.ts`, `plan.ts`, `memory-tool.ts`, `profile.ts`.
- SKILL.md branches updated to match on `result.data.error.code` instead of string patterns.
- `saveState` boolean flag, rollback wrappers, and per-bead mutex added to `state.ts`.
- AGENTS.md updated to permit framework-internal `FlywheelError` propagation.

### Fixed

- Silent catch blocks closed across exec call sites.
- Parameter type tightening and test gap coverage for `classifyExecError`.

## [3.2.1] - 2026-04-18

### Fixed

- `flywheel-start` opening-ceremony version lookup was broken.
- NTM skill: corrected spawn invocation and added misconfiguration detection.

## [3.2.0] - 2026-04-16

### Added

- Opus 4.7 adaptive thinking activated in deep-plan agents.
- Deep-plan timeout increased to 7 minutes with `FW_DEEP_PLAN_TIMEOUT_MS` env var override.
- SKILL.md split into phase-level docs; startup hook file added.
- NTM integrated as preferred agent launcher with mandatory Agent Mail bootstrap.
- ACFS stack one-shot installer added to `flywheel-setup`.
- Plugin marketplace one-liner install via `claude --plugin-dir`.

### Fixed

- Deep-plan empty-results failure surfaced instead of silently saving a bad plan.
- Bead IDs mandated as fully-qualified in impl-agent prompts.
- Lint baseline regenerated for current repo paths.
- Default Opus model bumped from 4.6 to 4.7.

## [2.11.0] - 2026-04-15

### Added

- Bundle of 13 critical skills integrated; `flywheel_memory` unwrap fix; workflow streamlining.
- `parsers.ts`: `parseBrList` accepts `{issues:[]}` shape from br v0.1.34+.

## [2.10.0] - 2026-04-14

### Added

- SKILL.md linter v1.0: parser, 6 rules including `errorCodeReferences`, 4 reporters, baseline and manifest support. Standalone CLI via `scripts/lint-skill.ts`.

## [2.9.0] - 2026-04-13

### Added

- 20+ specialist skills integrated into flywheel steps.

## [2.8.0] - 2026-04-12

### Added

- 14 agent-flywheel guide gaps closed across the orchestrator flow.

## [2.7.0] - 2026-04-11

### Fixed

- Bead auto-close and state desync bugs resolved.
- `AskUserQuestion` gates added at all decision points.
- Plan alignment check loop added at Step 5.55.
- Work-on-beads sub-menu and goal bootstrap added.

## [2.6.0] - 2026-04-10

### Added

- Perf caches, flywheel parity, and `AskUserQuestion` menus.
- Type-safe CLI parsing with Zod validators (2.6.1 patch).

## [2.5.0] - 2026-04-09

### Added

- Graceful MCP degradation and skill triage gate.

## [2.4.0] - 2026-04-08

### Added

- Health check, signal propagation, nudge budget, and test suite.

## [2.3.0] - 2026-04-07

### Added

- Structured stderr logger (`createLogger`) with JSON-line output and `FW_LOG_LEVEL` control.
- `SwarmTender` auto-escalation: nudges stuck agents up to `maxNudgesPerPoll` per cycle, kills after `killWaitMs`, emits `onSwarmComplete`.

## [2.2.0] - 2026-04-06

### Added

- Orchestrate skill updated; session plan artifacts stored.

## [2.1.0] - 2026-04-05

### Added

- Initial bead-tracker integration, state machine, and shared-tool unit tests.

## [2.0.0] - 2026-04-04

### Added

- Initial release as `claude-orchestrator` CC plugin.
- Multi-agent coding flywheel: scan, discover, plan, implement, review cycle.
- MCP server with stateless design; state persisted to `.pi-flywheel/checkpoint.json`.
- Agent isolation via git worktrees using CC `Agent(isolation: "worktree")`.
- agent-mail integration for file reservations and inter-agent messaging.
