import type { ExecFn } from "./exec.js";
import type { FlywheelState } from "./types.js";
export interface FreshEyesPromptOpts {
    round: number;
    memoryContext: string;
    allArtifacts: string[];
    callbackHint: string;
    regressionHint: string;
    /** `<from-sha>..<to-sha>` placeholder echoed into the structured-findings contract block when the batch-review path is the caller. */
    shaRange?: string;
    /** When true, append the `Finding[]` verdict contract used by the `review.ts` batch_review auto-synthesis path. The wave-gate caller passes `false` so its prompt is byte-identical to the legacy form. */
    emitStructuredFindings?: boolean;
}
export declare function buildFreshEyesPrompt(opts: FreshEyesPromptOpts): string;
export declare function runGuidedGates(exec: ExecFn, cwd: string, st: FlywheelState, extraInfo: string, saveState: () => void): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    details: any;
}>;
//# sourceMappingURL=gates.d.ts.map