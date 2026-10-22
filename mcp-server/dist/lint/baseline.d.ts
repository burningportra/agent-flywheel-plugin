import type { Finding } from "./types.js";
export declare const RULESET_VERSION = 1;
export declare function toRepoRelativePosix(file: string, repoRoot: string): string;
export interface BaselineEntry {
    ruleId: string;
    rulesetVersion: number;
    file: string;
    line: number;
    fingerprint: string;
    reason: string;
}
export interface BaselineFile {
    schemaVersion: 1;
    rulesetVersion: number;
    generated: string;
    entries: BaselineEntry[];
}
export declare function normalizeSourceForFingerprint(source: string): string;
export declare function computeFingerprint(source: string, line: number): string;
export declare function loadBaseline(path: string): Promise<BaselineFile | null>;
export declare function saveBaseline(path: string, baseline: BaselineFile): Promise<void>;
export declare function applyBaseline(findings: Finding[], baseline: BaselineFile | null, source: string, repoRoot?: string): {
    live: Finding[];
    baselined: Finding[];
};
export declare function generateBaseline(findings: Finding[], source: string, generated?: string, repoRoot?: string): BaselineFile;
//# sourceMappingURL=baseline.d.ts.map