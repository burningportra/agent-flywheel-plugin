# Plan: 3-way duel consensus winners — runtime safety + recovery substrate

**Date:** 2026-04-30
**Source:** `docs/duels/2026-04-30.md` (3-way duel, 1 cc + 2 pi, fresh-start mode)
**Plan source:** `duel` (per `_beads.md` Provenance block)
**Project:** agent-flywheel @ v3.10.2 (commit `1625236`, branch `main`)

## Goal

Ship the three duel consensus winners as a single coordinated wave: a runtime-safety + recovery substrate that closes the v3.10.0 quality-gate honor-system exposure, eliminates the session-recovery archaeology friction lived through this very session, and codifies the AGENTS.md Agent Mail reservation-conflict mitigation as code.

## Scope

In scope (3 features, ≈ 660 LOC source + tests + skill text):

1. **Completion Evidence Attestation Stage 1** — versioned `CompletionReport` JSON ledger written by every NTM implementor, validated by coordinator-side tools.
2. **`flywheel_observe`** — single read-only MCP tool returning a structured session-state snapshot.
3. **Lock-aware reservation helper + lint rule** — wrap `agentMailRPC("file_reservation_paths")` and treat any non-empty `conflicts` array as failure.

Explicitly out of scope (defer to future plans):

- Completion Evidence Attestation Stage 2 (server-side witnessed UBS/verify against recorded diff sha) — requires Stage 1 corpus to stabilize the schema first.
- Crash-aware session resume `inFlight` checkpoint extension — requires `flywheel_observe` to land first; harness-renderer surface adds boundary-crossing risk this plan avoids.
- Skill Contract Workbench — contested in the duel (pi 925/910 vs cc 670/680); needs human arbitration on priority before committing implementation effort.
- NTM Lane Planner — useful, but partial-adoption risk; defer until skills surfaces stabilize.
- Solutions vault auto-roll-up — useful, but lower urgency than runtime safety per all 3 agents.
- Command/Skill Drift Eliminator — fold into a later Skill Contract Workbench wave if that ships.
- Docs/Reality Consistency Oracle — duel-killed (cc 470 / pi2 710); the right fix is targeted docs PRs, not permanent infrastructure.

## Non-goals

- No new agent CLI integrations.
- No new MCP servers.
- No changes to Agent Mail upstream.
- No backwards-incompatible schema changes — `CompletionReport` is `version: 1` and additive forever.

## Architecture overview

```
                 NTM impl pane                       Coordinator
                 ─────────────                       ───────────
implements bead ──┬─> writes diff
                  ├─> runs UBS, verify, self-review
                  └─> writes .pi-flywheel/completion/<beadId>.json   ┐
                                                                      ├─> flywheel_advance_wave
reservation ──────> agentMailRPC via reserveOrFail() helper           │   reads attestation
attempts            ├─> ok: returns reservationId                     │   validates schema/presence
                    └─> conflicts: refuses + bubbles up               │   rejects on missing
                                                                      │
recovery agent ───> flywheel_observe ─────────────────────────────────┘
                    ├─> reads checkpoint, beads, NTM, agent-mail
                    ├─> reads .pi-flywheel/completion/*.json
                    └─> emits hints[] (stale attestations, ready beads, etc.)
```

The three features compose: attestation creates durable evidence; observe surfaces missing/stale evidence during recovery; the reservation helper prevents one of the silent-corruption failure modes the attestation contract is designed to catch after the fact.

## Tasks (with explicit dependency graph)

> Per CLAUDE.md "Planning: All implementation plans MUST include a dependency graph. Every task declares `depends_on: []`."

### T1 — Completion Evidence Attestation: schema + parser

- **id:** T1
- **depends_on:** []
- **scope:** `mcp-server/src/completion-report.ts`
- **deliverable:**
  - Zod schema `CompletionReportSchemaV1` matching the `_beads.md` Provenance block fields agreed in the duel: `version: 1`, `beadId`, `agentName`, `paneName?`, `status: "closed" | "blocked" | "partial"`, `changedFiles[]`, `commits[]`, `ubs.{ran, summary, findingsFixed, deferredBeadIds[], skippedReason?}`, `verify[].{command, exitCode, summary}`, `selfReview.{ran, summary}`, `beadClosedVerified`, `reservationsReleased?`, `createdAt`.
  - Helpers: `readCompletionReport(cwd, beadId)`, `validateCompletionReport(report, bead)`, `formatCompletionEvidenceSummary(report)`.
  - Unit tests covering: valid full report, docs-only UBS skip with reason, missing verify, bead marked closed but `beadClosedVerified=false`, invalid changed-file path escaping cwd.
- **acceptance:** all unit tests pass; `npm run build --prefix mcp-server` clean.

### T2 — Coordinator validation gate

- **id:** T2
- **depends_on:** [T1]
- **scope:** `mcp-server/src/tools/verify-beads.ts`, `mcp-server/src/tools/advance-wave.ts`
- **deliverable:**
  - `flywheel_verify_beads` reads `.pi-flywheel/completion/<beadId>.json` for each bead in the verify scope and returns a `missingEvidence[]` / `invalidEvidence[]` section in its structured response.
  - `flywheel_advance_wave` refuses to advance any bead whose attestation is missing or schema-invalid; returns structured error code `attestation_missing` or `attestation_invalid` with `error.hint` populated.
  - Phased enforcement: Stage 1 returns `status: ok, needsEvidence: true` instead of hard-blocking, so existing in-flight workflows aren't broken on first roll-out. A new env var `FW_ATTESTATION_REQUIRED=1` flips it to blocking; we will flip the default in v3.11.0 once the corpus stabilizes.
- **acceptance:** integration tests covering missing/present/invalid attestation paths; existing wave-advance tests still pass.

### T3 — Implementor prompt updates

- **id:** T3
- **depends_on:** [T1]
- **scope:** `skills/flywheel-swarm/SKILL.md`, `skills/start/_implement.md`
- **deliverable:**
  - Pre-Completion Quality Gate block in the marching-orders payload now requires (in order, after the existing UBS + verify + self-review): "(4) write `.pi-flywheel/completion/<beadId>.json` with the schema in `mcp-server/src/completion-report.ts`."
  - Add a worked example of the JSON file in the skill (small, single-bead).
  - Update `commands/flywheel-swarm.md` if it duplicates marching-orders text (per the duel's Command/Skill Drift critique).
- **acceptance:** `npm run lint:skill --prefix mcp-server` clean against the new text; manual review confirms the block is structurally identical across both skill files.

### T4 — Lock-aware reservation helper

- **id:** T4
- **depends_on:** []
- **scope:** `mcp-server/src/agent-mail-helpers.ts` (new)
- **deliverable:**
  - `reserveOrFail(paths, opts) -> {ok: true, reservationId} | {ok: false, conflicts}`. Treats any non-empty `conflicts` array as failure even when `granted` is also populated. Single retry with exponential backoff before failing.
  - `releaseReservations(reservationIds)` symmetric helper.
  - Migration: `mcp-server/src/tools/advance-wave.ts` and any other current `file_reservation_paths` call site routes through the helper. Direct `agentMailRPC("file_reservation_paths", ...)` calls remain a typecheck-only baseline for the lint rule in T5.
  - Unit tests covering: `granted` only success, `conflicts` only failure, `granted` + `conflicts` mixed (must fail), retry-on-conflict resolves on second attempt, retry exhausted.
- **acceptance:** existing `advance-wave` integration tests still pass; new helper-specific unit tests pass.

### T5 — `RESERVE001` linter rule

- **id:** T5
- **depends_on:** [T4]
- **scope:** `mcp-server/src/lint/rules/reserve001.ts` (new), `mcp-server/.lintskill-baseline.json`
- **deliverable:**
  - Rule warns on direct `agentMailRPC` calls with `tool: "file_reservation_paths"` outside the `agent-mail-helpers.ts` module. Severity `warn` initially.
  - Baseline existing references (post-T4 there should be none in src; if any remain, baseline them and TODO).
  - Promote to `error` after one release cycle.
- **acceptance:** `npm run lint:skill --prefix mcp-server` clean; deliberately-introduced raw call site triggers the rule.

### T6 — `flywheel_observe` schema + tool implementation

- **id:** T6
- **depends_on:** []  (independent of T1–T5; can run in parallel)
- **scope:** `mcp-server/src/tools/observe.ts` (new), `mcp-server/src/server.ts` (registration)
- **deliverable:**
  - Versioned `FlywheelObserveReport` Zod schema covering: `cwd`, `git.{branch, head, dirty, untracked[]}`, `checkpoint.{exists, phase?, selectedGoal?, planDocument?, activeBeadIds[]?, warnings[]}`, `beads.{initialized, counts, ready[]}`, `agentMail.{reachable, unreadCount?, warning?}`, `ntm.{available, panes[]?, warning?}`, `artifacts.{wizard[], flywheelScratch[]}`, `hints[]` with `severity: info|warn|red`.
  - Implementation aggregates from existing primitives: `loadState()`, `br list --json` parse, `agentMailRPC` health probe, cached `flywheel_doctor` (max age 60s — fresh fetch only if older), `git status --porcelain`, filesystem glob for `WIZARD_*.md`, `.simplify-ledger`, `refactor/`.
  - **Hard rules (all 3 duel agents agreed, must be enforced):** idempotent, non-mutating, doctor data either cached or short-budgeted (< 1.5s), every external probe degrades gracefully (mark sub-section `unavailable: true` rather than failing the whole call).
- **acceptance:** unit tests covering: no checkpoint/no beads; corrupt checkpoint warning; WIZARD artifact detection; br unavailable graceful degradation; agent-mail unreachable graceful degradation; tool registers via `flywheel_get_tools`.

### T7 — `flywheel_observe` ↔ Completion Evidence integration

- **id:** T7
- **depends_on:** [T1, T6]
- **scope:** `mcp-server/src/tools/observe.ts`
- **deliverable:**
  - `observe.hints[]` surfaces missing or stale completion attestations: for each in-flight bead in `state.activeBeadIds`, if `.pi-flywheel/completion/<beadId>.json` is missing, emit `severity: "warn", message: "bead <id> in-flight without attestation", nextAction: "agent should write completion JSON before advancing"`. If present but `createdAt` is more than 24h old, emit `severity: "info", message: "stale attestation for closed-bead <id>"`.
- **acceptance:** integration test with fixture cwd containing 2 in-flight beads, 1 with attestation present, 1 missing — only the missing one appears in `hints[]`.

### T8 — Documentation + CHANGELOG

- **id:** T8
- **depends_on:** [T2, T3, T4, T5, T6, T7]
- **scope:** `AGENTS.md`, `CHANGELOG.md`, `README.md` (if affected)
- **deliverable:**
  - `AGENTS.md`: new "Completion Evidence Attestation" section under the existing "Pre-Completion Quality Gate" replacing "agents must include UBS + verify + self-review evidence in the completion message" with "agents must (a) include the same evidence in the completion message AND (b) write a versioned `CompletionReport` JSON to `.pi-flywheel/completion/<beadId>.json`."
  - `AGENTS.md`: update the "Known issue" under file reservations to say "the `reserveOrFail()` helper in `mcp-server/src/agent-mail-helpers.ts` codifies this mitigation; do not call `agentMailRPC("file_reservation_paths", ...)` directly — `RESERVE001` lint rule enforces this."
  - `CHANGELOG.md`: new `[3.11.0]` entry summarizing all three features.
  - Bump `mcp-server/package.json` and `.claude-plugin/plugin.json` to `3.11.0`. Rebuild bundle.
- **acceptance:** `npm run check:skills-bundle --prefix mcp-server` passes; `git diff --stat` shows AGENTS.md + CHANGELOG.md + 2 package.json + bundle as the only doc/version changes.

## Dependency graph

```
T1 ──────────┬──> T2 ──┐
             │         │
             └─> T3 ───┤
                       │
T4 ──> T5 ─────────────┤
                       │
T6 ──> T7 ─────────────┴──> T8
       (also depends on T1)
```

Critical path: T1 → T2 → T8 (or T6 → T7 → T8 — same length, can run in parallel).
Independent waves possible: {T1, T4, T6} (3 panes wave 1), {T2, T3, T5, T7} (3 panes wave 2), {T8} (1 pane wave 3).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Agents fail to write `CompletionReport` JSON reliably on first roll-out | medium | Stage 1 returns `needsEvidence: true` instead of hard-blocking. Promote to blocking only after corpus stabilizes (target: 1 release cycle). |
| Schema needs v2 within 90 days | low | Schema is additive-only by contract; new fields are optional; never remove keys; document this in `mcp-server/src/completion-report.ts` as a comment. |
| `flywheel_observe` becomes a second `flywheel_doctor` | medium | Hard rule in T6 acceptance: tool is idempotent + non-mutating + doctor budget < 1.5s. PR description must explicitly call out any new probe added to observe and justify it isn't doctor's job. |
| Lock-aware helper misses skill-text reservation calls (PI2's reveal-phase critique) | medium | T3 + T5 cover this — skill prompt updates require the helper, lint rule blocks new direct calls. |
| Stale duel data (CC's reaction-phase concern: "this very session lived the recovery archaeology") | low | T6 + T7 directly close that gap; this plan is the on-ramp. |
| Three features ship simultaneously and break each other | low | Wave-based dispatch via `flywheel_advance_wave` (existing infra) keeps wave 1 (T1, T4, T6) green before wave 2 (T2, T3, T5, T7) starts; T8 is the merge gate. |

## Acceptance criteria (whole plan)

1. `npm run build --prefix mcp-server` clean.
2. `npm test --prefix mcp-server` passes; new tests cover all of T1, T2, T4, T5, T6, T7.
3. `npm run lint:skill --prefix mcp-server` clean; `RESERVE001` rule active and not triggering on baseline code.
4. `mcp-server/dist/skills.bundle.json` rebuilt with new `manifestSha256`.
5. `CHANGELOG.md` carries a `[3.11.0]` entry; `mcp-server/package.json` and `.claude-plugin/plugin.json` both at `3.11.0`.
6. A swarm test: spawn 3 panes, hand each a docs-only bead, confirm `flywheel_advance_wave` enforces attestation presence in `FW_ATTESTATION_REQUIRED=1` mode but warns-only otherwise.
7. `flywheel_observe` invoked from a fresh `/start` after this plan ships returns a structured envelope inside 1.5s and reports both ready beads + any missing attestations as `hints[]`.

## Provenance (per `_beads.md` Provenance block requirements)

- **Source:** 3-way duel `/dueling-idea-wizards --mode=ideas --top=5 --rounds=1`
- **Run at:** 2026-04-30T22:57:04Z (study) → 2026-04-30T23:38Z (synthesis)
- **Agents:** claude (cc, identity PinkWren), pi (BoldForge, originally IcyFinch), pi (MagentaFox)
- **Original adversarial scores driving the 3 winners:**
  - Completion Evidence Attestation: cc-on-pi1 = 760, cc-on-pi2 = 810, pi1-on-cc#1 = 900, pi1-on-pi2#2 = 890, pi2-on-cc#1 = 900, pi2-on-pi1#4 = 855 → avg 852
  - `flywheel_observe`: pi1-on-cc#2 = 845, pi2-on-cc#2 = 870, pi1-on-pi2#4 = 840 → avg 852
  - Lock-aware reservation helper: pi1-on-cc#5 = 875, pi2-on-cc#5 = 800 → avg 838
- **Surviving critiques folded in (not silently dropped):**
  - Stage attestation in two phases — PI2's reaction-phase concession that day-one server-side execution is the wrong implementation order.
  - Hard "no second doctor" rule on `flywheel_observe` — universal three-agent agreement.
  - `RESERVE001` lint rule paired with helper — PI2's reveal-phase critique that "the helper alone won't cover all real usage unless paired with linting."
  - Phased enforcement (`needsEvidence: true` → hard block) — PI2's reveal-phase concession that "the first release can warn/nudge instead of hard-blocking."
- **Steelmanned during reveal:** none of these three winners was contested enough to warrant a Phase 6.75 steelman; the contested ideas (Skill Contract Workbench, NTM Lane Planner) are explicitly out of this plan.
- **Full transcripts:** `WIZARD_IDEAS_*.md` (3), `WIZARD_SCORES_*.md` (3), `WIZARD_REACTIONS_*.md` (3) in project root.

---

## Why this plan and not a richer one

The duel produced 10 ideas; this plan ships only the 3 with strong cross-model consensus. The 4 contested ideas (Skill Contract Workbench, NTM Lane Planner, Solutions Vault, Command/Skill Drift Eliminator) and 1 marginal idea (crash-aware resume) are intentionally deferred. CC's reveal-phase summary captured the right discipline: "Top slots should go to the highest-leverage interventions, not the largest ones." Each of the three winners closes a *specific documented gap*, lands in <500 LOC against existing primitives, and is *obviously* additive (no removal of existing functionality, no migration cost on users).
