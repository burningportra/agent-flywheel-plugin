# Triangulation Report — SKILL.md Linter Synthesis

**Coordinator:** PinkRidge
**Date:** 2026-04-15
**Inputs:**
- Synthesis: `2026-04-15-skill-linter-synthesized.md` (BrightCave, 676 lines, 23 beads)
- Codex 2nd opinion: `2026-04-15-codex-second-opinion.md` (IndigoCreek, 107 lines)
- Empirical verification: this file

---

## TL;DR

Synthesis is technically sound. **Codex flags it as over-scoped for v1**: 23 beads / 5 new devDeps / autofix pipeline / SARIF / severity phasing / manifest, all for a single 1,438-line file with 38 AUQ call sites. Codex recommends **12-bead v1.0** (parser + 5 rules + reporters + baseline + CI + canary), defer everything else.

---

## Empirical verification

| Claim in synthesis | Reality | Verdict |
|---|---|---|
| AUQ call sites: "28 (correctness) or 59 (robustness)" | **38** real call sites (regex `AskUserQuestion\s*\(`); 20 prose mentions; 1 heading. Both planners wrong. | Lock T2 acceptance: "token matching `AskUserQuestion\s*\(`". Use 38 for baseline sanity check. |
| `remark-parse` "~100 transitive packages" | **42 packages / 3.1 MB** on disk (`remark-parse@11 + unified@11`) | Synthesis overstated by ~2.4×. Still the largest single addition but not catastrophic. |
| `tsx` footprint | **5 packages / 11 MB** | Negligible for dev; Codex flags it as unnecessary attack surface in CI (compile + run `node` instead). |
| `mcp-server` current dep count | 4 runtime + 4 dev = 8 packages | Plan adds 4 deps → 12 total. Doubles the audit surface. |

---

## Codex divergences from synthesis

Codex took independent positions on each load-bearing decision. Where it disagreed:

| Decision | Synthesis pick | Codex pick | Codex rationale |
|---|---|---|---|
| Parser | `remark-parse` + `unified` | Same, **with caveats** | Add `npm audit` CI gate; pin exact versions; if audit screams later, switch to `mdast-util-from-markdown` alone (smaller dep graph). |
| Rollout: severity phasing AND baseline | Both | **Baseline only** | The two mechanisms create 3 states for the same rule (warn/error/info) and reviewers won't model it correctly. Severity phasing was a pre-baseline hedge; baseline supersedes it. |
| `npm test` blocks on lint | Yes | **No** | `npm test` is the inner loop; coupling it to a markdown linter trains contributors to `--no-verify`. Pre-commit + CI is enough. |
| Autofix in v1 | Ship 4 safe + 2 review-required | **Defer all to v1.1** | Each "safe" autofix is a mini-feature with edge cases; saves T13 entirely (~2-3 beads). |
| Skill resolution: manifest + `--ci` flag | Yes | **Yes, with hardening** | Add a CI test that runs with `HOME=/nonexistent` to assert layers 3-4 silently skip. Add a `diff <(ls skills/) <(jq -r '.skills[]' .lintskill-manifest.json)` workflow check. |
| `tsx` in CI | Yes (`tsx scripts/lint-skill.ts`) | **No** | Compile to `dist/scripts/lint-skill.js` in build step; CI runs `node dist/...`. Reserve `tsx` for dev loop. |
| SARIF reporter | Ship in T10 | **Drop** | Speculative — nobody in this repo uses reviewdog or VS Code SARIF viewer. Defer until requested. |
| 23-bead v1 scope | Ship all | **12-bead v1.0** | Defer T8 (HARD001), T13 (autofix), T16 (pre-commit), T19 (full adversarial suite), T20 (runbook), T21-T23 (optional). |

---

## Codex unique insights (not in synthesis)

- **Fingerprint normalization order**: CRLF→LF must run BEFORE sha256 baseline fingerprint, or two machines get different baselines for the same content. Make explicit in T12 acceptance.
- **Ruleset version per finding**: each baseline entry should carry `rulesetVersion`, not just the file. When AUQ003 tightens in v1.1, old baselines silently drift without it.
- **Manifest drift CI guard**: one-line workflow check (`diff <(ls skills/) <(jq ...)`) catches whole class of "forgot to update manifest" bugs.
- **Rule isolation file reservations**: parallel waves touching `index.ts` / `types.ts` / `rules/index.ts` need Agent Mail reservations or merge-conflict.
- **Wave-3 over-parallelization**: 6 concurrent agents on a 21-skill codebase will saturate Agent Mail. Cap at 3 parallel; do T5/T6/T7 then T8/T9/T10/T11.
- **Realistic critical path**: 4 serial waves / 5 hops, not 8.

---

## Open questions for the coordinator (Step 5.55 inputs)

These are the load-bearing decisions where reasonable people disagree:

1. **Scope**: ship 23-bead full plan vs Codex's 12-bead v1.0 (defer autofix / SARIF / severity phasing / pre-commit / runbook / property tests).

2. **Parser**: keep `remark-parse + unified` (42 packages / 3.1 MB) vs hand-rolled state machine (zero deps, more risk on nested-fence corner cases).

3. **`npm test` blocking**: keep "test depends on lint:skill" (synthesis) vs CI-only enforcement (Codex).

4. **Rollout gating**: baseline + severity phasing (synthesis) vs baseline-only (Codex — argues they conflict).

5. **`tsx` in CI**: ship as-is (`tsx` runs the script) vs Codex's "compile in build, run via `node`" pattern.

These five are what to ask the user. Everything else is downstream of these.
