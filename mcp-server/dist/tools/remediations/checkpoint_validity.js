/**
 * checkpoint_validity remediation — back up corrupt checkpoint to .bak.<ts>.
 *
 * Strategy: rename `.pi-flywheel/checkpoint.json` to a timestamped backup so
 * the next session can start fresh. Reversible by renaming the .bak file
 * back. verifyProbe re-runs the same `readCheckpoint()` the doctor uses;
 * absent OR cleanly-loaded == green.
 */
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { readCheckpoint } from '../../checkpoint.js';
import { resolveRealpathWithinRoot } from '../../utils/path-safety.js';
import { guardedRename } from '../../utils/fs-safety.js';
const log = createLogger('remediation.checkpoint_validity');
function checkpointAbsPath(cwd) {
    return join(cwd, '.pi-flywheel', 'checkpoint.json');
}
function backupAbsPath(cwd, tsIso) {
    // Filesystem-safe timestamp: 2026-04-27T13-45-12-345Z
    const safeTs = tsIso.replace(/[:.]/g, '-');
    return join(cwd, '.pi-flywheel', `checkpoint.json.bak.${safeTs}`);
}
export const checkpointValidityHandler = {
    description: 'Back up the current checkpoint to .pi-flywheel/checkpoint.json.bak.<ts>',
    mutating: true,
    reversible: true,
    async buildPlan(ctx) {
        const target = checkpointAbsPath(ctx.cwd);
        if (!existsSync(target)) {
            return {
                description: 'No checkpoint file present — nothing to back up.',
                steps: [],
                mutating: false,
                reversible: true,
            };
        }
        return {
            description: 'Move .pi-flywheel/checkpoint.json to .pi-flywheel/checkpoint.json.bak.<timestamp> so the next session starts clean. Restore with `mv` from the .bak file.',
            steps: ['mv .pi-flywheel/checkpoint.json .pi-flywheel/checkpoint.json.bak.<ts>'],
            mutating: true,
            reversible: true,
        };
    },
    async execute(ctx) {
        const ckptDir = resolveRealpathWithinRoot('.pi-flywheel', {
            root: ctx.cwd,
            label: '.pi-flywheel',
            rootLabel: 'cwd',
        });
        if (!ckptDir.ok) {
            log.warn('execute: .pi-flywheel dir missing or refused', { reason: ckptDir.reason });
            return { stepsRun: 0, stderr: `cannot access .pi-flywheel/: ${ckptDir.reason}` };
        }
        const target = checkpointAbsPath(ctx.cwd);
        if (!existsSync(target)) {
            return { stepsRun: 0 };
        }
        const tsIso = new Date().toISOString();
        const dest = backupAbsPath(ctx.cwd, tsIso);
        // Prefer guardedRename (ownership + same-managed-root checks). Falls back
        // to renameSync only if the guard cannot be satisfied — but inside
        // .pi-flywheel/ the guard should always pass.
        const r = guardedRename(target, dest, ctx.cwd);
        if (!r.ok) {
            log.warn('guardedRename refused checkpoint backup', { reason: r.reason, detail: r.detail });
            // Last-resort fallback so the user is not stuck. We still log the warn.
            try {
                renameSync(target, dest);
            }
            catch (err) {
                log.warn('renameSync also failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
                return { stepsRun: 0, stderr: r.detail ?? r.reason };
            }
        }
        return { stepsRun: 1, stdout: `Backed up checkpoint to ${dest}` };
    },
    async verifyProbe(ctx) {
        const target = checkpointAbsPath(ctx.cwd);
        if (!existsSync(target))
            return true;
        try {
            const res = readCheckpoint(ctx.cwd);
            if (res === null) {
                log.warn('verifyProbe: checkpoint still unreadable after backup');
                return false;
            }
            if (res.warnings.length > 0) {
                log.warn('verifyProbe: checkpoint loaded with warnings', { warnings: res.warnings });
                return false;
            }
            return true;
        }
        catch (err) {
            log.warn('verifyProbe: readCheckpoint threw', {
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    },
};
//# sourceMappingURL=checkpoint_validity.js.map