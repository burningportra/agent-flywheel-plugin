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
import { basename } from 'node:path';
import { symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createLogger } from '../../logger.js';
const log = createLogger('remediation.projects_base_misconfig');
const NTM_CONFIG_TIMEOUT_MS = 5_000;
/**
 * Pure helper used by the plan's contract test. The doctor remediation
 * registry (below) wraps this with the standard buildPlan/execute/verifyProbe
 * shape; this overload is the standalone entry point the plan calls out.
 */
export async function remediateProjectsBase(opts) {
    const target = joinPath(opts.ntmBase, basename(opts.cwd));
    const command = `ln -s "${opts.cwd}" "${target}"`;
    if (opts.mode === 'dry-run' || opts.mode === 'skip') {
        return { command, executed: false, target };
    }
    if (!existsSync(target)) {
        await symlink(opts.cwd, target);
    }
    return { command, executed: true, target };
}
function joinPath(a, b) {
    if (a.endsWith('/'))
        return `${a}${b}`;
    return `${a}/${b}`;
}
async function readNtmBase(ctx) {
    try {
        const res = await ctx.exec('ntm', ['config', 'show'], {
            cwd: ctx.cwd,
            timeout: NTM_CONFIG_TIMEOUT_MS,
            signal: ctx.signal,
        });
        if (res.code !== 0)
            return null;
        const match = res.stdout.match(/projects_base\s*[=:]\s*"?([^"\n]+)"?/);
        return match?.[1]?.trim() ?? null;
    }
    catch (err) {
        log.warn('readNtmBase failed', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
export const projectsBaseMisconfigHandler = {
    description: 'Symlink the current project under ntm projects_base so ntm spawn resolves to the correct working tree.',
    mutating: true,
    reversible: true,
    async buildPlan(ctx) {
        const ntmBase = await readNtmBase(ctx);
        if (ntmBase === null) {
            return {
                description: 'ntm is not installed or `ntm config show` did not return a projects_base — no symlink to create.',
                steps: [],
                mutating: false,
                reversible: false,
            };
        }
        const { command, target } = await remediateProjectsBase({
            cwd: ctx.cwd,
            ntmBase,
            mode: 'dry-run',
        });
        if (existsSync(target)) {
            return {
                description: `projects_base symlink already present at ${target} — nothing to do.`,
                steps: [],
                mutating: false,
                reversible: false,
            };
        }
        return {
            description: `Symlink ${ctx.cwd} → ${target} so ntm spawn resolves correctly.`,
            steps: [command],
            mutating: true,
            reversible: true,
        };
    },
    async execute(ctx) {
        const ntmBase = await readNtmBase(ctx);
        if (ntmBase === null) {
            return { stepsRun: 0, stderr: 'ntm config show did not return a projects_base; nothing to symlink.' };
        }
        const { executed, target } = await remediateProjectsBase({
            cwd: ctx.cwd,
            ntmBase,
            mode: 'execute',
        });
        return {
            stepsRun: executed ? 1 : 0,
            stdout: executed ? `Symlinked ${ctx.cwd} → ${target}` : undefined,
        };
    },
    async verifyProbe(ctx) {
        const ntmBase = await readNtmBase(ctx);
        if (ntmBase === null)
            return true; // nothing to verify when ntm is absent
        const target = joinPath(ntmBase, basename(ctx.cwd));
        return existsSync(target);
    },
};
//# sourceMappingURL=projects_base_misconfig.js.map