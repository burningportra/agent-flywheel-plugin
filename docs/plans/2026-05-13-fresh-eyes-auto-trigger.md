# Plan: Auto-trigger fresh-eyes reviews on commit-batch accumulation

**Date:** 2026-05-13
**Goal:** During implementation, automatically dispatch fresh-eyes review subagents when accumulated commits since the last review cross a configurable threshold. The claude orchestrator (coordinator) tracks the counter and dispatches; review subagents return verdicts; the orchestrator decides whether to surface findings, requeue work, or continue waves.
**Source:** user-typed goal at `/agent-flywheel:start` → "Set a goal" (2026-05-13). Research grounded by `Agent(Explore)` pass over `gates.ts`, `_implement.md`, `types.ts`, `checkpoint.ts`, `outcome-grading.ts`.

---

## Why now

Today's fresh-eyes review (defined in [gates.ts:128–138](mcp-server/src/gates.ts:128)) only fires once — as the first auto-gate in `runGuidedGates()`, which runs AFTER all beads in a wave close. For long wave runs (12+ beads, 60+ commits), the review reads a wall of artifacts at once. Two failure modes follow:

1. **Late discovery.** Bugs in early beads compound through later beads before any reviewer reads the diff. Reverts cascade.
2. **Reviewer overwhelm.** A single fresh-eyes pass over 60+ changed files is shallower than 6 passes over 10 files each. Context window limits + attention drop.

A mid-wave trigger keyed off commit accumulation lets reviewers catch issues while the diff is still local and the implementor pane is still alive (NTM `--robot-send` cycle).

## Non-goals

- **NOT** replacing the post-wave `runGuidedGates()` flow — that gate stays, this is additive.
- **NOT** counting commits per individual bead — granularity is the *batch* (N commits since last review), not bead-scoped.
- **NOT** auto-committing on behalf of impl agents — agents commit per their existing pattern; we just observe the SHA stream.
- **NOT** introducing a separate orchestrator pane — the coordinator (existing claude session) IS the dispatcher; subagents (`Agent` tool, `subagent_type` matching the cc lane) do the actual reading.
- **NOT** changing the fresh-eyes prompt body — `gates.ts` already has a battle-tested prompt (lines 128–138). We reuse it.

## Approach (high-level)

1. **State counter.** Extend `FlywheelState` with three optional fields: `commitBatchCounter`, `commitBatchThreshold` (default 8), `lastBatchReviewSha`. Persist via existing `checkpoint.ts` atomic write.

2. **Commit-batch polling.** Add a helper `countCommitsSinceLastBatchReview(cwd, lastBatchReviewSha)` that runs `git rev-list --count <sha>..HEAD`. Called from two places: (a) coordinator's ScheduleWakeup loop tick, (b) `flywheel_advance_wave` after wave closes.

3. **Threshold check.** When the count ≥ `commitBatchThreshold`, the coordinator dispatches a fresh-eyes review:
   - **Primary path:** NTM `--robot-send` to the original implementor pane (re-uses existing `gates.ts` dispatch — already battle-tested). Subagent runs in the pane, returns verdict via Agent Mail.
   - **Fallback path:** when NTM is unavailable or panes are gone, spawn an `Agent(subagent_type="general-purpose")` directly. Returns verdict inline.

4. **Verdict handling.** The review subagent writes its verdict to `.pi-flywheel/batch-reviews/<sha-range>.json` (new directory). The verdict shape contains a top-level `status: "pass" | "needs_attention" | "blocking"` plus a `findings: Finding[]` array where each `Finding = { severity, summary, suggested_bead_title, affected_files, evidence_excerpt }`. The coordinator reads it on the next tick:

   - **`pass`** → reset counter + advance `lastBatchReviewSha = HEAD`. No user prompt.
   - **`needs_attention`** → surface findings via `AskUserQuestion` (Continue anyway / Synthesize beads / Pause to fix / Regress to plan).
   - **`blocking`** → call `synthesizeBeadsFromFindings(state, findings)` automatically: for **every** finding (all severities — `low`, `medium`, `high`, `critical`), run `br create --title "<suggested_bead_title>" --description "<summary>\n\nFound during batch review (sha range <range>).\n\nSeverity: <severity>\n\nEvidence:\n<evidence_excerpt>". The created bead IDs are tracked in `state.batchReviewSynthesizedBeads` (a record keyed by review sha-range → bead-IDs); the severity tag is preserved in the bead description so downstream tooling can prioritize. Then surface `AskUserQuestion` (Approve all / Approve subset / Reject all / Regress to plan) so the user retains the final approval gate. **Approve all** merges every new bead into the active wave; **Approve subset** drops into a second `AskUserQuestion` listing beads by severity (or a typed list of IDs in Other) so the user can keep the high-signal ones and reject the rest; **Reject all** deletes them via `br delete <id>` (with `br update --status closed --reason "rejected via batch-review approve/reject gate"` fallback when delete errors).

5. **Configuration.** `commitBatchThreshold` is settable via env (`FW_COMMIT_BATCH_THRESHOLD`) or per-session via the implementation-phase Pre-flight `AskUserQuestion`. Default is 8 commits — large enough to avoid noise on per-bead micro-commits, small enough to bound reviewer scope.

## Architecture

```
┌─ Impl agents (NTM panes) ──────────────────────────────────┐
│  cc pane #1 ──┐                                             │
│  cod pane #2 ─┼──> per-bead commits ──> git HEAD advances   │
│  cc pane #3 ──┘                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (every ScheduleWakeup tick / 270s)
┌─ Coordinator (claude orchestrator) ────────────────────────┐
│  1. countCommitsSinceLastBatchReview() → N                  │
│  2. if N >= threshold:                                      │
│       a. capture HEAD as reviewSha                          │
│       b. dispatch fresh-eyes review (NTM or Agent)          │
│       c. wait for verdict (poll batch-reviews/ on next tick)│
│       d. surface findings, reset counter, advance baseline  │
│  3. else: continue wave dispatch as normal                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (on threshold crossing)
┌─ Review subagent (cc) ─────────────────────────────────────┐
│  - reads diff: git log --oneline lastSha..reviewSha         │
│  - reads changed files                                      │
│  - applies the 4-question prompt from gates.ts:128–138      │
│  - writes verdict JSON to .pi-flywheel/batch-reviews/       │
└─────────────────────────────────────────────────────────────┘
```

## File-level changes

| File | Change | Lines (approx) |
|------|--------|---------------|
| `mcp-server/src/types.ts` | Add `commitBatchCounter?`, `commitBatchThreshold?`, `lastBatchReviewSha?`, `batchReviewSynthesizedBeads?: Record<string, string[]>` to `FlywheelState`. Add `BatchReviewVerdict`, `Finding`, `SeveritySchema` interfaces. | +35 |
| `mcp-server/src/commit-batch.ts` (NEW) | Export `countCommitsSinceLastBatchReview(cwd, sha)`, `shouldTriggerBatchReview(state)`, `recordBatchReview(state, sha, verdict)`, `synthesizeBeadsFromFindings(cwd, state, findings)` (calls `br create` via `execFile`; returns the new bead IDs), `rollbackSynthesizedBeads(cwd, beadIds)` (calls `br delete` for each, used when the operator rejects). Pure-ish; only FS writes are verdict path + br DB. | +220 |
| `mcp-server/src/tools/advance-wave.ts` | Hook into existing post-wave-verify flow: call `shouldTriggerBatchReview` before returning `nextWave`. If true, return a new `nextStep` kind `batch_review_due` instead of `nextWave`. | +35 |
| `mcp-server/src/tools/review.ts` | New action `action: "batch_review"` accepts a sha range, dispatches the gate prompt, persists verdict. **Auto-bead-synthesis branch:** when verdict.status === "blocking", call `synthesizeBeadsFromFindings` and return `nextStep` kind `synthesized_beads_pending` with the bead IDs + finding-to-bead mapping so the coordinator can surface the approve/reject gate without re-running synthesis. Reuses `runGuidedGates`'s memoryContext loader. | +110 |
| `mcp-server/src/gates.ts` | Extract the fresh-eyes prompt body (lines 128–138) into an exported function `buildFreshEyesPrompt(allArtifacts, opts)` so both `runGuidedGates` and the new batch-review action call it without duplication. **Extend the prompt:** instruct the review subagent to emit findings in the structured `Finding[]` shape (severity ∈ low/medium/high/critical, suggested_bead_title, affected_files, evidence_excerpt) so auto-synthesis has a contract to consume. | +35, -8 |
| `mcp-server/src/checkpoint.ts` | No schema-version bump (new fields are optional); existing reader/writer handles them. Add a migration guard that defaults `commitBatchThreshold` to 8 on read if checkpoint predates v3.17. | +10 |
| `skills/start/_implement.md` | Pre-flight: add an `AskUserQuestion` for `commitBatchThreshold` (Off / 5 / 8 / 12). Step 7.5: document the batch-review interrupt path, the `synthesized_beads_pending` `nextStep` handling, and the approve/reject `AskUserQuestion` template. Document rollback semantics (reject → `br delete`). | +90 |
| `mcp-server/src/__tests__/commit-batch.test.ts` (NEW) | Unit tests for the five pure-ish functions. Fixture: a checkpoint state + a fake git-log-count mock + a fake `br create`/`br delete` exec mock. Tests cover happy path, br create failure mid-batch (partial rollback), reject path (all created beads deleted), state-record bookkeeping. | +320 |
| `mcp-server/src/__tests__/tools/advance-wave.test.ts` | Add a case where threshold-crossing returns `batch_review_due`. | +40 |
| `mcp-server/src/__tests__/tools/review.test.ts` | Add cases for: `batch_review` action returning `synthesized_beads_pending` on blocking verdict; `pass` verdict returning no synthesis; review subagent emitting malformed Finding[] (validation rejects + falls back to surface-to-user mode). | +120 |
| `AGENTS.md` | Document `FW_COMMIT_BATCH_THRESHOLD` env var alongside `FW_GRADER_MODEL`. Document `state.batchReviewSynthesizedBeads` field for downstream tooling. | +12 |
| `CHANGELOG.md` | Entry for v3.17.0 (target). | +30 |

## Dependency graph

```
T1 (types + interfaces, incl. Finding[] schema)
   │
   ├──> T2 (commit-batch.ts: 3 pure helpers + synthesize/rollback)
   │       │
   │       ├──> T3 (advance-wave hook)
   │       │       │
   │       │       └──> T6 (advance-wave test)
   │       │
   │       └──> T4 (review.ts batch_review action + synthesized_beads_pending)
   │               │
   │               ├──> T5 (gates.ts extract buildFreshEyesPrompt + Finding[] contract)
   │               │
   │               └──> T11 (review.ts test cases — synthesized + malformed Finding[])
   │
   └──> T7 (commit-batch unit tests, incl. partial-rollback)

T8 (_implement.md docs, incl. approve/reject gate)  depends on T3, T4
T9 (AGENTS.md env var + state field docs)            depends on T2
T10 (CHANGELOG.md)                                    depends on T1..T9, T11
```

| Task | Depends on |
|------|------------|
| T1 — types + interfaces (`types.ts`), incl. `Finding`, `BatchReviewVerdict`, `batchReviewSynthesizedBeads` | [] |
| T2 — `commit-batch.ts` (count, shouldTrigger, recordReview, synthesizeBeadsFromFindings, rollbackSynthesizedBeads) | [T1] |
| T3 — `advance-wave.ts` hook returning `batch_review_due` | [T2] |
| T4 — `review.ts` `batch_review` action + `synthesized_beads_pending` `nextStep` on blocking | [T2, T5] |
| T5 — `gates.ts` extract `buildFreshEyesPrompt` + extend prompt with `Finding[]` contract | [] (parallel to T1) |
| T6 — `advance-wave.test.ts` regression + threshold-crossing case | [T3] |
| T7 — `commit-batch.test.ts` unit tests (incl. partial-rollback) | [T2] |
| T8 — `_implement.md` Pre-flight + Step 7.5 + approve/reject gate + rollback docs | [T3, T4] |
| T9 — `AGENTS.md` env var + state field docs | [T2] |
| T10 — `CHANGELOG.md` entry | [T1, T2, T3, T4, T5, T6, T7, T8, T9, T11] |
| T11 — `review.test.ts` cases for synthesized + malformed Finding[] | [T4] |

Parallelizable batches: `{T1, T5}` → `{T2}` → `{T3, T4, T7}` → `{T6, T8, T9, T11}` → `{T10}`.

## Risks + mitigations

1. **Commit-batch threshold is wrong by default.** 8 may be too tight for big-bead waves or too loose for micro-bead waves.
   *Mitigation:* surface as Pre-flight `AskUserQuestion`. Allow override via env. CASS learning entry on first-run.

2. **Review subagent fails silently.** Spawned Agent errors, NTM pane crashes — coordinator hangs waiting for verdict.
   *Mitigation:* 10-min verdict timeout; on timeout, record `verdict: "review_timeout"` and resume waves (don't block on a dead reviewer).

3. **Race between impl commits and review baseline.** Implementors keep committing while the review runs; the next batch could trigger before review verdict lands.
   *Mitigation:* set `lastBatchReviewSha` to the *snapshot* sha (when dispatch fires), not to HEAD after verdict. Counter resets the moment dispatch starts.

4. **Verdict storage grows unbounded.** `.pi-flywheel/batch-reviews/` accumulates JSON files indefinitely.
   *Mitigation:* keep last 20; older files moved to `batch-reviews/archive/` on next flywheel cycle start.

5. **NTM-misconfigured projects degrade silently.** Coordinator tries NTM dispatch, fails, falls back to Agent — but the user doesn't see why.
   *Mitigation:* log dispatch path to `tender-events.log` with `kind: "batch_review_dispatch"`. Surface in next-tick log tail.

6. **Auto-synthesized beads pollute the graph on rejection.** Reviewer emits 8 high-severity findings → 8 beads land in `br list` → user rejects all → 8 dangling closed beads remain unless explicitly cleaned.
   *Mitigation:* synthesize creates beads in **status `open` with label `auto-batch-review`**; rollback runs `br delete <id>` only for IDs in `state.batchReviewSynthesizedBeads[range]`. If `br delete` fails (e.g. bead already touched), fall back to `br update --status closed --reason "rejected via batch-review approve/reject gate"` so the graph reflects intent. Pre-Step-7-resume scan emits a doctor-yellow row if any `auto-batch-review` beads are open AND `state.batchReviewSynthesizedBeads` has no record of them (orphaned).

7. **Malformed Finding[] from review subagent.** Subagent doesn't follow the structured contract (returns prose, missing severity fields, etc.).
   *Mitigation:* `synthesizeBeadsFromFindings` validates with a Zod schema (`SeveritySchema = z.enum(["low","medium","high","critical"])`, `FindingSchema = z.object({severity, summary, suggested_bead_title, affected_files, evidence_excerpt})`). Validation failure → fall back to `needs_attention` mode (surface raw verdict text to user) and log a CASS note so we can iterate the prompt.

8. **Partial synthesis failure (`br create` succeeds for 5 of 8 findings, then errors).** Half a bead-set lives in the graph; the other half is lost.
   *Mitigation:* synthesize is **transactional in record-keeping**: the function appends bead IDs to `state.batchReviewSynthesizedBeads[range]` as each `br create` succeeds. On any failure, the caller MUST call `rollbackSynthesizedBeads(state, range)` which iterates the partial record and deletes everything created so far. Caller-side cleanup is wired in `review.ts` `batch_review` action; covered by `commit-batch.test.ts` partial-rollback case.

## Acceptance criteria

- A wave with ≥ `commitBatchThreshold` commits between waves emits exactly one `batch_review_due` `nextStep` from `flywheel_advance_wave`.
- The coordinator dispatches one review (NTM or Agent), and the verdict JSON lands in `.pi-flywheel/batch-reviews/<sha-range>.json` within 10 min.
- After the verdict, the counter resets and `lastBatchReviewSha` advances; subsequent commits accumulate from the new baseline.
- A `blocking` verdict triggers `synthesizeBeadsFromFindings`: every finding (all severities) becomes a new bead via `br create`, labeled `auto-batch-review`, with severity preserved in the bead description, recorded in `state.batchReviewSynthesizedBeads[<sha-range>]`. The coordinator surfaces a four-option `AskUserQuestion` (Approve all / Approve subset / Reject all / Regress to plan). **Approve all** merges every bead into the active wave; **Approve subset** presents a follow-up gate so the user keeps high-signal beads and rejects the rest (rejected ones go through rollback) — implemented as a multi-select `AskUserQuestion` with one option per bead (`<bead-id>: <title> [<severity>]`); when there are more than 4 beads the gate paginates through batches of 4, each batch yielding a keep/reject decision before showing the next; **Reject all** runs `rollbackSynthesizedBeads` for the full set (deletes each bead, with closed-fallback if delete fails).
- A `needs_attention` verdict surfaces the findings to the user without auto-synthesis; the user retains the Continue / Synthesize beads / Pause / Regress choice.
- Malformed Finding[] from the subagent triggers a graceful fallback to `needs_attention` mode + a CASS note logged for prompt iteration.
- Setting `FW_COMMIT_BATCH_THRESHOLD=0` (or threshold=Off in Pre-flight) disables the entire feature; existing post-wave gate flow is unchanged.
- `flywheel_advance_wave` regression test: existing behavior holds when threshold is unset OR commits < threshold.
- New unit tests in `commit-batch.test.ts` cover: counter increment, threshold crossing, verdict persistence, archive rotation, happy-path synthesize, partial-rollback on mid-batch `br create` failure, full-rollback on reject, malformed Finding[] schema rejection.

## Test plan

1. **Unit tests** (T6, T7): pure functions tested against fixture states + mock git output.
2. **Integration test** (manual, in dev worktree): set threshold=3, run a 4-bead wave, verify exactly one batch review fires.
3. **Regression test:** run the existing `_implement.md` Step 7 flow with threshold unset — no new behavior fires; existing post-wave gate fires exactly once.
4. **Failure-mode tests:**
   - Kill the review subagent mid-flight → verify 10-min timeout + resume.
   - Run with NTM uninstalled → verify Agent fallback kicks in.
   - Pre-populate `batch-reviews/` with 25 files → verify rotation keeps 20 + archives 5.

## Out of scope (deferred follow-ups)

- **Adaptive thresholds.** Adjust threshold dynamically based on diff complexity (lines changed, files touched). Defer until we have empirical data on the fixed-threshold version.
- **Cross-wave commit accumulation.** Currently each wave's commits feed one counter; we could split per-wave for finer attribution but adds state complexity.
- ~~**Review-finding → bead synthesis.**~~ **MOVED IN-SCOPE** (alignment-check round 1, 2026-05-13). See risk #6, #7, #8 and acceptance criteria for the full contract.

## Provenance

- Goal source: user typed `/agent-flywheel:start` → "Set a goal" → free-text in Other field on 2026-05-13.
- Research source: single `Agent(Explore)` pass; findings logged inline above (Sections 1–6 of research output).
- Planning mode: `standard` (single plan doc, no Deep/Duel/Triangulated).
- Phase 0.5 brainstorm: skipped (USER_INPUT > 100 chars with multi-clause framing per `_planning.md` §4.5a condition 2).

## Revision history

- **2026-05-13 (round 1):** Alignment check answered NTM-first dispatch (plan default ✓) + 8-commit threshold (plan default ✓) + **auto-bead-synthesis MOVED IN-SCOPE** (was deferred). Refinement traced through to: T2 gains `synthesizeBeadsFromFindings` + `rollbackSynthesizedBeads`; T1 gains `Finding`, `BatchReviewVerdict`, `batchReviewSynthesizedBeads` state field; T4 gains `synthesized_beads_pending` `nextStep`; T5 extends fresh-eyes prompt with `Finding[]` contract; T7 gains partial-rollback test case; new T11 covers review.ts synthesis branch + malformed Finding[] validation; new risks #6 (graph pollution), #7 (malformed schema), #8 (partial synthesis failure) with concrete mitigations; acceptance criteria extended for synthesize/approve/reject/rollback paths. Net plan growth: ~+170 LOC across 4 files vs original.
- **2026-05-13 (round 2):** Severity floor decision: **all severities synthesize**, not just high/critical (plan default was high/critical). Reject semantics confirmed (br delete + closed-fallback). Verdict trigger confirmed (blocking only). Refinement traced through to: synthesize loop drops the severity filter; severity is preserved in the bead description for downstream prioritization; the Approve/Reject gate gains an **Approve subset** option (with a follow-up sub-gate listing beads by severity) so the user can keep the high-signal ones and reject the rest in one cycle without manual `br delete` afterwards. Acceptance criteria updated to reference all severities + the four-option gate.
