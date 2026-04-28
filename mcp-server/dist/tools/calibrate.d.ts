import { z } from 'zod';
import type { ExecFn } from '../exec.js';
import { type EstimatedEffort } from '../types.js';
export declare const CalibrateInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    sinceDays: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
export type CalibrateInput = z.infer<typeof CalibrateInputSchema>;
export interface CalibrationRow {
    templateId: string;
    templateVersion?: number;
    estimatedEffort: EstimatedEffort | null;
    estimatedMinutes: number;
    sampleCount: number;
    meanMinutes: number;
    medianMinutes: number;
    p95Minutes: number;
    ratio: number;
    lowConfidence: boolean;
    proxyStartedCount: number;
}
export interface CalibrationReport {
    cwd: string;
    sinceDays: number;
    generatedAt: string;
    totalBeadsConsidered: number;
    droppedBeads: number;
    rows: CalibrationRow[];
    untemplated: {
        count: number;
    };
}
export declare function runCalibrate(args: CalibrateInput, exec: ExecFn, signal: AbortSignal): Promise<CalibrationReport>;
//# sourceMappingURL=calibrate.d.ts.map