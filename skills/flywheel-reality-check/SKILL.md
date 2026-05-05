---
name: flywheel-reality-check
description: Strategic gap analysis between vision (AGENTS.md / README.md / plan docs) and what's actually implemented. Converts gaps into beads, optionally launches a swarm. Use when "reality check", "where are we really", "gap analysis", "did we drift", or before declaring a long-running project done.
---

# Flywheel Reality Check — direct entry point

This skill is a thin pointer to the canonical reality-check sub-flow at `skills/start/_reality_check.md`. It exists so users can invoke the gap-analysis pass directly via `/agent-flywheel:flywheel-reality-check` without going through `/agent-flywheel:start` → "Reality check".

## When to use

- A long-running multi-agent project has accumulated dozens of closed beads — it's time to step back and verify the *aggregate* delivers on the original vision.
- Reviews are converging but you suspect drift between aspirational docs and actual implementation.
- Before a release / before declaring done — the "come-to-Jesus" alignment pass.
- After `/agent-flywheel:flywheel-drift-check` flagged significant drift and you want the deeper strategic lens.

## Instructions

1. **Read** `skills/start/_reality_check.md` end-to-end (resolve via `$CLAUDE_PLUGIN_ROOT/skills/start/_reality_check.md` or fall back to the cache path under `~/.claude/plugins/cache/agent-flywheel/agent-flywheel/<VERSION>/skills/start/_reality_check.md`).

2. Execute its depth-selection `AskUserQuestion` (Reality check only / Reality check + beads / Full pipeline) and route to the matching section verbatim. Do NOT pick a depth unilaterally — per the start-skill's UNIVERSAL RULE 1, this is a labeled-option decision.

3. The slash-named skill `/reality-check-for-project` is load-bearing — invoke via the `Skill` tool when reaching Phase 1, do NOT paraphrase its prompts.

4. CASS capture (§2) and bead tagging (§3) are mandatory — they make the reality-check round queryable across future sessions.

5. If you're in the middle of an active flywheel session (checkpoint exists), the reality-check findings should produce beads tagged `reality-check-<YYYY-MM-DD>` that the existing swarm can pick up via `flywheel_advance_wave`. If standalone, the "Full pipeline" depth launches a fresh 3 cod + 3 cc swarm specifically for gap-closure (pi fallback if Codex unavailable; see AGENTS.md NTM pane priority).

## Why this is a thin pointer

Same reasoning as `commands/start.md` (v3.6.3): single source of truth at `skills/start/_reality_check.md` eliminates drift between the slash-command surface and the canonical workflow. Every menu/routing change happens once, in one file.
