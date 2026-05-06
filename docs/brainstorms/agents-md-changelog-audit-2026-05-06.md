# Brainstorm — AGENTS.md + CHANGELOG audit since v3.11.0

**Date:** 2026-05-06
**Goal slug:** agents-md-changelog-audit
**Source:** Phase 0.5 pressure-test (skills/start/_planning.md §4.5)

## Framing synthesis

A single focused docs/DX polish cycle: audit AGENTS.md for factual drift since v3.11.0 (skill list, MCP tool names, NTM pane priority, key paths, missing sections for tools shipped since — e.g. `flywheel_convergence`) and audit CHANGELOG since v3.11.0 to ensure every release tag and shipped feature commit has an entry; fill gaps. Bundle a docs/solutions/ refresh pass (via `/flywheel-compound-refresh`) into the same cycle so all three docs surfaces converge on accurate state in one shot. Explicit non-goals for v1: no automated regeneration pipelines, no CI-driven CHANGELOG generation, no agent-contract reorg, no README polish, no per-claim "verify with" runnable examples — those are the 10x ceiling and stay as a future-direction appendix.

## User answers

### Smallest version (scope floor)
- **Selected:** Drift-fix + gap-fill
- **Detail:** AGENTS.md: only fix factually-wrong claims (binary names, paths, current pane priority); add missing AGENTS.md sections that current code requires (e.g. convergence tool). CHANGELOG: ensure each git tag since v3.11.0 has an entry; add CHANGELOG entries for un-tagged-but-shipped feature commits since v3.11.0.

### 10x version (ambition ceiling)
- **Selected:** Living automated docs
- **Detail:** AGENTS.md auto-regenerated from a single source-of-truth (skill manifest, MCP tool registry, NTM config) on every release; CHANGELOG auto-built from conventional commits via a CI job. Reserve as future-direction appendix; do NOT include in v1.

### Adjacent asks (scope creep radar)
- **Selected:** Bundle docs/solutions/ refresh
- **Detail:** Run `/flywheel-compound-refresh` on docs/solutions/ as part of the same docs polish cycle so all three docs surfaces (AGENTS.md, CHANGELOG, docs/solutions/) converge in one cycle.

## Planner instructions

Planner agents: read this file FIRST. Anchor the plan's scope to the smallest version (drift-fix + gap-fill across AGENTS.md and CHANGELOG since v3.11.0). Reserve "Living automated docs" as a "Future direction" appendix, not a v1 requirement. Fold in the docs/solutions/ refresh as a third in-scope work-stream (the user explicitly bundled this adjacent ask). Explicit non-goals: README polish, agent-contract reorg, automated regeneration pipelines, CI-driven CHANGELOG generation, per-claim runnable verification. Surface those under "Explicit non-goals" so they don't leak into beads.
