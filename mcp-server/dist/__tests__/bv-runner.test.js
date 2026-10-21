/**
 * Bead agent-flywheel-plugin-jl5 — runBvRobot unit tests.
 *
 * Coverage: all four --robot-* modes run with explicit timeout + signal
 * propagation; missing/non-zero/unparsable bv degrades to available:false;
 * aborted signal short-circuits without exec.
 */
import { describe, it, expect, vi } from 'vitest';
import { runBvRobot, BV_ROBOT_TIMEOUT_MS } from '../bv-runner.js';
function mockExec(result) {
    return (async () => result);
}
describe('runBvRobot', () => {
    for (const mode of ['triage', 'next', 'plan', 'insights']) {
        it(`runs bv --robot-${mode} with default timeout and parses JSON`, async () => {
            const seen = [];
            const exec = (async (cmd, args, opts) => {
                seen.push({ cmd, args, opts });
                return { code: 0, stdout: JSON.stringify({ mode, ok: true }), stderr: '' };
            });
            const r = await runBvRobot(exec, '/repo', mode, {});
            expect(r.available).toBe(true);
            expect(r.data).toEqual({ mode, ok: true });
            expect(seen).toHaveLength(1);
            expect(seen[0].cmd).toBe('bv');
            expect(seen[0].args).toEqual([`--robot-${mode}`]);
            expect(seen[0].opts.timeout).toBe(BV_ROBOT_TIMEOUT_MS);
        });
    }
    it('passes custom timeout and AbortSignal through to exec', async () => {
        const controller = new AbortController();
        let captured;
        const exec = (async (_cmd, _args, opts) => {
            captured = opts;
            return { code: 0, stdout: '{}', stderr: '' };
        });
        await runBvRobot(exec, '/repo', 'triage', { timeout: 1234, signal: controller.signal });
        expect(captured).toMatchObject({ timeout: 1234, signal: controller.signal });
    });
    it('degrades gracefully when bv is missing (exec rejects)', async () => {
        const exec = (async () => {
            throw new Error('spawn bv ENOENT');
        });
        const r = await runBvRobot(exec, '/repo', 'next', {});
        expect(r.available).toBe(false);
        expect(r.warning).toContain('unavailable');
    });
    it('degrades gracefully on non-zero exit', async () => {
        const r = await runBvRobot(mockExec({ code: 1, stdout: '', stderr: 'boom' }), '/repo', 'plan', {});
        expect(r.available).toBe(false);
        expect(r.warning).toContain('exited 1');
    });
    it('degrades gracefully on unparsable output', async () => {
        const r = await runBvRobot(mockExec({ code: 0, stdout: 'not json', stderr: '' }), '/repo', 'insights', {});
        expect(r.available).toBe(false);
        expect(r.warning).toContain('not JSON');
    });
    it('short-circuits on aborted signal without calling exec', async () => {
        const controller = new AbortController();
        controller.abort();
        const exec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
        const r = await runBvRobot(exec, '/repo', 'triage', { signal: controller.signal });
        expect(r.available).toBe(false);
        expect(exec).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=bv-runner.test.js.map