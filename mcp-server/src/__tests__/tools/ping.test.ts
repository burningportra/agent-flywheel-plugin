import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { runPing, type PingResult } from '../../tools/ping.js';
import { createCallToolHandler } from '../../server.js';
import { createInitialState } from '../../types.js';

describe('runPing', () => {
  it('returns pong with server metadata', async () => {
    const before = Date.now();
    const result = await runPing();
    const after = Date.now();

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^pong — agent-flywheel v\d+\.\d+\.\d+/);

    const sc = result.structuredContent as PingResult;
    expect(sc.tool).toBe('flywheel_ping');
    expect(sc.version).toBe(1);
    expect(sc.status).toBe('ok');
    expect(sc.data.kind).toBe('pong');
    expect(sc.data.serverName).toBe('agent-flywheel');
    expect(typeof sc.data.serverVersion).toBe('string');
    expect(sc.data.timestampMs).toBeGreaterThanOrEqual(before);
    expect(sc.data.timestampMs).toBeLessThanOrEqual(after);
  });

  it('returns a different timestampMs on each call', async () => {
    const a = await runPing();
    await new Promise(r => setTimeout(r, 2));
    const b = await runPing();
    const tsA = (a.structuredContent as PingResult).data.timestampMs;
    const tsB = (b.structuredContent as PingResult).data.timestampMs;
    expect(tsB).toBeGreaterThanOrEqual(tsA);
  });
});

describe('createCallToolHandler — flywheel_ping', () => {
  it('handles flywheel_ping without cwd', async () => {
    const handler = createCallToolHandler({
      makeExec: vi.fn(() => vi.fn()),
      loadState: vi.fn(() => createInitialState()),
      saveState: vi.fn(),
      clearState: vi.fn(),
    });

    const result = await handler({
      params: { name: 'flywheel_ping', arguments: {} },
    } as never);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/^pong/);
  });

  it('does not invoke loadState or makeExec for flywheel_ping', async () => {
    const mockLoadState = vi.fn(() => createInitialState());
    const mockMakeExec = vi.fn(() => vi.fn());

    const handler = createCallToolHandler({
      makeExec: mockMakeExec,
      loadState: mockLoadState,
      saveState: vi.fn(),
      clearState: vi.fn(),
    });

    await handler({
      params: { name: 'flywheel_ping', arguments: {} },
    } as never);

    expect(mockLoadState).not.toHaveBeenCalled();
    expect(mockMakeExec).not.toHaveBeenCalled();
  });
});
