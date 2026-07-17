# Brainstorm — Harden the opencode port of agent-flywheel

**Date:** 2026-07-17
**Goal slug:** harden-the-opencode-port-of-agent-flywheel
**Source:** Phase 0.5 pressure-test (skills/start/_planning.md §4.5)

## Framing synthesis

Ship a happy-path MVP of opencode-port hardening: a repeatable sync script that re-applies repo → `~/.config/opencode` cleanly (skills, commands, plugin, MCP registration) plus a sweep of the 23 synced skills and 25 commands for remaining Claude-isms. The diverged non-flywheel skills question and deeper polish are explicitly out of scope for v1. Fold in the two adjacent doctor yellows (codex `config.toml` model override, 24-file dirty working tree) since they ride the same cleanup pass. The ambition ceiling — automated sync with repo-watch, drift detection, and self-heal — is a future direction, not a v1 requirement.

## User answers

### Smallest version (scope floor)
- **Selected:** Happy-path MVP
- **Detail:** Cover the 80% case: sync script + sweep the 23 synced skills/commands for remaining Claude-isms. Defer the diverged non-flywheel skills question and polish.

### 10x version (ambition ceiling)
- **Selected:** Depth expansion
- **Detail:** Sync becomes fully automated: watch the repo, auto-reapply on change, detect drift between repo and live config, and self-heal.

### Adjacent asks (scope creep radar)
- **Selected:** Bundle doctor yellows
- **Detail:** The two doctor yellows (codex config.toml override + dirty tree) are adjacent cleanup — fold them into this cycle.

## Planner instructions

Planner agents: read this file FIRST. Anchor the plan's scope to the smallest
version. Reserve the 10x version as a "future direction" appendix, not a v1
requirement. Fold in adjacents ONLY if the user selected "Bundle a related
ask"; otherwise list them under "Explicit non-goals" so they don't leak in.
