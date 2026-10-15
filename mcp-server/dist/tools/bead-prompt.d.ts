export interface BeadCreationPromptOpts {
    goal: string;
    constraints?: string[];
    repoContext?: string;
    planPath?: string;
    planPreview?: string;
    provenance?: string;
    nextAction?: string;
}
export declare function buildBeadCreationPrompt(opts: BeadCreationPromptOpts): string;
export declare function containsForbiddenDependsOnFlag(text: string): boolean;
//# sourceMappingURL=bead-prompt.d.ts.map