export type SkillSource = "repo" | "manifest" | "allowlist" | "plugins";
export interface SkillRegistry {
    has(slashName: string): boolean;
    suggest(slashName: string, k?: number): string[];
    size: number;
    source(slashName: string): SkillSource | undefined;
}
export interface ManifestFile {
    schemaVersion: 1;
    skills: string[];
    generated?: string;
}
export interface AllowlistFile {
    schemaVersion: 1;
    knownExternalSlashes?: string[];
    acceptedFindings?: Array<{
        ruleId: string;
        file: string;
        line?: number;
        reason: string;
    }>;
}
export interface LoadSkillRegistryOptions {
    repoRoot: string;
    ci?: boolean;
    pluginsRoot?: string | null;
    manifestPath?: string;
    allowlistPath?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}
export declare function loadSkillRegistry(opts: LoadSkillRegistryOptions): Promise<SkillRegistry>;
//# sourceMappingURL=skillRegistry.d.ts.map