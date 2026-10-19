import type { FlywheelState, BatchReviewVerdict } from "./types.js";
/**
 * Count commits since the batch-review baseline with `git rev-list --count
 * <sha>..HEAD` via execFile (the sha is an argv element, never shell text).
 * Throws on git failure so callers can decide whether to skip the gate.
 */
export declare function countCommitsSinceLastBatchReview(cwd: string, sha: string, signal?: AbortSignal): Promise<number>;
/** A 0, unset, or non-integer `commitBatchThreshold` turns batch reviews off. */
export declare function batchReviewsEnabled(state: FlywheelState): boolean;
/** True when batch reviews are on and `count` (from `countCommitsSinceLastBatchReview`) has reached the threshold. */
export declare function shouldTriggerBatchReview(state: FlywheelState, count: number): boolean;
export declare function batchReviewVerdictPath(cwd: string, shaRange: string): string;
/**
 * Record that a review of `shaRange` went out. Only commits after its end sha
 * count toward the next review, so the gate stays quiet while this one runs,
 * and the range stays in `pendingBatchReviews` until its verdict is applied.
 */
export declare function recordBatchReviewDispatch(state: FlywheelState, shaRange: string): void;
export type AppliedBatchReview = {
    kind: "pending";
} | {
    kind: "filed";
    verdict: BatchReviewVerdict;
    beadIds: string[];
} | {
    kind: "malformed";
    reason: string;
    rawSnippet: string;
    beadIds: string[];
};
/**
 * Read the verdict for `shaRange` and file one bead per finding, whatever the
 * verdict's status, or one re-review bead when the verdict can't be read.
 *
 * Mutates `state`. Each bead id goes into `batchReviewSynthesizedBeads[shaRange]`
 * as soon as br returns it, so a call that fails partway can simply be
 * repeated: it files only the findings that don't have a bead yet, and a call
 * on an applied range files nothing. The range leaves `pendingBatchReviews`
 * once every finding has its bead. Throws when the verdict file can't be read
 * or `br create` fails; the caller saves `state` either way.
 */
export declare function applyBatchReviewVerdict(cwd: string, state: FlywheelState, shaRange: string, signal?: AbortSignal): Promise<AppliedBatchReview>;
//# sourceMappingURL=commit-batch.d.ts.map