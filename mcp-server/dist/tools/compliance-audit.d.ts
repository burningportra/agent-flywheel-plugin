import { z } from 'zod';
import type { McpToolResult, ToolContext } from '../types.js';
export declare const ComplianceAuditArgsSchema: z.ZodObject<{
    cwd: z.ZodString;
    beadIds: z.ZodArray<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        standard: "standard";
        "single-bead": "single-bead";
    }>>;
    threshold: z.ZodOptional<z.ZodNumber>;
    parallelism: z.ZodOptional<z.ZodNumber>;
    skipEnv: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ComplianceAuditArgs = z.infer<typeof ComplianceAuditArgsSchema>;
export interface ComplianceAuditOutcome {
    status: 'ok' | 'skipped' | 'error';
    passed: Array<{
        beadId: string;
        score: number;
        reportPath: string;
    }>;
    failed: Array<{
        beadId: string;
        score: number;
        reportPath: string;
        reasons: string[];
    }>;
    passUtc: string | null;
    errors: Record<string, string>;
    durationMs: number;
}
export declare function runComplianceAudit(ctx: ToolContext, rawArgs: unknown): Promise<McpToolResult>;
//# sourceMappingURL=compliance-audit.d.ts.map