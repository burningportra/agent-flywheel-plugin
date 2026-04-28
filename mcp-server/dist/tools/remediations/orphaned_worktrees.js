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
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { resolveRealpathWithinRoot } from '../../utils/path-safety.js';
import { realpathSync } from 'node:fs';
const log = createLogger('remediation.orphaned_worktrees');
const GIT_TIMEOUT_MS = 30_000;
const PER_REMOVE_TIMEOUT_MS = 30_000;
const WORKTREE_SCAN_ROOTS = [
    { relativePath: join('.claude', 'worktrees'), label: '.claude/worktrees' },
    { relativePath: join('.ntm', 'worktrees'), label: '.ntm/worktrees' },
    { relativePath: join('.pi-flywheel', 'worktrees'), label: '.pi-flywheel/worktrees' },
];
function canonical(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
function collectCandidates(cwd) {
    const out = [];
    for (const root of WORKTREE_SCAN_ROOTS) {
        const r = resolveRealpathWithinRoot(root.relativePath, {
            root: cwd,
            label: root.label,
            rootLabel: 'cwd',
        });
        if (!r.ok)
            continue;
        let entries;
        try {
            entries = readdirSync(r.realPath, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const p = join(r.realPath, e.name);
            try {
                statSync(p);
                out.push({ path: p, display: `${root.label}/${e.name}` });
            }
            catch {
                // ignore
            }
        }
    }
    return out;
}
function parseRegisteredPaths(raw) {
    const set = new Set();
    for (const line of raw.split('\n')) {
        if (line.startsWith('worktree ')) {
            set.add(canonical(line.slice('worktree '.length).trim()));
        }
    }
    return set;
}
async function findOrphans(ctx) {
    const candidates = collectCandidates(ctx.cwd);
    if (candidates.length === 0)
        return [];
    const res = await ctx.exec('git', ['worktree', 'list', '--porcelain'], {
        cwd: ctx.cwd,
        timeout: GIT_TIMEOUT_MS,
        signal: ctx.signal,
    });
    if (res.code !== 0) {
        log.warn('git worktree list exited non-zero', { exitCode: res.code });
        return [];
    }
    const registered = parseRegisteredPaths(res.stdout);
    return candidates.filter((c) => !registered.has(canonical(c.path)));
}
export const orphanedWorktreesHandler = {
    description: 'Enumerate orphaned worktree directories and remove them with `git worktree remove --force`.',
    mutating: true,
    reversible: false,
    async buildPlan(ctx) {
        const orphans = await findOrphans(ctx);
        if (orphans.length === 0) {
            return {
                description: 'No orphaned worktree directories detected.',
                steps: [],
                mutating: false,
                reversible: false,
            };
        }
        return {
            description: `Remove ${orphans.length} orphaned worktree director${orphans.length === 1 ? 'y' : 'ies'}.`,
            steps: orphans.map((o) => `git worktree remove --force ${o.display}`),
            mutating: true,
            reversible: false,
        };
    },
    async execute(ctx) {
        const orphans = await findOrphans(ctx);
        if (orphans.length === 0) {
            return { stepsRun: 0 };
        }
        const stdoutParts = [];
        const stderrParts = [];
        let stepsRun = 0;
        for (const orphan of orphans) {
            if (ctx.signal.aborted)
                break;
            const res = await ctx.exec('git', ['worktree', 'remove', '--force', orphan.path], {
                cwd: ctx.cwd,
                timeout: PER_REMOVE_TIMEOUT_MS,
                signal: ctx.signal,
            });
            stepsRun += 1;
            if (res.stdout)
                stdoutParts.push(`[${orphan.display}] ${res.stdout}`);
            if (res.stderr)
                stderrParts.push(`[${orphan.display}] ${res.stderr}`);
            if (res.code !== 0) {
                log.warn('worktree remove failed', { path: orphan.display, exitCode: res.code });
            }
        }
        return {
            stepsRun,
            stdout: stdoutParts.join('\n') || undefined,
            stderr: stderrParts.join('\n') || undefined,
        };
    },
    async verifyProbe(ctx) {
        const orphans = await findOrphans(ctx);
        if (orphans.length > 0) {
            log.warn('verifyProbe: orphans remain after remediation', {
                count: orphans.length,
                paths: orphans.map((o) => o.display),
            });
            return false;
        }
        return true;
    },
};
//# sourceMappingURL=orphaned_worktrees.js.map