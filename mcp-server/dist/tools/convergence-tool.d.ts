/**
 * `flywheel_convergence` — read-only handler that returns the persisted
 * convergence state for a plan slug.
 *
 * Path: `.pi-flywheel/plans/<slug>/convergence.json` (per Phase 12 §12.3 cuts —
 * NO `.flywheel/` rename).
 *
 * State writes use the existing `writeFile`/`mkdir` pattern from
 * `completion-report.ts` (no new atomic-write infrastructure per opus §4.2).
 */
import type { McpToolResult, ToolContext } from '../types.js';
import { type ConvergenceState } from '../convergence.js';
export declare const CONVERGENCE_DIR = ".pi-flywheel/plans";
/** Slugify a plan path (or arbitrary identifier) into a filesystem-safe directory name. */
export declare function planSlugFromIdentifier(identifierOrPath: string): string;
export declare function convergencePath(cwd: string, planSlug: string): string;
export interface ConvergenceToolArgs {
    cwd: string;
    planSlug: string;
}
type ConvergenceStructuredOk = {
    tool: 'flywheel_convergence';
    version: 1;
    status: 'ok';
    data: {
        kind: 'convergence_state';
        state: ConvergenceState;
    };
};
type ConvergenceStructuredNotFound = {
    tool: 'flywheel_convergence';
    version: 1;
    status: 'not_found';
    data: null;
    message: string;
    path: string;
};
type ConvergenceStructuredError = {
    tool: 'flywheel_convergence';
    version: 1;
    status: 'error';
    data: null;
    code: 'invalid_json' | 'schema_invalid' | 'score_version_mismatch' | 'invalid_input';
    message: string;
    path?: string;
};
export type ConvergenceStructured = ConvergenceStructuredOk | ConvergenceStructuredNotFound | ConvergenceStructuredError;
export declare function readConvergenceFromDisk(cwd: string, planSlug: string): Promise<ConvergenceStructured>;
/**
 * Persist a convergence state to disk. Writes are simple `mkdir -p` + `writeFile`
 * (matches `writeCompletionReport` in `completion-report.ts`). The state schema's
 * own `scoreVersion` literal makes recovery from older states an explicit migration.
 */
export declare function writeConvergenceToDisk(cwd: string, state: ConvergenceState): Promise<{
    path: string;
}>;
export declare function runConvergence(ctx: ToolContext, args: ConvergenceToolArgs): Promise<McpToolResult>;
export {};
//# sourceMappingURL=convergence-tool.d.ts.map