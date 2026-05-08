import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runComplianceAudit } from '../tools/compliance-audit.js';
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
    });
    it('returns ok with empty arrays when beadIds is empty', async () => {
        const result = await runComplianceAudit(stubCtx(), { cwd: '/tmp', beadIds: [] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.status).toBe('ok');
        expect(data.passed).toEqual([]);
        expect(data.failed).toEqual([]);
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
        const result = await runComplianceAudit(stubCtx(), {
            cwd: '/tmp',
            beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('skipped');
    });
    it('returns skipped when skipEnv argument is set', async () => {
        const result = await runComplianceAudit(stubCtx(), {
            cwd: '/tmp',
            beadIds: ['agent-flywheel-001'],
            skipEnv: 'agent-flywheel-001',
        });
        const data = result.structuredContent.data;
        expect(data.status).toBe('skipped');
    });
});
//# sourceMappingURL=compliance-audit.test.js.map