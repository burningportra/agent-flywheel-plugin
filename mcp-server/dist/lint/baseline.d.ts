import { z } from "zod";
import type { Finding } from "./types.js";
export declare const BASELINE_SCHEMA_VERSION = 1;
export declare const RULESET_VERSION = 1;
export declare function toRepoRelativePosix(file: string, repoRoot: string): string;
declare const BaselineEntrySchema: z.ZodObject<{
    ruleId: z.ZodString;
    rulesetVersion: z.ZodNumber;
    file: z.ZodString;
    line: z.ZodNumber;
    fingerprint: z.ZodString;
    reason: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
declare const BaselineFileSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    rulesetVersion: z.ZodNumber;
    generated: z.ZodString;
    entries: z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        rulesetVersion: z.ZodNumber;
        file: z.ZodString;
        line: z.ZodNumber;
        fingerprint: z.ZodString;
        reason: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;
export type BaselineFile = z.infer<typeof BaselineFileSchema>;
export declare function normalizeSourceForFingerprint(source: string): string;
export declare function computeFingerprint(source: string, line: number): string;
export declare function loadBaseline(path: string): Promise<BaselineFile | null>;
export declare function saveBaseline(path: string, baseline: BaselineFile): Promise<void>;
export declare function applyBaseline(findings: Finding[], baseline: BaselineFile | null, source: string, repoRoot?: string): {
    live: Finding[];
    baselined: Finding[];
};
export declare function generateBaseline(findings: Finding[], source: string, generated?: string, repoRoot?: string): BaselineFile;
export {};
//# sourceMappingURL=baseline.d.ts.map