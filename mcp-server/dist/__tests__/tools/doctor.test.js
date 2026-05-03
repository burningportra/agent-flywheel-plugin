import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctorChecks, computeOverallSeverity, countCriticalFails, diffVersionTriple, readManifestVersion, DOCTOR_CHECK_NAMES, parseCodexConfigTopLevelModel, isCodexIncompatibleModel, countLocalTelemetryRescuesWithin30Days, } from '../../tools/doctor.js';
// ─── Shared helpers ───────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
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
        // `rescues_last_30d` synthesis row queries `cm context flywheel-rescue --json`.
        // Empty array → 0 rescues → green.
        {
            match: (cmd, args) => cmd === 'cm' && args[0] === 'context' && args[1] === 'flywheel-rescue',
            respond: ok(JSON.stringify({
                success: true,
                data: { relevantBullets: [], historySnippets: [] },
            })),
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
describe('countLocalTelemetryRescuesWithin30Days', () => {
    const now = Date.UTC(2026, 3, 27, 12, 0, 0);
    const within = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const outside = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString();
    it('counts only rescue-coded local telemetry events in the 30-day window', () => {
        expect(countLocalTelemetryRescuesWithin30Days({
            version: 1,
            sessionStartIso: within,
            counts: { 'flywheel-rescue': 99 },
            recentEvents: [
                { code: 'flywheel-rescue', ts: within },
                { code: 'codex_rescue', ts: within },
                { code: 'flywheel-rescue', ts: outside },
                { code: 'cli_failure', ts: within },
            ],
        }, now)).toBe(2);
    });
});
// ─── runDoctorChecks ──────────────────────────────────────────────────────
describe('runDoctorChecks', () => {
    it('happy path — all 11 checks green yields overall green', async () => {
        const cwd = makeTmpCwd();
        try {
            const exec = makeStubbedExec(allGreenStubs());
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                codexConfigPath: null,
            });
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
    it('refuses to scan repo-relative symlink targets outside cwd', async () => {
        const cwd = makeTmpCwd();
        const outside = mkdtempSync(join(tmpdir(), 'doctor-outside-'));
        try {
            mkdirSync(join(outside, 'nested'), { recursive: true });
            writeFileSync(join(outside, 'nested', 'file.ts'), '// outside\n');
            symlinkSync(outside, join(cwd, 'mcp-server', 'src'));
            const exec = makeStubbedExec(allGreenStubs());
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                codexConfigPath: null,
            });
            const distDrift = report.checks.find((c) => c.name === 'dist_drift');
            expect(distDrift).toBeDefined();
            expect(distDrift.severity).toBe('yellow');
            expect(distDrift.message).toContain('refused path');
            expect(distDrift.message).toContain('outside cwd');
        }
        finally {
            cleanup(outside);
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
    it('binary that rejects --version but accepts --help → green via fallback', async () => {
        // Regression: ntm doesn't expose --version but is fully functional. The
        // doctor must fall back to --help before reporting yellow.
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('ntm', ['--version']));
            stubs.push({
                match: (cmd, args) => cmd === 'ntm' && args[0] === '--version',
                respond: { result: { code: 1, stdout: '', stderr: 'Error: unknown flag: --version' } },
            });
            stubs.push({
                match: (cmd, args) => cmd === 'ntm' && args[0] === '--help',
                respond: { result: { code: 0, stdout: 'ntm: Named Tmux Manager', stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const ntm = report.checks.find((c) => c.name === 'ntm_binary');
            expect(ntm.severity).toBe('green');
            expect(ntm.message).toMatch(/no --version flag/);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('binary that fails both --version and --help → yellow', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('ntm', ['--version']));
            stubs.push({
                match: (cmd, args) => cmd === 'ntm' && args[0] === '--version',
                respond: { result: { code: 1, stdout: '', stderr: 'broken' } },
            });
            stubs.push({
                match: (cmd, args) => cmd === 'ntm' && args[0] === '--help',
                respond: { result: { code: 2, stdout: '', stderr: 'broken' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            const ntm = report.checks.find((c) => c.name === 'ntm_binary');
            expect(ntm.severity).toBe('yellow');
            expect(ntm.message).toMatch(/returned code 1/);
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
    it('rescues_last_30d uses local telemetry fallback when cm context fails', async () => {
        const cwd = makeTmpCwd();
        const now = Date.UTC(2026, 3, 27, 12, 0, 0);
        const within = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
        const outside = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString();
        try {
            mkdirSync(join(cwd, '.pi-flywheel'), { recursive: true });
            writeFileSync(join(cwd, '.pi-flywheel', 'error-counts.json'), JSON.stringify({
                version: 1,
                sessionStartIso: within,
                counts: {},
                recentEvents: [
                    { code: 'flywheel-rescue', ts: within },
                    { code: 'codex_rescue', ts: within },
                    { code: 'flywheel-rescue', ts: outside },
                    { code: 'cli_failure', ts: within },
                ],
            }));
            const stubs = allGreenStubs().filter((s) => !s.match('cm', ['context', 'flywheel-rescue', '--json']));
            stubs.push({
                match: (cmd, args) => cmd === 'cm' && args[0] === 'context' && args[1] === 'flywheel-rescue',
                respond: { result: { code: 1, stdout: '', stderr: 'context failed' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                codexConfigPath: null,
                now: () => now,
            });
            const rescues = report.checks.find((c) => c.name === 'rescues_last_30d');
            expect(rescues).toBeDefined();
            expect(rescues.severity).toBe('green');
            expect(rescues.message).toContain('2 codex rescues in last 30d');
            expect(rescues.message).toContain('local telemetry fallback');
            expect(rescues.message).not.toContain('counts unknown');
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
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                codexConfigPath: null,
            });
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
    it('registered worktree older than 3 days with HEAD on main → yellow stale entry', async () => {
        const cwd = makeTmpCwd();
        const nowMs = Date.parse('2026-04-26T12:00:00.000Z');
        const worktreePath = join(cwd, '.ntm', 'worktrees', 'old-session', 'cod_1');
        try {
            mkdirSync(worktreePath, { recursive: true });
            writeFileSync(join(worktreePath, '.git'), 'gitdir: ../../../../.git/worktrees/cod_1\n');
            const old = new Date(nowMs - 4 * DAY_MS);
            utimesSync(worktreePath, old, old);
            const stubs = allGreenStubs().filter((s) => !s.match('git', ['worktree', 'list', '--porcelain']));
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'worktree',
                respond: {
                    result: {
                        code: 0,
                        stdout: [
                            `worktree ${cwd}`,
                            'HEAD root',
                            'branch refs/heads/main',
                            '',
                            `worktree ${worktreePath}`,
                            'HEAD abc123',
                            'branch refs/heads/ntm/old-session/cod_1',
                            '',
                        ].join('\n'),
                        stderr: '',
                    },
                },
            });
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor',
                respond: { result: { code: 0, stdout: '', stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                now: () => nowMs,
                codexConfigPath: null,
            });
            const worktrees = report.checks.find((c) => c.name === 'orphaned_worktrees');
            expect(worktrees.severity).toBe('yellow');
            expect(worktrees.message).toContain('stale worktree');
            expect(worktrees.message).toContain('.ntm/worktrees/old-session/cod_1');
            expect(worktrees.message).toContain('HEAD on main');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('registered fresh worktree on main stays green', async () => {
        const cwd = makeTmpCwd();
        const nowMs = Date.parse('2026-04-26T12:00:00.000Z');
        const worktreePath = join(cwd, '.ntm', 'worktrees', 'active-session', 'cod_1');
        try {
            mkdirSync(worktreePath, { recursive: true });
            writeFileSync(join(worktreePath, '.git'), 'gitdir: ../../../../.git/worktrees/cod_1\n');
            const fresh = new Date(nowMs - DAY_MS);
            utimesSync(worktreePath, fresh, fresh);
            const stubs = allGreenStubs().filter((s) => !s.match('git', ['worktree', 'list', '--porcelain']));
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'worktree',
                respond: {
                    result: {
                        code: 0,
                        stdout: [
                            `worktree ${cwd}`,
                            'HEAD root',
                            'branch refs/heads/main',
                            '',
                            `worktree ${worktreePath}`,
                            'HEAD abc123',
                            'branch refs/heads/ntm/active-session/cod_1',
                            '',
                        ].join('\n'),
                        stderr: '',
                    },
                },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                now: () => nowMs,
                codexConfigPath: null,
            });
            const worktrees = report.checks.find((c) => c.name === 'orphaned_worktrees');
            expect(worktrees.severity).toBe('green');
            expect(worktrees.message).toContain('none stale');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('locked stale worktree is flagged for inspection rather than normal cleanup', async () => {
        const cwd = makeTmpCwd();
        const nowMs = Date.parse('2026-04-26T12:00:00.000Z');
        const worktreePath = join(cwd, '.claude', 'worktrees', 'agent-old');
        try {
            mkdirSync(worktreePath, { recursive: true });
            const old = new Date(nowMs - 4 * DAY_MS);
            utimesSync(worktreePath, old, old);
            const stubs = allGreenStubs().filter((s) => !s.match('git', ['worktree', 'list', '--porcelain']));
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'worktree',
                respond: {
                    result: {
                        code: 0,
                        stdout: [
                            `worktree ${cwd}`,
                            'HEAD root',
                            'branch refs/heads/main',
                            '',
                            `worktree ${worktreePath}`,
                            'HEAD abc123',
                            'branch refs/heads/agent-old',
                            'locked still reviewing',
                            '',
                        ].join('\n'),
                        stderr: '',
                    },
                },
            });
            stubs.push({
                match: (cmd, args) => cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor',
                respond: { result: { code: 0, stdout: '', stderr: '' } },
            });
            const exec = makeStubbedExec(stubs);
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                now: () => nowMs,
                codexConfigPath: null,
            });
            const worktrees = report.checks.find((c) => c.name === 'orphaned_worktrees');
            expect(worktrees.severity).toBe('yellow');
            expect(worktrees.message).toContain('locked stale worktree');
            expect(worktrees.message).toContain('inspection');
        }
        finally {
            cleanup(cwd);
        }
    });
});
// ─── codex_config_compat ──────────────────────────────────────────────────
describe('parseCodexConfigTopLevelModel (pure)', () => {
    it('returns the value for a top-level `model = "..."` line', () => {
        expect(parseCodexConfigTopLevelModel('model = "gpt-5.5"\n')).toBe('gpt-5.5');
    });
    it('skips commented-out model lines', () => {
        expect(parseCodexConfigTopLevelModel('# model = "gpt-5.5"\n')).toBeNull();
    });
    it('returns null when the model key only appears inside a [section]', () => {
        const src = '[some_provider]\nmodel = "gpt-5.5"\n';
        expect(parseCodexConfigTopLevelModel(src)).toBeNull();
    });
    it('honors the first top-level value before any section header', () => {
        const src = 'model = "o3"\n[features]\nmulti_agent = true\n';
        expect(parseCodexConfigTopLevelModel(src)).toBe('o3');
    });
    it('returns null when no model line is present', () => {
        expect(parseCodexConfigTopLevelModel('approval_policy = "never"\n')).toBeNull();
    });
});
describe('isCodexIncompatibleModel', () => {
    it('flags gpt-5, gpt-5.5, gpt-5-codex, and o4-mini variants', () => {
        expect(isCodexIncompatibleModel('gpt-5')).toBe(true);
        expect(isCodexIncompatibleModel('gpt-5.5')).toBe(true);
        expect(isCodexIncompatibleModel('gpt-5-codex')).toBe(true);
        expect(isCodexIncompatibleModel('o4-mini')).toBe(true);
    });
    it('passes app-server-compatible models through', () => {
        expect(isCodexIncompatibleModel('o3')).toBe(false);
        expect(isCodexIncompatibleModel('gpt-4o')).toBe(false);
        expect(isCodexIncompatibleModel('claude-sonnet-4-6')).toBe(false);
    });
});
describe('codex_config_compat (integrated)', () => {
    it('green when ~/.codex/config.toml is absent', async () => {
        const cwd = makeTmpCwd();
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: join(cwd, 'no-such-config.toml'),
            });
            const compat = report.checks.find((c) => c.name === 'codex_config_compat');
            expect(compat.severity).toBe('green');
            expect(compat.message).toContain('nothing to validate');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('yellow when config sets gpt-5.5 (the bead `cif` repro)', async () => {
        const cwd = makeTmpCwd();
        const fixture = join(cwd, 'codex-config.toml');
        writeFileSync(fixture, 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n');
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: fixture,
            });
            const compat = report.checks.find((c) => c.name === 'codex_config_compat');
            expect(compat.severity).toBe('yellow');
            expect(compat.message).toContain('gpt-5.5');
            expect(compat.hint).toBeDefined();
            expect(compat.hint.toLowerCase()).toContain('comment out');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('green when config sets a compatible model (o3)', async () => {
        const cwd = makeTmpCwd();
        const fixture = join(cwd, 'codex-config.toml');
        writeFileSync(fixture, 'model = "o3"\n');
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: fixture,
            });
            const compat = report.checks.find((c) => c.name === 'codex_config_compat');
            expect(compat.severity).toBe('green');
            expect(compat.message).toContain('o3');
        }
        finally {
            cleanup(cwd);
        }
    });
});
// ─── countCriticalFails + criticalFails wiring ─────────────────────────────
describe('countCriticalFails', () => {
    const mk = (sev) => ({
        name: 'x',
        severity: sev,
        message: '',
    });
    it('counts only red-severity rows', () => {
        expect(countCriticalFails([mk('green'), mk('yellow'), mk('green')])).toBe(0);
        expect(countCriticalFails([mk('red'), mk('yellow'), mk('red')])).toBe(2);
        expect(countCriticalFails([])).toBe(0);
    });
});
describe('runDoctorChecks criticalFails wiring', () => {
    it('all-green sweep produces criticalFails=0 and overall=green', async () => {
        const cwd = makeTmpCwd();
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: null,
            });
            expect(report.criticalFails).toBe(0);
            expect(report.overall).toBe('green');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('absent required binary bumps criticalFails, gates overall=red', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = allGreenStubs().filter((s) => !s.match('br', ['--version']));
            // Make every br invocation fail (both --version and --help fallback)
            // so the check goes red rather than green-via-fallback.
            stubs.push({
                match: (cmd) => cmd === 'br',
                respond: { throws: new Error('br: command not found') },
            });
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(stubs),
                codexConfigPath: null,
            });
            expect(report.criticalFails).toBeGreaterThan(0);
            expect(report.overall).toBe('red');
        }
        finally {
            cleanup(cwd);
        }
    });
});
// ─── version-triple drift check ────────────────────────────────────────────
describe('diffVersionTriple', () => {
    it('returns empty when all three match', () => {
        expect(diffVersionTriple({ local: '1.0.0', marketplace: '1.0.0', installed: '1.0.0' })).toEqual([]);
    });
    it('flags every disagreeing pair', () => {
        const drift = diffVersionTriple({
            local: '1.0.0',
            marketplace: '1.0.1',
            installed: '0.9.0',
        });
        expect(drift).toHaveLength(3);
        expect(drift[0]).toContain('local(1.0.0)');
        expect(drift[0]).toContain('marketplace(1.0.1)');
    });
    it('skips pairs where one side is null', () => {
        const drift = diffVersionTriple({
            local: '1.0.0',
            marketplace: null,
            installed: '0.9.0',
        });
        expect(drift).toEqual(['local(1.0.0)↔installed(0.9.0)']);
    });
});
describe('readManifestVersion', () => {
    it('returns the version string when present', () => {
        const cwd = makeTmpCwd();
        try {
            const path = join(cwd, 'pkg.json');
            writeFileSync(path, JSON.stringify({ name: 'x', version: '2.3.4' }));
            expect(readManifestVersion(path)).toBe('2.3.4');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('returns null on missing file', () => {
        expect(readManifestVersion('/nonexistent/path/pkg.json')).toBeNull();
    });
    it('returns null on missing version field', () => {
        const cwd = makeTmpCwd();
        try {
            const path = join(cwd, 'pkg.json');
            writeFileSync(path, JSON.stringify({ name: 'x' }));
            expect(readManifestVersion(path)).toBeNull();
        }
        finally {
            cleanup(cwd);
        }
    });
    it('returns null on malformed JSON without throwing', () => {
        const cwd = makeTmpCwd();
        try {
            const path = join(cwd, 'pkg.json');
            writeFileSync(path, '{ not json');
            expect(readManifestVersion(path)).toBeNull();
        }
        finally {
            cleanup(cwd);
        }
    });
});
describe('npm_marketplace_version_drift check', () => {
    function setupRepo(cwd, versions) {
        if (versions.local) {
            writeFileSync(join(cwd, 'mcp-server', 'package.json'), JSON.stringify({ name: 'agent-flywheel-mcp', version: versions.local }));
        }
        if (versions.marketplace) {
            mkdirSync(join(cwd, '.claude-plugin'), { recursive: true });
            writeFileSync(join(cwd, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agent-flywheel', version: versions.marketplace }));
        }
    }
    it('green when local + marketplace versions match (installed skipped)', async () => {
        const cwd = makeTmpCwd();
        setupRepo(cwd, { local: '3.11.5', marketplace: '3.11.5' });
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: null,
                installedPluginManifestPath: null,
            });
            const check = report.checks.find((c) => c.name === 'npm_marketplace_version_drift');
            expect(check.severity).toBe('green');
            expect(check.message).toContain('aligned');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('yellow when local and marketplace diverge (warn-only, criticalFails unaffected)', async () => {
        const cwd = makeTmpCwd();
        setupRepo(cwd, { local: '3.11.5', marketplace: '3.10.0' });
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: null,
                installedPluginManifestPath: null,
            });
            const check = report.checks.find((c) => c.name === 'npm_marketplace_version_drift');
            expect(check.severity).toBe('yellow');
            expect(check.message).toContain('drift');
            expect(check.message).toContain('3.11.5');
            expect(check.message).toContain('3.10.0');
            expect(check.hint).toContain('/flywheel-setup');
            expect(report.criticalFails).toBe(0);
            expect(report.overall).toBe('yellow');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('green-skipped when no local manifest present (synthetic cwd)', async () => {
        const cwd = makeTmpCwd();
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: null,
                installedPluginManifestPath: null,
                marketplaceManifestPath: null,
            });
            const check = report.checks.find((c) => c.name === 'npm_marketplace_version_drift');
            expect(check.severity).toBe('green');
            expect(check.message).toContain('not applicable');
        }
        finally {
            cleanup(cwd);
        }
    });
    it('treats unreadable installed manifest as null (skips that side, no warning)', async () => {
        const cwd = makeTmpCwd();
        setupRepo(cwd, { local: '3.11.5', marketplace: '3.11.5' });
        try {
            const report = await runDoctorChecks(cwd, undefined, {
                exec: makeStubbedExec(allGreenStubs()),
                codexConfigPath: null,
                installedPluginManifestPath: join(cwd, 'no-such-file.json'),
            });
            const check = report.checks.find((c) => c.name === 'npm_marketplace_version_drift');
            expect(check.severity).toBe('green');
        }
        finally {
            cleanup(cwd);
        }
    });
});
// ─── renderDoctorReport (clack-prompts) ────────────────────────────────────
describe('renderDoctorReport (clack/picocolors)', () => {
    it('returns criticalFails as the exit-code value', async () => {
        const { renderDoctorReport } = await import('../../tools/doctor-render.js');
        const greenReport = {
            version: 1,
            cwd: '/tmp',
            overall: 'green',
            criticalFails: 0,
            partial: false,
            checks: [{ name: 'a', severity: 'green', message: 'ok' }],
            elapsedMs: 5,
            timestamp: '2026-05-03T00:00:00.000Z',
        };
        const redReport = { ...greenReport, overall: 'red', criticalFails: 2 };
        // Suppress clack output during tests so the test runner stays quiet.
        const stdoutWrite = process.stdout.write.bind(process.stdout);
        const noop = (() => true);
        process.stdout.write = noop;
        try {
            expect(renderDoctorReport(greenReport)).toBe(0);
            expect(renderDoctorReport(redReport)).toBe(2);
        }
        finally {
            process.stdout.write = stdoutWrite;
        }
    });
});
//# sourceMappingURL=doctor.test.js.map