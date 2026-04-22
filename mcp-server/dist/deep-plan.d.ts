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
/**
 * Matches a synthesizer-emitted template hint of the shape `<id>@<version>`.
 *
 * - `id`      — lowercase kebab-case (same shape validated by
 *               `validateTemplateIntegrity` in `bead-templates.ts`).
 * - `version` — positive integer.
 *
 * Leading/trailing whitespace is tolerated so `template: "  foo@1  "` still
 * parses; internal whitespace is rejected.
 */
export declare const TEMPLATE_HINT_REGEX: RegExp;
/**
 * Parse a synthesizer-emitted template hint (`"<id>@<version>"`).
 *
 * Returns `undefined` when the hint is missing, not a string, or malformed —
 * the caller should treat `undefined` as "no template hint, fall through to
 * legacy free-form bead creation." Malformed hints are logged at warn level so
 * they surface in session telemetry without breaking the bead-creation path.
 */
export declare function parseTemplateHint(hint: unknown): {
    id: string;
    version: number;
} | undefined;
/**
 * Guidance block embedded into the plan-to-beads prompt so the synthesizing
 * agent knows how to emit template hints. Kept as an exported helper so it
 * can be composed into both the freeform bead-creation prompt
 * (`prompts.ts` §planToBeadsPrompt) and any future synthesizer prompt paths.
 */
export declare function synthesizerTemplateHintGuidance(): string;
//# sourceMappingURL=deep-plan.d.ts.map