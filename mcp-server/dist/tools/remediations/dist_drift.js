/**
 * dist_drift remediation — rebuild mcp-server/dist after src changes.
 *
 * Strategy: run `npm run build` inside `mcp-server/`. verifyProbe re-runs the
 * doctor check (newest .ts mtime under src vs newest mtime under dist).
 *
 * Mutating, reversible (`git checkout mcp-server/dist`). Refuses
 * autoConfirm:false in execute mode (enforced by dispatcher in remediate.ts).
 */
import { join } from 'node:path';
import { newestMtime } from '../shared.js';
import { createLogger } from '../../logger.js';
import { resolveRealpathWithinRoot } from '../../utils/path-safety.js';
const log = createLogger('remediation.dist_drift');
const BUILD_TIMEOUT_MS = 120_000;
export const distDriftHandler = {
    description: 'Rebuild mcp-server/dist after src changes',
    mutating: true,
    reversible: true,
    async buildPlan(_ctx) {
        return {
            description: 'Run `npm run build` inside mcp-server/ to regenerate dist artefacts.',
            steps: ['cd mcp-server && npm run build'],
            mutating: true,
            reversible: true,
        };
    },
    async execute(ctx) {
        const cwd = join(ctx.cwd, 'mcp-server');
        const res = await ctx.exec('npm', ['run', 'build'], {
            cwd,
            timeout: BUILD_TIMEOUT_MS,
            signal: ctx.signal,
        });
        if (res.code !== 0) {
            log.warn('dist_drift build exited non-zero', { exitCode: res.code });
        }
        return { stepsRun: 1, stdout: res.stdout, stderr: res.stderr };
    },
    async verifyProbe(ctx) {
        const srcDir = resolveRealpathWithinRoot(join('mcp-server', 'src'), {
            root: ctx.cwd,
            label: 'mcp-server/src',
            rootLabel: 'cwd',
        });
        const distDir = resolveRealpathWithinRoot(join('mcp-server', 'dist'), {
            root: ctx.cwd,
            label: 'mcp-server/dist',
            rootLabel: 'cwd',
        });
        if (!srcDir.ok) {
            log.warn('verifyProbe could not resolve src dir', { reason: srcDir.reason });
            return srcDir.reason === 'not_found';
        }
        if (!distDir.ok) {
            log.warn('verifyProbe could not resolve dist dir', { reason: distDir.reason });
            return false;
        }
        const srcMax = newestMtime(srcDir.realPath, (n) => n.endsWith('.ts'));
        const distMax = newestMtime(distDir.realPath);
        if (srcMax === null)
            return true;
        if (distMax === null) {
            log.warn('verifyProbe found no dist artefacts after build');
            return false;
        }
        const green = srcMax <= distMax;
        if (!green)
            log.warn('verifyProbe still detects drift after build', { srcMax, distMax });
        return green;
    },
};
//# sourceMappingURL=dist_drift.js.map