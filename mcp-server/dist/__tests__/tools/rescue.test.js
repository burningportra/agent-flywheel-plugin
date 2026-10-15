import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../types.js';
import { createCallToolHandler, TOOLS } from '../../server.js';
import { buildRobotDocs } from '../../tools/robot-docs.js';
import { runRescue } from '../../tools/rescue.js';
function makeState(overrides = {}) {
    return { ...createInitialState(), selectedGoal: 'Recover the stalled cycle', ...overrides };
}
describe('flywheel_rescue', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'flywheel-rescue-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    function makeContext(state = makeState()) {
        const exec = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'diff') {
                return {
                    code: 0,
                    stdout: 'diff --git a/src/a.ts b/src/a.ts\n+fixed\n',
                    stderr: '',
                };
            }
            if (command === 'cm' && args[0] === '--version') {
                return { code: 0, stdout: 'cm 1.0.0\n', stderr: '' };
            }
            if (command === 'cm' && args[0] === 'add') {
                return { code: 0, stdout: 'rescue-memory-id\n', stderr: '' };
            }
            return { code: 1, stdout: '', stderr: `unexpected command: ${command}` };
        });
        return {
            exec,
            ctx: {
                cwd,
                exec,
                state,
                saveState: vi.fn(),
                clearState: vi.fn(),
                signal: new AbortController().signal,
            },
        };
    }
    it('returns a plan packet, Codex prompt, and canonical memory line', async () => {
        await mkdir(join(cwd, 'docs', 'plans'), { recursive: true });
        await writeFile(join(cwd, 'docs', 'plans', 'active.md'), '# Active plan\n');
        const { ctx, exec } = makeContext(makeState({ phase: 'planning', planDocument: 'docs/plans/active.md' }));
        const result = await runRescue(ctx, {
            cwd,
            phase: 'plan',
            notes: 'Re-plan the failed section.',
        });
        expect(result.isError).toBeUndefined();
        const structured = result.structuredContent;
        if (!structured || structured.status !== 'ok') {
            throw new Error('expected flywheel_rescue success envelope');
        }
        expect(structured.data.packet.phase).toBe('plan');
        expect(structured.data.packet.artifact_path).toBe('docs/plans/active.md');
        expect(structured.data.codexPrompt).toContain('CODEX BEAD DISPATCH');
        expect(structured.data.codexPrompt).toContain('Re-plan the failed section.');
        expect(structured.data.codexPrompt.endsWith('\n\n')).toBe(true);
        expect(structured.data.memoryLine).toMatch(/^flywheel-rescue ts=.* phase=plan error_code=internal_error/m);
        expect(exec).toHaveBeenCalledWith('cm', ['add', structured.data.memoryLine], expect.objectContaining({ cwd, timeout: 10_000 }));
    });
    it.each([
        ['impl', '.diff'],
        ['review', '.md'],
    ])('returns a %s packet with a materialized artifact', async (phase, suffix) => {
        const state = makeState({
            phase: phase === 'impl' ? 'implementing' : 'reviewing',
            currentBeadId: 'bead-42',
            beadReviews: phase === 'review'
                ? { 'bead-42': [{ beadId: 'bead-42', passed: false, feedback: 'Needs a fix.' }] }
                : undefined,
        });
        const { ctx } = makeContext(state);
        const result = await runRescue(ctx, { cwd, phase, beadId: 'bead-42' });
        expect(result.isError).toBeUndefined();
        const structured = result.structuredContent;
        if (!structured || structured.status !== 'ok') {
            throw new Error('expected flywheel_rescue success envelope');
        }
        expect(structured.data.packet.phase).toBe(phase);
        expect(structured.data.packet.artifact_path).toContain(`/${phase}-bead-42-`);
        expect(structured.data.packet.artifact_path.endsWith(suffix)).toBe(true);
        const artifact = await readFile(join(cwd, structured.data.packet.artifact_path), 'utf8');
        if (phase === 'impl') {
            expect(artifact).toBe('diff --git a/src/a.ts b/src/a.ts\n+fixed\n');
        }
        else {
            expect(artifact).toContain('Needs a fix.');
            expect(artifact).toContain('diff --git a/src/a.ts b/src/a.ts');
        }
    });
    it('copies the fixture error code and hint into the packet and Codex prompt', async () => {
        const { ctx } = makeContext(makeState({ phase: 'implementing' }));
        const result = await runRescue(ctx, {
            cwd,
            phase: 'impl',
            beadId: 'bead-7',
            errorEnvelope: {
                code: 'cli_failure',
                message: 'The build command failed.',
                hint: 'Run npm test and inspect the first failure.',
            },
        });
        const structured = result.structuredContent;
        if (!structured || structured.status !== 'ok') {
            throw new Error('expected flywheel_rescue success envelope');
        }
        expect(structured.data.packet.error_code).toBe('cli_failure');
        expect(structured.data.packet.hint).toBe('Run npm test and inspect the first failure.');
        expect(structured.data.codexPrompt).toContain('cli_failure');
        expect(structured.data.codexPrompt).toContain('Run npm test and inspect the first failure.');
    });
    it('returns invalid_input for an unsupported phase', async () => {
        const { ctx } = makeContext();
        const result = await runRescue(ctx, { cwd, phase: 'deploy' });
        expect(result.isError).toBe(true);
        const structured = result.structuredContent;
        if (!structured || structured.status !== 'error') {
            throw new Error('expected flywheel_rescue error envelope');
        }
        expect(structured.data.error.code).toBe('invalid_input');
    });
    it('lists the canonical tool and deprecated alias and dispatches both runners', async () => {
        const names = TOOLS.map((tool) => tool.name);
        expect(names).toContain('flywheel_rescue');
        expect(names).toContain('orch_rescue');
        const state = makeState({ phase: 'planning', planDocument: 'docs/plan.md' });
        const { exec } = makeContext(state);
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => exec),
            loadState: vi.fn(() => state),
            saveState: vi.fn(),
            clearState: vi.fn(),
        });
        for (const name of ['flywheel_rescue', 'orch_rescue']) {
            const result = await handler({
                params: { name, arguments: { cwd, phase: 'plan' } },
            });
            const structured = result.structuredContent;
            if (!structured || typeof structured !== 'object' || !('status' in structured)) {
                throw new Error(`${name} must return a structured result`);
            }
            expect(structured.status, `${name} must have a runner`).toBe('ok');
            expect('tool' in structured ? structured.tool : undefined).toBe('flywheel_rescue');
        }
    });
    it('documents the rescue call in robot docs', () => {
        const markdown = buildRobotDocs('common_workflows').data.markdown;
        expect(markdown).toContain('flywheel_rescue');
        expect(markdown).toContain('phase: "plan" | "impl" | "review"');
    });
});
//# sourceMappingURL=rescue.test.js.map