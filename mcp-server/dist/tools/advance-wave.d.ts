import type { McpToolResult, ToolContext, AdvanceWaveArgs } from '../types.js';
import type { VerifyBeadsOutcome } from './verify-beads.js';
import { type BeadComplexity } from '../model-routing.js';
declare const LANES: readonly ["cc", "cod", "gem"];
type Lane = typeof LANES[number];
export interface AdvanceWaveOutcome {
    verification: VerifyBeadsOutcome;
    nextWave: {
        beadIds: string[];
        prompts: Array<{
            beadId: string;
            lane: Lane;
            prompt: string;
        }>;
        complexity: Record<string, BeadComplexity>;
    } | null;
    waveComplete: boolean;
}
export declare function runAdvanceWave(ctx: ToolContext, args: AdvanceWaveArgs): Promise<McpToolResult>;
export {};
//# sourceMappingURL=advance-wave.d.ts.map