/**
 * projects_base_misconfig remediation (T6.1, v3.16.0 noob-onboarding).
 *
 * Symptom: `ntm` is installed and configured with a `projects_base` directory,
 * but the current project (`basename(cwd)`) is NOT reachable under it. Without
 * this symlink, `ntm spawn` resolves to the wrong working tree and the
 * flywheel's planning/impl phases silently fall back to plain `Agent()`.
 *
 * Fix: `ln -s <cwd> <projects_base>/<basename(cwd)>`.
 *
 * Mutating but reversible (a single symlink that can be removed with `rm`).
 */
import type { RemediationHandler } from '../remediate.js';
export type RemediateProjectsBaseInput = {
    cwd: string;
    ntmBase: string;
    mode: 'dry-run' | 'execute' | 'skip';
};
export type RemediateProjectsBaseResult = {
    command: string;
    executed: boolean;
    target: string;
};
/**
 * Pure helper used by the plan's contract test. The doctor remediation
 * registry (below) wraps this with the standard buildPlan/execute/verifyProbe
 * shape; this overload is the standalone entry point the plan calls out.
 */
export declare function remediateProjectsBase(opts: RemediateProjectsBaseInput): Promise<RemediateProjectsBaseResult>;
export declare const projectsBaseMisconfigHandler: RemediationHandler;
//# sourceMappingURL=projects_base_misconfig.d.ts.map