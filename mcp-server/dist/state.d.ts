import { z } from 'zod';
import { type FlywheelState } from './types.js';
export declare const ReviewModeSchema: z.ZodEnum<{
    autofix: "autofix";
    "report-only": "report-only";
    headless: "headless";
    interactive: "interactive";
}>;
export type ReviewModeZ = z.infer<typeof ReviewModeSchema>;
export declare const ReviewActionSchema: z.ZodEnum<{
    skip: "skip";
    "hit-me": "hit-me";
    "looks-good": "looks-good";
}>;
export type ReviewActionZ = z.infer<typeof ReviewActionSchema>;
declare const ReviewArgsSchema: z.ZodObject<{
    cwd: z.ZodString;
    beadId: z.ZodString;
    action: z.ZodEnum<{
        skip: "skip";
        "hit-me": "hit-me";
        "looks-good": "looks-good";
    }>;
    mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        autofix: "autofix";
        "report-only": "report-only";
        headless: "headless";
        interactive: "interactive";
    }>>>;
    parallelSafe: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, z.core.$strip>;
export type ReviewArgsZ = z.infer<typeof ReviewArgsSchema>;
export declare const PreCodeResearchSchema: z.ZodObject<{
    complete: z.ZodBoolean;
    docPath: z.ZodOptional<z.ZodString>;
    completedAt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type PreCodeResearch = z.infer<typeof PreCodeResearchSchema>;
export declare const PotetoCheckpointFieldsSchema: z.ZodObject<{
    potetoMode: z.ZodOptional<z.ZodBoolean>;
    interrogationDocPath: z.ZodOptional<z.ZodString>;
    architectureDocPath: z.ZodOptional<z.ZodString>;
    preCodeResearch: z.ZodOptional<z.ZodObject<{
        complete: z.ZodBoolean;
        docPath: z.ZodOptional<z.ZodString>;
        completedAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    polishRound: z.ZodOptional<z.ZodNumber>;
    polishConverged: z.ZodOptional<z.ZodBoolean>;
    reviewIterations: z.ZodOptional<z.ZodNumber>;
    verificationLedgerPath: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type PotetoCheckpointFields = z.infer<typeof PotetoCheckpointFieldsSchema>;
export type CheckpointState = FlywheelState & PotetoCheckpointFields;
export declare function loadState(cwd: string): CheckpointState;
export declare function saveState(cwd: string, state: CheckpointState): Promise<boolean>;
export declare function clearState(cwd: string): void;
export type FlywheelMemoryOperation = 'search' | 'store' | 'draft_postmortem' | 'draft_solution_doc' | 'refresh_learnings';
export interface FlywheelMemoryOperationDescriptor {
    /** Canonical name. */
    name: FlywheelMemoryOperation;
    /** Whether this op writes to CASS / disk. False for read-only/draft ops. */
    mutates: boolean;
    /** Whether this op needs the cm CLI to be installed. */
    requiresCmCli: boolean;
    /** Short human-readable summary surfaced in error hints. */
    summary: string;
}
/**
 * Classify a flywheel_memory operation. Returns null for unknown strings —
 * callers should treat null as `invalid_input` and surface the hint.
 *
 * NOTE: This is a pure lookup; do not perform side effects here. The actual
 * dispatch (calling `draftPostmortem`, `cm add`, etc.) lives in
 * `src/tools/memory-tool.ts`. This function exists so state.ts can act as
 * the single source of truth for *which* operations exist, leaving
 * `runMemory` to decide *how* each is executed.
 */
export declare function classifyMemoryOperation(op: string): FlywheelMemoryOperationDescriptor | null;
export {};
//# sourceMappingURL=state.d.ts.map