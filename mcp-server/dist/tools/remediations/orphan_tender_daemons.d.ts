/**
 * orphan_tender_daemons remediation (T6.2, v3.16.0 noob-onboarding).
 *
 * The doctor probe in `mcp-server/src/checks/orphan-tender-daemons.ts` already
 * enumerates `node tender-daemon.js` PIDs whose `--session <name>` is no
 * longer in `tmux list-sessions`. This handler re-runs that classifier in
 * buildPlan, renders the `kill -TERM <pid>` plan, then escalates SIGTERM →
 * 1s wait → SIGKILL via `platform.terminateMany` on execute. verifyProbe
 * re-runs the classifier and confirms zero orphans remain.
 *
 * Mutating + reversible:false (a killed process is gone; restart is operator
 * driven). The dispatcher in `remediate.ts` enforces `autoConfirm:true` for
 * mutating handlers, matching the SKILL.md remediation menu.
 */
import type { RemediationHandler } from '../remediate.js';
import { type KillOptions } from '../../platform.js';
export interface RemediateOrphanDaemonsOptions {
    pids: number[];
    mode: 'dry-run' | 'execute' | 'skip';
    killOptions?: KillOptions;
}
export interface RemediateOrphanDaemonsResult {
    commands: string[];
    executed: boolean;
    results?: Array<{
        pid: number;
        status: 'terminated' | 'killed' | 'error';
        error?: string;
    }>;
}
/**
 * Standalone helper covering the plan's documented entry point. Unit tests
 * construct {pids, mode} directly to avoid the full registry plumbing.
 */
export declare function remediateOrphanDaemons(opts: RemediateOrphanDaemonsOptions): Promise<RemediateOrphanDaemonsResult>;
export declare const orphanTenderDaemonsHandler: RemediationHandler;
//# sourceMappingURL=orphan_tender_daemons.d.ts.map