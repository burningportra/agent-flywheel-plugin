import type { ExecFn } from '../exec.js';
import type { Bead, BeadProgramScope } from '../types.js';
export declare const FLYWHEEL_GOAL_LABEL_PREFIX = "flywheel-goal:";
export interface ResolvedBeadProgram {
    scope: Extract<BeadProgramScope, {
        kind: 'tagged' | 'legacy';
    }>;
    beads: Bead[];
    warnings: string[];
}
export type DispatchBeadProgramResolution = {
    ok: true;
    scope: Extract<BeadProgramScope, {
        kind: 'tagged' | 'legacy';
    }>;
    warnings: string[];
} | {
    ok: false;
    code: 'cli_failure' | 'parse_failure';
    message: string;
    details: Record<string, unknown>;
};
export declare function slugifyGoal(goal: string): string;
export declare function goalBeadProgramLabel(goal: string): string;
export declare function beadHasProgramLabel(bead: Bead, label: string): boolean;
export declare function isFlywheelGoalLabel(label: string): boolean;
export declare function resolveBeadProgram(allBeads: readonly Bead[], expectedLabel: string): ResolvedBeadProgram;
export declare function resolveDispatchBeadProgramScope(exec: ExecFn, cwd: string, scope: BeadProgramScope | undefined, expectedLabel: string, signal?: AbortSignal): Promise<DispatchBeadProgramResolution>;
export declare function filterBeadsForProgram(beads: readonly Bead[], scope: BeadProgramScope | undefined): {
    beads: Bead[];
    warnings: string[];
};
export declare function formatBeadProgramWarnings(warnings: readonly string[]): string;
//# sourceMappingURL=bead-program.d.ts.map