# APR-Pro Phase Archive — Pre-synthesis Inputs (2026-05-06)

**Date:** 2026-05-06
**HEAD:** `05071af`
**Status:** Pre-synthesis inputs to APR-Pro adoption. Synthesis outputs live in [`research-apr-pro-landed-2026-05-06.md`](./research-apr-pro-landed-2026-05-06.md).

This archive consolidates the seven phase artifacts produced during the APR-Pro
research sweep (April 2026 → 2026-05-05). The artifacts ran sequentially as a
research pipeline: explore → deepen → invert → blunder-hunt → apply → ergonomics,
ultimately feeding the v3.12.0 A1-only scope-down. Phase outputs disagree in places;
those disagreements are called out explicitly per phase.

**Source artifacts archived here:**

- `docs/research/apr-pro-phase1-explore.md`
- `docs/research/apr-pro-phase2-deep.md`
- `docs/research/apr-pro-phase2-deepen.md`
- `docs/research/apr-pro-phase3-invert.md`
- `docs/research/apr-pro-phase4-blunders.md`
- `docs/research/apr-pro-apply.md` (Phase 6a)
- `docs/research/apr-pro-ergonomics.md` (Phase 6b)

---

## Phase 1 — Explore

**Artifact:** `apr-pro-phase1-explore.md` (458 lines)
**Author:** baseline architecture exploration of APR-Pro repo.

### Key findings

- **Primary entry:** `apr` script, ~6,900 LOC bash monolith. Robot-mode JSON API surfaced as parallel command surface.
- **Round execution lifecycle.** Each round: assemble doc bundle → invoke Oracle (browser-driven LLM transport) → poll for stable response → parse + write metrics → check convergence → loop.
- **Convergence detection (T2 tangent).** APR computes per-round metrics: `output_size`, `change_velocity`, `similarity_trend`. Aggregates first-half-vs-second-half averages over recent rounds, hard threshold at `≥0.75`. Linear extrapolation `estimated_rounds_remaining = (1 - score) * 5`.
- **Document bundling (T3 tangent).** APR pastes the full plan + recent diffs inline via DOM automation against ChatGPT — "the inline-paste workaround" was driven by file-upload corruption (later surfaced as B5).
- **Session & state management.** `.apr/sessions/<id>/` directory holds `state.json`, `metrics.jsonl`, PID file, lock file. 2-hour stale-lock TTL.
- **Notable techniques.** Oracle stability polling (T2 deepen target), session-PID tracking + reattachment, robot-mode JSON envelope with structured error codes, TOON encoding (later flagged as anti-pattern in Phase 3).

### Five tangents flagged for Phase 2 deepening

T1 Oracle browser automation API · T2 Convergence heuristics · T3 Document bundling & prompt engineering · T4 TUI integration with robot mode · T5 TOON encoding for structured output.

### Phase 1 stance

**Mostly observational.** Lists architectural patterns without yet recommending which ones agent-flywheel should adopt or reject. Two sibling Phase 2 explorations were spawned (deep + deepen) to drill into different tangent triplets.

---

## Phase 2 — Deep (top-3 tangents: T2 + T3 + T4)

**Artifact:** `apr-pro-phase2-deep.md` (289 lines)
**Subjects:** Convergence Heuristics (T2), Document Bundling & git-diff Prompts (T3), TUI + Robot Mode Sync (T4).

### Key claims

- **T2 mechanism deep-dive.** Confirmed `output_size_trend = (avg_size_second_half - avg_size_first_half) / avg_size_first_half` with the 50/75/90 ladder. **The "why it works" framing**: APR's three signals capture orthogonal axes — magnitude (size), motion (velocity), and direction (similarity).
- **T2 → flywheel mapping table:** `output_size_trend` ↔ `flywheel_plan` plan-doc growth across Step 5.45 refine cycles; `change_velocity` ↔ bead churn between waves; `similarity_trend` ↔ cosine/diff_ratio of plan doc; `convergence.detected` ↔ auto-arm "Approve" in Step 5.45 menu; `convergence.confidence` ↔ scrap-vs-refine recommendation weight in `flywheel_review`.
- **T3 mechanism deep-dive.** APR's bundle template includes the full plan, prior round's diff, structural-changes summary, and the previous N revisions. Asks the LLM for unified-diff hunks (`-3/+3` context). The diff itself is a cheap similarity signal.
- **T4 deep-dive.** APR's TUI is a pure disk reader on `state.json`; the Oracle process writes, the TUI never owns the lock. This decouples liveness from rendering.

### Phase 2 (deep) synthesis

> "The three tangents share one underlying recipe: persist structured state to disk under atomic writes, and let multiple views derive themselves from that file."

This synthesis is the seed of what later became the A1+A2+A3 cluster proposal — and was eventually scoped down to A1-only.

### Top adoption candidates (Phase 2 deep)

1. Pin plan-review prompt templates in `flywheel.config.yaml`, gate sends with `prompt_quality_check`.
2. Persist `flywheel_convergence.json` per plan, drive Step 5.45 menu defaults from APR's 50/75/90 ladder.
3. Detached-PID locks + atomic state writes so `flywheel_observe` and `/flywheel-status` are pure disk readers.
4. Refine branch produces unified-diff hunks vs prior plan.
5. `code_every_n` / `impl_every_n` periodic re-anchoring in `flywheel_advance_wave`.

(Items 3–5 were ultimately *not* adopted in v3.12.0 — see Phase 11/12 disagreement notes below.)

---

## Phase 2 — Deepen (parallel triplet: T1 + T2 + T3)

**Artifact:** `apr-pro-phase2-deepen.md` (401 lines)
**Subjects:** Oracle Session Persistence & Browser Lifecycle (T1), Convergence Heuristics & Metrics-Driven Stopping (T2), Document Bundling & Diff-Based Change Visibility (T3).

This is the *parallel* Phase 2 spawn that drilled into T1 (which "deep" did not pick up) and re-deepened T2 + T3.

### Key claims

- **T1 — stateful authentication model.** Oracle persists Chrome cookies/localStorage; session reattach checks browser-side state, not just PID. Implication: any flywheel session-reattach feature inherits the *same fragility surface* (browser process death, cookie expiry, OAuth token rotation). Phase 2 deepen flagged this as a reason flywheel should *not* adopt session reattach naively.
- **T2 — multi-signal convergence detection.** Reframed as three signals representing orthogonal information: stability (similarity), magnitude (size), velocity (change rate). The aggregation formula was inferred (not directly visible in APR source) as a weighted combination — Phase 2 deepen called this out as a reverse-engineering risk.
- **T2 — convergence pattern empirically observed.** Plans typically converge in 4–7 rounds; oscillation around round 5–6 is common. This empirical observation is what made B6 (Phase 4) particularly damning — APR's detector mis-classifies the most common failure mode.
- **T3 — diff-aware revision prompting.** APR injects `metrics_summary.json` *into the prompt* alongside the diff, so the LLM sees its own progress history. Diff filtering excludes lines with `<2 char` changes (whitespace noise). This is a meaningful signal-to-noise improvement that flywheel did not adopt.
- **T3 — implications for flywheel.** Step 5.45 should ask refiners for *unified-diff hunks*, not full revised documents — same conclusion as Phase 2 deep §T3, but with a stronger argument from the metrics-injection angle.

### Phase 2 disagreement with Phase 1

Phase 1's neutral tone framed T1 (Oracle session persistence) as worth deepening for its sophistication. Phase 2 deepen pushed back: the sophistication is *paying for a problem APR self-inflicted by choosing a browser-based LLM transport*; flywheel should not inherit the cost.

---

## Phase 3 — Invert (anti-patterns)

**Artifact:** `apr-pro-phase3-invert.md` (203 lines)
**Frame:** What APR-Pro does that agent-flywheel should *avoid*.

### Eight anti-patterns identified

1. **Bash as primary orchestration language (~6,900 LOC monolith).** `set -euo pipefail` interacts unpredictably with optional dependencies (later cited in B11). Agent-flywheel risks the same trap if NTM/start.md scripts grow too large.
2. **Browser-driven Oracle as the only LLM transport.** Couples APR to ChatGPT UI changes; B5/B8/B10 are all symptoms.
3. **Hardcoded round-count convergence pattern (1-3 / 4-7 / 8-12 / 13+).** Treats round count as a stand-in for actual progress; misclassifies oscillating series.
4. **File-based state in `.apr/sessions/` with 2-hour stale-lock TTL.** Time-based stale detection without ownership stamping; adversarial mode failures.
5. **TOON encoding — NIH format behind a JSON wrapper.** Adds a parsing layer with no observable benefit over plain JSON; flywheel should keep robot-mode envelopes plain JSON.
6. **Workflow YAML schema leaks implementation detail to the user.** APR's workflow file exposes Oracle prompt templates, retry counts, polling intervals — all of which should be *internal*. Agent-flywheel risks the same with its own `.flywheel/` config surface.
7. **Self-update via curl-pipe-bash with SHA-256 inside the same repo.** The checksum is committed alongside the script — provides no integrity guarantee against repo compromise.
8. **Inline document pasting via DOM automation as the bundling strategy.** Treats a workaround for B5 as a feature.

### Phase 3 stance vs Phase 2

Phase 2 (deep + deepen) said "this pattern is interesting, here's how flywheel might adopt it." Phase 3 inverted: "this pattern is interesting *because it's a trap*, here's what flywheel should not do." The two views are complementary but reach opposite conclusions on items like "TOON encoding" (Phase 1 flagged it for deepening; Phase 3 explicitly rejects it).

---

## Phase 4 — Blunders (B1–B11)

**Artifact:** `apr-pro-phase4-blunders.md` (183 lines)
**Frame:** Specific bugs APR-Pro hit in production, ranked for transferability.

### Eleven blunders

1. **B1.** Monkey-patching a third-party `node_modules` file (Oracle's `assistantResponse.js`). Survives until next `npm install`.
2. **B2.** Auto-checksum CI race against PR checksum-consistency check. The committed checksum updates faster than CI verifies it.
3. **B3.** `release_lock` deleted lock files it did not create. Agent A spawns, B replaces A's lock, A exits and deletes B's lock — race-condition footgun.
4. **B4.** `diff_rounds` showed diffs backwards. Conventionally `diff old new` produces `+` for additions; APR called it `diff new old` which inverts the polarity. Reviewers misread "improvements" as "regressions" for weeks.
5. **B5.** Inline-paste workaround masking the real bug — file uploads to ChatGPT silently corrupt under certain encodings. The "feature" is a band-aid.
6. **B6.** **Convergence detector cannot detect oscillation.** The score is `0.35*output_trend + 0.35*change_velocity + 0.30*similarity_trend`, all *first-half-vs-second-half averages*. None measure direction reversal. A spec growing → shrinking → growing has *low average diff_ratio* (small average change) — APR declares convergence on a non-converging series. **This is the blunder the flywheel B6 oscillation guard fixes.**
7. **B7.** Session-recovery via Oracle reattach is best-effort; silently gives up on truncation.
8. **B8.** `--notify` flag passed unconditionally to Oracle without version check.
9. **B9.** Robot-mode `APR_ERROR_CODE=...` tag emitted on stderr — interferes with BATS `run` capture.
10. **B10.** Headless / `--engine api` blocked for ~3 months; browser engine hardcoded in three places.
11. **B11.** `set -euo pipefail` + `bc` optional dependency = silent zero-confidence convergence. If `bc` is missing, the formula returns 0, and the `set -e` does *not* trip because the failure is masked.

### Phase 4 transferable lessons

> "(a) Never mutate a sibling tool's installed files, (b) classify exit codes before retrying, (c) detect oscillation explicitly in any 'ready to ship' gate, (d) machine-readable error channels must be one-stream-only, (e) gating signals fail-closed on missing dependencies."

Lesson (c) is what shipped. Lessons (a), (b), (d), (e) are deferred to future beads.

---

## Phase 6a — Apply (technical adoption proposals)

**Artifact:** `apr-pro-apply.md` (Phase 6a, claude-opus-4-7)
**Sibling:** Phase 6b ergonomics (sonnet, dev-UX half).
**Inputs:** Phases 1, 2-deep, 3, 4.

### Eight adoption proposals (P1–P8)

1. **P1.** Convergence as a multi-signal score driving Step 5.45 menu defaults.
2. **P2.** Versioned prompt templates in `flywheel.config.yaml` with a placeholder pre-send gate.
3. **P3.** Ring-buffer convergence with explicit oscillation detection. **This is the B6 fix.**
4. **P4.** `flywheel_observe` as a pure disk reader; atomic state writes everywhere.
5. **P5.** Detached-PID locks + ownership-stamped reservations (Agent Mail audit).
6. **P6.** Plan-vs-code git-diff bundling for Step 5.45 "Validate against code" branch.
7. **P7.** Semantic exit codes / structured error envelope across all flywheel MCP tools.
8. **P8.** Distribution audit: tagged releases, signed checksums, no curl-pipe-bash from `main`.

P1 + P3 became the v3.12.0 A1 ship. P2, P4–P8 were deferred (independent beads).

### Phase 6a anti-patterns avoided

Phase 6a explicitly enumerates anti-patterns flywheel already does *not* commit (in contrast to APR): no bash monolith (TypeScript MCP server + skill markdown), no browser-driven LLM transport, no hardcoded round counts (waves are operator-gated), no NIH encoding, no curl-pipe-bash self-update from `main`.

---

## Phase 6b — Ergonomics (DX + UX wins)

**Artifact:** `apr-pro-ergonomics.md` (Phase 6b, sonnet, 541 lines)
**Frame:** What APR's ergonomics teach about agent-flywheel UX, distinct from Phase 6a's *technical* adoption frame.

### Five biggest ergonomic wins

1. **Structured JSON envelope for all MCP tools.** APR's robot-mode is the model — every command returns `{status, data, error_code, hint}` regardless of success/failure.
2. **Convergence confidence score in `flywheel_observe`.** Surface the score; let the operator and downstream tools react.
3. **Step 5.45 menu smart-defaults (Validate / Approve / Refine / Scrap).** APR's TUI gates "next round" on `convergence.detected`, dims "approve" when confidence < 75%. *Note: ultimately Phase 12 §12.5 ruled this out — Step 5.45 displays the score in question text but never arms a default. This is a Phase 6b → Phase 12 disagreement.*
4. **`/flywheel-doctor` pane introspection (`am doctor` analog).** Per-pane alive/dead/last-beat report. Partially shipped — `convergence_state_validity` doctor check landed in v3.12.0 as one of 12 entries; the broader pane-introspection sweep is deferred.
5. **Prompt-quality pre-flight gate.** `{{...}}` placeholder check with semantic exit code 12 (`validation_failed`). Deferred.

### Other ergonomic surfaces explored

Unified-diff "Refine" branch in Step 5.45 (deferred — A2 cut), session reattach for long-running swarms (deferred — Phase 2 deepen flagged inherited fragility), convergence dashboard (`apr dashboard` analog — deferred), workflow-first README structure, convergence visualization in skill output, skills reference with input/output schemas, annotated YAML workflow examples.

### Phase 6a vs 6b disagreement

Phase 6a's P3 said "ring-buffer + oscillation detection should be its own bead." Phase 6b §2.3 said "Step 5.45 should *automatically arm* the menu default based on convergence." Phase 11b/12 sided with neither cleanly: ring-buffer + oscillation shipped (matching 6a), but auto-arming did *not* ship — the score is rendered in question text only (matching neither 6a's silence on UX nor 6b's auto-arm). This was the explicit Phase 12 §12.5 trap-avoidance decision: per AGENTS.md, every user decision flows through `AskUserQuestion` with no implicit choices.

---

## Cross-phase synthesis (forward link)

The synthesis output that ultimately drove what shipped lives in
[`research-apr-pro-landed-2026-05-06.md`](./research-apr-pro-landed-2026-05-06.md).
That document covers: (1) the multi-signal convergence schema as it landed in
`mcp-server/src/convergence.ts`, (2) the B6 oscillation-guard semantics
(`signFlips > revisions / 3 → status: "oscillating"`), (3) the Phase 11a (sonnet)
+ Phase 11b (opus) review verdicts, and (4) the explicit "what was NOT adopted"
list for the Phase 12 A1-only scope-down.

The phase-by-phase disagreements summarized above are preserved in the original
artifacts — those files are the authoritative record. This archive exists to make
the disagreement structure scannable without reading 1,500+ lines of
phase output.
