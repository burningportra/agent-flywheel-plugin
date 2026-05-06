# Docs Refresh Classifications — 2026-05-06

**Date:** 2026-05-06
**HEAD commit:** `05071af` (v3.12.0)
**Scope:** Top-level `docs/*.md` files only.
**Mode:** Classify-only — no mutations.

## Scope and method

This audit walks every Markdown file at the *top level* of `docs/` (i.e.
`docs/*.md`, not subdirectories) and assigns one of six classification labels
per file. It is paired with two consolidation beads — T8a covered the four
root-level APR-Pro synthesis files, T8a2 covered the seven phase artifacts
under `docs/research/apr-pro-*.md`. Files already covered by those beads are
listed here for completeness with a `Consolidate` label and a forward link.

**Subdirectories explicitly out of scope:** `docs/plans/`, `docs/brainstorms/`,
`docs/audits/` (this directory), `docs/upstream-asks/`, `docs/duels/`. Those
each have their own retention discipline and are not part of this top-level
refresh.

**No file is mutated by this audit.** Classifications are advisory; conversion
to follow-up beads is a separate action. The HEAD baseline (`05071af`) is
recorded so re-runs against later commits can detect drift.

## Classification labels

- **Keep** — current, accurate, no action needed.
- **Update** — content is salvageable but specific claims are stale; needs in-place edits.
- **Consolidate** — covered by another doc; should fold into a synthesis target.
- **Replace** — superseded by a newer canonical doc; replace pointer-style.
- **Delete** — no longer useful; remove (low priority — keep only if zero references).
- **Verify** — claims need cross-checking against current code before re-classifying.

## Top-level docs/*.md classifications

| Classification | Path | Rationale |
| --- | --- | --- |
| Keep | `docs/tender-config.md` | Current — describes `mcp-server/src/tender.ts` `TenderConfig` precedence (defaults → `.pi-flywheel/tender.config.json` → env vars). Path matches the v3.12.0 codebase (`.pi-flywheel/` retained per Phase 12 §12.3). No drift detected. |
| Update | `docs/agent-flywheel-complete-guide.md` | Snapshot of upstream complete-guide content from 2026-04-09. Largely still accurate, but predates v3.5+ shifts (NTM mandatory, single-branch + Agent Mail reservations replaced worktrees). Retain as historical-snapshot but add a banner header pointing to AGENTS.md / README.md for the current authoritative model. |
| Keep | `docs/gap-analysis-flywheel-guide.md` | Already carries an explicit "HISTORICAL SNAPSHOT — last updated 2026-04-09 (codebase ~v3.4.x)" banner with the two stale claims called out inline. Banner discipline is correct; no further action beyond the existing pointer to `/flywheel-reality-check`. |
| Consolidate | `docs/research-apr-pro-feedback-opus.md` | Synthesized into `docs/research/research-apr-pro-landed-2026-05-06.md` (T8a). Pointer header now prepended. |
| Consolidate | `docs/research-apr-pro-feedback-sonnet.md` | Synthesized into `docs/research/research-apr-pro-landed-2026-05-06.md` (T8a). Pointer header now prepended. |
| Consolidate | `docs/research-apr-pro-integration.md` | Synthesized into `docs/research/research-apr-pro-landed-2026-05-06.md` (T8a). Pointer header now prepended; the appendix Phase 9 deepening (FDS-v1) is preserved here as the canonical record of the most-ambitious framing. |
| Consolidate | `docs/research-automated_plan_reviser_pro-2026-05-05.md` | Synthesized into `docs/research/research-apr-pro-landed-2026-05-06.md` (T8a). Pointer header now records "Landed in v3.12.0 (commit 05071af)". |
| Verify | `docs/research-compound-engineering-plugin-2026-04-23.md` | Research-only proposal (Phases 1–7) for the EveryInc/compound-engineering-plugin. Pipeline outputs live under `docs/research/compound-engineering-*.md`. Integration Phases 8–12 were not run and the doc is stamped against `v3.4.0 @ dfc8c51`. Verify whether any of the 8 apply-proposals shipped in v3.5–v3.12; if shipped, route through the same landed/archive synthesis pattern as APR-Pro. |
| Update | `docs/skill-refine-flywheel-proposed.md` | Proposed changes to `flywheel/SKILL.md` from a 2026-04-15 session. Ten months of skill churn since then. Re-validate each proposed change against current `skills/flywheel/SKILL.md` content; some may already be applied. Retain the file as a refiner-evidence trail but mark applied-vs-pending per change. |
| Update | `docs/skill-refine-start-proposed.md` | Refinement proposal for `skills/start/` from 2026-04-21 v3.4.0 evidence. Several flagged friction points (br flag mismatches, contact_policy default) likely addressed in subsequent versions; verify each against current `skills/start/SKILL.md` and `skills/start/_beads.md`. Same pattern as the flywheel refinement doc — keep the evidence, mark applied vs pending. |

## Notes

- Four `Keep` (tender-config, gap-analysis already-banner-stamped) + `Consolidate`
  classifications are immediate; no follow-up bead needed beyond the T8a/T8a2
  consolidations already in flight.
- Two `Update` rows on `agent-flywheel-complete-guide.md` and the two
  `skill-refine-*` proposals — each warrants its own small bead to either
  add a banner (for the guide) or do an applied-vs-pending audit (for the
  refinement proposals).
- One `Verify` row on the compound-engineering-plugin research proposal —
  one bead to check whether any of its apply-proposals shipped between
  v3.4.0 and v3.12.0; if so, generate the landed/archive pair following the
  APR-Pro template.

The audit table contains 10 rows covering all 10 top-level `docs/*.md` files
discovered via `ls docs/*.md` against HEAD `05071af`. No `Delete` recommendations
issued — every file has at least pointer-trail or evidence value.
