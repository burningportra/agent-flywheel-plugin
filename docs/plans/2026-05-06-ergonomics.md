# Ergonomics plan — AGENTS.md + CHANGELOG + docs/solutions audit

Date: 2026-05-06  
Perspective: ERGONOMICS  
Scope anchor: **Drift-fix + gap-fill** floor from `docs/brainstorms/agents-md-changelog-audit-2026-05-06.md`  
Current HEAD: `05071af` / package `3.12.0`  
Non-ambition: no living-docs automation, no agent-contract rewrite.

## Section 1: Reader-friction inventory

Ranked by likely reader hit-rate.

1. **AGENTS.md starts with deep duel context before the 30-second survival map.** A cold agent sees high-stakes-track details before build rules, tools, swarm path, and conventions. Useful, but not first-screen useful.
2. **No quick index answers the four cold-reader questions.** The file has headings, but no compact “skills / MCP tools / swarm / conventions” jump table near the top.
3. **MCP tool docs are version-sliced, not task-sliced.** `flywheel_remediate`, `flywheel_get_skill`, `flywheel_observe`, etc. are under “added in vX” headings; `flywheel_convergence` is absent from AGENTS.md even though `mcp-server/src/server.ts` registers it at HEAD.
4. **Skill discovery is implied, not surfaced.** AGENTS.md says `skills/` exists, but a reader cannot quickly see the important project-local slash skills (`start`, `flywheel-doctor`, `flywheel-swarm`, `flywheel-compound-refresh`, etc.).
5. **Swarm instructions are complete but split across hard rule, pane priority, lifecycle, quality gate, and agent-mail sections.** Correct, but hard to execute in one pass; a “spawn swarm in 5 lines” pointer would reduce mistakes without weakening the contract.
6. **CHANGELOG has Keep-a-Changelog headings but entries read like release notes + design doc hybrids.** v3.11.9 is accurate but hard to scan; one-line release summaries are missing before long detail.
7. **CHANGELOG has no visible v3.12.0 entry for HEAD.** The code/package are at 3.12.0 and commit says convergence, but the top entry is 3.11.9.
8. **Version cadence is unclear because tags and changelog entries diverge.** Tags since v3.11.0 include `v3.11.2`, `v3.11.3`, `v3.11.4`; changelog includes 3.11.5-3.11.9 release commits without tags. A short note would prevent false “missing tag” hunts.
9. **`docs/solutions/` is referenced as a durable learning store but does not exist in this checkout.** `ls docs/solutions/` fails, while commands/skills/code describe it as the corpus for `/flywheel-compound-refresh`.
10. **`docs/solutions/` has no navigability shell even when seeded later.** The intended schema supports categories and symptom fields, but there is no `README.md` / search cheat-sheet / category map for humans or agents.

## Section 2: Reorg recommendations

Minimal, surgical only.

1. **Add a short “30-second map” immediately after Project Overview.** Four bullets: important skills, primary MCP tools, swarm path, binding conventions. Link to existing sections instead of moving contracts.
2. **Move or demote “High-stakes track” below the 30-second map and hard constraints.** Keep content intact; do not rewrite the duel contract. Goal: make first screen survival-oriented.
3. **Rename MCP section family to “MCP tools quick reference” plus “release-specific notes.”** Keep detailed v3.7/v3.11 prose, but add a compact current-tool list up front and insert missing `flywheel_convergence` / `flywheel_advance_wave` / `flywheel_memory.refresh_learnings` pointers where relevant.
4. **Add a “Project-local skills quick reference” bullet list.** Use `ls skills` as source; only list the top operator-facing skills, not every imported generic skill.
5. **Add a CHANGELOG “latest summary” block for v3.12.0 only.** Do not rewrite historical entries. Use one-line bullets under standard `Added` / `Changed` / `Migration notes` headings.
6. **Seed `docs/solutions/README.md` before any consolidation.** Since the corpus is absent, the right ergonomic fix is a navigability shell and “no corpus yet” explanation, not topic-page consolidation.
7. **Defer consolidated topic pages until `docs/solutions/**/*.md` has real entries.** A TOC over zero files is enough now; topic pages would be invented structure.

## Section 3: Verification UX

Each task has one fast shell check. Run from repo root.

| Task | Done-check command |
|---|---|
| T1 AGENTS 30-second map | `python3 - <<'PY'\nfrom pathlib import Path\ns=Path('AGENTS.md').read_text()\nassert '30-second map' in s and s.index('30-second map') < s.index('## Hard Constraints')\nassert all(x in s for x in ['Project-local skills', 'MCP tools', 'Swarm', 'Conventions'])\nPY` |
| T2 AGENTS current MCP tool refs | `python3 - <<'PY'\nfrom pathlib import Path\ns=Path('AGENTS.md').read_text()\nfor x in ['flywheel_convergence','flywheel_advance_wave','flywheel_memory','refresh_learnings']:\n    assert x in s, x\nPY` |
| T3 AGENTS swarm quick path | `python3 - <<'PY'\nfrom pathlib import Path\ns=Path('AGENTS.md').read_text()\nassert 'ntm spawn' in s and 'ntm --robot-send' in s and '--type=cod' in s\nassert s.count('NTM is mandatory') == 1\nPY` |
| T4 CHANGELOG v3.12.0 gap-fill | `python3 - <<'PY'\nfrom pathlib import Path\ns=Path('CHANGELOG.md').read_text()\nassert s.index('## [3.12.0]') < s.index('## [3.11.9]')\nfor x in ['flywheel_convergence','APR-Pro','oscillation','Migration']:\n    assert x in s, x\nPY` |
| T5 CHANGELOG cadence note | `python3 - <<'PY'\nfrom pathlib import Path\ns=Path('CHANGELOG.md').read_text()\nassert 'Tag cadence' in s or 'Release cadence' in s\nassert '3.11.5' in s and '3.11.9' in s and '05071af' in s\nPY` |
| T6 docs/solutions navigation shell | `test -f docs/solutions/README.md && rg -q 'symptom|problem_type|component|flywheel-compound-refresh|No corpus yet' docs/solutions/README.md` |
| T7 final docs audit smoke | `python3 - <<'PY'\nfrom pathlib import Path\nassert Path('AGENTS.md').read_text().count('flywheel_convergence') >= 1\nassert Path('CHANGELOG.md').read_text().startswith('# Changelog')\nassert Path('docs/solutions/README.md').exists()\nPY` |

## Section 4: Task table

Order: impact-per-line first. All tasks are independent at bead-graph level; implement in order to reduce merge friction.

| id | title | files | depends_on | acceptance |
|---|---|---|---|---|
| T1 | Add AGENTS.md 30-second map | `AGENTS.md` | `[]` | New top section answers: skills, MCP tools, swarm path, conventions. Must appear before Hard Constraints. |
| T2 | Add current MCP quick reference and v3.12 convergence pointer | `AGENTS.md` | `[]` | AGENTS mentions `flywheel_convergence`, `flywheel_advance_wave`, and `flywheel_memory.refresh_learnings`; version-sliced detail remains intact. |
| T3 | Add swarm quick path without changing contract | `AGENTS.md` | `[]` | One compact “if asked to spawn a swarm” recipe points to NTM, Agent Mail reservations, `--type=cod`, bead close/verify, and completion report. No duplicate hard-rule section. |
| T4 | Add CHANGELOG v3.12.0 entry | `CHANGELOG.md` | `[]` | Top release entry covers HEAD `05071af`, APR-Pro multi-signal convergence, B6 oscillation guard, `flywheel_convergence`, and migration note for convergence state. |
| T5 | Add CHANGELOG release/tag cadence note | `CHANGELOG.md` | `[]` | Short note explains changelog entries may exist before git tags; lists 3.11.5-3.11.9 release commits and v3.12.0 HEAD context. |
| T6 | Seed docs/solutions navigation README | `docs/solutions/README.md` | `[]` | Directory exists; README explains corpus may be empty, category layout, frontmatter keys, symptom search commands, and `/flywheel-compound-refresh` behavior. |
| T7 | Run final ergonomic smoke audit | no required file edits | `[]` | Run all Section 3 commands; fix only doc drift exposed by those checks. |

## Section 5: Bead-size rationale

- **T1:** Single AGENTS top-of-file affordance; splitting by each bullet would create micro-beads, merging with MCP details would muddy review.
- **T2:** One conceptual AGENTS gap: current MCP/tool discoverability; includes convergence because that is the HEAD drift.
- **T3:** One reader workflow: “how do I spawn a swarm safely?” It references existing sections instead of rewriting them.
- **T4:** One release gap: v3.12.0 missing from changelog. Needs one bead so reviewers can compare against HEAD.
- **T5:** One readability/cadence clarification. Separate from T4 because it affects release process interpretation, not feature content.
- **T6:** One missing-corpus/navigability fix. Not split into TOC/topic pages because there are zero solution entries in this checkout.
- **T7:** One verification bead because the value is cross-file done-ness, not another content change.

## Section 6: Explicit non-goals

- README polish.
- Agent-contract reorg or full AGENTS.md rewrite.
- Automated regeneration pipelines for AGENTS.md or CHANGELOG.
- CI-driven CHANGELOG generation.
- Per-claim runnable verification examples throughout docs.
- Rewriting old CHANGELOG entries for style.
- Creating consolidated `docs/solutions/` topic pages before real solution entries exist.
- Running `/flywheel-compound-refresh` as a mutation when `docs/solutions/` is absent; seed navigation first.

## Future direction (not v1)

Living automated docs remain the 10x ceiling: generate AGENTS/tool/skill inventories and changelog drafts from source-of-truth manifests. Do not bead this in the current drift-fix cycle.
