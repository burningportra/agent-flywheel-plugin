import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, LEVELS } from '../logger.js';

// ─── Helpers ────────────────────────────────────────────────────

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk).trim());
    return true;
  });
  fn();
  spy.mockRestore();
  return lines;
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l));
}

// ─── Level filtering ────────────────────────────────────────────

describe('createLogger — level filtering', () => {
  const originalEnv = process.env.ORCH_LOG_LEVEL;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ORCH_LOG_LEVEL;
    } else {
      process.env.ORCH_LOG_LEVEL = originalEnv;
    }
  });

  it('suppresses debug and info at default level (warn)', () => {
    delete process.env.ORCH_LOG_LEVEL;
    // Re-import so level is re-evaluated — use a fresh logger
    const log = createLogger('test');
    const lines = captureStderr(() => {
      log.debug('debug msg');
      log.info('info msg');
      log.warn('warn msg');
      log.error('error msg');
    });
    // Only warn and error should pass
    expect(lines).toHaveLength(2);
    const parsed = parseLines(lines);
    expect(parsed[0].level).toBe('warn');
    expect(parsed[1].level).toBe('error');
  });

  it('emits all levels when ORCH_LOG_LEVEL=debug', () => {
    process.env.ORCH_LOG_LEVEL = 'debug';
    const log = createLogger('test');
    const lines = captureStderr(() => {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    });
    expect(lines).toHaveLength(4);
    const levels = parseLines(lines).map((l) => l.level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('emits only error when ORCH_LOG_LEVEL=error', () => {
    process.env.ORCH_LOG_LEVEL = 'error';
    const log = createLogger('test');
    const lines = captureStderr(() => {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    });
    expect(lines).toHaveLength(1);
    expect(parseLines(lines)[0].level).toBe('error');
  });

  it('falls back to warn for unknown ORCH_LOG_LEVEL', () => {
    process.env.ORCH_LOG_LEVEL = 'verbose';
    const log = createLogger('test');
    const lines = captureStderr(() => {
      log.debug('d');
      log.warn('w');
    });
    expect(lines).toHaveLength(1);
    expect(parseLines(lines)[0].level).toBe('warn');
  });
});

// ─── Output format ───────────────────────────────────────────────

describe('createLogger — output format', () => {
  beforeEach(() => { process.env.ORCH_LOG_LEVEL = 'debug'; });
  afterEach(() => { delete process.env.ORCH_LOG_LEVEL; });

  it('writes valid JSON to stderr', () => {
    const log = createLogger('myctx');
    const lines = captureStderr(() => log.warn('hello'));
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('includes ts, level, ctx, msg fields', () => {
    const log = createLogger('myctx');
    const lines = captureStderr(() => log.warn('hello'));
    const obj = parseLines(lines)[0];
    expect(typeof obj.ts).toBe('string');
    expect(obj.level).toBe('warn');
    expect(obj.ctx).toBe('myctx');
    expect(obj.msg).toBe('hello');
  });

  it('ts is a valid ISO timestamp', () => {
    const log = createLogger('test');
    const before = Date.now();
    const lines = captureStderr(() => log.info('ts test'));
    const after = Date.now();
    const parsed = parseLines(lines)[0];
    const ts = new Date(parsed.ts as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('merges extra fields into output', () => {
    const log = createLogger('test');
    const lines = captureStderr(() => log.error('oops', { code: 42, path: '/tmp/x' }));
    const obj = parseLines(lines)[0];
    expect(obj.code).toBe(42);
    expect(obj.path).toBe('/tmp/x');
    expect(obj.msg).toBe('oops');
  });

  it('each log call writes exactly one newline-terminated line', () => {
    const log = createLogger('test');
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    log.warn('one');
    log.warn('two');
    spy.mockRestore();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].endsWith('\n')).toBe(true);
    expect(chunks[1].endsWith('\n')).toBe(true);
  });

  it('LEVELS constant is ordered debug < info < warn < error', () => {
    expect(LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
