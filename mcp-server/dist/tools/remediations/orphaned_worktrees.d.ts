/**
 * orphaned_worktrees remediation — enumerate then remove per-entry.
 *
 * "Orphaned" = a directory under one of the managed worktree roots that is
 * NOT registered in `git worktree list --porcelain`. We enumerate first
 * (buildPlan), then issue one `git worktree remove --force <path>` per entry
 * (execute). verifyProbe re-runs the registration scan and confirms zero
 * orphans remain.
 *
 * Mutating + NOT reversible (worktree files are gone after removal).
 */
import type { RemediationHandler } from '../remediate.js';
export declare const orphanedWorktreesHandler: RemediationHandler;
//# sourceMappingURL=orphaned_worktrees.d.ts.map