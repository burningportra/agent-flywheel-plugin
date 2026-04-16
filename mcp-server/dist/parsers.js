/**
 * Type-safe CLI output parsers using Zod schemas.
 *
 * Each schema uses `.passthrough()` to tolerate extra fields from CLI updates.
 * Each parse function returns a discriminated union `ParseResult<T>`.
 */
import { z } from "zod";
// ─── Zod Schemas ────────────────────────────────────────────
export const BeadSchema = z
    .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["open", "in_progress", "closed", "deferred"]),
    priority: z.number(),
    type: z.string().optional().default("task"),
    issue_type: z.string().optional(), // br v0.1.x uses issue_type instead of type
    labels: z.array(z.string()).optional().default([]),
    estimate: z.number().optional(),
    parent: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    closed_at: z.string().optional(),
})
    .passthrough();
export const BvBottleneckSchema = z
    .object({
    ID: z.string(),
    Value: z.number(),
})
    .passthrough();
export const BvInsightsSchema = z
    .object({
    Bottlenecks: z.array(BvBottleneckSchema),
    Cycles: z.array(z.array(z.string())).nullable(),
    Orphans: z.array(z.string()),
    Articulation: z.array(z.string()),
    Slack: z.array(z
        .object({
        ID: z.string(),
        Value: z.number(),
    })
        .passthrough()),
})
    .passthrough();
export const BvNextPickSchema = z
    .object({
    id: z.string(),
    title: z.string(),
    score: z.number(),
    reasons: z.array(z.string()),
    unblocks: z.array(z.string()),
})
    .passthrough();
export const BrStructuredErrorSchema = z
    .object({
    code: z.string().optional(),
    message: z.string().optional(),
    hint: z.string().optional(),
    retryable: z.boolean().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
})
    .passthrough();
export const AgentMailRpcResponseSchema = z
    .object({
    error: z
        .object({
        message: z.string().optional(),
        code: z.number().optional(),
    })
        .optional(),
    result: z.unknown().optional(),
})
    .passthrough();
export const CmResultSchema = z
    .object({
    success: z.boolean().optional(),
    data: z.unknown().optional(),
})
    .passthrough();
export const CmSearchResultSchema = z
    .object({
    text: z.string().optional(),
    content: z.string().optional(),
    score: z.number().optional(),
})
    .passthrough();
export const SophiaResultSchema = z
    .object({
    ok: z.boolean().optional(),
    data: z.unknown().optional(),
    error: z
        .object({
        message: z.string().optional(),
    })
        .optional(),
})
    .passthrough();
export const ProfileCacheSchema = z
    .object({
    gitHead: z.string(),
    cachedAt: z.string(),
    profile: z.unknown(),
})
    .passthrough();
export const FeedbackFileSchema = z
    .object({
    timestamp: z.string(),
    goal: z.string(),
    beadCount: z.number(),
    completedCount: z.number(),
    totalRounds: z.number(),
    planQualityScore: z.number().optional(),
    foregoneScore: z.number().optional(),
    polishRounds: z.number(),
    converged: z.boolean(),
    regressions: z.array(z.string()),
    spaceViolationCount: z.number(),
})
    .passthrough();
// ─── Helper ─────────────────────────────────────────────────
function tryParseJson(raw) {
    try {
        return { ok: true, data: JSON.parse(raw) };
    }
    catch (e) {
        const msg = e instanceof SyntaxError ? e.message : String(e);
        return { ok: false, error: `Invalid JSON: ${msg}` };
    }
}
function formatZodError(error) {
    return error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ");
}
// ─── Parse Functions ────────────────────────────────────────
export function parseBrList(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    // br v0.1.34+ returns `{issues: [...]}`; older versions returned a bare array.
    const candidate = Array.isArray(json.data)
        ? json.data
        : (json.data && typeof json.data === "object" && Array.isArray(json.data.issues))
            ? json.data.issues
            : null;
    if (candidate === null) {
        return { ok: false, error: "expected array or {issues:[]} object" };
    }
    const arr = z.array(BeadSchema).safeParse(candidate);
    if (!arr.success)
        return { ok: false, error: formatZodError(arr.error) };
    return { ok: true, data: arr.data };
}
export function parseBvInsights(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = BvInsightsSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    return { ok: true, data: result.data };
}
export function parseBvNextPicks(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const arr = z.array(BvNextPickSchema).safeParse(json.data);
    if (!arr.success)
        return { ok: false, error: formatZodError(arr.error) };
    return { ok: true, data: arr.data };
}
export function parseBvNextPick(raw) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "null" || trimmed === "{}") {
        return { ok: true, data: null };
    }
    const json = tryParseJson(trimmed);
    if (!json.ok)
        return json;
    if (json.data === null)
        return { ok: true, data: null };
    const result = BvNextPickSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    return { ok: true, data: result.data };
}
export function parseBrError(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = BrStructuredErrorSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    return { ok: true, data: result.data };
}
export function parseAgentMailResponse(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = AgentMailRpcResponseSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    const envelope = result.data;
    if (envelope.error) {
        const errMsg = envelope.error.message ?? "Unknown RPC error";
        const code = envelope.error.code != null ? ` (code ${envelope.error.code})` : "";
        return { ok: false, error: `RPC error: ${errMsg}${code}` };
    }
    return { ok: true, data: envelope.result };
}
export function parseCmResult(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = CmResultSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    const envelope = result.data;
    if (envelope.success === false) {
        return { ok: false, error: "cm command returned success=false" };
    }
    return { ok: true, data: envelope.data };
}
export function parseCmSearchResults(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const arr = z.array(CmSearchResultSchema).safeParse(json.data);
    if (!arr.success)
        return { ok: false, error: formatZodError(arr.error) };
    return { ok: true, data: arr.data };
}
export function parseSophiaResult(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = SophiaResultSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    const envelope = result.data;
    if (envelope.ok === false) {
        const errMsg = envelope.error?.message ?? "Unknown sophia error";
        return { ok: false, error: `sophia error: ${errMsg}` };
    }
    return { ok: true, data: envelope.data };
}
export function parseProfileCache(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = ProfileCacheSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    return { ok: true, data: result.data };
}
export function parseFeedbackFile(raw) {
    const json = tryParseJson(raw);
    if (!json.ok)
        return json;
    const result = FeedbackFileSchema.safeParse(json.data);
    if (!result.success)
        return { ok: false, error: formatZodError(result.error) };
    return { ok: true, data: result.data };
}
//# sourceMappingURL=parsers.js.map