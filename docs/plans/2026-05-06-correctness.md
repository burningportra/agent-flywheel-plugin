# AGENTS.md + CHANGELOG + docs/solutions audit — CORRECTNESS plan

**Date:** 2026-05-06
**Goal slug:** agents-md-changelog-audit
**Author perspective:** correctness (CloudyIvy)
**Scope anchor:** brainstorm `docs/brainstorms/agents-md-changelog-audit-2026-05-06.md` — drift-fix + gap-fill floor. No automation, no reorg.
**HEAD:** 05071af (v3.12.0)
**Last release tag on disk:** v3.11.4 (see §2)

---

## Section 1 — AGENTS.md drift catalog

Every claim in `AGENTS.md` checked against the v3.12.0 tree. Items below are factually wrong or factually missing. Stylistic nits omitted.

| Lines / section | Claim | Reality | Fix |
|---|---|---|---|
| §"MCP tools" — overall | AGENTS.md only documents tools "added in v3.7.0" and "added in v3.11.0". | v3.12.0 ships `flywheel_convergence` (`mcp-server/src/tools/convergence-tool.ts`) registered in `mcp-server/src/server.ts:379`, plus the `convergence_state_validity` doctor check (`mcp-server/src/tools/doctor.ts:99`). Neither documented. | **Add §"MCP tools added in v3.12.0"** describing `flywheel_convergence` (read-only, returns `ConvergenceState` from `.pi-flywheel/plans/<slug>/convergence.json`, surfaces `oscillation.detected` per APR-Pro B6 guard) and the new doctor check. |
| §"MCP tools added in v3.7.0" — `flywheel_remediate` | "Five handlers ship: `dist_drift`, `mcp_connectivity`, `agent_mail_liveness`, `orphaned_worktrees`, `checkpoint_validity`." | Verify against `mcp-server/src/tools/remediations/`. If a handler was added (e.g. for convergence) since v3.7.0, count is stale. | Spot-check via `ls mcp-server/src/tools/remediations/`; update count + names if drift found. |
| §"Build" (line 38) | "`mcp-server/dist/` is committed". | True at HEAD; verify `dist/skills.bundle.json` and `dist/server.js` are tracked. | Spot-check; no edit if matches. |
| §"Known issue: agent-mail exclusive-reservation enforcement" (line 171) | "the existing single use in `mcp-server/src/agent-mail.ts:228` is baselined". | Function `reserveFileReservations` exists; raw `agentMailRPC("file_reservation_paths", …)` call site is in that function. Line number is fragile and likely drifts every time the file changes. | Replace `agent-mail.ts:228` with a stable identifier: `reserveFileReservations()` in `mcp-server/src/agent-mail.ts`. (Same fix applies to the duplicate reference on line 91.) |
| §"NTM pane priority" (lines 112-118) | "prefer `--cod=` … over `--pi=` / `--type=pi`". | Matches HEAD policy after c0cf590 ("prioritize cod over pi"). **Not drift** — leave as is. | None. (Listed here so synthesizer doesn't double-fix.) |
| §"Available CLI Tools" (line 64) | "`ccc` — optional codebase indexing/search tool. Not required". | Verify `ccc` is still referenced in skills / setup. If no longer probed by `flywheel_doctor`, the line is dead. | Spot-check; remove if dead, keep if doctor still probes. |
| §"Code Conventions" (line 239) | "deep in `deep-plan.ts` synthesis". | Verify `mcp-server/src/deep-plan*.ts` exists at HEAD. | Spot-check; soften to "deep nested helpers" if file moved/renamed. |
| §"MCP tools added in v3.11.0" — `flywheel_observe` `hints[]` | "Hint surface includes missing or invalid completion attestations from the Stage 1 ledger". | Verify `flywheel_observe` actually emits these hints at HEAD (post v3.11.0 work may have moved or removed them). | Spot-check `mcp-server/src/tools/observe.ts`; if hint surface changed, update. |
| §"Tool name deprecation" (line 270) | "`orch_*` names are preserved as deprecated aliases … will be removed in v4.0." | True, plus v3.11.7 added a one-shot `orch_deprecation_warned` runtime warning (`e5ded9b`). AGENTS.md does not mention the warning. | Append one sentence: "v3.11.7+ logs a one-shot `orch_deprecation_warned` per alias call with the canonical replacement." |

**Skill path claims** are spot-checked in T5 (see Section 4) — `skills/flywheel-swarm/SKILL.md`, `skills/start/_implement.md`, `skills/start/_planning.md`, `skills/start/_deslop.md`, `commands/flywheel-swarm.md` are all referenced and must each exist on disk.

---

## Section 2 — CHANGELOG gap analysis

`git log v3.11.0..HEAD` yields 31 commits including 5 release commits and 1 feat commit untagged. CHANGELOG has entries through v3.11.9. The gaps:

| Commit / tag | Date | In CHANGELOG? | One-line entry to add |
|---|---|---|---|
| `05071af` v3.12.0 release | 2026-05-06 | **MISSING** | `## [3.12.0] - 2026-05-06` — Added: `flywheel_convergence` MCP tool reading `.pi-flywheel/plans/<slug>/convergence.json`; APR-Pro multi-signal convergence scoring; B6 oscillation guard (`signFlips > revisions/3` ⇒ `status: "oscillating"`); `convergence_state_validity` doctor check. |
| `c0cf590` feat(swarm): prioritize cod over pi for NTM pane spawning | 2026-05-04? | **MISSING** | Roll into v3.12.0 entry under `Changed`: "NTM pane priority — `--cod` is now the default secondary lane after `--cc`; `--pi` demoted to fallback." (Sister policy already documented in `AGENTS.md` §"NTM pane priority".) |
| `v3.11.5` release | 2026-05-02 | Yes (CHANGELOG line 72) | — |
| `v3.11.6` release | 2026-05-03 | Yes | — |
| `v3.11.7` release | 2026-05-03 | Yes | — |
| `v3.11.8` release (b0f4e6d) | 2026-05-03 | Yes | — |
| `v3.11.9` release (d47f22b) | 2026-05-03 | Yes | — |
| Git tag inventory mismatch | — | **Tag drift** (read-only finding) | `git tag -l 'v3.11.*'` returns only v3.11.0–v3.11.4. v3.11.5–v3.11.9 have CHANGELOG entries and release commits but no annotated git tag. Out of scope to create tags here (release process concern, not docs-correctness). Surface as a flag-only finding. |
| Phantom-entry sweep | — | None found | All CHANGELOG entries v3.11.0–v3.11.9 have a matching release commit on `main`. No phantom entries. |

The two real CHANGELOG **content** gaps are v3.12.0 + the c0cf590 NTM-pane-priority change. Everything else is either present or tag-creation (out of scope).

---

## Section 3 — docs/solutions/ refresh

**Important factual finding:** `docs/solutions/` does not exist in this repo. The brainstorm asked to bundle `/flywheel-compound-refresh` over docs/solutions/. The actual learning-bearing folders at HEAD are:

- `docs/research/` — 6 files including `research-apr-pro-*` (3 files), `research-automated_plan_reviser_pro-2026-05-05.md`, `research-compound-engineering-plugin-2026-04-23.md`.
- `docs/audits/` — audit transcripts.
- `docs/duels/` — wizard duel transcripts.
- `docs/upstream-asks/` — upstream-bug deltas.
- Loose root: `docs/agent-flywheel-complete-guide.md`, `docs/gap-analysis-flywheel-guide.md`, `docs/skill-refine-flywheel-proposed.md`, `docs/skill-refine-start-proposed.md`, `docs/tender-config.md`.

Apply `/flywheel-compound-refresh` Keep/Update/Consolidate/Replace/Delete classification:

| Path | Status | Reason |
|---|---|---|
| `docs/research/research-apr-pro-feedback-opus.md` | **Consolidate** | APR-Pro is now landed in v3.12.0 (`flywheel_convergence`). The 3 APR-Pro research files (opus / sonnet / integration) duplicate what is now in code; merge into a single `docs/research/research-apr-pro-landed-2026-05-06.md` outcome doc and archive the three sources. |
| `docs/research/research-apr-pro-feedback-sonnet.md` | **Consolidate** | Same as above. |
| `docs/research/research-apr-pro-integration.md` | **Consolidate** | Same as above. |
| `docs/research/research-automated_plan_reviser_pro-2026-05-05.md` | **Update** | Add a 1-line "✅ Landed in v3.12.0" header pointing to `mcp-server/src/convergence.ts`. |
| `docs/research/research-compound-engineering-plugin-2026-04-23.md` | **Keep** | Pre-dates v3.11.0 cycle; still informational baseline. |
| `docs/skill-refine-flywheel-proposed.md` | **Update or Delete** | If proposals shipped (compare against `skills/start/SKILL.md` HEAD), delete; else mark "still pending". |
| `docs/skill-refine-start-proposed.md` | **Update or Delete** | Same. |
| `docs/gap-analysis-flywheel-guide.md` | **Update** | Verify against current AGENTS.md/README.md before keeping; gap items may have been closed by v3.11.x feedback waves. |
| `docs/agent-flywheel-complete-guide.md` | **Verify** | If this duplicates AGENTS.md / README.md it is `Replace`-by-pointer; else `Keep`. |
| `docs/tender-config.md` | **Keep** | Operator runbook, not a learning. |
| `docs/upstream-asks/*` | **Keep** | Living upstream coordination ledger. |
| `docs/audits/*` | **Keep** | Historical audit record. |
| `docs/duels/*` | **Keep** | Adversarial-debate record (per `AGENTS.md` line 28: "never auto-delete"). |
| `docs/brainstorms/*`, `docs/plans/*`, `docs/reviews/*` | **Keep** | Phase artifacts; lifecycle owned by flywheel itself. |

Refresh effort: classify-only on this pass. Actual consolidation (the APR-Pro merge) is one bead's worth and gated behind T7 below.

---

## Section 4 — Task table (cap: 8)

Atomic, independent-shipping. Each task is one bead. Dependencies explicit.

| ID | Title | Touches | depends_on | Effort |
|---|---|---|---|---|
| **T1** | Add `## MCP tools added in v3.12.0` section to AGENTS.md documenting `flywheel_convergence` + `convergence_state_validity` doctor check + B6 oscillation guard semantics. | `AGENTS.md` | `[]` | S |
| **T2** | Add `## [3.12.0] - 2026-05-06` entry to CHANGELOG.md covering APR-Pro convergence, B6 guard, `flywheel_convergence` tool, and (under Changed) the c0cf590 NTM cod>pi default. | `CHANGELOG.md` | `[]` | S |
| **T3** | Replace fragile line-number reference `agent-mail.ts:228` with stable function reference `reserveFileReservations()` in both AGENTS.md mentions (lines 91 + 171). | `AGENTS.md` | `[]` | XS |
| **T4** | Append one sentence to AGENTS.md §"Tool name deprecation" describing the v3.11.7 `orch_deprecation_warned` runtime warning. | `AGENTS.md` | `[]` | XS |
| **T5** | Verify every file/path AGENTS.md claims exists at HEAD (skills/, mcp-server/src/, commands/). Produce a delta list; fix any path that drifted. Stop at 10 spot-checks max. | `AGENTS.md` | `[]` | S |
| **T6** | Verify `flywheel_remediate` handler list (count + names) in AGENTS.md §"MCP tools added in v3.7.0" against `mcp-server/src/tools/remediations/`; update if drifted. | `AGENTS.md` | `[]` | XS |
| **T7** | docs/research/ APR-Pro consolidation: merge `research-apr-pro-{opus,sonnet,integration}.md` into one `research-apr-pro-landed-2026-05-06.md` outcome doc; add 1-line "landed" header to `research-automated_plan_reviser_pro-2026-05-05.md`. | `docs/research/*` | `[]` | M |
| **T8** | Classify-only refresh pass over remaining `docs/*.md` per Section 3 table; record decisions in `docs/audits/2026-05-06-docs-refresh-classifications.md` (do NOT delete or rewrite anything in this task — that is follow-up). | `docs/audits/2026-05-06-docs-refresh-classifications.md` (new) | `[]` | S |

All eight tasks are independent — none reference each other's outputs. Synthesizer can ship in any order or in parallel.

---

## Section 5 — Verification block

One shell assertion per task. Each is a green/red gate; none are "and looks good".

| ID | Verification command | Expected |
|---|---|---|
| T1 | `grep -q "MCP tools added in v3.12.0" AGENTS.md && grep -q "flywheel_convergence" AGENTS.md && grep -q "B6\|oscillation" AGENTS.md` | exit 0 |
| T2 | `grep -q "^## \[3.12.0\] - 2026-05-06" CHANGELOG.md && grep -A30 "^## \[3.12.0\]" CHANGELOG.md \| grep -q "flywheel_convergence"` | exit 0 |
| T3 | `! grep -q "agent-mail.ts:228" AGENTS.md && grep -q "reserveFileReservations" AGENTS.md` | exit 0 |
| T4 | `grep -q "orch_deprecation_warned" AGENTS.md` | exit 0 |
| T5 | `for p in $(grep -oE 'mcp-server/src/[a-zA-Z/_.-]+\.ts\|skills/[a-zA-Z/_.-]+\.md\|commands/[a-zA-Z_.-]+\.md' AGENTS.md \| sort -u); do test -e "$p" \|\| echo MISSING: $p; done; ! grep -q MISSING` | no MISSING line |
| T6 | `actual=$(ls mcp-server/src/tools/remediations/ \| grep -v index \| wc -l); claimed=$(grep -oE "[Ff]ive handlers" AGENTS.md \| head -1); echo "actual=$actual claimed=$claimed"` then update AGENTS to match `actual` | manually compared, AGENTS reflects `actual` |
| T7 | `test -f docs/research/research-apr-pro-landed-2026-05-06.md && grep -q "v3.12.0" docs/research/research-apr-pro-landed-2026-05-06.md` | exit 0 |
| T8 | `test -f docs/audits/2026-05-06-docs-refresh-classifications.md && grep -cE "^\| (Keep\|Update\|Consolidate\|Replace\|Delete\|Verify) " docs/audits/2026-05-06-docs-refresh-classifications.md` ≥ 8 | classification table present |

Global gate after all tasks: `cd mcp-server && npm run lint:skill -- --baseline` exits 0 (no new lint findings introduced by AGENTS.md edits).

---

## Section 6 — Explicit non-goals

The brainstorm and the user's "smallest version" answer reserved these for later cycles. Keep them out of beads.

1. **README polish.** No edits to `README.md` even if drift is suspected.
2. **Automated AGENTS.md regeneration.** No source-of-truth manifest, no codegen, no script that emits the skill list / MCP tool list. Reserved as future-direction.
3. **CI-driven CHANGELOG generation.** No conventional-commits parser, no GH Action.
4. **Agent-contract reorganization.** No splitting AGENTS.md, no extracting "hard constraints" into a separate doc.
5. **Per-claim runnable verification examples.** AGENTS.md will not grow `$ verify with: …` blocks per claim.
6. **Tag creation for v3.11.5–v3.11.9.** Even though these have CHANGELOG entries but no `v3.11.*` git tags, retroactive tagging is a release-process concern not a docs-correctness concern. Flag-only.
7. **`flywheel-compound-refresh` automation pass.** The skill exists but applying it across all of `docs/` is a separate cycle. T7 + T8 are the manual carve-out for *this* cycle.

---

## Hard-to-verify claims (surfaced for synthesizer)

These I could not fully verify in the budget; flag for ergonomics/robustness perspectives to either confirm or escalate to T5:

- **`flywheel_observe.hints[]` actually surfaces missing/invalid attestations** (AGENTS.md line 156). Code path needs a quick read of `mcp-server/src/tools/observe.ts` to confirm the hint emitter still fires after v3.11.x changes.
- **`reserveOrFail` is called from every coordinator-side reservation site** (AGENTS.md line 171). RESERVE001 lint rule presumably enforces it; verify the lint rule is wired into `npm run lint:skill` or a sister job, and not silently disabled.
- **`flywheel_get_skill` recovery path** (AGENTS.md lines 77-83) — the v3.11.7 fix (claude-orchestrator-c9l) re-routed bundle/disk lookups through `findPluginInstallRoot()`. Verify the documented bypass `FW_SKILL_BUNDLE=off` still works post-fix.
- **CompletionReportSchemaV1 "additive forever"** (AGENTS.md line 152). No way to verify forward-compat in a snapshot; trust statement until contradicted.

These are not in the 8-task budget; they go in the synthesis review pile.
