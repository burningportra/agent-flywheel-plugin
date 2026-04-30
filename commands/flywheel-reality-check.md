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
   - **Duel reality-check** (`--duel` flag, or pick this row) — two agents (cc + cod, plus gmi if available) independently produce gap reports, cross-rate severity, and reveal. Consensus gaps become beads with `provenance.source = "reality-check-duel"`; contested gaps surface to the user via `AskUserQuestion` for explicit decision rather than silent triage. ~30 min; needs ntm + ≥2 healthy agents. Best for high-stakes "are we actually shipping the vision?" checks before a release.

3. **Do NOT** re-implement the prompts, depth selection, CASS capture, or bead tagging logic inline. The sub-file at `skills/start/_reality_check.md` is the single source of truth — every change happens there.

## Duel mode operational notes

When the user picks **Duel reality-check** (or invokes `/flywheel-reality-check --duel`):

1. Pre-flight identical to `/flywheel-duel`: `command -v ntm && ntm deps -v` and ≥2 of {claude, codex, gemini} on `$PATH` (the real binaries behind the `cc/cod/gmi` ntm pane types — do not `which cc` literally; it matches `/usr/bin/cc`). On failure, fall back to **Reality check + beads** with a one-line warning.
2. Invoke `/dueling-idea-wizards --mode=reliability --top=5 --rounds=1 --focus="vision-vs-code drift" --output=docs/reality-checks/<date>-duel.md`. Each agent reads AGENTS.md / README.md / docs/plans/ first, then walks the codebase, then writes its independent gap list before any cross-talk.
3. After the duel completes, parse the synthesis:
   - **Consensus gaps** (both agents flagged the same gap) → `br create` per gap with `provenance.source = "reality-check-duel"` and the standard `## Provenance` block (per `_beads.md` Step 5.5). Tag each bead with the bead-graph label `reality-check`.
   - **Contested gaps** (one agent flagged, the other defended the current state) → present via `AskUserQuestion` with both arguments. The user decides whether the gap is real, deferred, or rejected. Do NOT auto-create beads from contested gaps.
4. After bead creation, route into the depth-selection menu's normal flow (return to step 2's "Reality check + beads" path for the swarm-launch decision, but with the duel-sourced beads already in place).

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
