# APR-Pro adoption — landed in v3.12.0

**Date:** 2026-05-06
**HEAD:** `05071af`
**Status:** Shipped — A1-only scope-down per Phase 12 verdict.

**Source files synthesized into this document:**

- `docs/research-automated_plan_reviser_pro-2026-05-05.md` — original cross-phase research proposal (TL;DR + A1–A5 + traps).
- `docs/research-apr-pro-integration.md` — A1+A2+A3 integration cluster draft (Phase 8 → Phase 12 final synthesis).
- `docs/research-apr-pro-feedback-opus.md` — Phase 11b reviewer (opus) — scope-down verdict.
- `docs/research-apr-pro-feedback-sonnet.md` — Phase 11a reviewer (sonnet-4-6) — ship-with-changes verdict.

**Implementation references:**

- `mcp-server/src/convergence.ts` — `ConvergenceState`, `RevisionMetrics`, `SCORE_VERSION` constant, B6 oscillation detector.
- `mcp-server/src/tools/convergence-tool.ts` — `flywheel_convergence({ cwd, planSlug })` MCP tool (read-only).
- `mcp-server/src/server.ts` — tool registration.
- `CHANGELOG.md` `[3.12.0] - 2026-05-06` — Added/Changed entries describe the landed surface.

---

## Multi-signal convergence — what shipped

The landed feature is the A1 capability ("convergence as a multi-signal score") with the B6 oscillation guard layered on. Per-revision metrics are computed as `RevisionMetrics`:

```typescript
size: { lines, words, chars };
structural: { headings, code_blocks, links, list_items };
diff_vs_prior: { added_lines, removed_lines, similarity_score } | null;
```

Aggregated across a ring buffer of the last N=5 revisions into `ConvergenceState`:

- `signals.output_size_trend` (-1.0 to 1.0; >0 means growing)
- `signals.change_velocity` (0.0–1.0; magnitude of recent deltas)
- `signals.similarity_trend` (0.0–1.0; how similar recent revisions are)
- `oscillation.signFlips` + `oscillation.detected`
- `score` (0.0–1.0 weighted composite)
- `status: "diverging" | "approaching" | "nearly_converged" | "converged" | "oscillating"`

Status thresholds (50/75/90 ladder, inherited from APR-Pro):

- `score < 0.50` → `diverging`
- `0.50 ≤ score < 0.75` → `approaching`
- `0.75 ≤ score < 0.90` → `nearly_converged`
- `score ≥ 0.90` → `converged`
- `oscillation.detected = true` → overrides to `oscillating`

Persistence: `.pi-flywheel/plans/<slug>/convergence.json`. Per Phase 12 §12.3 the directory was kept as `.pi-flywheel/` rather than renamed to `.flywheel/` (opus §4.1 ruled the rename a gratuitous breaking change). Writes use the existing `writeFile`/`mkdir` pattern from `completion-report.ts` (no new atomic-write infrastructure per opus §4.2).

Each persisted score carries a `score_version: 1` constant so any future scoring algorithm change becomes an explicit, behavioral migration.

## B6 oscillation guard — semantics

APR-Pro's original convergence detector averages first-half vs second-half deltas, which is blind to ping-pong sequences. A spec that grows in round 4, shrinks in round 5, grows in round 6 looks "stable" to APR-Pro because the average diff_ratio is small (Phase 4 blunder B6).

The flywheel implementation replaces that with a ring buffer + sign-flip count:

> When `signFlips > revisions / 3` → `status: "oscillating"`, `estimatedRoundsRemaining: null`.

Refusing to estimate `rounds_remaining` when oscillating is the right discipline — fail-loud rather than gaslight (opus §3 explicitly endorsed this). The acceptance test feeds `1000 → 1200 → 800 → 1100 → 900` to the detector and asserts `status === "oscillating"`.

The guard is surfaced via:

- `flywheel_convergence({ cwd, planSlug })` — returns the persisted `ConvergenceState`. Result envelope includes `oscillation.detected: boolean`, `signFlips`, `revisions`.
- `flywheel_doctor` — new `convergence_state_validity` check (the 12th entry in the standard sweep). Severity yellow on parse failure, red only on schema-required-field violations.
- `flywheel_advance_wave` — kill-switch consults convergence + oscillation flags. Auto-approve at score ≥ 0.90 still routes through `AskUserQuestion` (per README Design Philosophy #3).
- `skills/start/_picked_up_plan.md` (Step 5.45) — renders the score in the question text only and never arms a default option (per Phase 12 §12.5).

Operator kill-switch: `flywheel.config.yaml` field `convergence.gate_advance_wave: bool` (default `true`).

---

## Source-file synthesis

### From `research-automated_plan_reviser_pro-2026-05-05.md` (cross-phase research proposal)

The original proposal listed **A1–A5** as the cross-phase synthesis, with A1 ("convergence as multi-signal score") explicitly anchored on Phase 2 T2 + Phase 6a P1 and B6 layered as a fix on top of APR-Pro's average-of-halves. The ring-buffer + sign-flip count approach is *flywheel's contribution* — APR-Pro itself does not have it. Surfaces named in the proposal: new `convergence.json`, `flywheel_plan` returns a `convergence` block, `skills/start/_picked_up_plan.md` reads it, `polishConverged` upgraded.

The proposal flagged four traps to avoid. Trap T1 ("Oscillation blindness — APR's convergence detector averages first-half vs second-half deltas") drove the B6 guard that shipped. Traps T2–T4 (lock-file ownership, auto-checksum CI race, hardcoded round counts) are *not* in v3.12.0 scope — they were always tagged as "watch out, don't replicate APR's bash hygiene mistakes" rather than positive features to adopt.

### From `research-apr-pro-integration.md` (A1+A2+A3 integration cluster)

This was the most ambitious draft — the full cluster proposed shipping A1 (convergence) + A2 (plan-vs-code git-diff bundling at `.flywheel/plans/<slug>/refine-bundle-<revision-id>.md`) + A3 (atomic disk state contract with rename-temp-then-fsync) together. Phase 12 §12.2 ("Minimum Viable Cluster") scoped it down to A1-only after reviewer convergence with Phase 10's blunder hunt.

Key decisions resolved 2026-05-05 that *did* land (per §12.4):
- Score gates `flywheel_advance_wave` (operator-overrode the reviewer-recommended human-only).
- Auto-approve at score ≥ 0.90 still routes through `AskUserQuestion`.
- `score_version: 1` tag on every persisted score for migration safety.
- `convergenceGated: boolean` field on `FlywheelObserveReport` so consumers detect the new gating mode.
- Kill-switch `convergence.gate_advance_wave` defaulting to `true`.

The cluster also surfaced semantic critiques that shaped the final acceptance test surface (§12.6, Phase 10 Pass 3): the score conflates "stable" with "good" (mitigation: Step 5.45 default-arming must also gate on a "validate-against-code" signal — the landed surface honors this by *never* arming a default in Step 5.45, only annotating the question text). Threshold-boundary discontinuity (0.749 vs 0.751) was acknowledged but not mitigated in v3.12.0 (hysteresis deferred).

### From `research-apr-pro-feedback-opus.md` (Phase 11b — opus reviewer)

Verdict: **scope-down**. The cluster bundled "one solid idea (oscillation-aware convergence) with one premature commitment (`.pi-flywheel` → `.flywheel` rename) and one redundant rebuild (atomic-state discipline that flywheel already largely has)." Ship A1 alone first; defer the rename and the `flywheel_observe` rewrite until A1 actually demonstrates the schema needs. This is the verdict that ultimately drove what shipped.

Specific objections that the implementation honored:
- §4.1: `.pi-flywheel` → `.flywheel` rename is gratuitous; **kept `.pi-flywheel/`**.
- §4.2: The proposed atomic-write helper duplicates existing `writeFile`/`mkdir` infrastructure; **reused completion-report.ts pattern**.
- §4.3: Bundle-as-canonical-refine-input is over-specified for v1; **A2 deferred entirely**.
- §4.4: `code_every_n` defaults are made up out of thin air; **A2/code_every_n deferred**.
- §3 (where right): "The B6 oscillation fix is genuinely novel and worth shipping. The schema in §C1 is well thought out — explicit `null` for `estimated_rounds_remaining` when oscillating is the right discipline." This positive review carried the A1 scope into v3.12.0.

### From `research-apr-pro-feedback-sonnet.md` (Phase 11a — sonnet-4-6 reviewer)

Verdict: **ship-with-changes**. The cluster was architecturally sound but underspecified the migration safety story and bundled premature filesystem reorganization (the `checkpoint.json` move) with otherwise well-scoped work. Sonnet's open question — *"should convergence scoring gate `flywheel_advance_wave` or only inform Step 5.45's refine menu?"* — was the explicit decision §12.4 resolved in favor of wave-level gating with a kill-switch.

Sonnet's "what to cut" list closely matched what Phase 12 ultimately cut: the `.pi-flywheel` → `.flywheel` rename, the `checkpoint.json` move, and the atomic-write helper rebuild. Where sonnet diverged from opus: sonnet was willing to keep more of A2/A3 if migration safety were specified, while opus argued for stripping them entirely. **The implementation followed opus's stricter line.**

---

## What was NOT adopted

Per Phase 12 §12.3 the following were explicitly cut from the original draft:

- **A2 — plan-vs-code git-diff bundling.** No `refine-bundle-<revision-id>.md` files. No bundle-as-canonical-refine-input. No `code_every_n` re-anchoring in `flywheel_advance_wave`. (Reason: opus §4.3 — over-specified for v1; opus §4.4 — defaults made up; sonnet — bundles premature reorganization with otherwise good work.)
- **A3 — atomic disk state contract / FDS-v1 substrate.** No new atomic-write helper. No rename of `.pi-flywheel/` → `.flywheel/`. No `checkpoint.json` relocation. (Reason: opus §4.1 — gratuitous breaking change; opus §4.2 — duplicates existing `writeFile`/`mkdir` infrastructure.)
- **`flywheel_observe` rewrite as pure disk reader.** Deferred until A1 demonstrates schema needs. (Reason: opus §1 — "redundant rebuild that flywheel already largely has".)
- **Cross-plan convergence trends / codebase-level signals.** Phase 8→9 Q4 "aggregate convergence across all plans" was tagged scope creep dressed as deepening (opus §4.7); the appendix's Phase 9 deepening preserved the framing but explicitly deferred it.
- **Hysteresis on threshold boundaries.** The 0.749 vs 0.751 menu-default-flap critique (Phase 10 Pass 3 §3.4) was acknowledged but not mitigated in v3.12.0 — Step 5.45 sidesteps it by never arming a default at all.
- **`estimated_rounds_remaining` from empirical history.** Phase 10 Pass 3 §3.3 noted that `(1-score)*5` is the same gaslight APR shipped on a non-oscillating trajectory. The flywheel implementation returns the linear estimate when not oscillating and `null` when oscillating; the empirical-distribution alternative (requires N≥10 plans observed) is deferred.
- **Auto-recovery on oscillation.** Phase 9 Q3 proposed routing oscillation detection to `/flywheel-duel --mode=plan-rescue` for human-initiated regeneration; v3.12.0 only surfaces the oscillating status — duel routing is deferred.
- **TUI / dashboard surfaces.** Per Phase 6b §4.3 ("convergence dashboard") not in v3.12.0 scope.
- **Prompt-quality preflight gate (`{{...}}` placeholder check, A4 / Phase 6a P2).** Independent of A1; deferred to a separate bead.
- **Structured JSON envelope + semantic exit codes (A5 / Phase 6a P5).** Independent of A1; deferred.

The Phase 9 "FDS-v1 substrate" appendix is preserved in `research-apr-pro-integration.md` as the project's eventual destination for the disk-state layer — but explicitly not the v3.12 ship.
