> Consolidated into [docs/research/research-apr-pro-landed-2026-05-06.md] on 2026-05-06.

# APR-Pro Integration Feedback — Sonnet Reviewer

**Date.** 2026-05-05
**Reviewer model.** claude-sonnet-4-6
**Reviewing.** `docs/research-apr-pro-integration.md` (A1+A2+A3 cluster)

---

## 1. Verdict

**ship-with-changes** — the cluster is architecturally sound and addresses real gaps, but the proposal underspecifies the migration safety story and bundles a premature filesystem reorganization (`checkpoint.json` move) with otherwise well-scoped work.

---

## 2. Strongest argument FOR shipping the cluster

The three capabilities share a genuine foundational dependency: all three assume mv-atomic JSON on disk and pull-only readers. Implementing C3 first unlocks C1 and C2 without retrofitting. This is the correct dependency order and the proposal names it clearly. The "one schema decision, one migration cut" argument is correct — shipping them separately would force the disk-layout question twice and produce two partially-overlapping migrations.

The convergence mechanism (C1) solves a real user-facing problem that the current `polishConverged: boolean` cannot: users get no signal about oscillation, no trend, no "you've been going in circles for 4 revisions." The ring buffer approach from APR maps cleanly onto Step 5.45's existing menu structure (Validate / Approve / Refine / Scrap). The 50/75/90 score ladder gives operators something concrete to act on without prescribing what to do. This directly serves the flywheel's stated design goal of "the human is always in the loop."

The plan-vs-code bundle (C2) transforms refine prompts from ad-hoc inline strings into deterministic, replayable artifacts. That is strictly better: it enables `flywheel-drift-check` to compare against a known bundle rather than reconstructing context from scratch, and it makes the TUI's "what changed" display free (read bundle, don't re-run git). The `code_every_n` re-anchoring is a small addition that prevents plan drift in long sessions — a real failure mode in current swarm runs.

---

## 3. Strongest argument AGAINST shipping the cluster as drafted

The proposal couples two distinct concerns: the disk-state discipline (good, foundational) and a filesystem namespace migration from `.pi-flywheel/` to `.flywheel/` (scope creep). The namespace change is not required by C1, C2, or C3. It forces a migration script that must handle two checkpoint generations (noted in Risks §1) before users can use the new features at all. This raises the blast radius of the cluster from "adds new state files" to "moves existing state files users have in production." A failed or half-applied migration is a silent data-loss event.

The `flywheel_observe` rewrite (C3, Wave 2, ~300 LOC, risk: medium) is the highest-risk item in the cluster and the one most likely to introduce regression. The current `flywheel_observe` aggregates probes from 7 live sources — replacing it with a disk reader changes its semantics from "snapshot of what is happening right now" to "snapshot of what was last written to disk." For fast-changing swarm state this is a correctness tradeoff, not just an implementation detail. The proposal does not address what happens when a pane crashes between disk writes: the reader returns stale data with no signal that it is stale. APR runs on single-process workflows where this is not an issue; flywheel swarms are multi-process.

---

## 4. Specific concerns

**C1 — oscillation detection threshold is not specified.** The proposal mentions B6 (oscillation blindness trap) and says "add oscillation detector" but does not define what constitutes oscillation. How many alternating revisions trigger the flag? Is it configurable? Without a spec, two implementors will make different choices. (§ Capabilities adopted > C1)

**C3 — `fs.rename` atomicity on APFS is overstated.** The proposal says "atomic on POSIX" but macOS APFS `rename(2)` is atomic at the syscall level yet Spotlight and Time Machine hold open file descriptors that can cause brief read-failure windows. The proposed mitigation (`fsync` before rename) is the right call but is listed as a conditional ("if cross-platform tests show drift") rather than a default. Recommend making `fsync` unconditional for the temp file. (§ Risks §4)

**C2 — `code_every_n` default of 5 is not justified.** Why 5? APR's equivalent is workflow-specific. At 5 beads with 3-5 beads per wave, this fires once per wave which feels right, but the proposal does not say so explicitly. Without justification this will be changed arbitrarily during implementation. (§ C2)

**C3 — `.flywheel/` namespace migration is scope creep.** Moving `checkpoint.json` from `.pi-flywheel/` to `.flywheel/` is not required for C1, C2, or C3 correctness. It is a rename operation that raises migration complexity and blast radius. The three capabilities could ship against the existing `.pi-flywheel/` directory, with the rename as a follow-on bead. (§ C3 Layout, §Risks §1)

**C3 — concurrent-refine CAS is last-write-wins, which loses data.** The proposal documents concurrent revision generation as "last-write-wins" and suggests documenting that in `_picked_up_plan.md`. This is not a safe resolution for `convergence.json` — whichever process wins may overwrite a revision that contained new oscillation data. The correct fix is a flock on the plan directory or a monotonic sequence number check before rename. (§ Risks §5)

**C1 — `polishConverged` boolean shim is not load-bearing.** The shim `polishConverged = (status === "converged" || status === "nearly_converged")` is the right backwards-compat approach, but the proposal does not say when the shim is removed. Without a deprecation target this shim will persist indefinitely alongside the new score. Add a removal target (e.g., "shim removed in the same wave that `flywheel_plan` returns the convergence block").

**C2 — bundle file retention is unspecified.** The proposal says "N-revision retention with size cap" but does not define N or the cap. Given bundles can hit 50KB+ (cited in Risks §3), a slug with 20 revisions could accumulate 1MB+ of bundle files. Specify defaults: e.g., retain last 5 bundles, cap at 100KB each, emit warning above 80KB. (§ Risks §3)

**Acceptance signals are weak.** The acceptance criteria (§ Acceptance signals) are mostly structural ("convergence.json written after each revision") not behavioral ("oscillation detected within N rounds on a known oscillating plan", "bundle file smaller than X for a plan with Y paths"). Add at least one property-based test criterion.

---

## 5. What you'd change

**Section "C3 Layout" — remove the `.flywheel/` rename from this cluster.** Keep all new files in `.pi-flywheel/` for this cluster. Ship the rename as a standalone cosmetic bead after the cluster lands, with its own migration script and rollback path. This cuts Wave 1 migration risk from medium to low and eliminates the need for `flywheel-migrate-state` as a prerequisite.

**Section "Risks §5" — replace last-write-wins with flock.** Change "attempt rename; if mtime changed, retry" to "acquire an advisory flock on `.pi-flywheel/plans/<slug>/.lock` before reading mtime; release after rename." Node `fs.open` + `LOCK_EX` is cross-platform enough. Document that concurrent refines block, not race.

**Section "Risks §4" — make `fsync` unconditional.** Remove the conditional. `atomicWrite` should always `fsync` the temp file before `rename`. The performance cost is negligible for state files that are written at human-paced revision intervals.

**Section "Acceptance signals" — add behavioral criteria.** Add: (a) property test: given a plan with alternating revisions A→B→A→B, oscillation flag set by round 4; (b) integration test: bundle file for a 3-path plan stays under 100KB; (c) regression: `flywheel_observe` returns same fields as before C3 rewrite (schema parity test).

**Section "Effort estimate" — split C3 `flywheel_observe` rewrite into two beads.** Wave 2 currently has the rewrite as one item (~300 LOC, medium risk). Split into: (a) add `AtomicJsonReader` and write pane state to disk (low risk, ~150 LOC); (b) rewrite `flywheel_observe` to use disk readers (medium risk, ~150 LOC). The split means the reader infrastructure can be validated before the observe rewrite removes the probe aggregator.

**Section "Phase 8 → 9 hand-off Q5" — defer atomic-state-as-agent-mail-handshake.** This is speculative and depends on agent-mail's internals. Move it to a separate research question, not a Phase 9 proposal, to avoid scope inflation.

---

## 6. What you'd cut

**The `.flywheel/` directory rename.** Entirely. Not load-bearing for any of C1/C2/C3. The new files (convergence.json, refine-bundle-*.md, revisions/) can live in `.pi-flywheel/plans/<slug>/`. The rename is cosmetic and should not block the cluster.

**`flywheel-migrate-state` as a prerequisite command.** If the rename is cut, there is no migration of existing state files — new files are additive. The `flywheel-migrate-state` command becomes unnecessary for this cluster.

**Phase 8 → 9 Q5 (atomic-state as agent-mail handshake).** Speculative, crosses into agent-mail internals. Cut from this proposal entirely.

**Phase 8 → 9 Q4 (cross-plan convergence trends).** Interesting research question but adds an aggregation layer that is not needed for the core cluster. Cut; defer to a future research phase.

**The conditional `fsync` qualifier.** "If cross-platform tests show drift" introduces conditionality that will never be tested. Replace with an unconditional `fsync` or cut the qualifier.

---

## 7. What's missing

**Rollback story for a partially-applied cluster.** If Wave 2 fails mid-implementation (e.g., `flywheel_observe` rewrite is broken), what is the recovery path? The proposal mentions rollback for beads but not for schema changes. Specifically: if `convergence.json` schema changes between Wave 2 and Wave 3, does the cluster need a schema version field from day one? Yes — add `schema_version: 1` to `convergence.json` and `refine-bundle-*.md` frontmatter.

**Staleness signal for disk readers.** `AtomicJsonReader` caches by mtime, but what if a pane crashes and never writes an updated mtime? The reader returns stale data forever with no signal. Need a TTL on the mtime cache or an explicit "written-at" timestamp in each file that readers can compare against a max-staleness threshold.

**Token budget enforcement for C2 bundles.** The proposal says "emit a warning when bundle exceeds effective context" but does not specify what happens: truncate, split, or abort? For a 100K-token model the threshold is different than for a 32K-token model. The bundle generator needs to know the active model's context window, or the budget must be a conservative fixed cap.

**Test plan for `flywheel_observe` parity.** The rewrite changes internal implementation while promising the same external contract. Without a schema parity test (same field names, same types, same optionality) regressions will be invisible until a downstream tool breaks.

---

## 8. Open question for the user/team

The proposal treats convergence as a per-plan signal ("this specific plan has converged"), but the flywheel's primary feedback loop is per-bead, not per-plan. Should convergence scoring gate `flywheel_advance_wave` (wave-level gating) or only inform Step 5.45's refine menu (operator-visible hint, no automatic gating)? The proposal currently chooses the latter, but the Phase 8→9 Q3 ("convergence score as feedback to the planner") implies the former may be the intended end state. This decision determines whether convergence becomes a blocking state-machine signal or an advisory display — and those two architectures are hard to migrate between after the fact.
