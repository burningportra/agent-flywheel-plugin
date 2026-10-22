import { z } from 'zod';
import { FLYWHEEL_ERROR_CODES, DEFAULT_HINTS, DEFAULT_TRY_THIS, DEFAULT_RETRYABLE, FlywheelError, throwFlywheelError, errMsg } from './errors-core.js';
/**
 * Side-channel telemetry hook. telemetry.ts registers itself here on first
 * import so that makeFlywheelErrorResult can fire recordErrorCode without
 * creating a circular ESM dependency (errors ← telemetry ← errors).
 */
let _telemetryHook = null;
export function registerTelemetryHook(hook) {
    _telemetryHook = hook;
}
export { FLYWHEEL_ERROR_CODES, DEFAULT_HINTS, DEFAULT_TRY_THIS, DEFAULT_RETRYABLE, FlywheelError, throwFlywheelError, errMsg };
export const FlywheelErrorCodeSchema = z.enum(FLYWHEEL_ERROR_CODES);
export const FlywheelToolErrorSchema = z.object({
    code: FlywheelErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean().optional(),
    hint: z.string().optional(),
    /**
     * R-007 — concrete next-step the caller can paste/execute. Where `hint`
     * is narrative ("a required prerequisite is missing"), `try_this` is
     * imperative ("Run flywheel_profile(cwd: <repo-root>) first."). Always
     * defaulted from DEFAULT_TRY_THIS; per-call overrides win.
     */
    try_this: z.string().optional(),
    cause: z.string().optional(),
    phase: z.string().optional(),
    tool: z.string().optional(),
    timestamp: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
});
export const FlywheelStructuredErrorSchema = z.object({
    tool: z.string(),
    version: z.literal(1),
    status: z.literal('error'),
    phase: z.string(),
    data: z.object({
        kind: z.literal('error'),
        error: FlywheelToolErrorSchema,
    }),
});
/**
 * Redact absolute filesystem paths and cap length before embedding raw error
 * messages in MCP-visible structured output. Prevents local-path leakage via
 * FlywheelToolError.cause without losing signal value for debugging.
 */
export function sanitizeCause(raw, maxLen = 200) {
    const homeRedacted = raw.replace(/\/Users\/[^/\s:'"]+/g, '~');
    const unixRedacted = homeRedacted.replace(/\/(?:home|var|tmp|opt|private)\/[^\s:'"]*/g, (m) => {
        const base = m.split('/').slice(-1)[0] ?? '';
        return base ? `<path>/${base}` : '<path>';
    });
    return unixRedacted.length > maxLen ? `${unixRedacted.slice(0, maxLen - 1)}…` : unixRedacted;
}
export function classifyExecError(err) {
    const msg = errMsg(err);
    const cause = sanitizeCause(msg);
    if (/Timed out after \d+ms/.test(msg))
        return { code: 'exec_timeout', retryable: true, cause };
    if (/aborted|AbortError/i.test(msg))
        return { code: 'exec_aborted', retryable: false, cause };
    return { code: 'cli_failure', retryable: true, cause };
}
export function makeFlywheelErrorResult(tool, phase, input) {
    const error = {
        ...input,
        retryable: input.retryable ?? DEFAULT_RETRYABLE[input.code],
        // R-007 — auto-fill hint and try_this from the per-code defaults so
        // every error envelope carries both fields. Per-call values win.
        hint: input.hint ?? DEFAULT_HINTS[input.code],
        try_this: input.try_this ?? DEFAULT_TRY_THIS[input.code],
        ...(input.cause !== undefined && input.cause !== null && { cause: sanitizeCause(input.cause) }),
        phase,
        tool,
        timestamp: new Date().toISOString(),
    };
    // Fire-and-forget telemetry hook (no-op if telemetry module not yet registered)
    try {
        _telemetryHook?.(input.code, input.cause !== undefined && input.cause !== null ? { hashable: input.cause } : undefined);
    }
    catch { /* never throw from error result builder */ }
    return {
        content: [{ type: 'text', text: input.message }],
        isError: true,
        structuredContent: {
            tool,
            version: 1,
            status: 'error',
            phase,
            data: { kind: 'error', error },
        },
    };
}
//# sourceMappingURL=errors.js.map