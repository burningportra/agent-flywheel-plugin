# Codex Second Opinion — SKILL.md Linter Synthesized Plan

**Reviewer:** IndigoCreek (codex-cli, gpt-5-codex)
**Date:** 2026-04-15
**Input:** `docs/plans/2026-04-15-skill-linter-synthesized.md` (676 lines, by BrightCave)

---

## Summary verdict

**HOLD for scope cut, then ship.** The synthesis is technically sound and the load-bearing decisions (remark parser, tolerant AUQ walker, rule isolation, HTML-comment suppressions, baseline + fingerprints) are the right ones. But v1 carries 23 beads, 5+ devDependency additions, severity phasing, an autofix pipeline, SARIF output, property tests, memory-profile tests, a manifest system, *and* a baseline system — for a single 1,438-line file with 38 real AUQ call sites. This is a ~3-engineer-week deliverable dressed as a one-sprint project. A 12-bead v1.0 that ships the parser + 5 rules + compact/gha/json reporters + baseline is enough to catch the next bead-z9g; everything else is v1.1+. Ship the spine, defer the ornaments.

---

## Per-decision take

1. **Parser choice: `remark-parse`.** Agree with synthesis, but cache the concern. The bead-z9g incident (`*/` inside nested fences) is the deciding precedent — a hand-rolled state machine sounds elegant until you meet the actual quad-backtick CommonMark corner cases, and rewriting that logic invites the same failure class back. *However:* the ~100 transitive-dep hit is a legitimate supply-chain concern for an MCP server that currently has **4 deps + 4 devDeps total**. Mitigation: add a `devDependency audit` CI gate that fails if `remark-parse` ever graduates to a runtime dep, and pin exact versions (already in plan §4.1). If a future audit screams, `mdast-util-from-markdown` alone covers the 80% use case with fewer transitives.

2. **Rollout gating: both mechanisms.** Disagree with synthesis — these *do* conflict. The baseline already hides pre-existing findings from the exit code; severity phasing ratchets the *new* finding severity over time. Running both means a SLASH001 added tomorrow is a warn, the one in the baseline is demoted to info, and in 2 weeks the *new* one becomes an error while the baselined one is still info. That's three states for the same rule, and reviewers will not model it correctly. **Pick baseline-only.** Severity phasing was a pre-baseline hedge; once you have fingerprints, you don't need it.

3. **`npm test` blocking on lint failures: no.** Disagree. `npm test` is the tight inner loop — developers run it dozens of times during a feature. Coupling it to a markdown linter against an AI-authored doc trains them to `--no-verify` reflexively the first time it fires during an unrelated refactor. Keep `lint:skill` as its own script and let CI be the enforcer. Pre-commit hook (T16) already catches 90% of drift before push. Ergonomics's "test depends on lint:skill" was a muscle-memory argument, not a correctness one.

4. **Autofix breadth in v1: defer all of T13.** Disagree with synthesis. Four "safe" autofixes sound cheap; in practice each one is a mini-feature with its own edge cases (AUQ003's header truncation at grapheme boundaries, PLACE001's stub-comment placement, HARD001's enforcement-ref synthesis). You need a fix pipeline, atomic tmpfile writes, diff preview, and `--fix-review` UX — all to save ~30 seconds per finding on a file that changes weekly. Ship autofix in v1.1 after the detection surface is stable. Saves T13 entirely (~2–3 beads of real work) and the `--fix-review` coordination UX.

5. **Skill resolution: manifest + `--ci` flag.** Agree with synthesis, mostly. The manifest is the clean answer to "passes locally, fails in CI" and 21 local skills (verified) is small enough that `--update-manifest` is not a burden. **Caveat:** the "CI flag disables `~/.claude/plugins`" logic needs a test that explicitly runs with `HOME=/nonexistent` and asserts layers 3–4 are silently skipped — this is the exact kind of environment difference that bites at 3am, and the integration test list in §14.3 mentions it but the acceptance criteria for T3 doesn't make it load-bearing.

6. **AUQ call site count: 38 real + 20 prose = 58 text hits.** Empirically verified:
   ```
   grep -cE 'AskUserQuestion\s*\(' skills/orchestrate/SKILL.md  → 38
   grep -c  '`AskUserQuestion`'       skills/orchestrate/SKILL.md  → 20
   grep -c  'AskUserQuestion'         skills/orchestrate/SKILL.md  → 59 (one extra in a heading/bullet)
   ```
   Correctness (28) was undercounting — likely only matched call sites that opened a block the author recognized. Robustness (59) was overcounting — included every textual reference. The **load-bearing number for rule scoping is 38** (actual calls the linter must parse); the **load-bearing number for IMPL001's "AUQ-within-20-lines" FP defense is 38** (the anchors that exempt surrounding prose). The plan's baseline-generation step (T15) should use 38 as its sanity check, not 28 or 59. The disagreement is itself a bug report: both planners were reading the same file and got different numbers because neither one defined "AUQ call site" precisely. Lock the definition in T2's acceptance criteria: *"a token matching `AskUserQuestion\s*\(` starting at column ≤ indentation of enclosing code fence."*

---

## Gaps surfaced

- **`tsx` runtime attack surface.** Not discussed anywhere in the synthesis. `tsx` transpiles TypeScript on the fly via esbuild; in CI it pulls a native binary that's platform-specific. For a tool that runs on every PR, this is one more trust anchor. Mitigation: compile `scripts/lint-skill.ts` to `dist/scripts/lint-skill.js` during `npm run build`, and have CI run the compiled JS (`node dist/scripts/lint-skill.js`) — not `tsx`. Reserve `tsx` for dev-loop only. Cost: one npm script change. Benefit: one fewer transitive in the CI hot path, and faster CI cold-start.

- **SARIF reporter is speculative.** Plan §7.2 lists it for "reviewdog / VS Code SARIF viewer / future GitHub Code Scanning." Nobody in this repo uses any of those today. Shipping SARIF means maintaining a second output schema and testing it. Defer to v1.1 once someone asks for it. Drop from T10's acceptance criteria.

- **Fingerprint (sha256 of line ± 1) robustness is weaker than claimed.** The plan says it "survives minor line shifts." That's true for pure insertions/deletions above the finding, but fails for:
  - The common case where an editor reformats a code block (whitespace change on adjacent lines → fingerprint breaks).
  - Rename-refactor across a skill (swap `/orchestrate-scan` → `/orchestrate-audit` on the offending line → fingerprint breaks on purpose, which is *correct* behavior but the plan doesn't say so).
  - Line endings: if CRLF→LF normalization hasn't happened yet when the fingerprint is computed, two machines get different baselines. §1.5 robustness normalization must run *before* fingerprint computation; make that explicit in T12's acceptance criteria.
  Recommend: sha256 of `(trimmed(line-1), trimmed(line), trimmed(line+1))` joined by `\n`. Documented limitation: intentionally breaks on substantive edits.

- **Golden-file determinism test is fragile.** Byte-identical stdout across runs is great; byte-identical stdout across **different machines** (macOS vs GHA ubuntu-latest) is harder — locale, terminal width, ANSI color detection, path separators. Plan §7.3 mentions sorting but not locale. Force `LANG=C` in the golden test and use `\n` explicitly, never `EOL`. Add to T10 acceptance.

- **No rule-version field.** JSON schema (§7.4) has `rulesetVersion: 1` but individual findings don't carry the rule version that produced them. When AUQ003 gets tightened in v1.1, old baselines will silently drift. Add `rulesetVersion` to each baseline entry.

- **Emergency escape hatch + `--ignore-rule` overlap.** Plan has three escape hatches (suppression comments, `--ignore-rule`, `SKILL_LINT_EMERGENCY=1`). The runbook (T20) needs an explicit decision tree; otherwise reviewers will reach for `SKILL_LINT_EMERGENCY` because it's shortest, and the CI grep guard won't catch local use.

- **No drift test for `.lintskill-manifest.json` itself.** If someone adds a skill directory and forgets `--update-manifest`, the manifest silently lags. Add a CI check: `diff <(ls skills/) <(jq -r '.skills[]' .lintskill-manifest.json | sort)` — fail if different. One line of workflow, catches a whole class of bugs.

---

## Recommended scope cuts

Current: 23 beads (20 core + 3 optional). Proposed v1.0: **12 beads**, with 11 deferred to v1.1.

**Keep in v1.0:**
- T1 (skeleton), T2 (parser), T3 (skill registry), T4 (logger), T5 (AUQ rules), T6 (SLASH001), T7 (PLACE001), T9 (IMPL001), T10 (reporters — pretty/compact/gha/json only, **no SARIF**), T11 (rule isolation), T14 (CLI), T15 (baseline), T17 (CI workflow), T18 (live canary).

That's 14 beads. Merge two pairs to get to 12:
- **Merge T4 into T1** — the logger is small enough that separating it is overhead; ship them together.
- **Merge T11 into T14** — rule isolation is structural code inside the CLI assembly; a single bead covers both.

**Defer to v1.1:**
- T8 (HARD001) — severity `info`, never blocks, shipping it day one adds noise. Add after the baseline is clear.
- T12 suppression-comment half — baseline alone covers v1.0; add `<!-- lint-disable-next-line -->` when a real case appears.
- T13 (autofix entire pipeline) — see decision 4.
- T16 (pre-commit hook) — CI enforcement is enough for v1.0; a hook template is a 10-minute add later.
- T19 (adversarial fixture suite + golden-file) — keep *some* adversarial fixtures inline in T2's tests (nested-fence-with-comment-terminator is mandatory, bead-z9g replay). Defer the full 22-fixture suite and golden-file determinism test.
- T20 (runbook) — write it once there's an actual CI failure to reference.
- T21 (property tests), T22 (memory profile), T23 (MCP wrapper) — all marked optional; keep them optional.
- SARIF reporter — remove from T10.
- Severity phasing — remove from §13.2 (see decision 2).

Headline: **ship the parser + 4 rules + baseline + CI + canary**, stop there, iterate. Everything else is the second lap.

---

## Parallelization realism

The 6-wave plan is optimistic. File-overlap check:

- Wave 3 (T5–T11 in parallel) touches `src/lint/index.ts` from T10 and T11, both depend on T1's index.ts stub. If two agents edit `index.ts` concurrently without coordination, you get a merge conflict. **Agent Mail file-reservation is mandatory** for any bead touching `index.ts`, `types.ts`, or `rules/index.ts` (the rule registry).
- Wave 3 also spawns 6 agents in parallel on a codebase with 21 skills — the team-mode bootstrap overhead (per memory `feedback_parallel_agents.md`) is meaningful. Consider capping to 3 parallel (T5/T6/T7 one wave, T8/T9/T10/T11 the next) so the Agent Mail traffic doesn't dominate.
- Wave 6 (T15/T16/T18/T19 in parallel) is fine — all touch different files.

Realistic: **4 serial waves, not 6.** Critical path ~5 hops, not 8.

---

## Open questions for the coordinator (≤3)

1. **Are we willing to ship v1.0 with 12 beads and explicitly defer autofix, SARIF, severity phasing, and the full adversarial fixture suite to v1.1?** This is the single biggest scope decision. If the answer is "no, we want the full 23," then the plan's 8-hop critical path needs a calendar estimate — this is ≥2 weeks of focused work, not a sprint.

2. **Do we accept ~100 transitive devDependencies from `remark-parse`, or do we instead budget 2 extra days to use `mdast-util-from-markdown` alone and take the smaller dep graph?** The answer shapes T2 and every future `npm audit` conversation.

3. **Is `npm test` in `mcp-server/` expected to gate on SKILL.md lint, or will CI be the only enforcer?** Decision 3 above. This affects contributor UX more than any other single call in the plan — and it will get revisited under pressure, so settle it now.

---

**End of second opinion.**
