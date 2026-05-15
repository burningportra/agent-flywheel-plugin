import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { storeComplianceScore } from '../cass-helpers.js';
import { _resetTelemetryForTest, flushTelemetry, readTelemetry } from '../telemetry.js';
import { runComplianceAudit } from '../tools/compliance-audit.js';
vi.mock('../cass-helpers.js', () => ({
    storeComplianceScore: vi.fn(),
}));
const __dirname = dirname(fileURLToPath(import.meta.url));
const stubCtx = (overrides = {}) => ({
    exec: vi.fn(),
    cwd: '/tmp',
    state: {},
    saveState: vi.fn(),
    clearState: vi.fn(),
    ...overrides,
});
describe('runComplianceAudit', () => {
    beforeEach(() => {
        delete process.env.FW_COMPLIANCE_OVERRIDE;
        delete process.env.FW_SESSION_ID;
        _resetTelemetryForTest();
        vi.mocked(storeComplianceScore).mockReset();
    });
    it('returns ok with empty arrays when beadIds is empty', async () => {
        const exec = vi.fn();
        const result = await runComplianceAudit(stubCtx({ exec }), { cwd: '/tmp', beadIds: [] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passed).toEqual([]);
        expect(data.failed).toEqual([]);
        expect(exec).not.toHaveBeenCalled();
    });
    it('returns invalid_input when beadIds is not an array', async () => {
        const result = await runComplianceAudit(stubCtx(), { cwd: '/tmp', beadIds: 'nope' });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_compliance_audit',
            status: 'error',
            data: { error: { code: 'invalid_input' } },
        });
    });
    it('returns skipped when FW_COMPLIANCE_OVERRIDE env is set', async () => {
        process.env.FW_COMPLIANCE_OVERRIDE = 'agent-flywheel-001,agent-flywheel-002';
        const exec = vi.fn();
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: '/tmp',
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('skipped');
        expect(exec).not.toHaveBeenCalled();
    });
    it('returns skipped when skipEnv argument is set', async () => {
        const exec = vi.fn();
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: '/tmp',
            beadIds: ['agent-flywheel-001'],
            skipEnv: 'agent-flywheel-001',
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('skipped');
        expect(exec).not.toHaveBeenCalled();
    });
});
function setupFakePassDir(cwd, fixtureName) {
    const passUtc = '2026-05-08T19-14-22Z';
    const passDir = join(cwd, 'beads_compliance_audit', 'passes', passUtc);
    mkdirSync(passDir, { recursive: true });
    const fixturePath = join(__dirname, 'fixtures', fixtureName);
    writeFileSync(join(passDir, 'result.json'), readFileSync(fixturePath, 'utf8'));
    return passDir;
}
function setupFakePassDirWithResult(cwd, result) {
    const passUtc = '2026-05-08T19-14-22Z';
    const passDir = join(cwd, 'beads_compliance_audit', 'passes', passUtc);
    mkdirSync(passDir, { recursive: true });
    writeFileSync(join(passDir, 'result.json'), JSON.stringify(result));
    return passDir;
}
function setupFakeManifestPassDir(cwd, manifest) {
    const passUtc = '2026-05-15T14-33-55Z-flywheel-gate';
    const passDir = join(cwd, 'beads_compliance_audit', 'passes', passUtc);
    mkdirSync(passDir, { recursive: true });
    writeFileSync(join(passDir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(passDir, 'REPORT.md'), '# Flywheel-Gate Audit\n');
    return passDir;
}
describe('runComplianceAudit - skill spawn + parse', () => {
    let tmp;
    beforeEach(() => {
        delete process.env.FW_COMPLIANCE_OVERRIDE;
        delete process.env.FW_SESSION_ID;
        _resetTelemetryForTest();
        vi.mocked(storeComplianceScore).mockReset();
        tmp = mkdtempSync(join(tmpdir(), 'fw-comp-'));
    });
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });
    it('spawns the skill and parses all-pass result', async () => {
        setupFakePassDir(tmp, 'compliance-result-pass.json');
        const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
        const result = await runComplianceAudit(stubCtx({ exec }), { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passed).toEqual([
            {
                beadId: 'agent-flywheel-001',
                score: 850,
                reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z', 'beads/agent-flywheel-001/scorecard.md'),
            },
        ]);
        expect(data.failed).toEqual([]);
        expect(data.passUtc).toBe('2026-05-08T19:14:22Z');
        expect(exec).toHaveBeenCalledWith('claude', [
            '-p',
            '--permission-mode',
            'bypassPermissions',
            '/beads-compliance-and-completion-verification --mode flywheel-gate --beads agent-flywheel-001 --threshold 700 --parallelism 5',
        ], { cwd: tmp, timeout: 15 * 60 * 1000, signal: undefined });
    });
    it('parses manifest/report output layout without result.json', async () => {
        setupFakeManifestPassDir(tmp, {
            audit_dir_version: '1.0.0',
            pass_id: '2026-05-15T14-33-55Z-flywheel-gate',
            pass_started_at: '2026-05-15T14:33:55Z',
            mode: 'flywheel-gate',
            score_threshold: 700,
            target_beads: ['agent-flywheel-001', 'agent-flywheel-002'],
            results: {
                'agent-flywheel-001': {
                    score: 920,
                    verdict: 'Substantially complete',
                    gate: 'PASS',
                },
                'agent-flywheel-002': {
                    score: 640,
                    verdict: 'Evidence missing',
                    gate: 'FAIL',
                },
            },
            summary: {
                total_beads: 2,
                passed: 1,
                failed: 1,
                gate_verdict: 'FAIL',
            },
        });
        const exec = vi.fn(async (cmd) => {
            if (cmd === 'git')
                return { code: 0, stdout: 'abc123\n', stderr: '' };
            return { code: 0, stdout: '', stderr: '' };
        });
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passUtc).toBe('2026-05-15T14:33:55Z');
        expect(data.errors.parse).toBeUndefined();
        expect(data.passed).toEqual([
            {
                beadId: 'agent-flywheel-001',
                score: 920,
                reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-15T14-33-55Z-flywheel-gate', 'beads/agent-flywheel-001/scorecard.md'),
            },
        ]);
        expect(data.failed).toEqual([
            {
                beadId: 'agent-flywheel-002',
                score: 640,
                reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-15T14-33-55Z-flywheel-gate', 'beads/agent-flywheel-002/scorecard.md'),
                reasons: ['Evidence missing', 'gate:FAIL'],
            },
        ]);
    });
    it('parses the 2026-05-15 five-bead manifest and matches the report verdict', async () => {
        setupFakeManifestPassDir(tmp, {
            audit_dir_version: '1.0.0',
            pass_id: '2026-05-15T14-33-55Z-flywheel-gate',
            pass_started_at: '2026-05-15T14:33:55Z',
            mode: 'flywheel-gate',
            score_threshold: 700,
            target_beads: [
                'claude-orchestrator-3s58',
                'claude-orchestrator-ao9u',
                'claude-orchestrator-2wcd',
                'claude-orchestrator-37n6',
                'claude-orchestrator-34ok',
            ],
            results: {
                'claude-orchestrator-3s58': { score: 970, verdict: 'Verified', gate: 'PASS' },
                'claude-orchestrator-ao9u': { score: 920, verdict: 'Substantially complete', gate: 'PASS' },
                'claude-orchestrator-2wcd': { score: 910, verdict: 'Substantially complete', gate: 'PASS' },
                'claude-orchestrator-37n6': { score: 890, verdict: 'Substantially complete', gate: 'PASS' },
                'claude-orchestrator-34ok': { score: 855, verdict: 'Substantially complete', gate: 'PASS' },
            },
            summary: {
                total_beads: 5,
                passed: 5,
                failed: 0,
                mean_score: 909,
                gate_verdict: 'PASS',
            },
        });
        const exec = vi.fn(async (cmd) => {
            if (cmd === 'git')
                return { code: 0, stdout: 'abc123\n', stderr: '' };
            return { code: 0, stdout: '', stderr: '' };
        });
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: [
                'claude-orchestrator-3s58',
                'claude-orchestrator-ao9u',
                'claude-orchestrator-2wcd',
                'claude-orchestrator-37n6',
                'claude-orchestrator-34ok',
            ],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passUtc).toBe('2026-05-15T14:33:55Z');
        expect(data.passed.map((bead) => [bead.beadId, bead.score])).toEqual([
            ['claude-orchestrator-3s58', 970],
            ['claude-orchestrator-ao9u', 920],
            ['claude-orchestrator-2wcd', 910],
            ['claude-orchestrator-37n6', 890],
            ['claude-orchestrator-34ok', 855],
        ]);
        expect(data.failed).toEqual([]);
        expect(data.errors.parse).toBeUndefined();
    });
    it('parses mixed result and partitions passed/failed', async () => {
        setupFakePassDir(tmp, 'compliance-result-mixed.json');
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passed).toHaveLength(1);
        expect(data.failed).toEqual([
            {
                beadId: 'agent-flywheel-002',
                score: 420,
                reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z', 'beads/agent-flywheel-002/scorecard.md'),
                reasons: [
                    'impl_completeness:120/300',
                    'test_depth:60/150',
                    'anti_theater:30/150',
                ],
            },
        ]);
    });
    it('returns status=error when the skill subprocess fails', async () => {
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'skill not found' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.spawn).toContain('exit 1');
        expect(data.errors.spawn).toContain('skill not found');
    });
    it('parses partial result.json on spawn timeout and marks missing beads as timeout', async () => {
        setupFakePassDirWithResult(tmp, {
            schema_version: 1,
            pass_utc: '2026-05-08T19:14:22Z',
            mode: 'flywheel-gate',
            threshold: 700,
            beads: [
                {
                    id: 'agent-flywheel-001',
                    score: 850,
                    passed: true,
                    scorecard_path: 'beads/agent-flywheel-001/scorecard.md',
                },
            ],
        });
        const timeoutError = Object.assign(new Error('Timed out after 900000ms: claude -p --permission-mode bypassPermissions'), { timedOut: true });
        const exec = vi.fn(async (cmd) => {
            if (cmd === 'claude') {
                throw timeoutError;
            }
            return { code: 0, stdout: cmd === 'git' ? 'abc123\n' : '', stderr: '' };
        });
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passed).toEqual([
            {
                beadId: 'agent-flywheel-001',
                score: 850,
                reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z', 'beads/agent-flywheel-001/scorecard.md'),
            },
        ]);
        expect(data.failed).toEqual([
            {
                beadId: 'agent-flywheel-002',
                score: 0,
                reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z', 'REPORT.md'),
                reasons: ['timeout'],
            },
        ]);
        expect(data.errors['agent-flywheel-002']).toBe('timeout');
        expect(data.errors.spawn).toContain('Timed out after 900000ms');
        expect(exec).toHaveBeenCalledWith('br', ['update', 'agent-flywheel-002', '--status', 'open'], { cwd: tmp, timeout: 10000, signal: undefined });
    });
    it('returns status=error when the passes directory is missing', async () => {
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.parse).toContain('passes directory missing');
    });
    it('returns status=error when manifest.json and legacy result.json are missing', async () => {
        mkdirSync(join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z'), { recursive: true });
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.parse).toContain('manifest.json not found');
        expect(data.errors.parse).toContain('legacy result.json not found');
    });
    it('returns status=error when result.json is invalid JSON', async () => {
        const passDir = join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z');
        mkdirSync(passDir, { recursive: true });
        writeFileSync(join(passDir, 'result.json'), '{not json');
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.parse).toBeTruthy();
    });
    it('returns status=error when result.json schema_version is not 1', async () => {
        setupFakePassDirWithResult(tmp, {
            schema_version: 2,
            pass_utc: '2026-05-08T19:14:22Z',
            mode: 'flywheel-gate',
            threshold: 700,
            beads: [],
        });
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.parse).toContain('schema_version');
    });
    it('returns status=error when result.json omits beads', async () => {
        setupFakePassDirWithResult(tmp, {
            schema_version: 1,
            pass_utc: '2026-05-08T19:14:22Z',
            mode: 'flywheel-gate',
            threshold: 700,
        });
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.parse).toContain('beads');
    });
    it('returns status=error when result.json includes unknown top-level keys', async () => {
        setupFakePassDirWithResult(tmp, {
            schema_version: 1,
            pass_utc: '2026-05-08T19:14:22Z',
            mode: 'flywheel-gate',
            threshold: 700,
            beads: [],
            unexpected: true,
        });
        const ctx = stubCtx({
            exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
        });
        const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const data = result.structuredContent.data;
        expect(data.status).toBe('error');
        expect(data.errors.parse).toContain('unexpected');
    });
});
describe('runComplianceAudit - side effects', () => {
    let tmp;
    beforeEach(() => {
        delete process.env.FW_COMPLIANCE_OVERRIDE;
        delete process.env.FW_SESSION_ID;
        _resetTelemetryForTest();
        vi.mocked(storeComplianceScore).mockReset();
        tmp = mkdtempSync(join(tmpdir(), 'fw-comp-effects-'));
    });
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        delete process.env.FW_SESSION_ID;
    });
    it('runs br update --status open + br comments add for each failed bead', async () => {
        setupFakePassDir(tmp, 'compliance-result-mixed.json');
        const exec = vi.fn(async (cmd, _args, _opts) => ({
            code: 0,
            stdout: cmd === 'git' ? 'abc123\n' : '',
            stderr: '',
        }));
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        const brCalls = exec.mock.calls.filter((call) => call[0] === 'br');
        expect(brCalls).toContainEqual([
            'br',
            ['update', 'agent-flywheel-002', '--status', 'open'],
            { cwd: tmp, timeout: 10000, signal: undefined },
        ]);
        const commentCall = brCalls.find((call) => call[1][0] === 'comments' && call[1][1] === 'add');
        expect(commentCall).toBeDefined();
        expect(commentCall[1]).toEqual([
            'comments',
            'add',
            'agent-flywheel-002',
            '--message',
            expect.stringContaining('score 420/1000'),
        ]);
    });
    it('does not run br update or comment for passed beads', async () => {
        setupFakePassDir(tmp, 'compliance-result-pass.json');
        const exec = vi.fn(async (cmd, _args, _opts) => ({
            code: 0,
            stdout: cmd === 'git' ? 'abc123\n' : '',
            stderr: '',
        }));
        await runComplianceAudit(stubCtx({ exec }), { cwd: tmp, beadIds: ['agent-flywheel-001'] });
        const brCalls = exec.mock.calls.filter((call) => call[0] === 'br');
        expect(brCalls).toEqual([]);
    });
    it('continues when br update fails and records an errors entry', async () => {
        setupFakePassDir(tmp, 'compliance-result-mixed.json');
        const exec = vi.fn(async (cmd, args) => {
            if (cmd === 'br' && args[0] === 'update') {
                return { code: 2, stdout: '', stderr: 'bead locked' };
            }
            return { code: 0, stdout: cmd === 'git' ? 'abc123\n' : '', stderr: '' };
        });
        const result = await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.errors['agent-flywheel-002']).toContain('br update failed');
        expect(data.errors['agent-flywheel-002']).toContain('bead locked');
        const commentCall = exec.mock.calls.find((call) => call[0] === 'br' && call[1][0] === 'comments' && call[1][1] === 'add');
        expect(commentCall).toBeUndefined();
    });
    it('records compliance_false_closed telemetry once per failed bead', async () => {
        setupFakePassDirWithResult(tmp, {
            schema_version: 1,
            pass_utc: '2026-05-08T19:14:22Z',
            mode: 'flywheel-gate',
            threshold: 700,
            beads: [
                {
                    id: 'agent-flywheel-001',
                    score: 410,
                    passed: false,
                    scorecard_path: 'beads/agent-flywheel-001/scorecard.md',
                },
                {
                    id: 'agent-flywheel-002',
                    score: 420,
                    passed: false,
                    scorecard_path: 'beads/agent-flywheel-002/scorecard.md',
                },
                {
                    id: 'agent-flywheel-003',
                    score: 430,
                    passed: false,
                    scorecard_path: 'beads/agent-flywheel-003/scorecard.md',
                },
            ],
        });
        const exec = vi.fn(async (cmd, _args, _opts) => ({
            code: 0,
            stdout: cmd === 'git' ? 'abc123\n' : '',
            stderr: '',
        }));
        await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002', 'agent-flywheel-003'],
        });
        await flushTelemetry({ cwd: tmp });
        const telemetry = await readTelemetry({ cwd: tmp });
        expect(telemetry?.counts.compliance_false_closed).toBe(3);
    });
    it('persists compliance scores to CASS for all parsed beads', async () => {
        setupFakePassDir(tmp, 'compliance-result-mixed.json');
        process.env.FW_SESSION_ID = 'sess-test';
        const exec = vi.fn(async (cmd, _args, _opts) => ({
            code: 0,
            stdout: cmd === 'git' ? 'abc123\n' : '',
            stderr: '',
        }));
        await runComplianceAudit(stubCtx({ exec }), {
            cwd: tmp,
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
            threshold: 750,
        });
        expect(storeComplianceScore).toHaveBeenCalledTimes(2);
        expect(storeComplianceScore).toHaveBeenNthCalledWith(1, tmp, {
            beadId: 'agent-flywheel-001',
            score: 850,
            threshold: 750,
            passed: true,
            rubric: { impl_completeness: '260/300' },
            passUtc: '2026-05-08T19:14:22Z',
            sessionId: 'sess-test',
            gitHead: 'abc123',
        });
        expect(storeComplianceScore).toHaveBeenNthCalledWith(2, tmp, {
            beadId: 'agent-flywheel-002',
            score: 420,
            threshold: 750,
            passed: false,
            rubric: { impl_completeness: '120/300' },
            passUtc: '2026-05-08T19:14:22Z',
            sessionId: 'sess-test',
            gitHead: 'abc123',
        });
    });
});
//# sourceMappingURL=compliance-audit.test.js.map