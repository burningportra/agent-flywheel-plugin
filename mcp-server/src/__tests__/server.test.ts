import { describe, expect, it, vi } from 'vitest';
import { createCallToolHandler } from '../server.js';
import { createInitialState } from '../types.js';

describe('createCallToolHandler', () => {
  it('preserves structuredContent returned by tool implementations', async () => {
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
        arguments: { cwd: '/tmp/repo' },
      },
    } as never);

    expect(runProfile).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/repo' }),
      { cwd: '/tmp/repo' }
    );
    expect(result.structuredContent).toBe(structuredContent);
  });

  it('returns structured validation errors before dispatching to the tool', async () => {
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
        arguments: { cwd: '/tmp/repo' },
      },
    } as never);

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

  it('returns structured internal errors when a tool runner throws', async () => {
    const handler = createCallToolHandler({
      makeExec: vi.fn(() => vi.fn()),
      loadState: vi.fn(() => ({ ...createInitialState(), phase: 'planning' as const })),
      saveState: vi.fn(),
      clearState: vi.fn(),
      runners: {
        flywheel_plan: vi.fn().mockRejectedValue(new Error('boom')),
      },
    });

    const result = await handler({
      params: {
        name: 'flywheel_plan',
        arguments: { cwd: '/tmp/repo' },
      },
    } as never);

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
});
