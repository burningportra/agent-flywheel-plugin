/**
 * Type-safe CLI output parsers using Zod schemas.
 *
 * Each schema uses `.passthrough()` to tolerate extra fields from CLI updates.
 * Each parse function returns a discriminated union `ParseResult<T>`.
 */
import { z } from "zod";
import type { Bead, BvInsights, BvNextPick } from "./types.js";
import type { FlywheelFeedback } from "./feedback.js";
export type ParseResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: string;
};
export interface BrStructuredError {
    code?: string;
    message?: string;
    hint?: string;
    retryable?: boolean;
    context?: Record<string, unknown>;
}
export interface CmSearchResult {
    text?: string;
    content?: string;
    score?: number;
}
export interface ProfileCache {
    gitHead: string;
    cachedAt: string;
    profile: unknown;
}
export declare const BeadSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    status: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
        open: "open";
        in_progress: "in_progress";
        closed: "closed";
        deferred: "deferred";
    }>>;
    priority: z.ZodNumber;
    type: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    issue_type: z.ZodOptional<z.ZodString>;
    labels: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
    estimate: z.ZodOptional<z.ZodNumber>;
    parent: z.ZodOptional<z.ZodString>;
    created_at: z.ZodOptional<z.ZodString>;
    updated_at: z.ZodOptional<z.ZodString>;
    closed_at: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const BvBottleneckSchema: z.ZodObject<{
    ID: z.ZodString;
    Value: z.ZodNumber;
}, z.core.$loose>;
export declare const BrStructuredErrorSchema: z.ZodObject<{
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
    hint: z.ZodOptional<z.ZodString>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    context: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$loose>;
export declare const AgentMailRpcResponseSchema: z.ZodObject<{
    error: z.ZodOptional<z.ZodObject<{
        message: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    result: z.ZodOptional<z.ZodUnknown>;
}, z.core.$loose>;
export declare const CmResultSchema: z.ZodObject<{
    success: z.ZodOptional<z.ZodBoolean>;
    data: z.ZodOptional<z.ZodUnknown>;
}, z.core.$loose>;
/** A br output row that `parseBrList` left out, and why. */
export interface SkippedBrRow {
    /** Zero-based position in br's output. */
    index: number;
    id?: string;
    reason: string;
}
export type BrListParseResult = {
    ok: true;
    data: Bead[];
    skipped: SkippedBrRow[];
} | {
    ok: false;
    error: string;
};
/**
 * Reads `br list --json` / `br ready --json` row by row. br accepts more than
 * the flywheel models, so one unreadable row is skipped and reported instead
 * of failing the whole list.
 */
export declare function parseBrList(raw: string): BrListParseResult;
export declare function formatSkippedBrRows(skipped: readonly SkippedBrRow[]): string[];
export declare function parseBvInsights(raw: string): ParseResult<BvInsights>;
export declare function parseBvNextPicks(raw: string): ParseResult<BvNextPick[]>;
export declare function parseBvNextPick(raw: string): ParseResult<BvNextPick | null>;
export declare function parseBrError(raw: string): ParseResult<BrStructuredError>;
export declare function parseAgentMailResponse<T>(raw: string): ParseResult<T>;
export declare function parseCmResult<T>(raw: string): ParseResult<T>;
export declare function parseCmSearchResults(raw: string): ParseResult<CmSearchResult[]>;
export declare function parseSophiaResult<T>(raw: string): ParseResult<T>;
export declare function parseProfileCache(raw: string): ParseResult<ProfileCache>;
export declare function parseFeedbackFile(raw: string): ParseResult<FlywheelFeedback>;
//# sourceMappingURL=parsers.d.ts.map