/**
 * mcp_connectivity remediation — ensure mcp-server build artefacts are present.
 *
 * The doctor check probes whether `mcp-server/dist/server.js` exists. If
 * missing, we run `npm ci && npm run build` (mutating only when missing).
 * verifyProbe re-runs the existence check.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { resolveRealpathWithinRoot } from '../../utils/path-safety.js';
const log = createLogger('remediation.mcp_connectivity');
const NPM_CI_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 120_000;
function distServerExists(cwd) {
    const r = resolveRealpathWithinRoot(join('mcp-server', 'dist', 'server.js'), {
        root: cwd,
        label: 'mcp-server/dist/server.js',
        rootLabel: 'cwd',
    });
    return r.ok && existsSync(r.realPath);
}
export const mcpConnectivityHandler = {
    description: 'Verify mcp-server/dist/server.js exists; install + build when missing.',
    // The plan flips mutating:true when build is required (see buildPlan).
    mutating: false,
    reversible: true,
    async buildPlan(ctx) {
        const present = distServerExists(ctx.cwd);
        if (present) {
            return {
                description: 'mcp-server/dist/server.js already present — no action required.',
                steps: [],
                mutating: false,
                reversible: true,
            };
        }
        return {
            description: 'mcp-server/dist/server.js missing — run `npm ci && npm run build` inside mcp-server/.',
            steps: ['cd mcp-server && npm ci', 'cd mcp-server && npm run build'],
            mutating: true,
            reversible: true,
        };
    },
    async execute(ctx) {
        if (distServerExists(ctx.cwd)) {
            return { stepsRun: 0 };
        }
        const cwd = join(ctx.cwd, 'mcp-server');
        const ci = await ctx.exec('npm', ['ci'], {
            cwd,
            timeout: NPM_CI_TIMEOUT_MS,
            signal: ctx.signal,
        });
        if (ci.code !== 0) {
            log.warn('npm ci exited non-zero', { exitCode: ci.code });
            return { stepsRun: 1, stdout: ci.stdout, stderr: ci.stderr };
        }
        const build = await ctx.exec('npm', ['run', 'build'], {
            cwd,
            timeout: BUILD_TIMEOUT_MS,
            signal: ctx.signal,
        });
        if (build.code !== 0)
            log.warn('npm run build exited non-zero', { exitCode: build.code });
        return {
            stepsRun: 2,
            stdout: `${ci.stdout}\n${build.stdout}`,
            stderr: `${ci.stderr}\n${build.stderr}`,
        };
    },
    async verifyProbe(ctx) {
        const present = distServerExists(ctx.cwd);
        if (!present)
            log.warn('verifyProbe: dist/server.js still missing after remediation');
        return present;
    },
};
//# sourceMappingURL=mcp_connectivity.js.map