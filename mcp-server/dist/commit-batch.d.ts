import type { FlywheelState, Finding, BatchReviewVerdict } from "./types.js";
/**
 * Count commits since the batch-review baseline. Uses `git rev-list --count
 * <sha>..HEAD` via execFile (shell-injection-safe — sha is an argv element,
 * not a shell-interpolated string). If `sha` is empty/undefined, returns the
 * total HEAD commit count of the branch. Throws on git failure so callers
 * can decide whether to surface the error or skip the batch-review tick.
 */
export declare function countCommitsSinceLastBatchReview(cwd: string, sha: string | undefined): Promise<number>;
/**
 * Pure check: should the coordinator dispatch a batch review now? Returns
 * true iff the feature is enabled (`commitBatchThreshold` is a positive
 * integer) AND the live commit count has reached the threshold. 0/undefined
 * threshold disables the feature — the existing post-wave gate flow is
 * unchanged.
 *
 * The caller MUST compute `count` from `countCommitsSinceLastBatchReview(cwd,
 * state.lastBatchReviewSha)` and pass it in. This intentionally keeps the
 * boolean check pure-synchronous: callers handle the I/O for testability and
 * to make the data-flow visible in `advance-wave.ts` (we count commits at
 * gate-time, not from a stored counter — `state.commitBatchCounter` is
 * deprecated and unused by this function).
 */
export declare function shouldTriggerBatchReview(state: FlywheelState, count: number): boolean;
/**
 * Record a dispatched batch review against the state. Returns a NEW state
 * object — the input is not mutated. Sets `lastBatchReviewSha` to the
 * snapshot sha (dispatch time, not verdict time — risk #3 in the plan),
 * resets `commitBatchCounter` to 0, and pre-initializes
 * `batchReviewSynthesizedBeads[verdict.sha_range]` to an empty array when
 * the verdict is blocking so the synthesize loop has a record to append to.
 */
export declare function recordBatchReview(state: FlywheelState, sha: string, verdict: BatchReviewVerdict): FlywheelState;
/**
 * Synthesize one bead per finding via `br create --silent` and record each
 * created ID in `state.batchReviewSynthesizedBeads[range]` immediately so a
 * mid-batch failure leaves a valid partial-rollback record. Mutates the
 * passed `state` (the record is the durable artifact callers rely on for
 * rollback). Throws on the first `br create` failure — callers MUST invoke
 * `rollbackSynthesizedBeads(cwd, state.batchReviewSynthesizedBeads[range])`
 * to clean up the partial set.
 *
 * Every finding is validated against `FindingSchema` before the `br create`
 * shells out; a single invalid finding short-circuits the whole batch (the
 * caller falls back to `needs_attention` mode).
 *
 * All severities synthesize — no filter. (Alignment-check round 2 decision:
 * severity is preserved in the bead description for downstream prioritization
 * via the Approve subset gate.)
 */
export declare function synthesizeBeadsFromFindings(cwd: string, state: FlywheelState, findings: Finding[], range: string): Promise<string[]>;
/**
 * Tear down auto-synthesized beads when the user picks Reject all (or the
 * rejected subset of Approve subset). Primary path: `br delete <id>
 * --reason "<REJECT_REASON>"`. If delete fails (dependents, tombstone
 * conflict, etc.) the fallback is `br update <id> --status closed
 * --notes "<REJECT_REASON>"` so the graph reflects intent. Never throws —
 * collects per-bead outcomes so the caller can surface partial-failure
 * info to the operator.
 */
export declare function rollbackSynthesizedBeads(cwd: string, beadIds: string[]): Promise<{
    deleted: string[];
    closed: string[];
    failed: string[];
}>;
//# sourceMappingURL=commit-batch.d.ts.map