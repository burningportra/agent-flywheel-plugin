# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
