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
    rows: z.array(HotspotRowSchema),
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
 */
export const BeadTemplateContractSchema = z.object({
    id: z.string(),
    version: z.number().int().positive(),
    body: z.string(),
    placeholders: z.array(z.string()),
    dependenciesHint: z.string().optional(),
    testStrategy: z.string().optional(),
});
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