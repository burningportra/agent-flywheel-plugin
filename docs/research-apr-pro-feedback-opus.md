> Consolidated into [docs/research/research-apr-pro-landed-2026-05-06.md] on 2026-05-06.

# Phase 11b Feedback (opus) — APR-Pro Integration Cluster (A1+A2+A3)

**Date.** 2026-05-05
**Reviewer.** opus (Phase 11b)
**Subject.** [`docs/research-apr-pro-integration.md`](./research-apr-pro-integration.md) — A1 (convergence) + A2 (plan-vs-code bundling) + A3 (atomic disk state) cluster
**Sibling.** sonnet feedback (Phase 11a)
**Pipeline inputs read.** integration proposal · Phase 7 synthesis · Phase 6a apply.md · Phase 6b ergonomics.md · `AGENTS.md` · `README.md`

---

## 1. Verdict

**Scope-down.** The cluster bundles one solid idea (oscillation-aware convergence) with one premature commitment (`.pi-flywheel` → `.flywheel` rename) and one redundant rebuild (atomic-state discipline that flywheel already largely has). Ship A1 alone first; defer the rename and the `flywheel_observe` rewrite until A1 actually demonstrates the schema needs.

---

## 2. First-principles re-derivation

If I sit down with Phase 1–7 outputs and pretend the integration doc doesn't exist, the question is: **what's the thinnest cut from APR-Pro that's load-bearing for flywheel right now?**

APR's *one* genuinely-portable contribution is the **oscillation guard on convergence math** (B6 fix + ring-buffer + sign-flip count). Everything else APR does — atomic mv-rename, pull-don't-push readers, JSON-on-disk state, slug-keyed sessions, structured envelopes — flywheel already has under different names. `.pi-flywheel/checkpoint.json` is atomic-rename today (per AGENTS.md hard constraint #6, written only via `flywheel_*` MCP tools). `flywheel_observe` is already documented as "idempotent and non-mutating; doctor probes are cached or short-budgeted (<1.5s total tool runtime)" with a versioned `FlywheelObserveReport` schema. The 36-code `FlywheelErrorCode` enum is the structured envelope. Completion Evidence v1 (Zod) is the schema-versioned per-entity disk state. The disk discipline isn't aspirational; it shipped in v3.11.0.

So the cluster I'd design from scratch is: **A1 only, riding on existing `.pi-flywheel/` infrastructure and the existing `FlywheelObserveReport` envelope.** Compute `.pi-flywheel/plans/<slug>/convergence.json` per revision with the ring-buffer + sign-flip detector, surface it as a new `convergence` block on `flywheel_observe`'s already-versioned report, and arm Step 5.45's existing menu with a default. ~600 LOC, one wave, two beads. The proposal's 1830 LOC / 4 waves / 14 beads is mostly the rebuild cost of work that's already done — A3's "C3 atomic disk state" is the largest line item (~650 LOC) and almost entirely re-derives existing invariants under new names.

The proposal's mistake is treating APR's full disk-state architecture as the goal, rather than treating the *one delta* (oscillation-aware multi-signal convergence) as the goal and reusing flywheel's existing primitives to deliver it.

---

## 3. Where the proposal is right

**The B6 oscillation fix is genuinely novel and worth shipping.** APR's average-of-halves detector is blind to `1000 → 1200 → 800 → 1100 → 900` and the ring-buffer + sign-flip guard is a real, testable improvement that flywheel doesn't currently have anywhere. The schema in §C1 (`RevisionMetrics`, `ConvergenceState`, `oscillation.sign_flips`, `score`-or-`oscillating`) is well thought out — explicit `null` for `estimated_rounds_remaining` when oscillating is the right discipline (fail-loud rather than gaslight). The trap-avoidance checklist's first item (property test on `1000 → 1200 → 800 → 1100 → 900`) is exactly the right test. Also right: refusing `code_every_n` as a stopping rule and keeping it strictly as a sampling/re-anchor cadence (§C2 + trap §Anti-pattern #3 fix). The "score is a hint, not a decision; menu always overridable" framing in §Risks #2 matches AGENTS.md's "every user decision flows through AskUserQuestion (no implicit choices)" principle. Phase 9 hand-off question #2 ("could the bundle be human-editable?") is the right question to leave open.

---

## 4. Where the proposal is wrong

### 4.1 The `.pi-flywheel/` → `.flywheel/` rename is a gratuitous breaking change

§C3's "Layout. All flywheel disk state moves under `.flywheel/`" silently buries a migration that touches every existing user. AGENTS.md hard constraint #6 names `.pi-flywheel/checkpoint.json` directly. README.md names `.pi-flywheel/completion/<beadId>.json` as the canonical attestation path. v3.11.0's release notes are built around `.pi-flywheel/`. Renaming the root creates two-generation back-compat code, breaks every external script that grep's the directory name, invalidates user-side .gitignore entries, and gains nothing functional — atomic-rename works identically at either path. The proposal's §Risks #1 acknowledges "two checkpoint generations exist in the wild (v3.11.1 wrote stale checkpoint detected this session)" and proposes a `flywheel-migrate-state` one-shot, but this risk *only exists because of the rename*. Drop the rename and the risk evaporates. Add subdirectories under `.pi-flywheel/` (`.pi-flywheel/plans/<slug>/convergence.json`) with no parent-directory rename.

### 4.2 §C3's atomic-write helper duplicates existing infrastructure

The `atomicWrite` and `AtomicJsonReader<T>` snippets in §C3 read like greenfield code, but flywheel already has `mcp-server/src/completion-report.ts` writing schema-versioned Zod-validated JSON, and AGENTS.md hard constraint #6 codifies that all state writes go through `flywheel_*` MCP tools. The proposal doesn't cite either. Either §C3 needs to specifically extend / replace `completion-report.ts`'s write helpers (in which case it's a 50-LOC PR, not 150+200+300 LOC), or it's proposing a parallel disk-state lane that will diverge from the existing one. The mapping table in §"Mapping to existing flywheel architecture" lists "`state.ts` Map-based in-memory state" as the surface to migrate — but `state.ts` isn't in `mcp-server/src/` per AGENTS.md's documented layout. Either the surface name is wrong or the proposal hasn't actually read the current code; either way it's not safe to bead this without a code audit.

### 4.3 §C2 "bundle file is the canonical refine input" is over-specified for v1

The claim "The LLM never receives a freshly-constructed prompt — it receives the bundle path or content. This makes refine prompts deterministic, cacheable, and replayable" is a major architectural commitment dressed as a tactical optimization. It implicitly forbids in-place prompt augmentation (new instructions injected at refine time), forces every future change to refine prompts to go through the bundle generator, and makes the bundle generator the load-bearing single point of truth for refine semantics. APR doesn't actually win from this — APR's bundles are deterministic because *APR is single-user*. Flywheel runs swarms; multiple agents will refine concurrently against different code states. "Cacheable" is mostly false because `git log -p` results change every commit. Recommend: ship the bundle as a file artifact (audit trail, replay, debugging) but keep the prompt-construction path mutable. The bundle is a cache-able input; it is not the prompt.

### 4.4 `code_every_n` defaults are made up out of thin air

§C2 asserts `code_every_n` default of 5 and APR's "(default 4)" without any signal that 5 is right for flywheel's wave shape. APR's `impl_every_n=4` was tuned for a single-user spec-revision loop with 8–12 round arcs. Flywheel waves are 3–5 beads each; "every 5 beads" might cross wave boundaries, which means the re-anchor cadence is *defined by wave shape*, not bead count. Trap §Anti-pattern #3 explicitly says round-counts mustn't be hardcoded — but `code_every_n=5` is exactly that, just renamed. Either make it adaptive (re-anchor at wave boundaries, or when convergence score drops) or punt to a TODO with measurement.

### 4.5 The "schema_version: '1.0.0'" plan ignores existing precedent

§C1's `RevisionMetrics` and `ConvergenceState` both pin `schema_version: "1.0.0"` but flywheel's `FlywheelObserveReport` and `CompletionReportSchemaV1` use `version: 1` (integer, additive-forever). Two different versioning conventions in one codebase is a smell. Match existing precedent or document why this one diverges.

### 4.6 §Acceptance signals #3 "<500ms for a 50-file plan" has no baseline

Where does the 500ms come from? `git log -p --since=<plan-mtime> -- <path>` for 50 paths can easily blow past that on a large repo with deep history. If the budget is a real gate, it needs a measurement plan; if it's aspirational, mark it so. As written, it's the kind of acceptance signal that gets dropped silently when the first PR comes in 700ms.

### 4.7 §Phase 8→9 #4 ("aggregate convergence across all plans") is scope creep dressed as deepening

Cross-plan convergence trends pre-supposes a "plans" registry that doesn't exist (`docs/plans/` is just a directory). This isn't a Phase 9 deepening question; it's a Phase 12 / future-version question. Surface only the in-plan signals for now; resist the temptation to design the cross-plan story before single-plan ships.

---

## 5. Hidden architectural commitments

These are loaded contracts the proposal accepts without flagging:

1. **Plan slug becomes a primary key.** The `.flywheel/plans/<slug>/` (or `.pi-flywheel/plans/<slug>/`) layout makes the *plan slug* a stable cross-tool identifier — `convergence.json`, `refine-bundle-<rev-id>.md`, `revisions/<rev-id>.md` all key off it. Today flywheel keys off bead IDs (ULIDs in `br`) and a single `checkpoint.json`. Adding plan-slug as a key is a new invariant the rest of the system must honor: deslop, swarm, reality-check, audit, drift-check all need to know how to find the plan dir, and renaming a plan becomes a multi-file migration. The proposal doesn't say what generates the slug or who owns its lifecycle.

2. **Per-revision file proliferation.** With ring buffer N=5 and a refine bundle per revision, every plan accumulates 5+ files just for convergence + bundles. For a 4-wave run that's ~20 disk artifacts per plan, plus revisions/<rev>.md historical copies. `flywheel-cleanup` semantics (currently flags WIZARD_*.md older than 7 days, never auto-deletes per README) need an explicit retention policy. The proposal doesn't address it.

3. **`flywheel_observe` becomes coupled to plan layout.** Today `flywheel_observe` is documented (per AGENTS.md v3.11.0 notes) as a fixed-shape `FlywheelObserveReport` snapshot of {git, checkpoint, beads, agentMail, ntm, artifacts, hints}. Adding a `convergence` block per plan turns it into a multi-tenant report — what does `flywheel_observe` return when there are 3 plans in flight? Pick the active one? List all? The schema impact is non-trivial and the proposal hand-waves it ("`flywheel_plan` returns convergence block").

4. **Reversibility cost.** Once external scripts (CI hooks, dotfiles, the `flywheel-doctor` healthcheck, downstream tools like `dsr` / `caam`) hard-code paths under `.flywheel/plans/<slug>/`, ripping the layout back out is a major-version migration. The proposal commits to a layout that doesn't exist yet, with no fallback if A1 alone gets shipped and A2 / A3 are deferred.

5. **Concurrent-refine semantics handed to "last-write-wins" in §Risks #5.** This is fine for APR (single-user) and gaslight-bait for flywheel (swarm). The README explicitly markets "File-reservation conflict prevention ✅ pre-commit guard" as a differentiator vs Aider/Cline. Punting concurrent refine to last-write-wins is a regression on a load-bearing positioning claim. At minimum, document that refine writes go through Agent Mail's `file_reservation_paths` lock — the infrastructure already exists (RESERVE001 lint rule, `reserveOrFail` helper, AGENTS.md v3.11.0 notes).

6. **Convergence score becomes UI surface forever.** §Acceptance signal #1 "Step 5.45 menu shows convergence score in its question text" hard-couples the scoring algorithm to user-facing copy. Tuning the algorithm later means tuning what the user sees mid-session. Either pin the algorithm version in the rendered text ("score 0.82 [v1]") or commit to never changing it without a UX migration.

---

## 6. Strawman alternatives

**Smaller (80% of the value, 20% of the cost): A1-only, on-rails.**

- Path: `.pi-flywheel/plans/<slug>/convergence.json` (existing root, new subdir).
- Schema: Zod (not raw types), `version: 1`, modeled on `CompletionReportSchemaV1`.
- Compute: pure function in new file `mcp-server/src/convergence.ts`. Property tests from day one (`1000 → 1200 → 800 → 1100 → 900` golden fixture, plus monotonic-increase, monotonic-decrease, and flat fixtures).
- Surface: extend existing `FlywheelObserveReport` with optional `convergence?: ConvergenceState` block (active plan only). Expose via a new `flywheel_convergence({ planSlug })` MCP tool for explicit queries.
- Step 5.45 wiring: read it via `flywheel_get_skill`'s skill body, no menu-rendering change required if the skill is the one consuming the score.
- Effort: ~600 LOC, 2 beads, 1 wave. Ships in days, not a 4-wave epic.
- Risk: low. No rename, no atomic-write rebuild, no bundle generator, no `code_every_n`. The B6 fix lands; everything else is deferred until A1 demonstrates value.

**More ambitious (worth the extra cost only after A1 ships and proves itself): A1 + bundle audit trail (no architectural commitment).**

- Bundle generator writes `.pi-flywheel/plans/<slug>/refine-bundle-<rev-id>.md` *as an audit artifact*, not as the canonical prompt. Refine prompts are still constructed inline in the skill; the bundle is a side-effect for replay/debugging.
- This breaks the "deterministic, cacheable, replayable" framing in §C2 — but that framing was overstating the win, as argued in §4.3.
- Adds bundle-retention policy to `flywheel-cleanup` (mirror the WIZARD_*.md 7-day rule).
- Effort: +300 LOC on top of A1.

The proposal's full A1+A2+A3 cluster is the *most ambitious* version. There's no reason it should be the floor.

---

## 7. Trap-avoidance audit

| Item | Rating | Notes |
|---|---|---|
| **B6 fix (oscillation property test)** | ✅ adequate | Good fixture, explicit `null` on rounds_remaining. |
| **B3 fix (ownership stamp on release)** | ⚠️ partial | The proposal says "every `release` operation on disk state checks ownership stamp" but doesn't reference flywheel's existing `reserveOrFail` / RESERVE001 infrastructure or Agent Mail's `force_release_file_reservation`. As written, it sounds like a parallel ownership system. Should explicitly extend the existing one. |
| **B11 fix (no optional deps)** | ✅ adequate | "All convergence math is pure TS — no shelling out to `bc`" is correct and matches AGENTS.md's TS-strict posture. |
| **Anti-pattern #3 fix (no branching on revision_count)** | ⚠️ partial | Score-only branching in convergence is right, but `code_every_n=5` reintroduces hardcoded round-counts under a different name (see §4.4). The fix is incomplete. |
| **Anti-pattern #4 fix (no 2-hour TTL)** | ⚠️ partial | "Locks have explicit owner PID + token; release verifies" is correct in spirit but doesn't reference the existing renewal-based scheme (`renew_file_reservations`). Risk of inventing a third lock-ownership convention. |
| **B2 fix (no CI auto-bump)** | ✅ adequate | "Convergence score is computed in-process, not by a CI step" is the right rule. |
| **Recovery determinism (SIGKILL mid-revision)** | ❌ insufficient | One-line claim with no test plan. Recovery is the hardest part. Needs an explicit fixture: kill -9 the orchestrator after writing `revision_id` but before `convergence.json`; restart must detect the partial state and either complete or abandon it cleanly. APR's session-recovery semantics (Phase 1 explore.md, Phase 2 deepen.md) are non-trivial — the proposal handwaves the equivalent. |

Two ✅, three ⚠️, one ❌, one ✅ on B2. The pattern: traps that are *new* and well-isolated (B6, B11, B2) are handled cleanly; traps that touch existing infrastructure (B3, anti-pattern #3, anti-pattern #4, recovery) are under-specified because the proposal hasn't reckoned with what's already in the tree.

---

## 8. Open question for the team

**Is the convergence score for the human, for the orchestrator, or for both — and if both, is the human-facing presentation versioned independently from the algorithm?**

If it's for the human only (Step 5.45 menu hint, `flywheel_observe` display), the algorithm can iterate freely; just bump a `score_version` field and let the UI render "(v2)". If it's for the orchestrator (e.g., `flywheel_advance_wave` gating, auto-approve at 0.90 in §C1's "score thresholds"), then changing the algorithm changes runtime behavior across versions — every score-change becomes a behavioral migration, and the v3.11.0 attestation discipline (§"completion attestation") implies a parallel "convergence attestation" pattern would be needed for replay.

The proposal mixes both uses without distinguishing them: §Acceptance signal #1 is human-facing rendering; §C1's threshold ladder + Step 5.45 default-arming is orchestrator behavior. Pick a primary use, design for that, and document the constraints on the other use. My recommendation: **human-only for v1.** Convergence is decision support, not a gate. Match the README's "every user decision flows through AskUserQuestion" framing.

---

## Strongest critique (one-paragraph summary)

The proposal's load-bearing contribution is the B6 oscillation guard, which is real and worth shipping. Everything else in the cluster is either redundant with existing flywheel infrastructure (atomic disk-state, structured envelope, schema-versioned per-entity JSON all shipped in v3.11.0), gratuitously breaking (`.pi-flywheel` → `.flywheel` rename), or scope-creep dressed as architecture (bundle-as-canonical-prompt, cross-plan convergence aggregation). The proposal reads like APR was studied carefully and flywheel was studied less carefully — at least three claimed "new" surfaces (`state.ts` Map-based state, atomic-write contract, structured error envelope) duplicate things already in `mcp-server/src/`. **Recommendation: scope down to A1 only, on the existing `.pi-flywheel/` root, riding the existing `FlywheelObserveReport` and Zod-schema conventions; defer A2 (bundle-as-prompt) and A3 (rename + rebuild) until A1 ships and proves the schema gaps are real.** Two beads, one wave, days of work — and the load-bearing B6 fix lands without dragging a 4-wave epic behind it.
