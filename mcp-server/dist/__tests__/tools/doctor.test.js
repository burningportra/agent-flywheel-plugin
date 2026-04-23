import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctorChecks, computeOverallSeverity, DOCTOR_CHECK_NAMES, } from '../../tools/doctor.js';
// ─── Shared helpers ───────────────────────────────────────────────────────
function makeTmpCwd() {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    // Always create a minimal dist/server.js that is newer than any src so
    // the mcp_connectivity + dist_drift checks can stay green when we want.
    mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'mcp-server', 'dist', 'server.js'), '// built\n');
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
function makeStubbedExec(stubs) {
    return async (cmd, args, opts) => {
        if (opts?.signal?.aborted)
            throw new Error('Aborted');
        const stub = stubs.find((s) => s.match(cmd, args));
        if (!stub) {
            return { code: 1, stdout: '', stderr: `not mocked: ${cmd} ${args.join(' ')}` };
        }
        if ('throws' in stub.respond) {
            throw stub.respond.throws;
        }
        if ('hangMs' in stub.respond) {
            const { hangMs, result } = stub.respond;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve(result), hangMs);
                if (opts?.signal) {
                    opts.signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new Error('Aborted'));
                    }, { once: true });
                }
                if (opts?.timeout) {
                    setTimeout(() => {
                        clearTimeout(timer);
                        reject(new Error(`Timed out after ${opts.timeout}ms: ${cmd}`));
                    }, opts.timeout);
                }
            });
        }
        return stub.respond.result;
    };
}
/** Build a stub set that turns all exec-based checks green. */
function allGreenStubs() {
    const ok = (stdout) => ({ result: { code: 0, stdout, stderr: '' } });
    return [
        {
            match: (cmd, args) => cmd === 'curl' && args.includes('http://127.0.0.1:8765/health/liveness'),
            respond: ok('{"status":"alive"}'),
        },
        { match: (cmd, args) => cmd === 'br' && args[0] === '--version', respond: ok('br 0.1.0') },
        { match: (cmd, args) => cmd === 'bv' && args[0] === '--version', respond: ok('bv 0.1.0') },
        { match: (cmd, args) => cmd === 'ntm' && args[0] === '--version', respond: ok('ntm 0.1.0') },
        { match: (cmd, args) => cmd === 'cm' && args[0] === '--version', respond: ok('cm 0.1.0') },
        // `rescues_last_30d` synthesis row queries `cm search flywheel-rescue --json`.
        // Empty array → 0 rescues → green.
        {
            match: (cmd, args) => cmd === 'cm' && args[0] === 'search' && args[1] === 'flywheel-rescue',
            respond: ok('[]'),
        },
        { match: (cmd, args) => cmd === 'node' && args[0] === '--version', respond: ok('v22.0.0') },
        { match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse', respond: ok('abc123') },
        {
            match: (cmd, args) => cmd === 'git' && args[0] === 'status',
            respond: ok(''), // clean
        },
        {
            match: (cmd, args) => cmd === 'git' && args[0] === 'worktree',
            respond: ok(''),
        },
        // Swarm-agent CLI detection (claude/codex/gemini at 1:1:1).
        {
            match: (cmd, args) => cmd === 'which' && args[0] === 'claude',
            respond: ok('/usr/local/bin/claude'),
        },
        {
            match: (cmd, args) => cmd === 'which' && args[0] === 'codex',
            respond: ok('/usr/local/bin/codex'),
        },
        {
            match: (cmd, args) => cmd === 'which' && args[0] === 'gemini',
            respond: ok('/usr/local/bin/gemini'),
        },
    ];
}
// ─── computeOverallSeverity ───────────────────────────────────────────────
describe('computeOverallSeverity', () => {
    const mk = (sev) => ({
        name: 'x',
        severity: sev,
        message: '',
    });
    it('returns green when all checks are green', () => {
        expect(computeOverallSeverity([mk('green'), mk('green')])).toBe('green');
    });
    it('returns yellow when any check is yellow and none are red', () => {
        expect(computeOverallSeverity([mk('green'), mk('yellow'), mk('green')])).toBe('yellow');
    });
    it('returns red when any check is red (even with yellows)', () => {
        expect(computeOverallSeverity([mk('green'), mk('yellow'), mk('red')])).toBe('red');
    });
    it('returns green for an empty list', () => {
        expect(computeOverallSeverity([])).toBe('green');
    });
});
// ─── runDoctorChecks ──────────────────────────────────────────────────────
describe('runDoctorChecks', () => {
    it('happy path — all 11 checks green yields overall green', async () => {
        const cwd = makeTmpCwd();
        try {
            const exec = makeStubbedExec(allGreenStubs());
            const report = await runDoctorChecks(cwd, undefined, { exec });
            expect(report.version).toBe(1);
            expect(report.cwd).toBe(cwd);
            expect(report.partial).toBe(false);
            expect(report.checks).toHaveLength(DOCTOR_CHECK_NAMES.length);
            const names = report.checks.map((c) => c.name).sort();
            expect(names).toEqual([...DOCTOR_CHECK_NAMES].sort());
            expect(report.overall).toBe('green');
            for (const c of report.checks) {
                expect(c.severity).toBe('green');
            }
            expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
            expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('pre-aborted signal returns partial report with empty checks', async () => {
        const cwd = makeTmpCwd();
        try {
            const ac = new AbortController();
            ac.abort();
            const exec = makeStubbedExec(allGreenStubs());
            const report = await runDoctorChecks(cwd, ac.signal, { exec });
            expect(report.partial).toBe(true);
            expect(report.checks).toEqual([]);
            expect(report.overall).toBe('red');
            expect(report.elapsedMs).toBe(0);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('mid-sweep abort short-circuits slow checks without blocking the sweep', async () => {
        const cwd = makeTmpCwd();
        try {
            // All exec checks hang for 30s — the only way the sweep returns quickly
            // is if the abort signal short-circuits them.
            const hang = { hangMs: 30_000, result: { code: 0, stdout: '', stderr: '' } };
            const exec = makeStubbedExec([
                { match: () => true, respond: hang },
            ]);
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 50);
            const start = Date.now();
            const report = await runDoctorChecks(cwd, ac.signal, {
                exec,
                perCheckTimeoutMs: 60_000, // don't let per-check timeout mask the abort
                totalBudgetMs: 60_000,
            });
            const elapsed = Date.now() - start;
            // Should exit well before any 30s hang completes.
            expect(elapsed).toBeLessThan(5_000);
            expect(report.partial).toBe(true);
            // Non-exec checks (mcp_connectivity, dist_drift, checkpoint_validity) can
            // still complete even when exec is hanging — that is fine. What matters
            // is that exec-bound checks do NOT block.
            expect(report.checks.length).toBe(DOCTOR_CHECK_NAMES.length);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('absent required binary (br) → red entry; tool does not throw', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('br', ['--version']));
            stubs.push({
                match: (cmd, args) => cmd === 'br' && args[0] === '--version',
                respond: { throws: Object.assign(new Error('spawn br ENOENT'), { code: 'ENOENT' }) },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const br = report.checks.find((c) => c.name === 'br_binary');
            expect(br).toBeDefined();
            expect(br.severity).toBe('red');
            expect(br.message.toLowerCase()).toContain('br');
            expect(report.overall).toBe('red');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('absent optional binary (bv) → yellow entry, not red', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('bv', ['--version']));
            stubs.push({
                match: (cmd, args) => cmd === 'bv' && args[0] === '--version',
                respond: { throws: Object.assign(new Error('spawn bv ENOENT'), { code: 'ENOENT' }) },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const bv = report.checks.find((c) => c.name === 'bv_binary');
            expect(bv).toBeDefined();
            expect(bv.severity).toBe('yellow');
            expect(report.overall).not.toBe('red');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('per-check timeout classifies hanging exec check as yellow without stalling the sweep', async () => {
        const cwd = makeTmpCwd();
        try {
            // ntm hangs longer than perCheckTimeout — makeStubbedExec honors opts.timeout.
            const stubs = allGreenStubs().filter((s) => !s.match('ntm', ['--version']));
            stubs.push({
                match: (cmd, args) => cmd === 'ntm' && args[0] === '--version',
                respond: { hangMs: 5_000, result: { code: 0, stdout: 'ntm 0.1.0', stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const start = Date.now();
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                perCheckTimeoutMs: 100,
                totalBudgetMs: 10_000,
            });
            const elapsed = Date.now() - start;
            // Sweep must exit well before the 5s hang.
            expect(elapsed).toBeLessThan(3_000);
            const ntm = report.checks.find((c) => c.name === 'ntm_binary');
            expect(ntm).toBeDefined();
            // Hanging ntm surfaces as yellow (timeout branch of optional-binary check).
            expect(ntm.severity).toBe('yellow');
            // Other checks still complete.
            const br = report.checks.find((c) => c.name === 'br_binary');
            expect(br.severity).toBe('green');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('dirty git working tree → yellow git_status entry', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !(s.match('git', ['status', '--porcelain'])));
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'status',
                respond: { result: { code: 0, stdout: ' M foo.ts\n?? bar.ts\n', stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const git = report.checks.find((c) => c.name === 'git_status');
            expect(git.severity).toBe('yellow');
            expect(git.message).toMatch(/2 changed/);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('agent mail connection refused → red entry', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:8765/health/liveness']));
            stubs.push({
                match: (cmd) => cmd === 'curl',
                respond: { result: { code: 7, stdout: '', stderr: 'connection refused' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const mail = report.checks.find((c) => c.name === 'agent_mail_liveness');
            expect(mail.severity).toBe('red');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('agent mail reachable but not alive → yellow entry', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:8765/health/liveness']));
            stubs.push({
                match: (cmd) => cmd === 'curl',
                respond: { result: { code: 0, stdout: '{"status":"degraded"}', stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const mail = report.checks.find((c) => c.name === 'agent_mail_liveness');
            expect(mail.severity).toBe('yellow');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('dist drift: src file newer than dist → red dist_drift entry', async () => {
        const cwd = makeTmpCwd();
        try {
            // Write a src/.ts file AFTER dist/server.js (which makeTmpCwd wrote).
            mkdirSync(join(cwd, 'mcp-server', 'src'), { recursive: true });
            // Slight delay to ensure mtime differs on fast filesystems.
            await new Promise((r) => setTimeout(r, 15));
            writeFileSync(join(cwd, 'mcp-server', 'src', 'server.ts'), '// new\n');
            const exec = makeStubbedExec(allGreenStubs());
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const drift = report.checks.find((c) => c.name === 'dist_drift');
            expect(drift.severity).toBe('red');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('orphaned worktree directory → yellow entry', async () => {
        const cwd = makeTmpCwd();
        try {
            mkdirSync(join(cwd, '.claude', 'worktrees', 'ghost'), { recursive: true });
            const stubs = allGreenStubs().filter((s) => !s.match('git', ['worktree', 'list', '--porcelain']));
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'worktree',
                // git reports only the main worktree — no "ghost" registration.
                respond: { result: { code: 0, stdout: `worktree ${cwd}\nHEAD abc\n`, stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const worktrees = report.checks.find((c) => c.name === 'orphaned_worktrees');
            expect(worktrees.severity).toBe('yellow');
            expect(worktrees.message).toContain('ghost');
        }
        finally {
            cleanup(cwd);
        }
    });
});
//# sourceMappingURL=doctor.test.js.map