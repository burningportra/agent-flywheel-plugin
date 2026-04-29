/**
 * Regression spec for bead claude-orchestrator-2eg —
 * cli_binary remediation handlers (br/bv/ntm/cm).
 *
 * Verifies:
 *   1. Each of the four flywheel-owned CLI checks has a registered handler
 *      (no longer null in REMEDIATION_REGISTRY).
 *   2. buildPlan returns the canonical curl|bash installer for each binary,
 *      mirroring commands/flywheel-setup.md.
 *   3. execute shells out via `bash -lc <installer>` so login PATH is
 *      honoured (cargo/.local/bin/brew shellenv).
 *   4. verifyProbe re-checks `<binary> --version` (with --help fallback) and
 *      returns true only when the binary actually resolves on PATH.
 *   5. Mutating dry_run is accepted; mutating execute without autoConfirm is
 *      rejected with `remediation_requires_confirm`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMEDIATION_REGISTRY, runRemediate } from '../../tools/remediate.js';
import { _resetForTest as resetMutex } from '../../mutex.js';
const CLI_CHECKS = ['br_binary', 'bv_binary', 'ntm_binary', 'cm_binary'];
const EXPECTED_BINARY = {
    br_binary: 'br',
    bv_binary: 'bv',
    ntm_binary: 'ntm',
    cm_binary: 'cm',
};
function makeTmpRoot() {
    return mkdtempSync(join(tmpdir(), 'cli-binary-rem-'));
}
function cleanup(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
}
describe('cli_binary remediation handlers (claude-orchestrator-2eg)', () => {
    beforeEach(() => resetMutex());
    for (const name of CLI_CHECKS) {
        describe(name, () => {
            it('is registered with a non-null handler', () => {
                expect(REMEDIATION_REGISTRY[name]).not.toBeNull();
            });
            it('declares itself mutating + reversible', () => {
                const h = REMEDIATION_REGISTRY[name];
                expect(h.mutating).toBe(true);
                expect(h.reversible).toBe(true);
            });
            it('plan steps reference the binary install command', async () => {
                const cwd = makeTmpRoot();
                try {
                    const exec = async () => ({ code: 0, stdout: '', stderr: '' });
                    const result = await runRemediate({ cwd, checkName: name, autoConfirm: false, mode: 'dry_run' }, exec, new AbortController().signal);
                    expect('check' in result).toBe(true);
                    const ok = result;
                    expect(ok.plan.steps.length).toBeGreaterThan(0);
                    // All four use a curl|bash one-liner.
                    expect(ok.plan.steps[0]).toMatch(/curl -fsSL/);
                    expect(ok.plan.steps[0]).toMatch(/install\.sh/);
                    expect(ok.plan.mutating).toBe(true);
                }
                finally {
                    cleanup(cwd);
                }
            });
            it('execute without autoConfirm is rejected with remediation_requires_confirm', async () => {
                const cwd = makeTmpRoot();
                try {
                    const exec = async () => ({ code: 0, stdout: '', stderr: '' });
                    const result = await runRemediate({ cwd, checkName: name, autoConfirm: false, mode: 'execute' }, exec, new AbortController().signal);
                    // makeFlywheelErrorResult shape
                    const err = result;
                    expect(err.isError).toBe(true);
                    expect(err.structuredContent.data.error.code).toBe('remediation_requires_confirm');
                }
                finally {
                    cleanup(cwd);
                }
            });
            it('execute with autoConfirm shells out via `bash -lc` and re-probes the binary', async () => {
                const cwd = makeTmpRoot();
                try {
                    const calls = [];
                    const exec = async (cmd, args, _opts) => {
                        calls.push({ cmd, args });
                        // Installer succeeds; verify probe (bash -lc 'command -v ... && --version') succeeds too.
                        return { code: 0, stdout: '1.2.3', stderr: '' };
                    };
                    const result = await runRemediate({ cwd, checkName: name, autoConfirm: true, mode: 'execute' }, exec, new AbortController().signal);
                    // Did NOT error.
                    expect('isError' in result && result.isError).not.toBe(true);
                    const ok = result;
                    expect(ok.executed).toBe(true);
                    expect(ok.stepsRun).toBe(1);
                    expect(ok.verifiedGreen).toBe(true);
                    // First call: installer via bash -lc.
                    expect(calls[0].cmd).toBe('bash');
                    expect(calls[0].args[0]).toBe('-lc');
                    expect(calls[0].args[1]).toMatch(/curl -fsSL/);
                    // Subsequent verify call: bash -lc with the binary's --version probe.
                    const verifyCall = calls.find((c, i) => i > 0 &&
                        c.cmd === 'bash' &&
                        c.args[0] === '-lc' &&
                        typeof c.args[1] === 'string' &&
                        c.args[1].includes(EXPECTED_BINARY[name]) &&
                        c.args[1].includes('--version'));
                    expect(verifyCall).toBeDefined();
                }
                finally {
                    cleanup(cwd);
                }
            });
            it('verifyProbe returns false when the binary is still missing after install', async () => {
                const cwd = makeTmpRoot();
                try {
                    let installCallCount = 0;
                    const exec = async (cmd, args, _opts) => {
                        // First call (the installer) succeeds; subsequent verify probes
                        // (command -v / --version / --help) fail to simulate a network
                        // or permission error during install.
                        if (cmd === 'bash' && args[0] === '-lc' && installCallCount === 0) {
                            installCallCount += 1;
                            return { code: 0, stdout: 'installed', stderr: '' };
                        }
                        return { code: 127, stdout: '', stderr: 'command not found' };
                    };
                    const result = await runRemediate({ cwd, checkName: name, autoConfirm: true, mode: 'execute' }, exec, new AbortController().signal);
                    const ok = result;
                    expect(ok.executed).toBe(true);
                    expect(ok.verifiedGreen).toBe(false);
                }
                finally {
                    cleanup(cwd);
                }
            });
        });
    }
});
//# sourceMappingURL=cli-binary-remediation.test.js.map