---
entry_id: "b-moun3zzq-kszhny"
problem_type: "doc_drift_audit"
component: "agents-md"
category: "docs"
tags: ["audit", "drift", "changelog", "deep-plan", "step-5.55", "alignment-check", "apr-pro-consolidation"]
applies_when: "Running a docs/DX polish cycle after a release shipped, where AGENTS.md and CHANGELOG.md need drift-fixing and adjacent corpus needs consolidation."
created_at: 2026-05-06
---

# AGENTS.md + CHANGELOG drift audit + APR-Pro corpus consolidation

A 10-bead docs/DX polish cycle ran post-v3.12.0. This doc captures the reusable lessons — not the per-bead diff (that's in the v3.12.1 commit stack 0df7cd2..512a607).

## When this pattern applies

Post-release docs polish where:

- A version (v3.12.0) just shipped with an undocumented MCP tool / doctor check / convention change
- AGENTS.md has accreted fragile `file.ts:NNN` line-number references that rotted
- CHANGELOG has gaps for unreleased-but-shipped feature commits
- A research corpus (here: APR-Pro) was consolidated into the codebase but the source artifacts are still scattered

## What worked

1. **Empirical verification at Step 5.55, before bead creation.** When the synthesized plan cited specific paths, I ran `ls`, `git tag -l`, and `find` BEFORE approving. Caught two errors:
   - Synthesizer cited `docs/research/research-apr-pro-{feedback-opus,feedback-sonnet,integration}.md` — real paths are `docs/research-apr-pro-*` (under `docs/` root, no `research/` subdir).
   - Synthesizer said "consolidate 4 files" — `find docs -name '*apr*'` showed 12 (4 root synthesis + 8 phase artifacts under `docs/research/apr-pro-phase*.md`).

   Cost: one shell command. Benefit: prevented 4 bead failures + a re-plan.

2. **Decisive convergence rule.** Step 5.55 user feedback was 3 confirms + 1 expand on T8 (single-direction). Per spec, this qualified for "decisive convergence" — one refinement round, then skip the re-alignment loop. Saved one ceremonial round.

3. **Coordinator-serial mode for AGENTS.md contention.** 5 beads (T1, T3, T4, T5, T6) all touched AGENTS.md. Hotspot matrix flagged `med` severity; recommendation `coordinator-serial`. Doing them sequentially in the coordinator session avoided merge conflicts entirely AND preserved cumulative ordering invariants (T5a's "30-second map" must precede Hard Constraints; T1's quick-ref goes at head of MCP family; T6's "Five → Six handlers" must not collide with T1's MCP family rewrite).

4. **Background subagent for non-contending beads.** T8a/T8a2/T8b touched separate file groups (synthesis files vs phase artifacts vs audit). Spawned ONE background agent that did all three in parallel-via-sequential. Clean wall-time win without contention risk.

5. **Inline verification commands per bead.** Plan §7 provides one-line shell verification per task. Lifted them into bead descriptions; ran each at close-time. Caught the "Five → Six handlers" drift inline. The global gate (`npm run lint:skill`) at the end was a confirmation, not a discovery.

6. **Plan refinement after a single-direction expansion.** User picks "EXPAND" → spawn one refinement agent → trace ripple effects (~25 edits across 6 sections) → re-register. Faster than per-question loops.

## What failed / required intervention

1. **gmi (Gemini) planner wedged at 13min Thinking with zero tool use.** No tool calls visible in `--robot-tail`; pane buffer identical across 4 ticks. Decision: proceed with 2/3 plans (cc + pi). Synthesizer filled robustness perspective inline per task.

   **Lesson:** if a planner shows >5 minutes of Thinking with no tool-use detectable in `--robot-tail`, nudge or smart-restart proactively rather than waiting through 3 cycles. 2-of-3 is usable per spec; don't burn 10 minutes on the third.

2. **Agent Mail `recovery.mode=corrupt` all session.** `health_check` returned `health_level=green` but `recovery.mode=corrupt` with `next_action: "Run am doctor repair --yes"`. `macro_start_session` returned transient DB errors. `fetch_inbox` failed every call.

   **Workaround:** `register_agent` directly (succeeded). For receive-side, polled disk for plan files instead of inbox.

   **Tooling gap:** `health_check` should escalate to `yellow` when `recovery.mode != "ok"`. Currently the health gauge reports green even when the underlying SQLite store is in forensic-recovery mode. Doctor's `agent_mail_liveness` check should mirror this.

3. **Stale "research-apr-pro" team blocked TeamCreate.** Old team from a prior research session (the one that produced v3.12.0) had 8 in-process zombies. `TeamDelete` failed with "Cannot cleanup team with 8 active member(s)". Workaround: `jq` edit `~/.claude/teams/research-apr-pro/config.json` to keep only `team-lead` in `members`, then retry `TeamDelete` (succeeded).

   **Lesson:** v3.6.5+ cycle-reset checklist drains teams. This was a leak from a prior session that didn't run cycle-reset. `/flywheel-stop` should also run team-drain.

4. **Empty post-mortem draft.** `flywheel_memory operation: "draft_postmortem"` returned empty draft (`postmortem_empty_session` warning) because `sessionStartSha` was lost when I deleted the stale checkpoint at the "New goal" route. The cycle-reset / checkpoint-delete should write a fresh `sessionStartSha = git rev-parse HEAD` to a session-tracker before clearing.

   **Workaround:** wrote post-mortem manually and stored via `operation: "store"` directly.

## Patterns worth replicating in future docs-polish cycles

- Run **Deep plan** even on narrow scope. Multi-perspective caught both the path errors AND the corpus expansion that Standard would have shipped wrong.
- **Patch-bump for docs-only releases.** Don't be tempted to bundle docs polish into a minor — you lose the separation that makes bisects useful.
- **5-commit topic split** (one per logical group: AGENTS / CHANGELOG / research-corpus / governance / session-artifacts). Bisect-friendly. The user explicitly preferred this over a single bundle.
- **Conditional language for cadence notes.** "Tag cadence (as of 2026-05-06)" stays correct if retroactive tags get created later. Unconditional language rots.

## Anti-patterns

- **Don't trust deep-plan synthesizer file paths blindly.** Verify with `ls` before bead creation. Synthesizer hallucinated paths twice in this cycle.
- **Don't wait through 3 nudge cycles for a wedged planner.** 13min Thinking with no tool use is signal enough to forfeit. 2/3 plans is usable per spec.

## Coordinator identity

SwiftKite (claude-opus-4-7). Synthesis subagent: HazyPlateau. Refinement subagent + combined T8 implementor: anonymous Agent tool subagents. NTM panes: RubyIvy (cc, correctness), MagentaRaven (pi, ergonomics), SandyCliff (gmi, robustness — wedged).

## Related artifacts

- Plan: `docs/plans/2026-05-06-agents-md-changelog-audit-synthesized.md`
- Brainstorm: `docs/brainstorms/agents-md-changelog-audit-2026-05-06.md`
- Source plans: `docs/plans/2026-05-06-{correctness,ergonomics}.md`
- Landed APR-Pro doc: `docs/research/research-apr-pro-landed-2026-05-06.md`
- Phase archive: `docs/research/research-apr-pro-phase-archive-2026-05-06.md`
- Classification audit: `docs/audits/2026-05-06-docs-refresh-classifications.md`

---
_CASS entry: b-moun3zzq-kszhny_
