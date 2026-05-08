# Outcome Grading — Robustness Perspective Implementation Plan
**Date:** 2026-05-08
**Perspective:** Robustness
**Author:** BronzeLotus (gemini-cli)

## Goal
Integrate the outcome-grading loop (rubric synthesis + decorrelated grading) into the flywheel while ensuring the system survives adversarial conditions: network blips, process crashes, malformed LLM output, context limit overflows, and racing operations. Focus on the grader fallback chain (Codex → Fresh CC) and robust artifact collection.

## Prior Session Context
*CASS search for "grader timeout retry crash recovery decorrelation fallback" yielded no direct matches (new feature set); however, existing project patterns from `mcp-server/src/` show:*
1. **Additive Schema Pattern:** All Zod schemas (`CompletionReportSchemaV1`, `ConvergenceStateSchema`) use `version: 1` and are additive-forever to survive checkpoint migrations.
2. **Exec Discipline:** Every shell command must carry a timeout and propagate an `AbortSignal`.
3. **Structured Error Hints:** Errors must include actionable hints (≤140 chars) to help the operator recover.
4. **Doctor-Gated Dispatch:** `codex_cli` and `codex_config_compat` already exist to pre-validate the preferred grader environment.

## Phased Task Breakdown

### Phase 1: Robust Grader Infrastructure
*Implement the foundational execution and recovery logic for the grader.*

- **T1.1: Grader Fallback Chain Logic**
  - Implement `spawnGrader(args)` in `outcome-grading.ts`.
  - Logic: Check `doctor.codex_cli` health. If green → spawn `codex exec`. If it fails (non-zero exit, timeout, or malformed output) OR if doctor was not green → fallback to `Agent()` (fresh CC subagent) with explicit decorrelation preamble.
  - `depends_on: []`
- **T1.2: Grader Timeout & Signal Handling**
  - Wire `FW_GRADER_TIMEOUT_MS` (default 120s).
  - Use `SIGTERM` followed by `SIGKILL` escalation for the `codex` process if it hangs.
  - Ensure `AbortSignal` from MCP call cancels the grader process immediately.
  - `depends_on: [T1.1]`
- **T1.3: JSON Recovery & Retry**
  - Implement a single auto-retry for malformed JSON from the grader.
  - Re-prompt prompt: "Your previous output was not valid JSON. Return ONLY the GraderVerdictSchemaV1 JSON object. Do not include prose."
  - `depends_on: [T1.1]`

### Phase 2: Resilient Artifact Collection
*Ensure the grader receives meaningful evidence even when cycle data is large.*

- **T2.1: Robust `cycleStartSha` Resolution**
  - Capture `cycleStartSha` during `flywheel_select`.
  - Fallback logic for existing sessions: `checkpoint.gitHead` -> `git log -n 1 --before="<checkpoint.timestamp>" --format="%H"` -> `HEAD~50` (last resort).
  - `depends_on: []`
- **T2.2: Diff & Test Output Truncation**
  - Implement unified diff truncation at 30K chars.
  - Insert marker: `[TRUNCATED: Diff exceeded 30K limit. Showing first 15K and last 15K. Full file list follows...]`.
  - Prioritize test output: `npm test` > `lint` > `typecheck` within the 10K test output budget.
  - `depends_on: []`

### Phase 3: State & Concurrency Integrity
- **T3.1: Atomic File Operations**
  - Use `writeFile` pattern (write to `.tmp` then rename) for `rubric.md` and `iteration-N.json` to prevent partial-write corruption.
  - `depends_on: []`
- **T3.2: Concurrent Operation Lock**
  - Implement an in-memory mutex (or check existing `flywheel_remediate` pattern) to prevent parallel `flywheel_grade_outcome` calls for the same plan.
  - `depends_on: []`

## Per-task Acceptance Criteria
- **T1.1:** Grader provably switches to CC if `codex` is forced to fail (e.g., via `FW_GRADER_MODEL=invalid`).
- **T1.2:** A 1ms timeout triggers `grader_timeout` error with a hint to check model latency.
- **T1.3:** If grader returns "Here is your JSON: { ... }", the retry logic extracts the JSON or re-prompts once.
- **T2.1:** `cycleStartSha` is correctly resolved even in sessions started pre-v3.13.0.
- **T2.2:** Large diffs (e.g. `package-lock.json` changes) do not overflow context or crash the tool.
- **T3.1:** Rubric files are never left in a 0-byte or half-written state.
- **T3.2:** Parallel tool calls return `concurrent_write` for the second caller.

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Grader Hallucination on Truncated Diff | High | Grader prompt explicitly notes truncation and provides the full file list + `git diff --stat` for context. |
| Context Window Overflow (Rubric + Diff + Tests) | Medium | Dynamic budget: if total prompt > limit, prioritize Rubric > Diff Stat > Diff Body (truncated) > Test Output. |
| State/Git Drift Mid-Grade | Low | Grader receives SHAs. If `HEAD` moves during the 120s grade, the verdict is pinned to the SHAs captured at tool-start. |
| Disk Full / EROFS | Low | Return verdict in-memory to the operator even if `iteration-N.json` write fails, but tag verdict with `persistence: "failed"`. |
| Weak Decorrelation in Fallback | Low | CC fallback uses a completely fresh agent session. Pre-prompt reinforces "You are a blind auditor." |
| Subprocess Zombie | Medium | SIGKILL escalation after 5s SIGTERM grace period. |
| Incompatible `codex exec` Model | Medium | Doctor check `codex_config_compat` warns; grader falls back to fresh CC automatically. |
| Grader "Prose Leakage" | Medium | Use `--json` flag for Codex; use Zod `safeParse` with regex-based JSON extraction from prose. |

## File-level Changes

| File | Change | Line Estimate |
|---|---|---|
| `mcp-server/src/outcome-grading.ts` | **New** core logic (spawn, fallback, truncate, parse). | 350 |
| `mcp-server/src/errors.ts` | Add `rubric_synth_invalid`, `rubric_missing`, `grader_timeout`, `verdict_invalid`. | 20 |
| `mcp-server/src/tools/grade-outcome.ts` | **New** tool handler with fallback chain and retry logic. | 120 |
| `mcp-server/src/tools/synthesize-rubric.ts` | **New** tool handler with atomic write. | 80 |
| `mcp-server/src/session-state.ts` | Add new state fields (`cycleStartSha`, etc.). | 15 |
| `mcp-server/src/__tests__/outcome-grading.test.ts` | **New** tests for truncation and fallback. | 200 |

## Testing Strategy
- **Timeout Simulation:** Unit test `spawnGrader` with a mocked `exec` that hangs; verify `grader_timeout` and process cleanup.
- **Fault Injection:** Pass malformed JSON from a mocked grader; verify the single auto-retry fires with the correct re-prompt.
- **Migration Safety:** Load a checkpoint from v3.11.x; verify `cycleStartSha` fallback works without crashing.
- **Truncation Logic:** Feed a 100KB diff string; verify the output contains the truncation marker and keeps within context limits.
- **Race Condition:** Use `Promise.all` in a vitest to call `gradeOutcome` twice; verify one returns `concurrent_write`.

## Open Questions
1. **OQ-A Resolution:** Capture `cycleStartSha` at `flywheel_select` time. This ensures that any "discovery" or "prep" commits made before formal planning are included in the graded outcome.
2. **OQ-B Resolution:** Skip-rubric should be **one-cycle**. It preserves the quality bar by default while allowing ad-hoc speed-ups.
3. **Context Prioritization:** If context is tight, should we drop the full diff entirely in favor of test output, or vice versa? (Plan: prioritize test output as it's the strongest signal of correctness).

## Failure Mode Catalog

| Trigger | Detection | Recovery | Surface |
|---|---|---|---|
| Codex times out | `exec` catch `Timed out` | Kill `codex`, fallback to CC subagent | "Primary grader timed out; falling back to fresh Claude session." |
| CC Fallback times out | `exec` catch `Timed out` | Terminate, return `grader_timeout` | Error code + hint to increase `FW_GRADER_TIMEOUT_MS`. |
| Grader returns prose | Zod parse fail + no `{` | Re-prompt once for JSON only | "Grader returned prose; retrying with strict JSON instruction..." |
| Diff > 30K chars | `unifiedDiff.length` check | Truncate middle, keep 15K start/end | Verdict `explanation` notes truncation. |
| Test output > 10K | `testOutput.length` check | Truncate end, keep start | Verdict `explanation` notes truncation. |
| Process crash (SIGSEGV) | `res.code !== 0` (non-timeout) | Fallback to CC immediately | "Primary grader process crashed; falling back..." |
| Disk Full | `fs.writeFile` throw | Return verdict in-memory | "Warning: Verdict generated but could not be persisted to disk." |
