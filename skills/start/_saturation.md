# Saturation Pass — `/agent-flywheel:start` Auto-swarm late-game pipeline

**When to use:** the in-flight Auto-swarm has reached convergence — 2 review cycles produce ≤1 new actionable finding each AND ≥80% of original beads are closed. The swarm is winding down. This is the moment to apply the *broad-lens* skills that surface tactical and strategic improvements the bead-by-bead loop tends to miss.

This file orchestrates the canonical saturation pipeline: a unified pass through `/reality-check-for-project` (strategic lens) and the tactical lenses (`/mock-code-finder`, `/deadlock-finder-and-fixer`, `/modes-of-reasoning-project-analysis`, `/profiling-software-performance`, `/security-audit-for-saas`, `/simplify-and-refactor-code-isomorphically`), with deduplication and a single bead-creation pass at the end.

**How to use:** read this file end-to-end, then surface the gate `AskUserQuestion` below. Per UNIVERSAL RULE 1 in `SKILL.md`, the user picks the depth — never run the full pipeline unilaterally; some saturation skills are slow and the cost should be visible.

---

## Step 1: Saturation gate (mandatory)

```
AskUserQuestion(questions: [{
  question: "Saturation reached. Run the broad-lens pass before declaring done?",
  header: "Saturation",
  options: [
    { label: "Strategic + tactical (Recommended)", description: "Phase 1 reality-check first → then tactical lenses scoped by gap report → then unified bead pass. ~30-60 min, highest signal." },
    { label: "Tactical only", description: "Skip reality-check; run /mock-code-finder, /deadlock-finder-and-fixer, /security-audit-for-saas, /profiling-software-performance, /simplify-and-refactor-code-isomorphically, /modes-of-reasoning-project-analysis in parallel. ~20-40 min." },
    { label: "Reality-check only", description: "Strategic lens only — skip tactical lenses. Routes to skills/start/_reality_check.md depth selector. ~15-20 min." },
    { label: "Skip saturation — wrap up", description: "Proceed directly to Step 9.5 wrap-up. Choose this if scope was tight and reviews already converged cleanly." }
  ],
  multiSelect: false
}])
```

Route on the answer:

| Mode | Action |
|------|--------|
| Strategic + tactical | Run §2, then §3, then §4 |
| Tactical only | Run §3, then §4 |
| Reality-check only | Read `skills/start/_reality_check.md` and execute its depth-selector. Return here when done. |
| Skip — wrap up | Transition to Step 9.5 via `_wrapup.md`. |

---

## Step 2: Strategic lens — reality-check first

The reality-check provides the *strategic frame* that makes the tactical lenses more focused. Without it, tactical skills surface generic findings; with it, they're scoped to the actual gap areas.

1. Read `skills/start/_reality_check.md`.
2. Run §2 (Phase 1 — exhaustive reality check).
3. Persist the gap report via CASS (per `_reality_check.md` §2).
4. **Do NOT run §3 (bead creation) yet** — defer to §4 below so all saturation findings produce a single unified bead pass with consistent tagging.
5. Surface the gap report inline. The `gaps[]` list scopes the tactical lenses in §3 — feed each subsystem-level gap into the matching lens.

---

## Step 3: Tactical lenses — parallel saturation skills

Dispatch each skill via the `Skill` tool. If you ran §2 first, scope each invocation to the subsystems flagged in the gap report; otherwise, run repo-wide.

The skills are independent — invoke them in parallel via the `Agent` tool with `dispatching-parallel-agents` skill, or via individual NTM panes if the swarm is still alive. Each agent records findings to a shared scratchpad: `.pi-flywheel/saturation-findings-<YYYY-MM-DD>.json` (one entry per finding, with `{skill, area, severity, description, suggested_bead_title, suggested_bead_body}`).

| Lens | Skill | Scope hint | Output |
|------|-------|-----------|--------|
| Mock-code | `/mock-code-finder` | Hot subsystems from gap report (or all of `src/`) | List of mock/stub/fake-data sites that should be real |
| Deadlock / race | `/deadlock-finder-and-fixer` | Concurrency-heavy modules | Suspect lock orderings, races, double-acquires |
| Performance | `/profiling-software-performance` | Subsystems with user-visible latency | Hotspots ranked by CPU/IO/memory cost |
| Security | `/security-audit-for-saas` | Auth, network, data-handling code | OWASP-style findings + STRIDE threats |
| Reasoning gaps | `/modes-of-reasoning-project-analysis` | Whole project | Logic gaps, undefined edge cases, unproven invariants |
| Code shape | `/simplify-and-refactor-code-isomorphically` | Subsystems with high LOC-to-behavior ratio | Isomorphism-preserving simplifications |

**Build mutex caveat:** if any tactical lens invokes `rch build` or `rch test` to validate findings, it MUST use `flock $PWD/.pi-flywheel/build.lock rch <cmd>` so the lenses don't fight each other or the still-live swarm.

After all lenses return, the scratchpad has every finding deduplicated by `{skill, area}` key.

---

## Step 4: Unified bead-creation pass

This is the single point at which findings become beads. Doing it once (rather than per-lens) keeps tagging consistent and avoids duplicate beads when two lenses surface the same issue.

Procedure:
1. Read the scratchpad `.pi-flywheel/saturation-findings-<YYYY-MM-DD>.json` (and the gap report from §2 if it was run).
2. **Dedup pass:** group findings by affected file/symbol/subsystem. If two lenses flag the same area (e.g. `/mock-code-finder` and `/security-audit-for-saas` both flag `auth/session.ts`), merge into one bead with body referencing both lenses.
3. **Severity-based prioritization:** sort by severity (high → med → low). The user picks how aggressive to be:
   ```
   AskUserQuestion(questions: [{
     question: "Saturation pass found <N total> findings (<H high>, <M med>, <L low>). Which should become beads?",
     header: "Beads",
     options: [
       { label: "All high + med", description: "Skip low-severity findings; create <H+M> beads (Recommended)" },
       { label: "All findings", description: "Create <N> beads — comprehensive but generates more swarm work" },
       { label: "High only", description: "Create <H> beads — highest leverage, smallest set" },
       { label: "Custom", description: "Manually pick which findings in the Other field" }
     ],
     multiSelect: false
   }])
   ```
4. **Create the beads via `br create` only.** Each bead gets:
   - Tag `saturation-<YYYY-MM-DD>` (and `reality-check-<YYYY-MM-DD>` if §2 ran — both apply).
   - Tag `lens-<skill-short-name>` (e.g. `lens-mock-finder`, `lens-security-audit`) so users can later filter by lens.
   - Body includes background (which lens flagged it + why), reasoning/justification, considerations, acceptance criteria.
   - Reference to the CASS `entryId` from §2 (if applicable) so the bead is traceable to the strategic gap.
   - Dependencies declared via `br dep add` if findings are inherently sequenced (e.g. "fix the deadlock before adding the perf optimization that depends on the new lock order").
5. Run `bv --robot-triage` to validate the unified graph.

---

## Step 5: Dispatch into the existing swarm

If the in-flight swarm panes are still alive, dispatch the new beads via `flywheel_advance_wave` — the existing 4 cod + 2 cc agents pick them up via `bv triage` on their next looper tick. No new pane spawning needed.

If the swarm has been torn down (post-saturation cleanup), surface:

```
AskUserQuestion(questions: [{
  question: "<N> saturation beads created but the swarm is offline. How should I proceed?",
  header: "Dispatch",
  options: [
    { label: "Re-spawn swarm and dispatch", description: "Spin up 4 cod + 2 cc per _inflight_prompt.md and let them work the new beads" },
    { label: "Save for next session", description: "Beads are tagged and queued — they'll show up at next /start as 'open beads exist'" },
    { label: "Spawn smaller swarm", description: "2 cod + 1 cc — sufficient if the saturation bead count is small" }
  ],
  multiSelect: false
}])
```

Route accordingly — the `_inflight_prompt.md` pre-flight checklist applies for any re-spawn.

---

## Termination / hand-off

- All saturation beads dispatched (or saved for next session) → transition to Step 9.5 wrap-up via `_wrapup.md`.
- User interrupts → save the scratchpad to `.pi-flywheel/saturation-findings-<date>.json` so the next session can resume from §4 without re-running the lenses.
- New saturation round needed (rare — only if §2/§3 surface enough new beads to warrant another full implementation wave) → loop back to `_inflight_prompt.md` rather than running saturation again.
