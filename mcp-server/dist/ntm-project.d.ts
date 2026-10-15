type NtmProjectTargetBase = {
    project: string;
    root: string;
    target: string;
};
export type NtmProjectTarget = (NtmProjectTargetBase & {
    kind: 'missing';
}) | (NtmProjectTargetBase & {
    kind: 'matching';
    resolvedTarget: string;
}) | (NtmProjectTargetBase & {
    kind: 'collision';
    reason: 'different-target' | 'regular-file' | 'dangling-symlink';
    resolvedTarget?: string;
});
export declare function parseNtmProjectsBase(raw: string): string | null;
export declare function ntmProjectName(cwd: string): string;
export declare function classifyNtmProjectTarget(cwd: string, projectsBase: string): Promise<NtmProjectTarget>;
export {};
//# sourceMappingURL=ntm-project.d.ts.map