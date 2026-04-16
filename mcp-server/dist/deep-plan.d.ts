import type { ExecFn } from "./exec.js";
export interface DeepPlanAgent {
    name: string;
    task: string;
    model?: string;
}
/**
 * Compute or load the repo profile snapshot and persist it as JSON under outputDir.
 * Returns the absolute path to the snapshot, or null if profiling failed entirely.
 * Exported for testability.
 */
export declare function writeProfileSnapshot(exec: ExecFn, cwd: string, outputDir: string, signal?: AbortSignal): Promise<string | null>;
export interface DeepPlanResult {
    name: string;
    model: string;
    plan: string;
    exitCode: number;
    elapsed: number;
    error?: string;
}
/**
 * Run deep planning agents via the claude CLI in print mode.
 * Each agent gets its own task file and runs in parallel.
 */
export declare function runDeepPlanAgents(exec: ExecFn, cwd: string, agents: DeepPlanAgent[], signal?: AbortSignal): Promise<DeepPlanResult[]>;
/**
 * Filter deep-plan results to only those that are viable for synthesis.
 * Excludes failed agents and empty results (sentinel strings starting with "(AGENT").
 */
export declare function filterViableResults(results: DeepPlanResult[]): DeepPlanResult[];
//# sourceMappingURL=deep-plan.d.ts.map