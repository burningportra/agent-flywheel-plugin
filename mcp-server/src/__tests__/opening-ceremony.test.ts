import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOpeningCeremonyFrames,
  resolveOpeningCeremonyMode,
  runOpeningCeremony,
} from '../opening-ceremony.js';
import type {
  OpeningCeremonyRuntime,
  OpeningCeremonyWriter,
} from '../types.js';

function makeWriter(): OpeningCeremonyWriter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write(text: string) {
      writes.push(text);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getOpeningCeremonyFrames', () => {
  it('returns non-empty banner frames with positive delays', () => {
    const frames = getOpeningCeremonyFrames();

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.text.trim().length > 0)).toBe(true);
    expect(frames.every((frame) => frame.delayMs > 0)).toBe(true);
    expect(frames.every((frame) => frame.text.includes('AGENT-FLYWHEEL'))).toBe(true);
  });

  it('returns defensive copies of the frame objects', () => {
    const first = getOpeningCeremonyFrames();
    first[0].text = 'mutated';

    const second = getOpeningCeremonyFrames();

    expect(second[0].text).not.toBe('mutated');
    expect(second[0].text).toContain('CLAUDE // AGENT-FLYWHEEL');
  });
});

describe('resolveOpeningCeremonyMode', () => {
  it('selects static mode for non-interactive, reduced-motion, or narrow terminals', () => {
    expect(resolveOpeningCeremonyMode({ interactive: false })).toBe('static');
    expect(resolveOpeningCeremonyMode({ reducedMotion: true })).toBe('static');
    expect(resolveOpeningCeremonyMode({ terminalWidth: 55 })).toBe('static');
  });

  it('selects animated mode by default and skip mode when disabled or quiet', () => {
    expect(resolveOpeningCeremonyMode()).toBe('animated');
    expect(resolveOpeningCeremonyMode({ terminalWidth: 56 })).toBe('animated');
    expect(resolveOpeningCeremonyMode({ enabled: false })).toBe('skip');
    expect(resolveOpeningCeremonyMode({ quiet: true })).toBe('skip');
  });
});

describe('runOpeningCeremony', () => {
  it('renders the static fallback as a single write and does not sleep', async () => {
    const writer = makeWriter();
    const sleep = vi.fn<OpeningCeremonyRuntime['sleep']>();
    const runtime: OpeningCeremonyRuntime = {
      now: () => 100,
      sleep,
    };

    const result = await runOpeningCeremony(writer, {
      interactive: false,
      runtime,
    });

    expect(result).toEqual({
      rendered: true,
      mode: 'static',
      frameCount: 1,
      durationMs: 0,
    });
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]).toContain('ceremony complete');
    expect(writer.writes[0]).toContain('ignite /start');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('falls back to static mode for terminals narrower than 56 columns', async () => {
    const writer = makeWriter();

    const result = await runOpeningCeremony(writer, {
      terminalWidth: 40,
      runtime: {
        now: () => 0,
        sleep: vi.fn(),
      },
    });

    expect(result.mode).toBe('static');
    expect(result.frameCount).toBe(1);
    expect(writer.writes).toHaveLength(1);
  });

  it('animates all frames, sleeps between frames, and caps reported duration at 900ms', async () => {
    const writer = makeWriter();
    const sleep = vi.fn<OpeningCeremonyRuntime['sleep']>().mockResolvedValue(undefined);
    let now = 0;
    const runtime: OpeningCeremonyRuntime = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        await sleep(ms);
      },
    };

    const result = await runOpeningCeremony(writer, {
      runtime,
      maxDurationMs: 900,
    });
    const frames = getOpeningCeremonyFrames();

    expect(result).toEqual({
      rendered: true,
      mode: 'animated',
      frameCount: frames.length,
      durationMs: 300,
    });
    expect(result.durationMs).toBeLessThanOrEqual(900);
    expect(writer.writes).toHaveLength(frames.length);
    expect(sleep).toHaveBeenCalledTimes(frames.length - 1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([120, 180]);
  });

  it('uses fake timers with the default runtime clock and sleep implementation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));

    const writer = makeWriter();
    const run = runOpeningCeremony(writer);
    await vi.advanceTimersByTimeAsync(120);
    expect(writer.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(180);
    const result = await run;

    expect(result).toMatchObject({
      rendered: true,
      mode: 'animated',
      frameCount: getOpeningCeremonyFrames().length,
      durationMs: 300,
    });
    expect(writer.writes).toHaveLength(getOpeningCeremonyFrames().length);
  });

  it('returns a structured failure when the writer throws', async () => {
    const result = await runOpeningCeremony(
      {
        write() {
          throw new Error('terminal unavailable');
        },
      },
      {
        runtime: {
          now: () => 25,
          sleep: vi.fn(),
        },
      },
    );

    expect(result).toEqual({
      rendered: false,
      mode: 'animated',
      frameCount: 0,
      durationMs: 0,
      error: 'terminal unavailable',
    });
  });
});
