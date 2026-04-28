/**
 * Chaos test: headless / CI use case.
 *
 * Simulates `process.stdin.isTTY === false` (no terminal) AND
 * `autoConfirm: true`. The dispatcher MUST proceed — it must not block on
 * any interactive confirm. This is the canonical CI invocation pattern.
 *
 * The dispatcher itself does not consult `process.stdin.isTTY` (the gate is
 * autoConfirm), so the goal here is to assert the contract holds even when
 * stdin is non-TTY: a mutating handler in execute mode with autoConfirm:true
 * runs to completion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runRemediate } from '../../tools/remediate.js';
import { _resetForTest as resetMutex } from '../../mutex.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, } from './_helpers.js';
describe('chaos/remediate-headless', () => {
    const originalIsTTY = process.stdin.isTTY;
    beforeEach(() => {
        resetMutex();
        // Force non-TTY (CI scenario). Some CI runners already report this; we
        // override anyway so the test is deterministic.
        Object.defineProperty(process.stdin, 'isTTY', {
            value: false,
            configurable: true,
        });
    });
    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', {
            value: originalIsTTY,
            configurable: true,
        });
    });
    it('headless + autoConfirm:true proceeds through execute', async () => {
        const cwd = makeTmpCwd();
        try {
            expect(process.stdin.isTTY).toBeFalsy();
            const exec = makeExecFn([
                {
                    match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
                    respond: { result: { code: 0, stdout: 'built', stderr: '' } },
                },
            ]);
            const ac = new AbortController();
            const result = await runRemediate({ cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' }, exec, ac.signal);
            expect('check' in result).toBe(true);
            const ok = result;
            expect(ok.mode).toBe('execute');
            expect(ok.executed).toBe(true);
            expect(ok.stepsRun).toBe(1);
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
    it('headless + autoConfirm:false on mutating handler still refuses (no implicit confirm)', async () => {
        const cwd = makeTmpCwd();
        try {
            expect(process.stdin.isTTY).toBeFalsy();
            const exec = makeExecFn([
                {
                    match: (cmd) => cmd === 'npm',
                    respond: { result: { code: 0, stdout: '', stderr: '' } },
                },
            ]);
            const ac = new AbortController();
            const result = await runRemediate({ cwd, checkName: 'dist_drift', autoConfirm: false, mode: 'execute' }, exec, ac.signal);
            expect('isError' in result && result.isError).toBe(true);
            const errResult = result;
            expect(errResult.structuredContent.data.error.code).toBe('remediation_requires_confirm');
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
});
//# sourceMappingURL=remediate-headless.test.js.map