import { z } from 'zod';
/**
 * Estimated effort for a bead, used by the calibration system.
 * @since v3.7.0
 */
export const EFFORT_LEVELS = ['S', 'M', 'L', 'XL'];
/**
 * Mapping from effort tier to expected minutes-of-work.
 * @since v3.7.0
 */
export const EFFORT_TO_MINUTES = {
    S: 30,
    M: 90,
    L: 240,
    XL: 720,
};
export function createInitialState() {
    return {
        phase: "idle",
        constraints: [],
        retryCount: 0,
        maxRetries: 3,
        maxReviewPasses: 2,
        iterationRound: 0,
        currentGateIndex: 0,
        polishRound: 0,
        polishChanges: [],
        polishConverged: false,
    };
}
export { FLYWHEEL_ERROR_CODES, FlywheelStructuredErrorSchema } from './errors.js';
// ─── v3.4.0 Shared Contracts (doctor / hotspot / postmortem / template / telemetry) ──
export const DoctorCheckSeveritySchema = z.enum(['green', 'yellow', 'red']);
export const DoctorCheckSchema = z.object({
    name: z.string(),
    severity: DoctorCheckSeveritySchema,
    message: z.string(),
    hint: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
});
export const DoctorReportSchema = z.object({
    version: z.literal(1),
    cwd: z.string(),
    overall: DoctorCheckSeveritySchema,
    /**
     * Count of red-severity checks. Exit code = 1 iff `criticalFails > 0`.
     * Yellow checks never gate. Mirrors context-mode's doctor counter
     * (context-mode/src/cli.ts ~L350-L495).
     */
    criticalFails: z.number().int().nonnegative().default(0),
    partial: z.boolean().default(false),
    checks: z.array(DoctorCheckSchema),
    elapsedMs: z.number().int().nonnegative(),
    timestamp: z.string(),
});
export const HotspotSeveritySchema = z.enum(['low', 'med', 'high']);
export const HotspotRowSchema = z.object({
    file: z.string(),
    beadIds: z.array(z.string()),
    contentionCount: z.number().int().nonnegative(),
    severity: HotspotSeveritySchema,
    provenance: z.enum(['files-section', 'prose']),
});
export const HotspotMatrixSchema = z.object({
    version: z.literal(1),
    // Bounded to prevent DoS from attacker-crafted plans with thousands of fake rows.
    // Real waves top out at ~20 contested files; 500 is an order-of-magnitude headroom.
    rows: z.array(HotspotRowSchema).max(500),
    maxContention: z.number().int().nonnegative(),
    recommendation: z.enum(['swarm', 'coordinator-serial']),
    summaryOnly: z.boolean().default(false),
});
export const PostmortemDraftSchema = z.object({
    version: z.literal(1),
    sessionStartSha: z.string().optional(),
    goal: z.string(),
    phase: z.string(),
    // Bound the markdown payload to prevent an unbounded-growth DoS where a
    // pathological post-mortem (e.g., huge concatenated stderr or commit-message
    // dumps) could inflate cross-process messages, logs, or the memory store.
    // 200_000 chars ~ 200KB UTF-8 worst case; real post-mortems are <10KB.
    markdown: z.string().max(200_000),
    hasWarnings: z.boolean().default(false),
    warnings: z.array(z.string()).default([]),
});
/**
 * v3.4.1 note: `BeadTemplateContractSchema` / `BeadTemplateContract` was
 * declared here during v3.4.0 as a planned MCP-boundary contract but never
 * wired to any `.parse()` call site. It was deleted per the v3.4.0 release
 * gate's P1-5 finding — dead export-only code should not linger in the public
 * surface. If a future MCP tool needs a wire-friendly template contract,
 * reintroduce the schema beside the handler that actually validates it so
 * the declaration, parse site, and tests ship together.
 *
 * The in-process `BeadTemplate` interface above (richer, with placeholder
 * metadata) remains the canonical shape for `bead-templates.ts` consumers.
 */
/**
 * Error-code telemetry. Keys of `counts` and the `code` field of each
 * `recentEvents` entry SHOULD be `FlywheelErrorCode` values, but the schema
 * accepts any string to stay forward-compatible with newer sessions that may
 * have added codes we don't yet know about. The write path (in `telemetry.ts`,
 * landed in I7) MUST validate the key is a known `FlywheelErrorCode` before
 * incrementing; the read path tolerates unknown keys so checkpoints from
 * future versions don't fail to load.
 */
export const ErrorCodeTelemetrySchema = z.object({
    version: z.literal(1),
    sessionStartIso: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    recentEvents: z.array(z.object({
        code: z.string(),
        ts: z.string(),
        ctxHash: z.string().optional(),
    })),
});
//# sourceMappingURL=types.js.map