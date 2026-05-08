# Outcome Grading for agent-flywheel — Design Spec

- **Status:** Draft — self-review complete, awaiting operator review
- **Date:** 2026-05-08
- **Authors:** Brainstorm session (operator + Claude)
- **Inspired by:** [Anthropic Managed Agents — Define outcomes](https://docs.anthropic.com/en/docs/managed-agents/outcomes)
- **Target version:** agent-flywheel v3.13.0 (or later)

## Summary

Borrow the Managed Agents API's rubric + decorrelated grader + iteration loop pattern locally — without adopting the MA API itself. Synthesize a cycle-level rubric at plan-approve, grade the outcome with a decorrelated agent (codex primary, fresh CC fallback) at wrap-up, surface verdict via `AskUserQuestion` with a 3-iteration cap.

The flywheel already has analogues for everything *except* a structured per-criterion verdict from a strictly-decorrelated grader. This spec ships exactly that, complementing (not replacing) `flywheel_verify_beads`, `flywheel_advance_wave`, `flywheel_convergence`, and `flywheel_review`.

## Goals

- **G1.** Add a cycle-level `rubric.md` artifact authored at plan-approve time, optionally edited by the operator before bead creation.
- **G2.** Grade the cycle outcome with a model strictly decorrelated from the impl swarm — codex primary, fresh-context CC fallback. Never reuse the impl session.
- **G3.** Return a structured per-criterion verdict (met / unmet / partial + evidence + gaps) the iteration loop can act on.
- **G4.** Cap auto-iteration at 3 by default (matches MA's `max_iterations` default), surface verdict via `AskUserQuestion` per UNIVERSAL RULE 1.
- **G5.** Persist iteration history to disk under `.pi-flywheel/plans/<slug>/grading/iteration-<N>.json`.
- **G6.** Wire it through `skills/start/_planning.md` Step 5.6 and `skills/start/_wrapup.md` Step 9.5.

## Non-goals

- Adopting the Managed Agents API as a runtime substrate (deferred — concepts-only per Brainstorm Q1).
- Per-bead or per-wave rubrics (deferred — whole-cycle only per Brainstorm Q2).
- Files API equivalent for artifact upload (git is the artifact store).
- Streaming verdict events (single-shot is sufficient).
- Replacing or duplicating the existing `flywheel_review`, `flywheel_verify_beads`, `flywheel_advance_wave`, or `flywheel_convergence` tools — they continue unchanged.

## Existing flywheel ↔ MA API analogues (reference)

| Managed Agents API | Flywheel today | After this spec |
|---|---|---|
| `define_outcome.description` | `flywheel_select(goal)` | unchanged |
| `define_outcome.rubric` | (no analogue at cycle scope) | **`.pi-flywheel/plans/<slug>/rubric.md`** |
| `max_iterations` | `state.maxReviewPasses`, `polishRound`, `retryCount` | **`state.maxOutcomeIterations` (default 3, bounded [1,5])** |
| `outcome_evaluation_end.result` | `flywheel_convergence.status` (50/75/90 ladder); `flywheel_verify_beads.outcome` (verified/autoClosed/...); `flywheel_advance_wave.outcome` | **`GraderVerdict.status` ∈ {satisfied, needs_revision, max_iterations_reached, failed}** |
| Hosted grader, separate context | local subagent reviewer personas in `flywheel_review` (same context family) | **codex `exec` (different vendor) primary, fresh-context CC fallback** |
| `/mnt/session/outputs/` + Files API | git commits + `.pi-flywheel/completion/<beadId>.json` | unchanged — grader reads commit range + diff directly |
| `span.outcome_evaluation_*` event stream | (none) | (out of scope — single-shot grader) |

## Architecture

### New module: `mcp-server/src/outcome-grading.ts`

Exports:

```ts
export const RUBRIC_VERSION = 1;
export const VERDICT_VERSION = 1;

export const RubricSchemaV1 = z.object({
  version: z.literal(1),
  source: z.enum(['auto', 'user', 'edited']),
  generatedAt: z.string().datetime(),
  planSlug: z.string(),
  goal: z.string(),
  criteria: z.array(z.object({
    id: z.string().regex(/^c\d+$/),       // c1, c2, ...
    description: z.string().min(10),
    weight: z.number().min(0).max(1).optional(),
    evidenceHint: z.string().optional(),  // "Look in mcp-server/src/foo.ts"
  })).min(3).max(15),
});
export type Rubric = z.infer<typeof RubricSchemaV1>;

export const PerCriterionVerdictSchema = z.object({
  criterionId: z.string(),
  status: z.enum(['met', 'unmet', 'partial']),
  evidence: z.string(),                   // commit shas, file paths, quoted code
  gaps: z.array(z.string()),              // empty if met; non-empty if unmet/partial
});

export const GraderVerdictSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['satisfied', 'needs_revision', 'max_iterations_reached', 'failed']),
  iteration: z.number().int().min(1),
  perCriterion: z.array(PerCriterionVerdictSchema),
  explanation: z.string(),
  modelUsed: z.enum(['codex', 'claude']),
  durationMs: z.number().int().min(0),
  timestamp: z.string().datetime(),
});
export type GraderVerdict = z.infer<typeof GraderVerdictSchemaV1>;

export interface SynthesizeRubricArgs {
  cwd: string;
  planSlug: string;
  planPath: string;
}

export interface GradeOutcomeArgs {
  cwd: string;
  planSlug: string;
  artifactRefs: {
    commitRangeStart: string;             // sha at cycle start (state.cycleStartSha)
    commitRangeEnd: string;               // 'HEAD'
    modifiedFilePaths?: string[];         // optional cap on what grader sees
  };
}

export async function synthesizeRubric(
  ctx: ToolContext,
  args: SynthesizeRubricArgs,
): Promise<{ rubricPath: string; rubric: Rubric }>;

export async function gradeOutcome(
  ctx: ToolContext,
  args: GradeOutcomeArgs,
): Promise<GraderVerdict>;
```

### File layout

```
.pi-flywheel/plans/<slug>/
├── convergence.json          # existing (flywheel_convergence)
├── rubric.md                 # NEW — markdown body + frontmatter for Zod parse
└── grading/                  # NEW
    ├── iteration-1.json      # GraderVerdictSchemaV1
    ├── iteration-2.json
    └── iteration-3.json
```

`rubric.md` format:

```markdown
---
version: 1
source: auto
generatedAt: 2026-05-08T12:30:00Z
planSlug: 2026-05-08-outcome-grading
goal: Integrate outcome grading concept from Managed Agents API
criteria:
  - id: c1
    description: outcome-grading.ts module exists with RubricSchemaV1 + GraderVerdictSchemaV1 Zod schemas
    weight: 0.2
    evidenceHint: mcp-server/src/outcome-grading.ts
  - id: c2
    description: flywheel_synthesize_rubric MCP tool registered in server.ts and writes .pi-flywheel/plans/<slug>/rubric.md
    weight: 0.2
  - id: c3
    description: flywheel_grade_outcome MCP tool spawns codex (or fresh CC) and returns GraderVerdictSchemaV1-shaped JSON
    weight: 0.2
  - id: c4
    description: skills/start/_planning.md Step 5.6 and _wrapup.md Step 9.5 invoke the new tools
    weight: 0.15
  - id: c5
    description: Doctor outcome_rubric_validity check parses rubric.md when active plan slug exists
    weight: 0.15
  - id: c6
    description: Tests cover schema round-trips, real plan synthesis, fake artifact grading
    weight: 0.10
---

# Outcome Rubric — Integrate outcome grading concept from Managed Agents API

(Auto-generated 2026-05-08T12:30:00Z. Edit freely; the frontmatter is the source of truth.)

## c1 — outcome-grading.ts module
The new module mcp-server/src/outcome-grading.ts must export RubricSchemaV1 and GraderVerdictSchemaV1 (Zod), plus synthesizeRubric and gradeOutcome async functions, with all types exported.

## c2 — flywheel_synthesize_rubric tool
...
```

The frontmatter is the canonical Zod-parseable record. The body is human-readable expansion. `synthesizeRubric()` writes both; the grader reads only the frontmatter.

### New MCP tools (2)

#### `flywheel_synthesize_rubric`

- **When:** called from `skills/start/_planning.md` Step 5.6 (after the plan-ready gate fires).
- **Inputs:** `{ cwd, planSlug?, planPath? }` — at least one of slug/path required; if both omitted, use `state.planDocumentPath` and derive slug.
- **Behavior:**
  1. Read the plan markdown.
  2. Spawn synthesizer subagent via the existing `Agent()` tool (uses **same** model as orchestrator — synth is a low-stakes reading task; decorrelation matters at grade time, not synth time) with prompt: "Read this plan and produce a rubric of 5–10 criteria. Each criterion must be (a) testable, (b) directly attributable to a file or behavior change, (c) <140 chars in description. Output ONLY YAML frontmatter matching this Zod schema: {schema dump}." The synthesizer agent is given Read tool access scoped to the plan path + repo root.
  3. Parse output, validate against `RubricSchemaV1`. On parse failure: structured error `rubric_synth_invalid` with `error.hint` = "Synthesizer returned non-conforming YAML; re-run with `force=true` or write rubric.md by hand and re-call with `source=user`."
  4. Write `.pi-flywheel/plans/<slug>/rubric.md`.
  5. Set `state.outcomeRubricPath`.
- **Returns:** `{ rubricPath, rubric, source: "auto" }`.
- **Operator gate (in `_planning.md`):** after tool returns, AskUserQuestion `[Approve / Edit inline / Regenerate / Skip rubric]`.

#### `flywheel_grade_outcome`

- **When:** called from `skills/start/_wrapup.md` Step 9.5 start.
- **Inputs:** `{ cwd, planSlug?, force?: boolean }`. Slug derived from `state.outcomeRubricPath` if omitted.
- **Behavior:**
  1. Load rubric from `state.outcomeRubricPath`. If `state.outcomeGradingSkipped === true`, short-circuit and return sentinel `{ status: 'skipped', reason: 'operator-skipped-at-plan-approve' }`. If unset and `state.outcomeRubricPath` is missing: structured error `rubric_missing` with hint "Run `flywheel_synthesize_rubric` first, or pick Skip rubric at the plan-approve gate."
  2. Compute artifact range: `commitRangeStart = state.cycleStartSha` (NEW state field, captured at `flywheel_select` time), `commitRangeEnd = 'HEAD'`.
  3. Build grader prompt with: rubric frontmatter, `git log <range> --oneline`, `git diff <range> --stat`, list of modified file paths (capped at 50, sorted by lines-changed desc), AND the full unified diff if total diff is <30K chars (truncate with marker if larger). The grader does NOT get tool access — everything it needs is in the prompt. This keeps the verdict deterministic and the boundary clean.
  4. Pick grader: doctor's `codex_cli` green → spawn `codex exec --model gpt-5.5 --json` (override available via `FW_GRADER_MODEL` env). Otherwise → spawn fresh `Agent()` subagent with explicit "you have not seen the impl conversation" preamble. Record `modelUsed` in verdict.
  5. Run grader with timeout `FW_GRADER_TIMEOUT_MS` (default 120000). On timeout: structured error `grader_timeout`.
  6. Parse grader stdout as JSON, validate against `GraderVerdictSchemaV1`. Set `iteration` to `state.outcomeGradingHistory.length + 1`. On parse failure: structured error `verdict_invalid` (one auto-retry with re-prompt before giving up).
  7. Write `.pi-flywheel/plans/<slug>/grading/iteration-<N>.json`.
  8. Append to `state.outcomeGradingHistory`.
  9. Apply max-iterations gate: if `iteration >= state.maxOutcomeIterations` and verdict is `needs_revision`, force-coerce `verdict.status` to `max_iterations_reached`.
- **Returns:** the `GraderVerdict`.

### State changes

```ts
// mcp-server/src/session-state.ts (or state.ts) — additive
state.outcomeRubricPath?: string;
state.outcomeGradingSkipped?: boolean;     // operator picked Skip at plan-approve
state.outcomeGradingHistory?: Array<{
  iteration: number;
  verdict: GraderVerdict;
  timestamp: string;
}>;
state.maxOutcomeIterations: number;        // default 3, bounded [1, 5]
state.cycleStartSha?: string;              // captured at flywheel_select; used as commitRangeStart
state.cycleEndTestOutput?: string;         // captured by _wrapup.md test-runner hook; passed to grader
```

All fields optional/additive; existing checkpoints continue to load. Schema bump unnecessary at this stage (per `completion-report.ts` "version: 1 additive forever" pattern).

### Iteration loop wiring (Step 9.5 in `_wrapup.md`)

Before commit review:

1. Call `flywheel_grade_outcome`.
2. Branch on `verdict.status`:
   - `satisfied` → continue Step 9.5 normally (commit review, docs, version bump).
   - `needs_revision` AND `iteration < maxOutcomeIterations` → AskUserQuestion:
     ```
     Options: [
       Iterate (Recommended) — auto-create remediation beads from verdict.perCriterion[*].gaps and route back to Step 6,
       Accept anyway — continue Step 9.5 despite failing criteria,
       Abort — stop the cycle, no commit review or wrap-up
     ]
     ```
   - `max_iterations_reached` → force-surface (no Iterate option):
     ```
     Options: [
       Accept anyway,
       Abort
     ]
     ```
   - `failed` → Abort with `verdict.explanation` printed; suggest editing rubric.md.

When user picks Iterate: parse `verdict.perCriterion.filter(c => c.status !== 'met').flatMap(c => c.gaps)` into a list of remediation tasks, prefix each with the criterion ID, and feed into `flywheel_approve_beads(action: "remediate")` (existing surface; adds `state.iterationRound++`).

### Decorrelation enforcement

| Layer | Mechanism |
|---|---|
| Process boundary | grader runs as a separate process (`codex exec` or `Agent()` subagent), never inline in the impl conversation |
| Model boundary | codex (different vendor + family) primary; fresh CC subagent fallback. Never reuse the impl session's CC instance |
| Context boundary | grader prompt contains ONLY rubric frontmatter + git artifacts + explicit "you have not seen the impl chatter" preamble |
| Doctor gate | `codex_config_compat` check (already exists) flags codex misconfig before grader runs |

`FW_GRADER_MODEL` env var override allows operators to force a specific model (e.g. `claude-3-5-sonnet`, `gpt-5.5`); doctor will accept any string but warn if the corresponding CLI is missing.

### Doctor: new check

`outcome_rubric_validity`:
- When `state.outcomeRubricPath` is set: parse `rubric.md` frontmatter; validate against `RubricSchemaV1`.
- Severity: `green` if parses, `yellow` if file missing or malformed, `red` only if frontmatter parses but criteria array is empty.
- `hint` on yellow/red: "Re-run `flywheel_synthesize_rubric` with `force=true`, or edit `.pi-flywheel/plans/<slug>/rubric.md` by hand."

### Welcome banner (Step 0c in `start/SKILL.md`)

Append to banner when active plan + rubric exist:

```
 Rubric: 6 criteria
 Last grade: needs_revision @ iter 1 (3 unmet)
```

If no grading history yet: omit `Last grade`. If no rubric: omit both lines (no behavior change).

### Telemetry

Per-cycle entry to CASS via `flywheel_memory(operation: "save", type: "session-learning")`:

```
Cycle for goal '<goal>' graded <status> after <N> iterations.
Unmet criteria: <list of criterionId + description>.
Decorrelation: <modelUsed>.
```

This builds a corpus of "what gets graded as needs_revision most often" — feeds back into rubric synthesis quality (future iteration).

## File-level changes

### New files

- `mcp-server/src/outcome-grading.ts` (~400 LOC, schemas + synth + grade + helpers)
- `mcp-server/src/tools/synthesize-rubric.ts` (~80 LOC, MCP tool wrapper)
- `mcp-server/src/tools/grade-outcome.ts` (~120 LOC, MCP tool wrapper)
- `mcp-server/src/__tests__/outcome-grading.test.ts` (~250 LOC)
- `mcp-server/src/__tests__/synthesize-rubric.test.ts`
- `mcp-server/src/__tests__/grade-outcome.test.ts`
- `docs/superpowers/specs/2026-05-08-outcome-grading-design.md` (this file)

### Modified files

- `mcp-server/src/server.ts` — register the 2 new MCP tools
- `mcp-server/src/session-state.ts` (or `state.ts`) — additive state fields
- `mcp-server/src/errors.ts` — new structured error codes: `rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`
- `mcp-server/src/tools/doctor.ts` — add `outcome_rubric_validity` check
- `skills/start/SKILL.md` — Step 0c banner extension (rubric + last-grade line)
- `skills/start/_planning.md` — Step 5.6 routing: call `flywheel_synthesize_rubric` after plan-ready gate, surface Approve/Edit/Regenerate/Skip
- `skills/start/_wrapup.md` — Step 9.5 routing: call `flywheel_grade_outcome` before commit review, branch on verdict
- `AGENTS.md` — new "Outcome Grading" section under Phase 12 or its own phase
- `CHANGELOG.md` — entry for the version that ships this
- `mcp-server/package.json` — version bump (additive, no breaking changes)

## Testing strategy

### Unit
- `outcome-grading.test.ts` — schema round-trip (parse → stringify → parse, equal); rubric YAML frontmatter generation; verdict JSON parse with all 4 status values; gap extraction.
- `synthesize-rubric.test.ts` — feed a fixture plan (`docs/plans/<existing>.md`), assert criteria extracted are non-trivial; round-trip persistence.
- `grade-outcome.test.ts` — with mocked grader stdout, assert verdict written to disk + state appended; iteration cap coercion (`needs_revision` → `max_iterations_reached` at iter 3); error paths (timeout, invalid JSON, missing rubric).

### Integration
- Doctor check round-trip (write rubric → run doctor → assert green; corrupt rubric → assert yellow).
- End-to-end: planning step writes rubric, wrap-up step grades, AskUserQuestion routing branches correctly. Run via existing `mcp-server` test harness.

### Out of scope for v1
- Live codex grader test (would require real `codex_cli` in CI). Mocked process spawn is sufficient.
- Cross-cycle correlation between `verdict.status` and `flywheel_convergence.score` (interesting but not load-bearing).

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Synthesizer produces vague criteria | medium | Hard schema constraints (description ≥10 chars; ≥3 criteria); operator gate (Approve/Edit/Regenerate); negative examples in synthesizer prompt |
| Grader returns non-JSON output | medium | Structured `verdict_invalid` error with one auto-retry; `--json` flag where supported; explicit "JSON only, no prose" preamble |
| Codex unavailable, fallback fresh-CC has weak decorrelation | low | Doctor `codex_cli` is green for most users; fresh-CC subagent still has empty-context guarantee; document weakness in AGENTS.md |
| Iteration loop infinite | very low | Hard cap at `state.maxOutcomeIterations` (default 3, max 5); `state` persistence ensures iteration count survives crashes |
| `cycleStartSha` not captured (existing sessions) | medium | If missing, use the checkpoint's `gitHead` as fallback; if both missing, default to `HEAD~50` and log warning |
| Operator skips rubric every cycle | medium | Add CASS learning: "Operator skipped rubric on N consecutive cycles — consider revisiting `flywheel_synthesize_rubric` prompt quality" |
| Conflicts with `flywheel_review` | low | Different role: review = bead-level reviewer suggestions, grade = cycle-level pass/fail. Document the distinction in AGENTS.md |

## Success criteria (rubric for the implementation cycle)

1. **outcome-grading.ts module ships** — exports `RubricSchemaV1`, `GraderVerdictSchemaV1`, `synthesizeRubric`, `gradeOutcome`. All Zod-parseable. Tests cover schema round-trips.
2. **2 MCP tools registered** — `flywheel_synthesize_rubric` and `flywheel_grade_outcome` listed in `flywheel_doctor`'s server tool inventory; both return `version: 1` envelopes.
3. **Decorrelation enforced** — grader process is provably separate from impl session; `verdict.modelUsed` records which model graded; codex used when doctor green, fresh-CC fallback otherwise.
4. **Iteration loop respected** — at iter 3 with `needs_revision`, status auto-coerces to `max_iterations_reached`; AskUserQuestion drops Iterate option.
5. **Persistence works** — rubric.md + grading/iteration-N.json present on disk after a real cycle; reload-from-checkpoint works.
6. **Skill wiring fires** — `_planning.md` Step 5.6 surfaces Approve/Edit/Regenerate/Skip; `_wrapup.md` Step 9.5 surfaces Iterate/Accept anyway/Abort.
7. **Doctor check works** — green when rubric parses, yellow when malformed, red when criteria empty.
8. **Docs land** — AGENTS.md "Outcome Grading" section + CHANGELOG entry + this spec committed.
9. **Existing tests still pass** — no regressions in `flywheel_review`, `flywheel_verify_beads`, `flywheel_advance_wave`, `flywheel_convergence`, `flywheel_doctor`.

## Resolved decisions (formerly open questions)

- **R1.** Rubric criterion limits: **min 3, max 15** (Zod-enforced). Adjust in a follow-up if synthesizer routinely produces outside this range.
- **R2.** "Skip rubric" at plan-approve: sets `state.outcomeRubricPath = undefined` and `state.outcomeGradingSkipped = true`. `flywheel_grade_outcome` short-circuits at wrap-up with status `skipped` (not a verdict — a sentinel return). Documented in `_wrapup.md`.
- **R3.** Grader sees test output: **YES, in v1**. `artifactRefs.testOutput?: string` field added — captured at cycle end via the existing test-runner hook in `_wrapup.md`. Truncated at 10K chars if larger.
- **R4.** Cross-cycle telemetry (status distribution over last 10 cycles in `flywheel_doctor`): **deferred to a follow-up cycle**. v1 ships per-cycle CASS entries only.

## Open questions (genuinely undecided — flag at plan-review)

- **OQ-A.** Where does `cycleStartSha` get captured? `flywheel_select` is the obvious slot, but `flywheel_plan` registration is later and arguably more "this is when work starts." Pick one in the plan.
- **OQ-B.** Should `Skip rubric` at the plan-approve operator gate be a one-cycle decision (next cycle re-prompts) or sticky (records preference in CASS)? Default to one-cycle; revisit after telemetry.

## References

- Anthropic Managed Agents — Define outcomes (user-pasted doc, 2026-05-08)
- `mcp-server/src/convergence.ts` — existing scoring pattern (50/75/90 ladder)
- `mcp-server/src/completion-report.ts` — existing version-1-additive Zod evidence pattern
- `mcp-server/src/refresh-learnings.ts` — existing 5-vector overlap rubric pattern (CE port)
- `mcp-server/src/ideation-funnel.ts:214` — existing 5-axis ideation rubric (useful, pragmatic, accretive, robust, ergonomic)
- `docs/plans/2026-04-18-structured-error-contracts-synthesized.md` §6 — existing hint quality rubric with negative examples
- `skills/start/_planning.md` Step 5.6 — plan-ready gate (where synthesize hooks in)
- `skills/start/_wrapup.md` Step 9.5 — wrap-up phase (where grade hooks in)
