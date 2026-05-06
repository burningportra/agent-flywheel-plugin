/**
 * Convergence math for plan revisions.
 *
 * Multi-signal convergence detector with a ring-buffer of revision metrics
 * and a sign-flip oscillation guard (the "B6" trap from APR-Pro:
 * `1000 → 1200 → 800 → 1100 → 900` looks "stable" by avg-of-halves but is
 * actually oscillating).
 *
 * Schema is `version: 1` — additive forever (mirrors the convention set by
 * `CompletionReportSchemaV1` in `completion-report.ts`). When algorithm
 * behaviour changes in a way that affects gating, bump `scoreVersion`
 * separately so consumers can detect score-version mismatches without
 * reinterpreting old states under new rules.
 *
 * Per Phase 12 final synthesis (docs/research-apr-pro-integration.md §12.4):
 * the score is consumed by both human (Step 5.45 menu hint) and orchestrator
 * (`flywheel_advance_wave` gating). Auto-approve at score ≥0.90 STILL routes
 * through `AskUserQuestion` — no silent advancement. The score never arms
 * menu defaults; it only mentions itself in question text.
 */
import { z } from "zod";
/** Ring-buffer cap. Holds at most N most-recent revisions. */
export declare const REVISION_BUFFER_SIZE = 5;
/** Score algorithm version. Bump when gating behaviour changes. */
export declare const SCORE_VERSION: 1;
export declare const RevisionMetricsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    revisionId: z.ZodString;
    timestamp: z.ZodString;
    size: z.ZodObject<{
        lines: z.ZodNumber;
        words: z.ZodNumber;
        chars: z.ZodNumber;
    }, z.core.$strip>;
    structural: z.ZodObject<{
        headings: z.ZodNumber;
        codeBlocks: z.ZodNumber;
        links: z.ZodNumber;
        listItems: z.ZodNumber;
    }, z.core.$strip>;
    diffVsPrior: z.ZodNullable<z.ZodObject<{
        addedLines: z.ZodNumber;
        removedLines: z.ZodNumber;
        similarityScore: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RevisionMetrics = z.infer<typeof RevisionMetricsSchema>;
export declare const ConvergenceStatusEnum: z.ZodEnum<{
    converged: "converged";
    diverging: "diverging";
    approaching: "approaching";
    nearly_converged: "nearly_converged";
    oscillating: "oscillating";
}>;
export type ConvergenceStatus = z.infer<typeof ConvergenceStatusEnum>;
export declare const ConvergenceStateSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    planSlug: z.ZodString;
    scoreVersion: z.ZodLiteral<1>;
    revisions: z.ZodArray<z.ZodObject<{
        version: z.ZodLiteral<1>;
        revisionId: z.ZodString;
        timestamp: z.ZodString;
        size: z.ZodObject<{
            lines: z.ZodNumber;
            words: z.ZodNumber;
            chars: z.ZodNumber;
        }, z.core.$strip>;
        structural: z.ZodObject<{
            headings: z.ZodNumber;
            codeBlocks: z.ZodNumber;
            links: z.ZodNumber;
            listItems: z.ZodNumber;
        }, z.core.$strip>;
        diffVsPrior: z.ZodNullable<z.ZodObject<{
            addedLines: z.ZodNumber;
            removedLines: z.ZodNumber;
            similarityScore: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    signals: z.ZodObject<{
        outputSizeTrend: z.ZodNumber;
        changeVelocity: z.ZodNumber;
        similarityTrend: z.ZodNumber;
    }, z.core.$strip>;
    oscillation: z.ZodObject<{
        signFlips: z.ZodNumber;
        detected: z.ZodBoolean;
    }, z.core.$strip>;
    score: z.ZodNumber;
    status: z.ZodEnum<{
        converged: "converged";
        diverging: "diverging";
        approaching: "approaching";
        nearly_converged: "nearly_converged";
        oscillating: "oscillating";
    }>;
    estimatedRoundsRemaining: z.ZodNullable<z.ZodNumber>;
    computedAt: z.ZodString;
}, z.core.$strip>;
export type ConvergenceState = z.infer<typeof ConvergenceStateSchema>;
declare function countWords(s: string): number;
declare function countLines(s: string): number;
declare function structuralCounts(md: string): {
    headings: number;
    codeBlocks: number;
    links: number;
    listItems: number;
};
/**
 * Cheap shingled-similarity score in [0, 1]. Uses 4-gram character shingles.
 * 1 = identical, 0 = no shingles in common. Does not normalise markdown
 * structure (Phase 13 deferred per §12.7).
 */
declare function jaccardSimilarity(a: string, b: string): number;
declare function diffLineCounts(prior: string, current: string): {
    addedLines: number;
    removedLines: number;
};
export declare function computeRevisionMetrics(currentMd: string, priorMd: string | null, opts?: {
    revisionId?: string;
    timestamp?: string;
}): RevisionMetrics;
/**
 * Score thresholds (50/75/90 ladder):
 *   <0.50 diverging | 0.50–0.75 approaching | 0.75–0.90 nearly_converged | ≥0.90 converged
 * `oscillation.detected = true` overrides → "oscillating".
 */
declare function statusForScore(score: number): Exclude<ConvergenceStatus, "oscillating">;
declare function computeSignals(revs: RevisionMetrics[]): {
    outputSizeTrend: number;
    changeVelocity: number;
    similarityTrend: number;
};
declare function detectOscillation(revs: RevisionMetrics[]): {
    signFlips: number;
    detected: boolean;
};
/**
 * Score = weighted blend of the three signals, mapped into [0,1].
 *   - similarityTrend (high = converging): weight 0.5
 *   - inverse outputSizeTrend (low churn = converging): weight 0.3
 *   - inverse changeVelocity (low diff churn = converging): weight 0.2
 *
 * With <2 revisions there's no signal to blend — score is 0 (diverging).
 */
declare function computeScore(signals: ReturnType<typeof computeSignals>, revCount: number): number;
export interface AppendRevisionOptions {
    /** Override for tests / reproducibility. */
    computedAt?: string;
}
/**
 * Append a revision to a (possibly null) prior state, recompute signals,
 * score, and oscillation flag. Returns a new state — never mutates input.
 *
 * `state.scoreVersion` is always pinned to the current `SCORE_VERSION`. If
 * `state.scoreVersion` does not match (possible when reading an older
 * persisted state), the caller should reject via the dedicated
 * `score_version_mismatch` error code rather than passing it here.
 */
export declare function appendRevision(state: ConvergenceState | null, metrics: RevisionMetrics, planSlug: string, opts?: AppendRevisionOptions): ConvergenceState;
/**
 * Return a *Recommended* label for Step 5.45 — never auto-arms the menu.
 * Per Phase 12 §12.4 + README §Design Philosophy #3, the skill renders all 4
 * options unchanged in label and order; this is hint text only.
 *
 * Note: branches on `status` and `score`, never on `revisions.length`
 * (anti-pattern #3 from Phase 10).
 */
export declare function defaultStep545Action(state: ConvergenceState): "validate" | "approve" | "refine";
export type ConvergenceReadError = {
    code: "invalid_json";
    message: string;
} | {
    code: "schema_invalid";
    message: string;
    issues: z.core.$ZodIssue[];
} | {
    code: "score_version_mismatch";
    message: string;
    gotVersion: number;
};
export type ConvergenceReadResult = {
    ok: true;
    state: ConvergenceState;
} | {
    ok: false;
    error: ConvergenceReadError;
};
/**
 * Parse + version-check a persisted state JSON string. Use this when reading
 * `.pi-flywheel/plans/<slug>/convergence.json` from disk; returns a discriminated
 * `score_version_mismatch` error for older states so the orchestrator can refuse
 * to gate on stale-algorithm scores.
 */
export declare function parseConvergenceState(raw: string): ConvergenceReadResult;
/** @internal exposed for test inspection only */
export declare const __test: {
    computeSignals: typeof computeSignals;
    detectOscillation: typeof detectOscillation;
    computeScore: typeof computeScore;
    statusForScore: typeof statusForScore;
    jaccardSimilarity: typeof jaccardSimilarity;
    diffLineCounts: typeof diffLineCounts;
    countLines: typeof countLines;
    countWords: typeof countWords;
    structuralCounts: typeof structuralCounts;
};
export {};
//# sourceMappingURL=convergence.d.ts.map