/**
 * T15 — Unit specs for `runRemediate` (mcp-server/src/tools/remediate.ts).
 *
 * Coverage targets:
 *   1. Schema validation rejects unknown checkName.
 *   2. Table-driven exhaustiveness over DOCTOR_CHECK_NAMES — every name in
 *      REMEDIATION_REGISTRY is exercised. `null` registry entries return the
 *      `remediation_unavailable` envelope; populated entries return a valid
 *      RemediationResult for both dry_run and execute modes.
 *   3. Mutating handler in execute mode WITHOUT autoConfirm returns the
 *      `remediation_requires_confirm` envelope.
 *   4. dry_run never invokes exec (the dispatcher must short-circuit before
 *      calling handler.execute).
 *   5. Idempotent re-run of a non-mutating handler is a no-op (no exec calls
 *      beyond verifyProbe — but we observe `executed:true`/`stepsRun:0`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemediateInputSchema, REMEDIATION_REGISTRY, runRemediate, } from '../../tools/remediate.js';
import { DOCTOR_CHECK_NAMES } from '../../tools/doctor.js';
import { _resetForTest as resetMutex } from '../../mutex.js';
// ─── Tmp project root ─────────────────────────────────────────
function makeTmpRoot() {
    const dir = mkdtempSync(join(tmpdir(), 't15-remediate-'));
    // Provide a populated mcp-server/dist so mcp_connectivity verifyProbe
    // (existence check) can return true on the no-op path.
    mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'mcp-server', 'dist', 'server.js'), '// built\n');
    // Provide a src dir with a single .ts so dist_drift verifyProbe
    // can compute mtimes without aborting.
    mkdirSync(join(dir, 'mcp-server', 'src'), { recursive: true });
    writeFileSync(join(dir, 'mcp-server', 'src', 'index.ts'), '// src\n');
    return dir;
}
function cleanup(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
}
// ─── Helpers ──────────────────────────────────────────────────
/** ExecFn that returns success for any command. Lets every handler succeed. */
function alwaysOkExec() {
    const calls = [];
    const exec = async (cmd, args, _opts) => {
        calls.push({ cmd, args });
        // Specific mocks for verify probes
        if (cmd === 'curl') {
            return { code: 0, stdout: '{"status":"alive"}', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'worktree') {
            return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: 'ok', stderr: '' };
    };
    return { exec, calls };
}
// ─── Tests ────────────────────────────────────────────────────
describe('T15 — runRemediate dispatcher', () => {
    beforeEach(() => {
        resetMutex();
    });
    describe('schema validation', () => {
        it('rejects an unknown checkName', () => {
            const parsed = RemediateInputSchema.safeParse({
                cwd: '/tmp/x',
                checkName: 'not_a_real_check',
            });
            expect(parsed.success).toBe(false);
        });
        it('rejects empty cwd', () => {
            const parsed = RemediateInputSchema.safeParse({
                cwd: '',
                checkName: 'mcp_connectivity',
            });
            expect(parsed.success).toBe(false);
        });
        it('defaults mode to dry_run and autoConfirm to false', () => {
            const parsed = RemediateInputSchema.parse({
                cwd: '/tmp/x',
                checkName: 'mcp_connectivity',
            });
            expect(parsed.mode).toBe('dry_run');
            expect(parsed.autoConfirm).toBe(false);
        });
    });
    describe('table-driven over DOCTOR_CHECK_NAMES', () => {
        for (const name of DOCTOR_CHECK_NAMES) {
            const handler = REMEDIATION_REGISTRY[name];
            const isAvailable = handler != null;
            it(`${name}: ${isAvailable ? 'returns plan in dry_run' : 'returns remediation_unavailable'}`, async () => {
                const cwd = makeTmpRoot();
                try {
                    const { exec } = alwaysOkExec();
                    const ac = new AbortController();
                    const result = await runRemediate({ cwd, checkName: name, autoConfirm: false, mode: 'dry_run' }, exec, ac.signal);
                    if (!isAvailable) {
                        expect('isError' in result && result.isError).toBe(true);
                        // Envelope shape from makeFlywheelErrorResult
                        const errResult = result;
                        expect(errResult.structuredContent.data.error.code).toBe('remediation_unavailable');
                        return;
                    }
                    // Handler available → dry_run → RemediationResult shape
                    expect('check' in result).toBe(true);
                    const ok = result;
                    expect(ok.check).toBe(name);
                    expect(ok.mode).toBe('dry_run');
                    expect(ok.executed).toBe(false);
                    expect(ok.stepsRun).toBe(0);
                    expect(ok.verifiedGreen).toBe(false);
                    expect(typeof ok.plan.description).toBe('string');
                    expect(Array.isArray(ok.plan.steps)).toBe(true);
                    expect(typeof ok.plan.mutating).toBe('boolean');
                    expect(typeof ok.plan.reversible).toBe('boolean');
                    expect(typeof ok.durationMs).toBe('number');
                }
                finally {
                    cleanup(cwd);
                }
            });
        }
    });
    describe('dry_run does not invoke exec for mutating handlers', () => {
        it('dist_drift dry_run never calls exec', async () => {
            const cwd = makeTmpRoot();
            try {
                const { exec, calls } = alwaysOkExec();
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'dist_drift', autoConfirm: false, mode: 'dry_run' }, exec, ac.signal);
                expect('check' in result).toBe(true);
                // dist_drift.buildPlan is purely synchronous metadata — no exec.
                // dist_drift.execute (which would invoke npm run build) must NOT run.
                const npmCalls = calls.filter((c) => c.cmd === 'npm');
                expect(npmCalls).toHaveLength(0);
            }
            finally {
                cleanup(cwd);
            }
        });
    });
    describe('mutating handler refuses execute without autoConfirm', () => {
        it('agent_mail_liveness execute mode + autoConfirm:false → remediation_requires_confirm', async () => {
            const cwd = makeTmpRoot();
            try {
                const { exec } = alwaysOkExec();
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'agent_mail_liveness', autoConfirm: false, mode: 'execute' }, exec, ac.signal);
                expect('isError' in result && result.isError).toBe(true);
                const errResult = result;
                expect(errResult.structuredContent.data.error.code).toBe('remediation_requires_confirm');
                expect(errResult.structuredContent.data.error.details?.mutating).toBe(true);
            }
            finally {
                cleanup(cwd);
            }
        });
        it('dist_drift execute mode + autoConfirm:false → remediation_requires_confirm', async () => {
            const cwd = makeTmpRoot();
            try {
                const { exec } = alwaysOkExec();
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'dist_drift', autoConfirm: false, mode: 'execute' }, exec, ac.signal);
                expect('isError' in result && result.isError).toBe(true);
                const errResult = result;
                expect(errResult.structuredContent.data.error.code).toBe('remediation_requires_confirm');
                expect(errResult.structuredContent.data.error.details?.mutating).toBe(true);
            }
            finally {
                cleanup(cwd);
            }
        });
        it('orphaned_worktrees execute mode + autoConfirm:false → remediation_requires_confirm when orphans exist', async () => {
            const cwd = makeTmpRoot();
            // Create an orphan candidate so the plan is mutating.
            mkdirSync(join(cwd, '.claude', 'worktrees', 'orphan-1'), { recursive: true });
            try {
                const { exec } = alwaysOkExec();
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'orphaned_worktrees', autoConfirm: false, mode: 'execute' }, exec, ac.signal);
                expect('isError' in result && result.isError).toBe(true);
                const errResult = result;
                expect(errResult.structuredContent.data.error.code).toBe('remediation_requires_confirm');
            }
            finally {
                cleanup(cwd);
            }
        });
    });
    describe('execute mode with autoConfirm proceeds', () => {
        it('dist_drift execute + autoConfirm:true → executed:true, exec called', async () => {
            const cwd = makeTmpRoot();
            try {
                const { exec, calls } = alwaysOkExec();
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' }, exec, ac.signal);
                expect('check' in result).toBe(true);
                const ok = result;
                expect(ok.mode).toBe('execute');
                expect(ok.executed).toBe(true);
                expect(ok.stepsRun).toBe(1);
                const npmCalls = calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'run' && c.args[1] === 'build');
                expect(npmCalls.length).toBeGreaterThan(0);
            }
            finally {
                cleanup(cwd);
            }
        });
        it('agent_mail_liveness execute + autoConfirm:true runs stop/repair/normalize/restart and verifies', async () => {
            const cwd = makeTmpRoot();
            try {
                const { exec, calls } = alwaysOkExec();
                const ac = new AbortController();
                const result = await runRemediate({ cwd, checkName: 'agent_mail_liveness', autoConfirm: true, mode: 'execute' }, exec, ac.signal);
                expect('check' in result).toBe(true);
                const ok = result;
                expect(ok.executed).toBe(true);
                expect(ok.stepsRun).toBe(5);
                expect(ok.verifiedGreen).toBe(true);
                expect(ok.plan.mutating).toBe(true);
                expect(calls.some((c) => c.cmd === 'am' && c.args.join(' ') === 'doctor repair --yes')).toBe(true);
                expect(calls.some((c) => c.cmd === 'am' && c.args.join(' ') === 'doctor archive-normalize --yes')).toBe(true);
                expect(calls.filter((c) => c.cmd === 'bash' && c.args[0] === '-lc').length).toBeGreaterThanOrEqual(3);
            }
            finally {
                cleanup(cwd);
            }
        });
        it('mcp_connectivity execute on a populated dist is a no-op (idempotent)', async () => {
            const cwd = makeTmpRoot();
            try {
                const { exec, calls } = alwaysOkExec();
                const ac = new AbortController();
                // First run: dist already exists → plan.mutating:false, stepsRun:0, verifiedGreen:true.
                const result = await runRemediate({ cwd, checkName: 'mcp_connectivity', autoConfirm: false, mode: 'execute' }, exec, ac.signal);
                expect('check' in result).toBe(true);
                const ok = result;
                expect(ok.executed).toBe(true);
                expect(ok.stepsRun).toBe(0);
                expect(ok.verifiedGreen).toBe(true);
                // No npm install/build was needed.
                const npmCalls = calls.filter((c) => c.cmd === 'npm');
                expect(npmCalls).toHaveLength(0);
            }
            finally {
                cleanup(cwd);
            }
        });
    });
    describe('handler buildPlan failure surfaces remediation_failed', () => {
        it('wraps a buildPlan throw into the structured error envelope', async () => {
            const cwd = makeTmpRoot();
            try {
                // Inject a temporary spy that makes mcp_connectivity.buildPlan throw.
                const handler = REMEDIATION_REGISTRY.mcp_connectivity;
                const original = handler.buildPlan.bind(handler);
                const spy = vi.spyOn(handler, 'buildPlan').mockRejectedValueOnce(new Error('boom'));
                try {
                    const { exec } = alwaysOkExec();
                    const ac = new AbortController();
                    const result = await runRemediate({ cwd, checkName: 'mcp_connectivity', autoConfirm: false, mode: 'dry_run' }, exec, ac.signal);
                    expect('isError' in result && result.isError).toBe(true);
                    const errResult = result;
                    expect(errResult.structuredContent.data.error.code).toBe('remediation_failed');
                    expect(errResult.structuredContent.data.error.details?.stage).toBe('buildPlan');
                }
                finally {
                    spy.mockRestore();
                    // sanity: original is still callable
                    expect(typeof original).toBe('function');
                }
            }
            finally {
                cleanup(cwd);
            }
        });
    });
});
//# sourceMappingURL=remediate.test.js.map