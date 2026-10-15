interface FreshEyesPromptBase {
    round: number;
    memoryContext: string;
    allArtifacts: string[];
    callbackHint: string;
    regressionHint: string;
}
export type FreshEyesPromptOpts = FreshEyesPromptBase & ({
    emitStructuredFindings: true;
    shaRange: string;
    findingsPath: string;
} | {
    emitStructuredFindings?: false;
    shaRange?: never;
    findingsPath?: never;
});
export declare function buildFreshEyesPrompt(opts: FreshEyesPromptOpts): string;
export {};
//# sourceMappingURL=gates.d.ts.map