import { z } from 'zod';
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
    markdown: z.string(),
    hasWarnings: z.boolean().default(false),
    warnings: z.array(z.string()).default([]),
});
/**
 * v3.4.0 Bead template contract used by the `expand_bead_template` tool and
 * template library (`bead-templates.ts`). Distinct from the richer legacy
 * `BeadTemplate` interface above, which models in-repo template fixtures
 * with placeholders-as-objects.
 *
 * **Selection rule for downstream beads:**
 * - Use `BeadTemplateContract` (this type) when crossing the MCP tool boundary
 *   (e.g., `expand_bead_template` tool input/output, `deep-plan` hint emission,
 *   `approve`-time expansion). The flat-string `placeholders` is wire-friendly.
 * - Use `BeadTemplate` (richer legacy interface) when calling the in-process
 *   library API (`getTemplateById()`, `renderTemplate()`). Placeholder metadata
 *   (`description`, `example`, `required`) is needed for validation UX.
 * - Conversions between the two happen at the tool-handler edge; never mix
 *   them in the same call frame.
 */
export const BeadTemplateContractSchema = z.object({
    id: z.string(),
    version: z.number().int().positive(),
    body: z.string(),
    placeholders: z.array(z.string()),
    dependenciesHint: z.string().optional(),
    testStrategy: z.string().optional(),
});
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