# Research Proposal — APR-Pro → Agent-Flywheel

**Source repo.** [`Dicklesworthstone/automated_plan_reviser_pro`](https://github.com/Dicklesworthstone/automated_plan_reviser_pro) (v1.2.2)
**Date.** 2026-05-05
**Pipeline.** 7-phase research pipeline + Phases 8–12 (Major Feature Integration mode)
**Coordinator.** CoralBrook
**Status.** Phase 7 complete. Phase 8 next.

---

## TL;DR

APR-Pro is a 6,900-LOC Bash CLI for **iterative document refinement against an LLM oracle** — the closest in-the-wild analog to flywheel's *plan-revision* surface (Step 5.45 / `flywheel_plan` / picked-up-plan validate-against-code). Its **architectural ideas** are worth stealing; its **implementation choices** are mostly cautionary tales. Five adoptions and four explicit traps came out of the 6-phase analysis:

**Adopt:**
1. **Multi-signal convergence score** (size_trend × change_velocity × similarity_trend, 50/75/90 ladder) drives Step 5.45 menu defaults — but with a **ring-buffer + sign-flip oscillation guard** (the explicit B6 fix APR doesn't have).
2. **Plan-vs-code git-diff bundling** for the "refine" branch — feed the LLM unified-diff hunks since plan mtime, not just file paths.
3. **Atomic-write disk state + pull-don't-push readers** — `flywheel_observe` becomes a pure disk reader; swarm pane state is mv-atomic JSON.
4. **Pinned prompt templates in `flywheel.config.yaml`** with a `prompt_quality_check` pre-send (placeholder-scan gate, ~30 LOC).
5. **Structured `{ok, code, data, hint, meta}` envelope on every MCP tool** + semantic exit codes — kills the string-parse-stderr anti-pattern in skills.

**Avoid:**
- **Bash as orchestration substrate** (anti-pattern #1) — flywheel's TS/MCP foundation already dodges this; codify it.
- **Browser-only LLM transport** (anti-pattern #2, blunder B10) — flywheel uses API auth; codify that as the *only* transport.
- **Hardcoded round-count convergence** (anti-pattern #3) — stay metric-driven.
- **`release_lock` deletes locks it didn't create** (B3) — audit Agent Mail's `release_file_reservations` for the same trap.

**Net research proposal:** spike A1+A2+A3 (convergence score + plan-vs-code diff bundling + atomic state) as a single integrated cluster in the next sprint, since they share the mv-atomic disk-state assumption and unlock each other. A4 (templates) and A5 (envelope) are independent ergonomic wins sequenced after.

---

## Phase artifacts

| Phase | File | Size |
|-------|------|------|
| 1 — Investigate | [`apr-pro-phase1-explore.md`](./research/apr-pro-phase1-explore.md) | 18 KB |
| 2 — Deepen | [`apr-pro-phase2-deep.md`](./research/apr-pro-phase2-deep.md) | 17 KB |
| 2 — Deepen (bonus) | [`apr-pro-phase2-deepen.md`](./research/apr-pro-phase2-deepen.md) | 14 KB |
| 3 — Inversion | [`apr-pro-phase3-invert.md`](./research/apr-pro-phase3-invert.md) | 19 KB |
| 4 — Blunder hunt | [`apr-pro-phase4-blunders.md`](./research/apr-pro-phase4-blunders.md) | 18 KB |
| 6a — Apply (opus) | [`apr-pro-apply.md`](./research/apr-pro-apply.md) | 26 KB |
| 6b — Ergonomics (sonnet) | [`apr-pro-ergonomics.md`](./research/apr-pro-ergonomics.md) | 21 KB |

---

## What APR-Pro is

A 6,900-LOC Bash monolith that takes a markdown spec and iteratively revises it through an LLM oracle (ChatGPT via headless browser by default; API mode added late). Each round bundles the current document + previous revisions + extracted metrics, sends to the oracle, receives a revised document, computes deltas, decides convergence. State persists in `.apr/sessions/<pid>/` via mv-atomic JSON. Robot mode emits structured JSON envelopes. Has a gum-styled TUI dashboard reading the same disk state the orchestrator writes.

**Mature parts:** convergence detection, document bundling, robot-mode API, session-recovery semantics, structured exit codes, graceful degradation stack.
**Fragile parts:** Bash for everything, browser as primary LLM transport, hardcoded round-count taxonomy, lock-ownership semantics, NIH "TOON" encoding.

Author: Jeffrey Emanuel ("Dicklesworthstone"). Single-user, single-workflow-type (security protocol specs), home-server + Tailscale lifestyle.

---

## Why this matches flywheel

| APR concept | Flywheel surface |
|-------------|------------------|
| Spec ↔ revised spec loop | Plan ↔ code-validated plan (Step 5.45) |
| `metrics.json` per round | `convergence.json` per plan (proposed) |
| Robot-mode JSON envelope | MCP tool return shape |
| `.apr/sessions/<pid>/` | Swarm pane state + checkpoint |
| Document bundling for revision prompt | Plan-vs-code diff bundling for refine prompt |
| TUI reading disk state | `flywheel_observe` (proposed: pull-only reader) |
| `apr doctor` | `flywheel-doctor` (already exists; needs pane introspection) |
| Workflow YAML | `flywheel.config.yaml` (proposed) |

The strongest one-to-one is the convergence loop — APR's signals + 50/75/90 ladder transfer almost verbatim to flywheel's Step 5.45 menu defaults, with the B6 oscillation fix layered on top.

---

## Top 5 adoption proposals (cross-phase synthesis)

### A1 — Convergence as a multi-signal score (Phase 2 T2 + 6a P1)

Persist `.flywheel/plans/<slug>/convergence.json` with `{output_size_trend, change_velocity, similarity_trend}` + structural-metric counts (headings, code blocks, links, lists) per revision. Compute weighted score → 50/75/90 ladder → arm Step 5.45 menu defaults (Approve at ≥0.75, Refine at 0.50–0.75, surface Scrap when score declining + size growing).

**B6 fix layered on:** ring-buffer of last N revisions with sign-flip count; > floor(N/3) → `status: "oscillating"`, refuse to estimate `rounds_remaining`. APR averages first-half vs second-half and is blind to ping-pong.

**Surfaces.** new `convergence.json`; `flywheel_plan` returns `convergence` block; `skills/start/_picked_up_plan.md` reads it; `polishConverged` upgraded.

### A2 — Plan-vs-code git-diff bundling (Phase 2 T3 + 6a P2)

Step 5.45's "Refine" branch should feed the LLM unified-diff hunks computed from `git log -p --since=<plan-mtime> -- <plan-claimed-paths>` rather than path lists. Pair with `code_every_n` (e.g., re-anchor the wave prompt with full source every 5 beads) inside `flywheel_advance_wave` to keep prompts lean without losing grounding.

**Surfaces.** Step 5.45 "Refine" prompt template; `flywheel_advance_wave` re-anchor logic.

### A3 — Atomic disk state + pull-don't-push readers (Phase 2 T4 + 6a P3)

Move flywheel toward APR's discipline: every state mutation is an mv-atomic write, every reader (TUI, dashboard, `flywheel_observe`, `flywheel_status`) re-reads disk on demand instead of subscribing. Decouples read latency from orchestrator state, makes recovery deterministic.

**Surfaces.** `flywheel_observe` (currently aggregates probes — make it a pure JSON-from-disk reader); swarm pane state at `.flywheel/swarm/panes/<pane-id>.json`.

### A4 — Pinned prompt templates + `prompt_quality_check` gate (Phase 2 T3 + 6a P4)

Surface plan/review/refine prompt templates in `flywheel.config.yaml` with versioned schema, gated by a 30-LOC pre-send placeholder-scan that refuses to send a prompt with `{{unfilled}}` slots. Today these live buried in skill bodies; users can't tune without forking the plugin.

**Surfaces.** `flywheel.config.yaml`; `skills/start/_planning.md`, `_review.md`, `_picked_up_plan.md` switch from inline strings to template lookups.

### A5 — Structured JSON envelope + semantic exit codes (Phase 6a P5 + 6b §2.1)

Every MCP tool returns `{ok: bool, code: string, data: object, hint: string, meta: {v, ts, durationMs}}`. Skills branch on `error.code`, never on stderr text. APR's robot-mode is the reference shape (already partially adopted in `flywheel_doctor`'s structured `data.error.code` → just generalize across all 25+ tools).

**Surfaces.** every MCP tool in `mcp-server/`; skills' error-handling sites switch to `data.error.code` branching.

---

## Top 4 traps to explicitly avoid

### Trap T1 — Oscillation blindness (B6)

APR's convergence detector averages first-half vs second-half deltas, so size going `1000 → 1200 → 800 → 1100 → 900` looks "stable" (avg ≈ 1000). Implement A1 with a ring-buffer + sign-flip count instead.

### Trap T2 — Lock-file ownership (B3)

APR's `release_lock` `rm -f`'d any lockfile at the expected path, including locks created by other processes. Audit Agent Mail's `release_file_reservations` and `force_release_file_reservation` — every release must verify the caller owns the reservation (PID + token check) before deleting.

### Trap T3 — Auto-checksum CI race (B2)

APR's CI auto-bumped a checksum file on every push and fought the PR's own "checksum consistency" check, causing flapping CI. Audit our release CI (`.github/workflows/`) for any auto-bump that runs on the same trigger as a verification step.

### Trap T4 — Hardcoded round counts (anti-pattern #3)

APR hardcoded `1-3 = major / 4-7 = refinement / 8+ = polish`. The taxonomy embedded in code makes it impossible to tune for different plan shapes. Flywheel must keep round counts as opaque IDs and let convergence score be the gate.

---

## Open questions for Phase 8 deepening

1. **Schema versioning.** APR's `metrics.json` has `schema_version`. Should `convergence.json` use the same field? Migration story when we add a new signal?
2. **`code_every_n` cadence.** What's the right re-anchoring period for `flywheel_advance_wave` — every 5 beads? Every 10? Per-wave? Tunable in `flywheel.config.yaml`?
3. **Prompt-template scope.** Just plan/review/refine, or also bead-creation prompts, swarm marching orders, doctor advisory templates? Where's the diminishing-returns line?
4. **Atomic-state migration.** What's the minimal cut to migrate to mv-atomic state without forking every consumer? Single `.flywheel/state/<entity>.json` shape, or per-entity directories?
5. **Envelope rollout.** All MCP tools at once, or incrementally with adapter? What's the deprecation path for current callers parsing free-text?

---

## Recommendation

Proceed to **Phase 8: Integration proposal** for the **A1 + A2 + A3 cluster** (convergence score + plan-vs-code bundling + atomic state) since they share the mv-atomic disk-state assumption and unlock each other. A4 (templates) and A5 (envelope) are independent ergonomic wins that can be sequenced after.

The opus apply.md (P1–P5) and sonnet ergonomics.md (DX/output/recovery/docs) provide complementary halves of the same picture — opus answers "what should the code do?" and sonnet answers "what should the user see?" Combine both into the Phase 8 integration document.

---

## Phase pipeline status

- ✅ Phase 1 — Investigate
- ✅ Phase 2 — Deepen (T2/T3/T4)
- ✅ Phase 3 — Inversion (8 anti-patterns)
- ✅ Phase 4 — Blunder hunt (11 footguns)
- ✅ Phase 5 — User review (picked: all-cross-phase + Major Feature Integration)
- ✅ Phase 6 — Multi-model synthesis (apply.md + ergonomics.md)
- ✅ Phase 7 — Synthesis (this document)
- ⏳ Phase 8 — Integration proposal
- ⏳ Phase 9 — Iterative deepening (1 opus pass)
- ⏳ Phase 10 — 5x blunder hunt
- ⏳ Phase 11 — Cross-model feedback (2-3 models)
- ⏳ Phase 12 — Final synthesis + recommended action
