import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { errMsg } from "./errors.js";
// ─── Constants ─────────────────────────────────────────────────
const WORKTREE_DIR = ".pi-flywheel/worktrees";
function worktreePath(repoRoot, stepIndex) {
    return join(repoRoot, WORKTREE_DIR, `step-${stepIndex}`);
}
function worktreeBranch(baseBranch, stepIndex) {
    // Use -- separator to avoid git ref path conflicts with slashes in baseBranch
    return `${baseBranch}--worktree-step-${stepIndex}`;
}
// ─── Low-level helpers ─────────────────────────────────────────
export async function createWorktree(exec, cwd, branch, path) {
    try {
        // Create the worktree branch from current HEAD
        const result = await exec("git", ["worktree", "add", "-b", branch, path], { timeout: 15000, cwd });
        if (result.code !== 0) {
            return { ok: false, error: result.stderr.trim() || `git worktree add failed (code ${result.code})` };
        }
        return { ok: true };
    }
    catch (err) {
        return {
            ok: false,
            error: `worktree create failed: ${errMsg(err)}`,
        };
    }
}
/**
 * Force-remove a git worktree. WARNING: discards uncommitted changes.
 * Use `autoCommitWorktree` first if you need to preserve work.
 * Falls back to `git worktree prune` if the directory was already deleted.
 */
export async function removeWorktree(exec, cwd, path) {
    try {
        const result = await exec("git", ["worktree", "remove", "--force", path], { timeout: 10000, cwd });
        if (result.code !== 0) {
            // Try prune as fallback if the directory was already deleted externally
            await exec("git", ["worktree", "prune"], { timeout: 5000, cwd });
            // Check if the directory still exists — if so, prune didn't help
            if (existsSync(path)) {
                return {
                    ok: false,
                    error: result.stderr.trim() || `git worktree remove failed (code ${result.code})`,
                };
            }
            return { ok: true }; // directory gone, prune cleaned up the stale entry
        }
        return { ok: true };
    }
    catch (err) {
        return {
            ok: false,
            error: `worktree remove failed: ${errMsg(err)}`,
        };
    }
}
export async function listWorktrees(exec, cwd) {
    try {
        const result = await exec("git", ["worktree", "list", "--porcelain"], { timeout: 5000, cwd });
        if (result.code !== 0) {
            return { ok: false, error: result.stderr.trim() };
        }
        const paths = result.stdout
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice("worktree ".length));
        return { ok: true, data: paths };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
/**
 * Auto-commit any uncommitted changes in a worktree.
 * Returns data:true if a commit was made, data:false if already clean.
 */
export async function autoCommitWorktree(exec, worktreePath, message) {
    try {
        // Check for dirty files
        const status = await exec("git", ["status", "--porcelain"], {
            timeout: 5000,
            cwd: worktreePath,
        });
        if (status.code !== 0) {
            return { ok: false, error: `git status failed: ${status.stderr.trim()}` };
        }
        const dirty = status.stdout.trim().length > 0;
        if (!dirty) {
            return { ok: true, data: false }; // nothing to commit
        }
        // Stage and commit
        const add = await exec("git", ["add", "-A"], {
            timeout: 5000,
            cwd: worktreePath,
        });
        if (add.code !== 0) {
            return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
        }
        const commit = await exec("git", ["commit", "-m", message], { timeout: 10000, cwd: worktreePath });
        if (commit.code !== 0) {
            return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
        }
        return { ok: true, data: true }; // commit made
    }
    catch (err) {
        return {
            ok: false,
            error: `autoCommitWorktree failed: ${errMsg(err)}`,
        };
    }
}
// ─── Orphan Detection & Cleanup ────────────────────────────────
/**
 * Find worktrees in `.pi-flywheel/worktrees/` that aren't in the tracked list.
 * Returns info about each orphan including dirty status and branch name (if detectable).
 */
export async function findOrphanedWorktrees(exec, repoRoot, tracked) {
    const worktreeDir = join(repoRoot, WORKTREE_DIR);
    if (!existsSync(worktreeDir))
        return [];
    let entries;
    try {
        entries = readdirSync(worktreeDir);
    }
    catch {
        return [];
    }
    const trackedPaths = new Set(tracked.map((w) => w.path));
    // Build a path→branch map from git once, not per-orphan
    const branchByPath = new Map();
    try {
        const result = await exec("git", ["worktree", "list", "--porcelain"], { timeout: 5000, cwd: repoRoot });
        if (result.code === 0) {
            const lines = result.stdout.split("\n");
            let currentPath;
            for (const line of lines) {
                if (line.startsWith("worktree ")) {
                    currentPath = line.slice("worktree ".length);
                }
                else if (line.startsWith("branch refs/heads/") && currentPath) {
                    branchByPath.set(currentPath, line.slice("branch refs/heads/".length));
                }
                else if (line === "") {
                    currentPath = undefined;
                }
            }
        }
    }
    catch {
        // Branch detection is best-effort
    }
    const orphans = [];
    for (const entry of entries) {
        if (!entry.startsWith("step-"))
            continue;
        const fullPath = join(worktreeDir, entry);
        if (trackedPaths.has(fullPath))
            continue;
        let isDirty = false;
        try {
            const status = await exec("git", ["status", "--porcelain"], {
                timeout: 5000,
                cwd: fullPath,
            });
            isDirty = status.code === 0 && status.stdout.trim().length > 0;
        }
        catch {
            // Can't check status — treat as clean, will force-remove anyway
        }
        orphans.push({
            path: fullPath,
            branch: branchByPath.get(fullPath),
            isDirty,
        });
    }
    return orphans;
}
/**
 * Remove orphaned worktrees. Auto-commits dirty ones first to preserve work.
 */
export async function cleanupOrphanedWorktrees(exec, repoRoot, orphans) {
    const summary = { removed: 0, autoCommitted: 0, errors: [] };
    for (const orphan of orphans) {
        // Auto-commit dirty worktrees to preserve work
        if (orphan.isDirty) {
            const commitResult = await autoCommitWorktree(exec, orphan.path, `[agent-flywheel] auto-commit: recovery of orphaned worktree`);
            if (commitResult.ok && commitResult.data) {
                summary.autoCommitted++;
            }
        }
        // Remove the worktree
        const removeResult = await removeWorktree(exec, repoRoot, orphan.path);
        if (removeResult.ok) {
            summary.removed++;
            // Also delete the branch if known
            if (orphan.branch) {
                await exec("git", ["branch", "-D", orphan.branch], {
                    timeout: 5000,
                    cwd: repoRoot,
                }).catch(() => { });
            }
        }
        else {
            summary.errors.push(`Failed to remove ${orphan.path}: ${removeResult.error ?? "unknown error"}`);
        }
    }
    // Final prune to catch any stale git refs
    await exec("git", ["worktree", "prune"], {
        timeout: 5000,
        cwd: repoRoot,
    }).catch(() => { });
    return summary;
}
// ─── WorktreePool ──────────────────────────────────────────────
export class WorktreePool {
    exec;
    state;
    constructor(exec, repoRoot, baseBranch) {
        this.exec = exec;
        this.state = {
            repoRoot,
            baseBranch,
            worktrees: [],
        };
    }
    /** Restore from persisted state. */
    static fromState(exec, state) {
        const pool = new WorktreePool(exec, state.repoRoot, state.baseBranch);
        pool.state = state;
        return pool;
    }
    /** Get serializable state for persistence. */
    getState() {
        return {
            ...this.state,
            worktrees: this.state.worktrees.map((w) => ({ ...w })),
        };
    }
    /** Create and acquire a worktree for a step. Returns the worktree cwd. */
    async acquire(stepIndex) {
        // Check if already exists
        const existing = this.state.worktrees.find((w) => w.stepIndex === stepIndex);
        if (existing) {
            return { ok: true, data: existing.path };
        }
        const path = worktreePath(this.state.repoRoot, stepIndex);
        const branch = worktreeBranch(this.state.baseBranch, stepIndex);
        const result = await createWorktree(this.exec, this.state.repoRoot, branch, path);
        if (!result.ok) {
            return { ok: false, error: result.error };
        }
        const info = { path, branch, stepIndex };
        this.state.worktrees.push(info);
        return { ok: true, data: path };
    }
    /** Release (remove) a worktree for a step. */
    async release(stepIndex) {
        const idx = this.state.worktrees.findIndex((w) => w.stepIndex === stepIndex);
        if (idx < 0) {
            return { ok: true }; // nothing to release
        }
        const info = this.state.worktrees[idx];
        const result = await removeWorktree(this.exec, this.state.repoRoot, info.path);
        if (result.ok) {
            // Also delete the branch
            await this.exec("git", ["branch", "-D", info.branch], {
                timeout: 5000,
                cwd: this.state.repoRoot,
            }).catch(() => { });
            this.state.worktrees.splice(idx, 1);
        }
        return result;
    }
    /** Get the worktree path for a step, if it exists. */
    getPath(stepIndex) {
        return this.state.worktrees.find((w) => w.stepIndex === stepIndex)?.path;
    }
    /** Get the branch name for a step's worktree. */
    getBranch(stepIndex) {
        return this.state.worktrees.find((w) => w.stepIndex === stepIndex)?.branch;
    }
    /** Get all active worktree infos. */
    getAll() {
        return this.state.worktrees;
    }
    /**
     * Remove all tracked worktrees without preserving uncommitted changes.
     * Prefer `safeCleanup()` unless you know all worktrees are already committed.
     */
    async cleanup() {
        const indices = this.state.worktrees.map((w) => w.stepIndex);
        for (const idx of indices) {
            await this.release(idx);
        }
        // Prune any stale entries
        await this.exec("git", ["worktree", "prune"], {
            timeout: 5000,
            cwd: this.state.repoRoot,
        }).catch(() => { });
    }
    /**
     * Auto-commit dirty worktrees, remove all tracked worktrees, then
     * sweep orphaned worktrees not tracked by this pool.
     */
    async safeCleanup() {
        const summary = { removed: 0, autoCommitted: 0, errors: [] };
        // 1. Auto-commit and remove tracked worktrees
        const indices = this.state.worktrees.map((w) => w.stepIndex);
        for (const idx of indices) {
            const info = this.state.worktrees.find((w) => w.stepIndex === idx);
            if (!info)
                continue;
            // Try auto-commit before removal
            try {
                const commitResult = await autoCommitWorktree(this.exec, info.path, `[agent-flywheel] auto-commit: safe cleanup of worktree step-${idx}`);
                if (commitResult.ok && commitResult.data) {
                    summary.autoCommitted++;
                }
            }
            catch {
                // Non-fatal — continue with removal
            }
            const releaseResult = await this.release(idx);
            if (releaseResult.ok) {
                summary.removed++;
            }
            else {
                summary.errors.push(`Failed to release step-${idx}: ${releaseResult.error ?? "unknown error"}`);
            }
        }
        // 2. Find and clean up orphaned worktrees (not tracked by pool)
        const orphans = await findOrphanedWorktrees(this.exec, this.state.repoRoot, this.state.worktrees // already empty after releases above
        );
        if (orphans.length > 0) {
            const orphanSummary = await cleanupOrphanedWorktrees(this.exec, this.state.repoRoot, orphans);
            summary.removed += orphanSummary.removed;
            summary.autoCommitted += orphanSummary.autoCommitted;
            summary.errors.push(...orphanSummary.errors);
        }
        return summary;
    }
}
//# sourceMappingURL=worktree.js.map