# AGENTS.md + CHANGELOG + docs/solutions audit — SYNTHESIZED plan

**Date:** 2026-05-06
**Goal slug:** agents-md-changelog-audit
**Synthesizer:** plan-synthesizer (claude-opus-4-7)
**Sources:**
- `docs/brainstorms/agents-md-changelog-audit-2026-05-06.md` (scope anchor)
- `docs/plans/2026-05-06-correctness.md` (cc/Opus, CloudyIvy)
- `docs/plans/2026-05-06-ergonomics.md` (pi/Codex)
- robustness perspective: **MISSING** — gmi planner wedged at 13min, no output. Robustness is filled in inline per-task per spec.
**HEAD:** `05071af` (v3.12.0)
**Revision:** Step 5.55 alignment refinement — APR-Pro corpus expanded from 4 → 12 files; path errors fixed; T8 split into T8a / T8a2 / T8b due to corpus size (247 KB across 12 files exceeds atomic-bead threshold).

---

## 1. Goal & Scope

**Goal.** A single, focused docs/DX polish cycle that makes AGENTS.md, CHANGELOG.md, and `docs/solutions/` factually accurate and survivable for a cold reader at v3.12.0 HEAD. Three surfaces, one cycle, no automation.

**Scope.** Drift-fix + gap-fill floor from the Phase 0.5 brainstorm. AGENTS.md: only fix factually-wrong claims (binary names, paths, fragile line refs, missing tool sections — notably the v3.12.0 `flywheel_convergence` family). CHANGELOG: ensure each shipped feature commit since v3.11.0 (incl. v3.12.0) has an entry; flag (do not create) missing git tags. Bundle a `docs/solutions/` refresh — but per the ergonomics finding, the directory is **absent**, so the in-scope work is a navigability shell + a classify-only audit of the actual `docs/*` learning corpus, not a topic-page generation pass. Living automated docs are the 10x ceiling and stay reserved as a future-direction appendix.

<!-- Step 5.55 refinement: scope sentence preserved; APR-Pro consolidation widened in §5/§7 to 12 source files. -->

---

## 2. Best-of-All-Worlds analysis

### What CORRECTNESS does better
- **Hard evidence everywhere.** Cites file paths and line numbers (`mcp-server/src/server.ts:379`, `agent-mail.ts:228`) and grades each AGENTS.md claim against HEAD. Catches subtle drift (the v3.11.7 `orch_deprecation_warned` warning that ergonomics misses; fragile line refs that would silently rot).
- **CHANGELOG gap analysis is exhaustive.** Walks every release tag v3.11.0..HEAD, finds the **tag inventory mismatch** (v3.11.5–v3.11.9 have CHANGELOG entries but no annotated git tags). Ergonomics notices the symptom but doesn't enumerate.
- **Hard-to-verify claims are surfaced honestly** (Section "Hard-to-verify claims" — `flywheel_observe.hints[]`, `reserveOrFail` lint wiring, `FW_SKILL_BUNDLE=off` recovery path). This is the closest the source plans come to robustness thinking.
- **`docs/solutions/` reality check.** Notes the directory does not exist and pivots to the actual `docs/*` learning folders (`docs/research/`, `docs/audits/`, etc.) with a Keep/Update/Consolidate/Replace/Delete table.

**Unique insight (Step 5.55-corrected):** APR-Pro research is now landed in v3.12.0, and the corpus is **larger than the source plan surfaced** — **12 files** (4 root-level synthesis docs + 8 `docs/research/apr-pro-*.md` phase artifacts), not 3. Total ≈247 KB. Without consolidation, every release widens the drift gap. The original "one bead" framing assumed 3–4 files; at 12, T8 must split (see §7).

<!-- Step 5.55 refinement: corrected file count from "three" to "twelve" and surfaced the corpus-size-driven split. User explicitly requested EXPAND. -->

### What ERGONOMICS does better
- **Reader-first framing.** Ranks reader-friction by hit-rate: cold-agent survival map, version-sliced vs task-sliced MCP docs, swarm-instructions sprawl. Correctness misses these because it grades atoms, not the document gestalt.
- **Surgical, non-mutating reorg.** "30-second map" + "MCP tools quick reference" added near the top *without* rewriting hard constraints. Solves the "I can't find what I need in 30s" problem with one bead, not a refactor.
- **`docs/solutions/` navigability shell.** The brainstorm asked for a `flywheel-compound-refresh` pass; ergonomics correctly identifies that running compound-refresh against an empty corpus is wrong, and seeds a `docs/solutions/README.md` first. This is the right ergonomic floor.
- **Verification UX.** Python `assert` blocks for done-checks are stricter than `grep -q` (e.g. ordering: `30-second map` must appear *before* `Hard Constraints`).

**Unique insight:** Tag/CHANGELOG cadence note. Readers will hunt for v3.11.5–v3.11.9 git tags and find nothing. A 2-line "Tag cadence" note in CHANGELOG.md prevents that hunt — cheap, high reader value.

### Unresolved tensions

| Tension | Correctness | Ergonomics | Synthesis decision |
|---|---|---|---|
| **`docs/solutions/` strategy** | Classify-only audit of the existing `docs/*` corpus + APR-Pro consolidation. | Seed a navigability `README.md`; defer topic pages until corpus is non-empty. | **Both.** Seed `docs/solutions/README.md` (T7) **and** classify the existing learning corpus (T8b) — they target different layers (intended-future surface vs. current-corpus hygiene). |
| **AGENTS.md reorg vs. surgical patches** | Surgical only; do not move sections. | Add "30-second map" near top + MCP quick reference. | **Ergonomics wins.** Adding new top-section affordances is not a reorg; it is a gap-fill. Hard constraints stay where they are. |
| **CHANGELOG cadence note** | Out of scope (release-process concern). | In-scope — readers need it. | **Ergonomics wins.** A 2-line note costs nothing and prevents tag-hunting. Tag *creation* remains out of scope. |
| **APR-Pro research consolidation** | One bead (T7 in correctness). | Not addressed. | **Adopt and split.** Real drift, but the corpus is 12 files / ≈247 KB. Ships in **two beads** — T8a (4 root synthesis files → landed-doc) and T8a2 (8 phase artifacts → phase-archive doc) — to keep each atomic. <!-- Step 5.55: corrected from "one bead" because user expanded scope to all 12 files. --> |
| **Verification style** | `grep -q` shell one-liners. | Python `assert` blocks. | **Mix.** Use `grep -q` for atom-presence checks; use Python for ordering / cross-file invariants. Keep each verification single-line where possible. |

---

## 3. Drift catalog (AGENTS.md)

From correctness §1, lightly edited. Each row is a factual error or factual omission against `05071af`.

| Section / anchor | Claim | Reality at HEAD | Fix |
|---|---|---|---|
| §"MCP tools" — overall | Documents tools added in v3.7.0 + v3.11.0 only. | v3.12.0 ships `flywheel_convergence` (`mcp-server/src/tools/convergence-tool.ts`, registered `mcp-server/src/server.ts:379`) and `convergence_state_validity` doctor check (`doctor.ts:99`). Both undocumented. | **Add §"MCP tools added in v3.12.0"** describing `flywheel_convergence` (read-only `ConvergenceState` from `.pi-flywheel/plans/<slug>/convergence.json`, surfaces `oscillation.detected` per APR-Pro B6 guard) + new doctor check. (T1) |
| §"MCP tools added in v3.7.0" — `flywheel_remediate` | "Five handlers ship: `dist_drift`, `mcp_connectivity`, `agent_mail_liveness`, `orphaned_worktrees`, `checkpoint_validity`." | Verify against `mcp-server/src/tools/remediations/`. Possibly stale if convergence handler added. | Spot-check; update count + names. (T6) |
| §"Known issue: agent-mail exclusive-reservation enforcement" | References `mcp-server/src/agent-mail.ts:228`. | Line number is fragile; rots on any edit to that file. | Replace with stable function ref `reserveFileReservations()` (both occurrences, lines ~91 and ~171). (T3) |
| §"Tool name deprecation" | `orch_*` aliases preserved, removed in v4.0. | True, plus v3.11.7 (`e5ded9b`) added one-shot `orch_deprecation_warned` runtime warning. AGENTS.md silent on it. | Append: "v3.11.7+ logs a one-shot `orch_deprecation_warned` per alias call with the canonical replacement." (T4) |
| §"Available CLI Tools" — `ccc` line | "`ccc` — optional codebase indexing/search tool. Not required". | Verify `flywheel_doctor` still probes `ccc`; if not, line is dead. | Spot-check; remove if dead, keep if doctor still probes. (T5) |
| §"Code Conventions" — `deep-plan.ts` ref | "deep in `deep-plan.ts` synthesis". | Verify file exists at HEAD. | Spot-check; soften to "deep nested helpers" if file moved. (T5) |
| §"MCP tools added in v3.11.0" — `flywheel_observe.hints[]` | "Hint surface includes missing or invalid completion attestations". | Possible drift after v3.11.x changes. | Spot-check `mcp-server/src/tools/observe.ts`. (T5) |
| §"NTM pane priority" | "prefer `--cod=` over `--pi=`". | Matches HEAD policy after `c0cf590`. **Not drift.** | None — listed only to prevent double-fixing. |

---

## 4. CHANGELOG gap inventory

From correctness §2.

| Commit / tag | Date | In CHANGELOG? | Action |
|---|---|---|---|
| `05071af` v3.12.0 release | 2026-05-06 | **MISSING** | Add `## [3.12.0] - 2026-05-06`: APR-Pro multi-signal convergence, B6 oscillation guard (`signFlips > revisions/3` ⇒ `status: "oscillating"`), `flywheel_convergence` MCP tool, `convergence_state_validity` doctor check. (T2) |
| `c0cf590` feat(swarm): cod>pi NTM pane priority | 2026-05-04 | **MISSING** | Roll into v3.12.0 entry under `Changed`: "NTM pane priority — `--cod` is now the default secondary lane after `--cc`; `--pi` demoted to fallback." (T2) |
| v3.11.5–v3.11.9 release commits | 2026-05-02..03 | Yes | — |
| Git tag inventory mismatch | — | **Tag drift (flag-only)** | `git tag -l 'v3.11.*'` returns only v3.11.0–v3.11.4. v3.11.5–v3.11.9 have CHANGELOG + release commits but no annotated git tag. **Tag creation = out of scope** (release process). Document via 2-line "Tag cadence" note in CHANGELOG. (T2 sub-bullet) |
| Phantom-entry sweep | — | None found | All v3.11.x CHANGELOG entries map to a `main` release commit. |

**Real content gaps:** v3.12.0 entry + c0cf590 (rolled into v3.12.0). Cadence note prevents reader confusion.

---

## 5. docs/solutions/ refresh classification

From correctness §3 (the actual learning corpus, since `docs/solutions/` is absent), with ergonomics' navigability-shell decision layered on top.

<!-- Step 5.55 refinement: APR-Pro source rows below were path-corrected (docs/research/research-apr-pro-* → docs/research-apr-pro-*) and EXPANDED from 4 files to 12 by adding the 8 phase-artifact rows under docs/research/apr-pro-*.md. User explicitly requested EXPAND. -->

| Path | Status | Reason |
|---|---|---|
| `docs/solutions/` (directory) | **Seed** | Does not exist. Per ergonomics, create `docs/solutions/README.md` navigation shell (category schema, frontmatter keys, "no corpus yet" note, pointer to `/flywheel-compound-refresh`). T7. |
| `docs/research-apr-pro-feedback-opus.md` | **Consolidate (synthesis)** | APR-Pro landed in v3.12.0. Root-level synthesis output. Merge into landed doc. T8a. |
| `docs/research-apr-pro-feedback-sonnet.md` | **Consolidate (synthesis)** | Same. T8a. |
| `docs/research-apr-pro-integration.md` | **Consolidate (synthesis)** | Same. T8a. |
| `docs/research-automated_plan_reviser_pro-2026-05-05.md` | **Update + Consolidate (synthesis)** | Add "Landed in v3.12.0" header pointing to `mcp-server/src/convergence.ts`; also referenced from landed doc. T8a. |
| `docs/research/apr-pro-phase1-explore.md` | **Consolidate (phase artifact)** | Phase-1 exploration; pre-synthesis input. Archive into phase-archive doc. T8a2. |
| `docs/research/apr-pro-phase2-deep.md` | **Consolidate (phase artifact)** | Phase-2 deep dive. T8a2. |
| `docs/research/apr-pro-phase2-deepen.md` | **Consolidate (phase artifact)** | Phase-2 deepening pass. T8a2. |
| `docs/research/apr-pro-phase3-invert.md` | **Consolidate (phase artifact)** | Phase-3 inversion / counter-arguments. T8a2. |
| `docs/research/apr-pro-phase4-blunders.md` | **Consolidate (phase artifact)** | Phase-4 blunder review. T8a2. |
| `docs/research/apr-pro-apply.md` | **Consolidate (phase artifact)** | Application notes. T8a2. |
| `docs/research/apr-pro-ergonomics.md` | **Consolidate (phase artifact)** | Ergonomics-of-APR-Pro phase notes; not the same as the AGENTS.md-audit ergonomics plan. T8a2. |
| `docs/research/research-compound-engineering-plugin-2026-04-23.md` | **Keep** | Pre-dates v3.11.0 cycle; baseline. |
| `docs/skill-refine-flywheel-proposed.md` | **Verify → Update or Delete** | Classify in T8b audit. |
| `docs/skill-refine-start-proposed.md` | **Verify → Update or Delete** | Classify in T8b audit. |
| `docs/gap-analysis-flywheel-guide.md` | **Update** | Many gaps may be closed by v3.11.x feedback waves. T8b. |
| `docs/agent-flywheel-complete-guide.md` | **Verify** | If duplicates AGENTS.md / README, replace-by-pointer. T8b. |
| `docs/tender-config.md` | **Keep** | Operator runbook. |
| `docs/upstream-asks/*` | **Keep** | Living upstream coordination ledger. |
| `docs/audits/*`, `docs/duels/*` | **Keep** | Per AGENTS.md "never auto-delete" rule. |
| `docs/brainstorms/*`, `docs/plans/*`, `docs/reviews/*` | **Keep** | Phase artifacts owned by flywheel itself. |

**APR-Pro source totals:** 12 files, ≈247 KB combined. Split rationale: 4 root-level synthesis files (≈116 KB) → T8a; 8 phase artifacts (≈131 KB) → T8a2. Each consolidation target is an additive write + pointer-headers on sources; no deletes.

---

## 6. Reader-friction fixes

Surgical, non-reorg additions to AGENTS.md (from ergonomics §1–§2). All keep existing sections in place.

1. **30-second map** (T5a) — top-of-file affordance directly after Project Overview, before Hard Constraints. Four bullets: *Project-local skills* / *MCP tools* / *Swarm path* / *Conventions*. Each links to an existing section.
2. **MCP tools quick reference** (T1) — compact current-tool list inserted at the head of the existing MCP tools family. Keeps version-sliced detail. Names every HEAD tool incl. `flywheel_convergence`, `flywheel_advance_wave`, `flywheel_memory.refresh_learnings`.
3. **Swarm quick path** (T5b, optional sub-bullet of T5) — single 5-line recipe pointing to `ntm spawn`, Agent Mail reservations, `--type=cod`, bead close/verify, completion report. References existing hard rules; does not duplicate them.
4. **CHANGELOG "Tag cadence" note** (T2) — 2-line block at top of CHANGELOG.md noting that entries 3.11.5–3.11.9 ship without annotated git tags; v3.12.0 corresponds to commit `05071af`.

Explicit out-of-scope per ergonomics §6: rewriting old CHANGELOG entries, full AGENTS.md rewrite, topic-page generation under `docs/solutions/`.

---

## 7. Task table

**9 atomic tasks** (was 8 pre-Step-5.55; T8 split into T8a / T8a2 / T8b after corpus expansion). Every task ships independently (`depends_on: []` per CLAUDE.md). Task IDs are stable; ordering below is recommended impact-per-line.

<!-- Step 5.55 refinement: T8 split into three because the consolidated landed doc would source 12 files (>8) and each consolidation target writes ≈30+ KB, exceeding the heuristic for an atomic bead. -->

| ID | Title | Files touched | depends_on | Robustness considerations | Verification command |
|---|---|---|---|---|---|
| **T1** | Add `## MCP tools added in v3.12.0` section + MCP tools quick reference at head of MCP family. Documents `flywheel_convergence`, `convergence_state_validity` doctor check, B6 oscillation semantics; lists `flywheel_advance_wave`, `flywheel_memory.refresh_learnings`. | `AGENTS.md` | `[]` | **Sequencing:** Insert quick-ref at the *head* of the MCP family, not above Project Overview, to avoid breaking T5a's 30-second-map anchor. **Silent-drift risk:** If a future MCP tool ships, the quick-ref must be updated alongside the version-sliced section — note this convention in the new subsection. **Avoid copy-pasting tool registration code paths into the doc** — paths drift; cite by symbol name. | `grep -q "MCP tools added in v3.12.0" AGENTS.md && grep -q "flywheel_convergence" AGENTS.md && grep -qE "B6\|oscillation" AGENTS.md && grep -q "flywheel_advance_wave" AGENTS.md` |
| **T2** | Add `## [3.12.0] - 2026-05-06` to CHANGELOG.md (APR-Pro convergence, B6 guard, `flywheel_convergence` tool, `convergence_state_validity` check, NTM cod>pi under `Changed`). Add 2-line "Tag cadence" note explaining that 3.11.5–3.11.9 ship without annotated git tags; v3.12.0 = commit `05071af`. | `CHANGELOG.md` | `[]` | **Sequencing:** Cadence note must go above the 3.12.0 entry, immediately after the file header, so a reader sees it before scanning entries. **Silent-drift risk:** If retroactive tags get created later, the cadence note becomes false; phrase it conditionally ("as of 2026-05-06"). **Verification:** ensure 3.12.0 entry sorts above 3.11.9 (Keep-a-Changelog reverse-chronological). | `grep -q "^## \[3.12.0\] - 2026-05-06" CHANGELOG.md && python3 -c "s=open('CHANGELOG.md').read(); assert s.index('## [3.12.0]') < s.index('## [3.11.9]'); assert '05071af' in s; assert 'Tag cadence' in s or 'Release cadence' in s"` |
| **T3** | Replace fragile `agent-mail.ts:228` line refs (×2) in AGENTS.md with stable function reference `reserveFileReservations()`. | `AGENTS.md` | `[]` | **Silent-drift risk:** This drift class is the highest-frequency rot vector in AGENTS.md. After this fix, prefer symbol-based refs everywhere; consider a follow-up bead for a sweep (out of scope here). | `! grep -q "agent-mail.ts:228" AGENTS.md && [ "$(grep -c "reserveFileReservations" AGENTS.md)" -ge 1 ]` |
| **T4** | Append one sentence to AGENTS.md §"Tool name deprecation" describing the v3.11.7 `orch_deprecation_warned` runtime warning. | `AGENTS.md` | `[]` | **Sequencing:** Single-paragraph append; no ordering hazard. **Verification:** confirm exact symbol `orch_deprecation_warned` (snake_case) appears, not a paraphrase. | `grep -q "orch_deprecation_warned" AGENTS.md` |
| **T5** | AGENTS.md ergonomics + path-drift sweep: (a) insert "30-second map" 4-bullet block after Project Overview, before Hard Constraints; (b) add 5-line "Swarm quick path" recipe; (c) verify every `mcp-server/src/...ts`, `skills/...md`, `commands/...md` path AGENTS.md cites exists at HEAD — fix any drift; (d) spot-check `flywheel_observe.hints[]`, `ccc` doctor probe, `deep-plan.ts` ref. Stop at 12 spot-checks. | `AGENTS.md` | `[]` | **Sequencing:** 30-second map MUST appear before Hard Constraints (ergonomics requirement). Use Python ordering assertion in verification. **Silent-drift risk:** Path checks should be string-extracted with regex, not eyeballed — otherwise drift recurs. **Avoid:** rewriting any duel/Hard Constraints content. This is additive only. | `python3 -c "s=open('AGENTS.md').read(); assert '30-second map' in s; assert s.index('30-second map') < s.index('Hard Constraints'); assert 'ntm spawn' in s and 'ntm --robot-send' in s" && for p in $(grep -oE '(mcp-server/src/[A-Za-z0-9/_.-]+\.ts\|skills/[A-Za-z0-9/_.-]+\.md\|commands/[A-Za-z0-9_.-]+\.md)' AGENTS.md \| sort -u); do test -e "$p" \|\| { echo MISSING $p; exit 1; }; done` |
| **T6** | Verify `flywheel_remediate` handler list (count + names) in AGENTS.md against `mcp-server/src/tools/remediations/`; update if drifted. | `AGENTS.md` | `[]` | **Verification command produces evidence;** human compares output and edits AGENTS.md if needed. **Silent-drift risk:** writing the count as a numeral ("Five") makes drift loud — keep the convention. | `actual=$(ls mcp-server/src/tools/remediations/ \| grep -vE '^(index\|README)' \| wc -l \| tr -d ' '); echo "actual=$actual"; grep -oE "[A-Z][a-z]+ handlers ship" AGENTS.md` |
| **T7** | Seed `docs/solutions/README.md` navigation shell: explains corpus may be empty, category layout, frontmatter keys (`symptom`, `problem_type`, `component`), search commands, `/flywheel-compound-refresh` behavior, "no corpus yet" disclaimer. | `docs/solutions/README.md` (new), `docs/solutions/` (mkdir) | `[]` | **Sequencing:** Must precede any future `flywheel-compound-refresh` mutation pass — the skill operates on the corpus and the shell defines its shape. **Silent-drift risk:** Frontmatter keys here become a soft contract; pick keys that match what `flywheel-compound-refresh` already reads (verify against the skill source before committing). **Avoid:** generating fake/template solution entries. | `test -f docs/solutions/README.md && grep -qE "(symptom\|problem_type\|component)" docs/solutions/README.md && grep -q "flywheel-compound-refresh" docs/solutions/README.md && grep -qE "(No corpus yet\|no entries yet\|empty)" docs/solutions/README.md` |
| **T8a** | Consolidate the **4 root-level APR-Pro synthesis files** into `docs/research/research-apr-pro-landed-2026-05-06.md`: cite `mcp-server/src/convergence.ts`, link to v3.12.0 CHANGELOG entry, summarize multi-signal convergence + B6 oscillation guard. Add "Landed in v3.12.0" header to `docs/research-automated_plan_reviser_pro-2026-05-05.md`. **Do NOT delete** any source file — append a `> Consolidated into [docs/research/research-apr-pro-landed-2026-05-06.md] on 2026-05-06.` pointer header to each of the 4 root-level sources. <!-- Step 5.55: paths corrected from docs/research/research-apr-pro-* → docs/research-apr-pro-* (real location). --> | `docs/research/research-apr-pro-landed-2026-05-06.md` (new), `docs/research-apr-pro-feedback-opus.md` (pointer header only), `docs/research-apr-pro-feedback-sonnet.md` (pointer header only), `docs/research-apr-pro-integration.md` (pointer header only), `docs/research-automated_plan_reviser_pro-2026-05-05.md` (pointer header + "Landed in v3.12.0") | `[]` | **Sequencing:** Soft-dependency on T2 (cite v3.12.0 CHANGELOG entry) — if T2 lands later, the link is forward-pointing and still valid. **Silent-drift risk:** 4 source files = 4 chances for a stale "Consolidated into" citation if the landed-doc filename changes; bake the date into the landed-doc filename so renames are loud. **Avoid:** deleting source files — `docs/audits` "never auto-delete" rule applies by analogy. **Path-error risk:** the prior synthesis cited `docs/research/research-apr-pro-*.md`; real paths are at `docs/` root. Verification command below tests both that the **landed doc exists** and that **all 4 sources have pointer headers**. | `test -f docs/research/research-apr-pro-landed-2026-05-06.md && grep -q "v3.12.0" docs/research/research-apr-pro-landed-2026-05-06.md && grep -q "convergence.ts" docs/research/research-apr-pro-landed-2026-05-06.md && grep -q "Landed in v3.12.0" docs/research-automated_plan_reviser_pro-2026-05-05.md && for f in docs/research-apr-pro-feedback-opus.md docs/research-apr-pro-feedback-sonnet.md docs/research-apr-pro-integration.md docs/research-automated_plan_reviser_pro-2026-05-05.md; do grep -q "Consolidated into" "$f" \|\| { echo "MISSING pointer: $f"; exit 1; }; done` |
| **T8a2** | Consolidate the **8 APR-Pro phase artifacts** under `docs/research/apr-pro-*.md` into `docs/research/research-apr-pro-phase-archive-2026-05-06.md`: one section per phase (explore / deep / deepen / invert / blunders / apply / ergonomics), preserve key claims and counter-arguments, link forward to the landed doc from T8a (forward-pointing OK). Add `> Archived into [docs/research/research-apr-pro-phase-archive-2026-05-06.md] on 2026-05-06.` pointer header to each of the 8 source files. **Do NOT delete** any source. <!-- Step 5.55: new task; needed because the user expanded scope from 4 to 12 source files and these 8 phase artifacts are categorically different (pre-synthesis inputs, not synthesis outputs) so they merit their own archive doc. --> | `docs/research/research-apr-pro-phase-archive-2026-05-06.md` (new), `docs/research/apr-pro-phase1-explore.md` (pointer), `docs/research/apr-pro-phase2-deep.md` (pointer), `docs/research/apr-pro-phase2-deepen.md` (pointer), `docs/research/apr-pro-phase3-invert.md` (pointer), `docs/research/apr-pro-phase4-blunders.md` (pointer), `docs/research/apr-pro-apply.md` (pointer), `docs/research/apr-pro-ergonomics.md` (pointer) | `[]` | **Sequencing:** Independent of T8a — cross-link can be forward-pointing in either direction. **Silent-drift risk:** 8 sources = 8 chances for a stale pointer if the archive filename rotates. Bake the date into the archive filename. **Naming-collision risk:** `docs/research/apr-pro-ergonomics.md` shares the *word* "ergonomics" with `docs/plans/2026-05-06-ergonomics.md` — keep them clearly separated in the archive (the plans-ergonomics doc is NOT in scope for this task). **Avoid:** treating phase artifacts as redundant with synthesis outputs — they record reasoning paths the synthesis files compress; archive preserves that history. **Verification scope:** must check **all 8** pointer headers, not a subset. | `test -f docs/research/research-apr-pro-phase-archive-2026-05-06.md && for f in docs/research/apr-pro-phase1-explore.md docs/research/apr-pro-phase2-deep.md docs/research/apr-pro-phase2-deepen.md docs/research/apr-pro-phase3-invert.md docs/research/apr-pro-phase4-blunders.md docs/research/apr-pro-apply.md docs/research/apr-pro-ergonomics.md; do grep -q "Archived into" "$f" \|\| { echo "MISSING pointer: $f"; exit 1; }; done && python3 -c "import os; assert os.path.getsize('docs/research/research-apr-pro-phase-archive-2026-05-06.md') > 4000, 'archive doc too small to credibly cover 8 phases'"` |
| **T8b** | Record classify-only audit decisions for remaining `docs/*.md` learning files (`skill-refine-*`, `gap-analysis-flywheel-guide.md`, `agent-flywheel-complete-guide.md`) in `docs/audits/2026-05-06-docs-refresh-classifications.md`. Keep / Update / Consolidate / Replace / Delete / Verify per row, with rationale. **Do NOT mutate** the underlying files in this task — future cycles execute. | `docs/audits/2026-05-06-docs-refresh-classifications.md` (new) | `[]` | **Sequencing:** Independent of T8a / T8a2; can ship before, after, or in parallel. **Silent-drift risk:** Classifications reflect HEAD = `05071af`; future readers may treat them as still-current. Bake the date + commit SHA into the audit doc. **Avoid:** classifying APR-Pro source files here — they are owned by T8a/T8a2 and double-classifying introduces ambiguity. | `test -f docs/audits/2026-05-06-docs-refresh-classifications.md && [ "$(grep -cE "^\| (Keep\|Update\|Consolidate\|Replace\|Delete\|Verify) " docs/audits/2026-05-06-docs-refresh-classifications.md)" -ge 4 ] && grep -q "05071af" docs/audits/2026-05-06-docs-refresh-classifications.md` |

**Global gate after all 9 tasks ship:** `cd mcp-server && npm run lint:skill -- --baseline` exits 0 (no new lint findings introduced). <!-- Step 5.55: count updated 8 → 9 due to T8 split. -->

---

## 8. Explicit non-goals

Per brainstorm and user "smallest version" answer. Surface so they don't leak into beads.

1. **README polish.** No edits to `README.md`.
2. **Automated AGENTS.md regeneration.** No source-of-truth manifest, no codegen.
3. **CI-driven CHANGELOG generation.** No conventional-commits parser, no GH Action.
4. **Agent-contract reorganization.** No splitting AGENTS.md, no extracting "hard constraints" doc. Additive top-of-file affordance (30-second map) is **not** reorg.
5. **Per-claim runnable verification examples** in AGENTS.md (no `$ verify with: ...` blocks per claim).
6. **Tag creation for v3.11.5–v3.11.9.** Retroactive annotated tagging is a release-process concern. Flag-only via cadence note in T2.
7. **`flywheel-compound-refresh` automation pass.** The skill exists but applying it across `docs/` is a separate cycle. T7 + T8a + T8a2 + T8b are the manual carve-out for *this* cycle. <!-- Step 5.55: enumerated tasks updated after T8 split. -->
8. **Topic-page generation under `docs/solutions/`** before the corpus has real entries.
9. **Exhaustive cross-ref audit** of every claim in AGENTS.md. Spot-checks capped at 12 in T5.
10. **Rewriting historical CHANGELOG entries** for style.
11. **Deleting or rewriting any of the 12 APR-Pro source files.** T8a/T8a2 are additive-only (new consolidation target + pointer headers). Future cycles may revisit deletion under explicit `flywheel-compound-refresh` policy. <!-- Step 5.55: new non-goal; surfaces explicitly because expanding from 4 → 12 sources increases the temptation to "tidy up" by deleting. The "never auto-delete" rule applies. -->

### Future direction (not v1)
Living automated docs: regenerate AGENTS.md tool/skill inventories and CHANGELOG drafts from source-of-truth manifests on every release. 10x ceiling, deferred.

---

## 9. Provenance

- **Brainstorm:** `docs/brainstorms/agents-md-changelog-audit-2026-05-06.md` — scope anchor; smallest-version + adjacent-ask decisions encoded here.
- **Correctness plan (cc/Opus, CloudyIvy):** `docs/plans/2026-05-06-correctness.md` — drift catalog, CHANGELOG gap analysis, `docs/solutions/` reality check + APR-Pro consolidation insight, 8-task table.
- **Ergonomics plan (pi/Codex):** `docs/plans/2026-05-06-ergonomics.md` — reader-friction inventory, 30-second map, MCP quick reference, CHANGELOG cadence note, `docs/solutions/README.md` shell.
- **Robustness plan: MISSING.** gmi planner wedged at 13 minutes with no output. Per spec floor (2 of 3 source plans is usable), this synthesis proceeded. Robustness considerations are filled inline per task in §7 — sequencing constraints, silent-drift risks, and verification commands. They are deliberately terse: this is a gap-fill, not a third full plan, and the user reviewed at Step 5.55 alignment.

### Step 5.55 alignment-check changes (this revision)

User feedback at Step 5.55 surfaced two corrections that rippled across the plan:

1. **APR-Pro path errors.** The pre-revision plan cited synthesis files at `docs/research/research-apr-pro-{feedback-opus,feedback-sonnet,integration}.md`. Real paths: `docs/research-apr-pro-{feedback-opus,feedback-sonnet,integration}.md` (under `docs/` root, not `docs/research/`). Same for `docs/research-automated_plan_reviser_pro-2026-05-05.md`. All §5 rows, T8 file-touch column, and T8 verification command are now path-correct.
2. **Corpus expansion 4 → 12 files.** User explicitly requested EXPAND: in addition to the 4 root synthesis files, the 8 phase artifacts under `docs/research/apr-pro-*.md` (`apply`, `ergonomics`, `phase1-explore`, `phase2-deep`, `phase2-deepen`, `phase3-invert`, `phase4-blunders`) must also consolidate. Total corpus ≈247 KB.
3. **T8 split** (4 → 12 files exceeded heuristic of "≤8 source files per atomic bead" and the consolidated landed doc would balloon past 5 KB). T8 → T8a (4 synthesis sources → landed doc) + T8a2 (8 phase artifacts → phase-archive doc) + T8b (classify-only audit). Task count 8 → 9.
4. **Ripple-driven edits outside T8:** §2 unique-insight count corrected (3 → 12); §2 unresolved-tensions APR-Pro row updated (one bead → two beads); §5 path corrections + 8 new rows; §7 header count 8 → 9 + global-gate count update; §8 non-goal #7 enumeration updated; §8 new non-goal #11 (no-deletion of source files); §9 provenance subsection (this one) added; §9 synthesis-decisions table APR-Pro row updated.

### Synthesis decisions adopted

| Decision | Adopted from | Rationale |
|---|---|---|
| 30-second map + MCP quick reference | Ergonomics | Higher reader-impact-per-line than any single drift fix; surgical, non-reorg. |
| Drift catalog content + line-ref hardening (T3) | Correctness | Hard evidence; ergonomics did not catch fragile `agent-mail.ts:228` rot. |
| `orch_deprecation_warned` mention (T4) | Correctness | Genuinely missing; cheap fix. |
| Path-drift spot-check sweep (T5c) | Correctness | Prevents future silent rot; capped at 12 to stay atomic. |
| CHANGELOG "Tag cadence" note (T2) | Ergonomics | Prevents reader tag-hunting; near-zero cost. |
| `docs/solutions/README.md` seed (T7) | Ergonomics | Right ergonomic floor when corpus is absent; running compound-refresh on empty would be wrong. |
| APR-Pro consolidation split into T8a + T8a2 | Correctness (insight) + Step 5.55 user feedback | Real corpus drift; corpus is 12 files / ≈247 KB; splitting keeps each bead atomic. <!-- Step 5.55: was "one bead"; corrected to two after user expanded scope. --> |
| Classify-only audit of remaining `docs/*` (T8b) | Correctness | Gathers decisions without mutating; future cycles execute. |
| Mixed `grep` + Python verification | Both | `grep` for atom presence, Python for ordering invariants and cross-file checks. |
