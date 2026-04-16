import type { ExecFn } from "./exec.js";
/**
 * Result type for worktree operations.
 * When ok=true, `data` holds the payload (if any) and `error` is undefined.
 * When ok=false, `error` describes what went wrong and `data` is undefined.
 */
export type WorktreeResult<T = void> = {
    ok: true;
    data?: T;
    error?: undefined;
} | {
    ok: false;
    data?: undefined;
    error: string;
};
export interface WorktreeInfo {
    path: string;
    branch: string;
    stepIndex: number;
}
export interface WorktreePoolState {
    repoRoot: string;
    baseBranch: string;
    worktrees: WorktreeInfo[];
}
export interface OrphanedWorktreeInfo {
    path: string;
    branch?: string;
    isDirty: boolean;
}
export interface CleanupSummary {
    removed: number;
    autoCommitted: number;
    errors: string[];
}
export declare function createWorktree(exec: ExecFn, cwd: string, branch: string, path: string): Promise<WorktreeResult>;
/**
 * Force-remove a git worktree. WARNING: discards uncommitted changes.
 * Use `autoCommitWorktree` first if you need to preserve work.
 * Falls back to `git worktree prune` if the directory was already deleted.
 */
export declare function removeWorktree(exec: ExecFn, cwd: string, path: string): Promise<WorktreeResult>;
export declare function listWorktrees(exec: ExecFn, cwd: string): Promise<WorktreeResult<string[]>>;
/**
 * Auto-commit any uncommitted changes in a worktree.
 * Returns data:true if a commit was made, data:false if already clean.
 */
export declare function autoCommitWorktree(exec: ExecFn, worktreePath: string, message: string): Promise<WorktreeResult<boolean>>;
/**
 * Find worktrees in `.pi-flywheel/worktrees/` that aren't in the tracked list.
 * Returns info about each orphan including dirty status and branch name (if detectable).
 */
export declare function findOrphanedWorktrees(exec: ExecFn, repoRoot: string, tracked: WorktreeInfo[]): Promise<OrphanedWorktreeInfo[]>;
/**
 * Remove orphaned worktrees. Auto-commits dirty ones first to preserve work.
 */
export declare function cleanupOrphanedWorktrees(exec: ExecFn, repoRoot: string, orphans: OrphanedWorktreeInfo[]): Promise<CleanupSummary>;
export declare class WorktreePool {
    private exec;
    private state;
    constructor(exec: ExecFn, repoRoot: string, baseBranch: string);
    /** Restore from persisted state. */
    static fromState(exec: ExecFn, state: WorktreePoolState): WorktreePool;
    /** Get serializable state for persistence. */
    getState(): WorktreePoolState;
    /** Create and acquire a worktree for a step. Returns the worktree cwd. */
    acquire(stepIndex: number): Promise<WorktreeResult<string>>;
    /** Release (remove) a worktree for a step. */
    release(stepIndex: number): Promise<WorktreeResult>;
    /** Get the worktree path for a step, if it exists. */
    getPath(stepIndex: number): string | undefined;
    /** Get the branch name for a step's worktree. */
    getBranch(stepIndex: number): string | undefined;
    /** Get all active worktree infos. */
    getAll(): ReadonlyArray<WorktreeInfo>;
    /**
     * Remove all tracked worktrees without preserving uncommitted changes.
     * Prefer `safeCleanup()` unless you know all worktrees are already committed.
     */
    cleanup(): Promise<void>;
    /**
     * Auto-commit dirty worktrees, remove all tracked worktrees, then
     * sweep orphaned worktrees not tracked by this pool.
     */
    safeCleanup(): Promise<CleanupSummary>;
}
//# sourceMappingURL=worktree.d.ts.map