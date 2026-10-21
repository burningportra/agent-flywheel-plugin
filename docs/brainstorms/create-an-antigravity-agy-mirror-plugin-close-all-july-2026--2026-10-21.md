# Brainstorm — Create an Antigravity (agy) mirror plugin, close all July 2026 Complete Flywheel Guide gaps, and deeply integrate poteto pstack into agent-flywheel

**Date:** 2026-10-21
**Goal slug:** create-an-antigravity-agy-mirror-plugin-close-all-july-2026-
**Source:** Phase 0.5 pressure-test (skills/start/_planning.md §4.5)

## Framing synthesis

We are unifying three surfaces into `agent-flywheel-plugin`:
1. **Antigravity (`agy`) Mirror & First-Class Swarm Lane**: Manifest-driven sync (`agy/manifest.json` + `scripts/sync-agy.sh` + `scripts/agy/sync.mjs`) emitting a native AGY plugin bundle (`~/.gemini/config/plugins/agent-flywheel/`) and `AntigravityAdapter` in `mcp-server/src/adapters/platform/`, plus first-class `--agy` (`agy` CLI on `gemini-4-argon`) in `swarm-spawn.ts`, `model-diversity.ts`, and `swarm.ts`.
2. **July 2026 Complete Flywheel Guide Gap Closures**: Restoring whole-repo Random Code Exploration + Cross-Agent Peer Review alternation in `gates.ts`, adding the 8 named Cognitive Operators (`[OPERATOR: ...]` including `overshoot-mismatch-hunt` / the 80-issue "Lie to Them" mismatch hunt in `_beads.md`), stack-aware validation + optional `rch exec --` build offloading in implementer prompts, `cass search` integration in `flywheel-refine-skill`, asymmetric capability Inversion Analysis in `flywheel-research` Phase 3, `git-diff` + 3-tier agreement report in plan synthesis, and post-compaction `AGENTS.md` re-read hook (`pcr`).
3. **Deep `pstack` (`poteto-mode`) Integration**:
   - **Model Routing & Effort Budgets (`setup-pstack`)**: `xai` (`grok-4.7-xhigh-fast`) + role/effort budget matrix (`unlimited/max`, `large/xhigh`, `medium/high`, `small/medium`) in `model-detection.ts`.
   - **Pre-Plan Grounding & Verification Generators**: Bundling `how`, `why`, `sharpen`, `architect` (with Ousterhout's 8 `design-red-flags.md`), `arena` (parallel fan-out + cross-judge + first-principles graft), `create-verification-skill`, and `create-formal-verification-skill`, plus `prototype`-first empirical fork resolution before `AskUserQuestion`.
   - **Structural Plan & Verification Enforcement**: Bundling `check-plan.mjs` (enforcing `Verify, unit` + `Verify, live` + `Verify, perf`) and `orch` ledger semantics (`live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed` keyed by SHA + `git patch-id`) into `completion-report.ts` and `advance-wave.ts`.
   - **Playbook-Typed Beads, 24 Principles & Decision Trail**: Adding `hillclimb`, `runtime-forensics`, `trace-forensics`, and scientific `bug-fix` templates to `bead-templates.ts`, injecting `pstack`'s 9-field `ORCH` brief + 24 Principles index into `claude-prompt.ts` / `codex-prompt.ts` / `agy-prompt.ts`, and logging append-only `.pi-flywheel/decisions/<slug>.tsv` (`show-me-your-work`).
   - **Hygiene, Interrogation & Structural Mistake Elimination**: Bundling `no-comments` (`comment-sicko`), `interrogate` (`code-quality-review.md` "Code Judo" + 4-bucket `lead-judgment.md`), `blast-radius` (Level 4/5 executable safety proof), 33-rule `unslop`, and `/correct` (Architecture → Types → Lint → Test → Docs + Rule Enforcement Table in `AGENTS.md`).

## Scope floor

Ship the complete, tested, compiled integration across `mcp-server/src/` (and `mcp-server/dist/`), `skills/`, `agy/`, and `scripts/`, verified by `tsc --noEmit`, `npm run build`, `npm test`, `npm run check:skills-bundle`, and `scripts/sync-agy.sh --check`.

## Ambition ceiling

Make `agent-flywheel` the canonical multi-harness meta-orchestrator where Claude Code, OpenCode, and Antigravity (`agy`) share one source of truth, every bead executes with `poteto-mode` rigor and a machine-verified SHA ledger, and recurring mistakes are automatically encoded into lint/type checks via `/correct`.

## Depth

1. **What a top professional would add:** Rather than dropping markdown files in a folder, enforce `pstack`'s contracts in TypeScript (in `gates.ts`, `completion-report.ts`, `model-detection.ts`, `bead-templates.ts`, `claude-prompt.ts`, `codex-prompt.ts`, `agy-prompt.ts`, and `check-plan.mjs`) and build a deterministic, manifest-backed `sync-agy.sh` port with `[LOCAL]` divergence protection and harness translation (`invoke_subagent`, `ask_question`, `define_subagent`).
2. **Raw material:** The 2,082-line live Complete Guide (`scratch/live_complete_guide.txt`), the cloned `cursor/plugins/pstack` repo (`scratch/pstack_repo/pstack/`), Antigravity's customization spec (`agy-customizations`), and `mcp-server/src/`.
3. **Methods and tools:** TypeScript strict-mode AST/schema updates, `check-plan.mjs`, `orch` ledger validation, `vitest` behavioral tests, `build-skills-bundle.mjs`, and `sync-agy.sh`.
4. **Outside check:** `cd mcp-server && npx tsc --noEmit && npm run build && npm test && npm run check:skills-bundle` plus `./scripts/sync-agy.sh --check` and `node scripts/check-plan.mjs` exiting 0.

## Planner instructions

Structure the plan into clean, dependency-ordered waves so independent workstreams (`mcp-server` TypeScript changes, `skills/` additions and upgrades, `agy/` mirror sync + harness adapter, and `AGENTS.md` / docs enforcement table) can be implemented and verified in parallel without file reservation conflicts.
