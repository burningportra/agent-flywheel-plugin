---
description: Strategic gap analysis between vision (AGENTS.md / README.md / plan docs) and actual implementation. Reads docs, investigates code, applies /reality-check-for-project exhaustively, converts gaps to tagged beads, optionally launches a 3+3 swarm.
---

# `/agent-flywheel:flywheel-reality-check` — direct entry to the gap-analysis pass

Run a strategic reality-check pass on the current project — the "come-to-Jesus" alignment check between what was promised (AGENTS.md / README.md / plan docs) and what's actually implemented. $ARGUMENTS

## Instructions

1. Invoke the reality-check skill via the `Skill` tool:

   ```
   Skill(skill: "agent-flywheel:flywheel-reality-check", args: "$ARGUMENTS")
   ```

2. The skill is a thin pointer to `skills/start/_reality_check.md` (the canonical workflow). It surfaces a depth-selection `AskUserQuestion`:
   - **Reality check only** — gap report, stop after.
   - **Reality check + beads** — gap report + convert every gap into a tagged bead graph via `br`.
   - **Full pipeline** — check + beads + 3 pi × 3 cc NTM swarm with 3-min looper (cod fallback if Pi unavailable; see AGENTS.md NTM pane priority).

3. **Do NOT** re-implement the prompts, depth selection, CASS capture, or bead tagging logic inline. The sub-file at `skills/start/_reality_check.md` is the single source of truth — every change happens there.

## When to use

- A long-running multi-agent project has accumulated dozens of closed beads — verify the *aggregate* delivers on the original vision.
- Reviews are converging but you suspect drift between aspirational docs and actual implementation.
- Before a release / before declaring done.
- After `/agent-flywheel:flywheel-drift-check` flagged significant drift and you want the deeper strategic lens.
- Periodically (every 7–14 days on an active project) — the welcome banner in `/agent-flywheel:start` will suggest it when CASS detects no recent reality-check.

## See also

- `/agent-flywheel:flywheel-drift-check` — lightweight tactical drift check (plan vs current beads). Reality check is the deep strategic version.
- `/agent-flywheel:flywheel-healthcheck` — periodic codebase + dependency audit (different lens; not vision-vs-code).
- `skills/start/_saturation.md` — orchestrates reality-check alongside `/mock-code-finder`, `/security-audit-for-saas`, etc. for a unified saturation pass.
