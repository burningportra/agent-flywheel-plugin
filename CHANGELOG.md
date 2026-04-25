# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
