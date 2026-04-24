import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCallToolHandler, TOOLS } from '../server.js';
import { createInitialState } from '../types.js';
import { FlywheelError } from '../errors.js';
function makeTmpCwd() {
    return mkdtempSync(join(tmpdir(), 'server-cwd-'));
}
function cleanup(dir) {
    rmSync(dir, { recursive: true, force: true });
}
describe('createCallToolHandler', () => {
    it('preserves structuredContent returned by tool implementations', async () => {
        const cwd = process.cwd();
        const structuredContent = {
            tool: 'flywheel_profile',
            version: 1,
            status: 'ok',
            phase: 'discovering',
            data: {
                kind: 'profile_ready',
                nested: {
                    items: ['a', { ok: true }],
                },
            },
        };
        const runProfile = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Profile complete' }],
            structuredContent,
        });
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => createInitialState()),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_profile: runProfile,
            },
        });
        const result = await handler({
            params: {
                name: 'flywheel_profile',
                arguments: { cwd },
            },
        });
        expect(runProfile).toHaveBeenCalledWith(expect.objectContaining({ cwd }), { cwd });
        expect(result.structuredContent).toBe(structuredContent);
    });
    it('returns structured validation errors before dispatching to the tool', async () => {
        const cwd = process.cwd();
        const runSelect = vi.fn();
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => createInitialState()),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_select: runSelect,
            },
        });
        const result = await handler({
            params: {
                name: 'flywheel_select',
                arguments: { cwd },
            },
        });
        expect(runSelect).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: "Error: required parameter 'goal' is missing for tool 'flywheel_select'." }],
            structuredContent: {
                tool: 'flywheel_select',
                version: 1,
                status: 'error',
                phase: 'idle',
                data: {
                    kind: 'error',
                    error: {
                        code: 'invalid_input',
                        message: "Error: required parameter 'goal' is missing for tool 'flywheel_select'.",
                        retryable: false,
                        details: {
                            field: 'goal',
                            reason: 'missing_required_parameter',
                        },
                    },
                },
            },
        });
    });
    it('dispatches deprecated orch_profile alias to the same runner as flywheel_profile', async () => {
        const cwd = process.cwd();
        const structuredContent = {
            tool: 'flywheel_profile',
            version: 1,
            status: 'ok',
            phase: 'discovering',
            data: { kind: 'profile_ready' },
        };
        const runProfile = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Profile complete' }],
            structuredContent,
        });
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => createInitialState()),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_profile: runProfile,
                orch_profile: runProfile,
            },
        });
        const primary = await handler({
            params: { name: 'flywheel_profile', arguments: { cwd } },
        });
        const alias = await handler({
            params: { name: 'orch_profile', arguments: { cwd } },
        });
        expect(runProfile).toHaveBeenCalledTimes(2);
        expect(primary.structuredContent).toBe(structuredContent);
        expect(alias.structuredContent).toBe(structuredContent);
        expect(alias).toEqual(primary);
    });
    it('dispatches deprecated orch_memory alias to the same runner as flywheel_memory', async () => {
        const cwd = process.cwd();
        const runMemory = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Memory result' }],
        });
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => createInitialState()),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_memory: runMemory,
                orch_memory: runMemory,
            },
        });
        const primary = await handler({
            params: { name: 'flywheel_memory', arguments: { cwd } },
        });
        const alias = await handler({
            params: { name: 'orch_memory', arguments: { cwd } },
        });
        expect(runMemory).toHaveBeenCalledTimes(2);
        expect(alias).toEqual(primary);
    });
    it('exposes orch_* aliases in the TOOLS list with a DEPRECATED description prefix', () => {
        const primaryNames = [
            'flywheel_profile',
            'flywheel_discover',
            'flywheel_select',
            'flywheel_plan',
            'flywheel_approve_beads',
            'flywheel_review',
            'flywheel_verify_beads',
            'flywheel_memory',
        ];
        for (const primary of primaryNames) {
            const aliasName = primary.replace(/^flywheel_/, 'orch_');
            const aliasTool = TOOLS.find((t) => t.name === aliasName);
            expect(aliasTool, `missing alias ${aliasName}`).toBeDefined();
            expect(aliasTool.description).toMatch(new RegExp(`^\\[DEPRECATED — use ${primary} instead; removed in v4\\.0\\]`));
            const primaryTool = TOOLS.find((t) => t.name === primary);
            expect(aliasTool.inputSchema).toEqual(primaryTool.inputSchema);
        }
    });
    it('converts thrown FlywheelError to structured response preserving code and fields', async () => {
        const cwd = process.cwd();
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => ({ ...createInitialState(), phase: 'implementing' })),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_review: vi.fn().mockRejectedValue(new FlywheelError({ code: 'blocked_state', message: 'wrong phase', hint: 'Wait for reviewing phase.', retryable: false })),
            },
        });
        const result = await handler({
            params: {
                name: 'flywheel_review',
                arguments: { cwd, beadId: 'b-1', action: 'looks-good' },
            },
        });
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: 'wrong phase' }],
            structuredContent: {
                tool: 'flywheel_review',
                version: 1,
                status: 'error',
                phase: 'implementing',
                data: {
                    kind: 'error',
                    error: {
                        code: 'blocked_state',
                        message: 'wrong phase',
                        hint: 'Wait for reviewing phase.',
                        retryable: false,
                    },
                },
            },
        });
        const sc = result.structuredContent;
        expect(sc.data.error.code).not.toBe('internal_error');
    });
    it('returns structured internal errors when a tool runner throws', async () => {
        const cwd = process.cwd();
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => ({ ...createInitialState(), phase: 'planning' })),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_plan: vi.fn().mockRejectedValue(new Error('boom')),
            },
        });
        const result = await handler({
            params: {
                name: 'flywheel_plan',
                arguments: { cwd },
            },
        });
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: 'Error in flywheel_plan: boom' }],
            structuredContent: {
                tool: 'flywheel_plan',
                version: 1,
                status: 'error',
                phase: 'planning',
                data: {
                    kind: 'error',
                    error: {
                        code: 'internal_error',
                        message: 'Error in flywheel_plan: boom',
                        retryable: true,
                    },
                },
            },
        });
    });
    it('passes an AbortSignal through ctx to tool runners', async () => {
        const cwd = process.cwd();
        let capturedSignal;
        const runProfile = vi.fn().mockImplementation(async (ctx) => {
            capturedSignal = ctx.signal;
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => createInitialState()),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: { flywheel_profile: runProfile },
        });
        await handler({
            params: { name: 'flywheel_profile', arguments: { cwd } },
        });
        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        expect(capturedSignal.aborted).toBe(false);
    });
    it('canonicalizes cwd through realpath before dispatching to tool runners', async () => {
        const realCwd = makeTmpCwd();
        const symlinkParent = makeTmpCwd();
        const symlinkCwd = join(symlinkParent, 'linked-repo');
        symlinkSync(realCwd, symlinkCwd);
        const canonicalCwd = realpathSync(realCwd);
        try {
            const runProfile = vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'Profile complete' }],
            });
            const makeExec = vi.fn(() => vi.fn());
            const loadState = vi.fn(() => createInitialState());
            const handler = createCallToolHandler({
                makeExec,
                loadState,
                saveState: vi.fn(),
                clearState: vi.fn(),
                runners: {
                    flywheel_profile: runProfile,
                },
            });
            await handler({
                params: {
                    name: 'flywheel_profile',
                    arguments: { cwd: symlinkCwd },
                },
            });
            expect(makeExec).toHaveBeenCalledWith(canonicalCwd);
            expect(loadState).toHaveBeenCalledWith(canonicalCwd);
            expect(runProfile).toHaveBeenCalledWith(expect.objectContaining({ cwd: canonicalCwd }), { cwd: canonicalCwd });
        }
        finally {
            cleanup(symlinkParent);
            cleanup(realCwd);
        }
    });
    it('returns structured not_found when cwd does not exist', async () => {
        const missingCwd = join(tmpdir(), `missing-cwd-${Date.now()}`);
        const runProfile = vi.fn();
        const handler = createCallToolHandler({
            makeExec: vi.fn(() => vi.fn()),
            loadState: vi.fn(() => createInitialState()),
            saveState: vi.fn(),
            clearState: vi.fn(),
            runners: {
                flywheel_profile: runProfile,
            },
        });
        const result = await handler({
            params: {
                name: 'flywheel_profile',
                arguments: { cwd: missingCwd },
            },
        });
        expect(runProfile).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: `cwd not found: ${missingCwd}` }],
            structuredContent: {
                tool: 'flywheel_profile',
                version: 1,
                status: 'error',
                phase: 'idle',
                data: {
                    kind: 'error',
                    error: {
                        code: 'not_found',
                        message: `cwd not found: ${missingCwd}`,
                        retryable: false,
                        details: {
                            cwd: missingCwd,
                            absolutePath: missingCwd,
                            reason: 'not_found',
                        },
                    },
                },
            },
        });
    });
});
//# sourceMappingURL=server.test.js.map