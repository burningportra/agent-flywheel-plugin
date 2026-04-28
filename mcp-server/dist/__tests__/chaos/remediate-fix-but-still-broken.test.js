/**
 * Chaos test: handler.execute returns success (exit 0) but verifyProbe says
 * the underlying condition is still broken. The dispatcher must surface
 * `verifiedGreen: false` and the handler must emit a warn-level log line.
 *
 * Scenario: dist_drift "build" succeeds but verifyProbe still detects drift
 * (we craft mtimes so newest src .ts is *newer* than newest dist file).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { runRemediate } from '../../tools/remediate.js';
import { _resetForTest as resetMutex } from '../../mutex.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, } from './_helpers.js';
describe('chaos/remediate-fix-but-still-broken', () => {
    beforeEach(() => {
        resetMutex();
    });
    it('execute exits 0 but verifyProbe false → verifiedGreen:false + warn', async () => {
        const cwd = makeTmpCwd();
        try {
            // Set up: src has a brand-new .ts; dist has only an old .js. Build
            // succeeds (mocked), but mtimes still indicate drift, so verifyProbe
            // returns false.
            const srcDir = join(cwd, 'mcp-server', 'src');
            mkdirSync(srcDir, { recursive: true });
            const srcFile = join(srcDir, 'fresh.ts');
            writeFileSync(srcFile, '// fresh\n');
            const now = Date.now() / 1000;
            utimesSync(srcFile, now, now);
            const distFile = join(cwd, 'mcp-server', 'dist', 'server.js'); // already exists from makeTmpCwd
            const past = now - 3600; // 1h old
            utimesSync(distFile, past, past);
            // Capture stderr (createLogger writes JSON lines to process.stderr).
            const writes = [];
            const originalWrite = process.stderr.write.bind(process.stderr);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            process.stderr.write = ((chunk) => {
                writes.push(String(chunk));
                return true;
            });
            try {
                const exec = makeExecFn([
                    {
                        match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
                        respond: { result: { code: 0, stdout: 'compiled', stderr: '' } },
                    },
                ]);
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' }, exec, ac.signal);
                expect('check' in result).toBe(true);
                const ok = result;
                expect(ok.executed).toBe(true);
                expect(ok.stepsRun).toBe(1);
                expect(ok.verifiedGreen).toBe(false);
            }
            finally {
                process.stderr.write = originalWrite;
            }
            const warnLines = writes.filter((l) => l.includes('"level":"warn"') && l.includes('verifyProbe still detects drift'));
            expect(warnLines.length).toBeGreaterThan(0);
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
});
//# sourceMappingURL=remediate-fix-but-still-broken.test.js.map