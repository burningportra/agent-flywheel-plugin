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
// MIN_LEVEL is cached at module load time.
// We test level filtering by loading the module fresh via vi.resetModules()
// for tests that need non-default levels.

describe('createLogger — level filtering', () => {
  it('suppresses debug and info at default level (warn)', () => {
    // Default env (no ORCH_LOG_LEVEL set) — module loaded at test startup with warn
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

  it('emits all levels when ORCH_LOG_LEVEL=debug', async () => {
    vi.resetModules();
    process.env.ORCH_LOG_LEVEL = 'debug';
    try {
      const { createLogger: freshCreateLogger } = await import('../logger.js?debug');
      const log = freshCreateLogger('test');
      const lines = captureStderr(() => {
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
      });
      expect(lines).toHaveLength(4);
      const levels = parseLines(lines).map((l) => l.level);
      expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
    } finally {
      delete process.env.ORCH_LOG_LEVEL;
    }
  });

  it('emits only error when ORCH_LOG_LEVEL=error', async () => {
    vi.resetModules();
    process.env.ORCH_LOG_LEVEL = 'error';
    try {
      const { createLogger: freshCreateLogger } = await import('../logger.js?error');
      const log = freshCreateLogger('test');
      const lines = captureStderr(() => {
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
      });
      expect(lines).toHaveLength(1);
      expect(parseLines(lines)[0].level).toBe('error');
    } finally {
      delete process.env.ORCH_LOG_LEVEL;
    }
  });

  it('falls back to warn for unknown ORCH_LOG_LEVEL', async () => {
    vi.resetModules();
    process.env.ORCH_LOG_LEVEL = 'verbose';
    try {
      const { createLogger: freshCreateLogger } = await import('../logger.js?verbose');
      const log = freshCreateLogger('test');
      const lines = captureStderr(() => {
        log.debug('d');
        log.warn('w');
      });
      // The module init emits a warning for the invalid level, plus our log.warn
      const logLines = lines.filter((l) => {
        try {
          const obj = JSON.parse(l);
          return obj.ctx !== 'logger';
        } catch {
          return false;
        }
      });
      expect(logLines).toHaveLength(1);
      expect(parseLines(logLines)[0].level).toBe('warn');
    } finally {
      delete process.env.ORCH_LOG_LEVEL;
    }
  });
});

// ─── Output format ───────────────────────────────────────────────

describe('createLogger — output format', () => {
  // These tests use the default module (warn level). We set ORCH_LOG_LEVEL=debug
  // and reload so info/debug calls are visible too.
  let freshCreateLogger: typeof createLogger;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ORCH_LOG_LEVEL = 'debug';
    const mod = await import('../logger.js?format');
    freshCreateLogger = mod.createLogger;
  });

  afterEach(() => { delete process.env.ORCH_LOG_LEVEL; });

  it('writes valid JSON to stderr', () => {
    const log = freshCreateLogger('myctx');
    const lines = captureStderr(() => log.warn('hello'));
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('includes ts, level, ctx, msg fields', () => {
    const log = freshCreateLogger('myctx');
    const lines = captureStderr(() => log.warn('hello'));
    const obj = parseLines(lines)[0];
    expect(typeof obj.ts).toBe('string');
    expect(obj.level).toBe('warn');
    expect(obj.ctx).toBe('myctx');
    expect(obj.msg).toBe('hello');
  });

  it('ts is a valid ISO timestamp', () => {
    const log = freshCreateLogger('test');
    const before = Date.now();
    const lines = captureStderr(() => log.info('ts test'));
    const after = Date.now();
    const parsed = parseLines(lines)[0];
    const ts = new Date(parsed.ts as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('merges extra fields into output', () => {
    const log = freshCreateLogger('test');
    const lines = captureStderr(() => log.error('oops', { code: 42, path: '/tmp/x' }));
    const obj = parseLines(lines)[0];
    expect(obj.code).toBe(42);
    expect(obj.path).toBe('/tmp/x');
    expect(obj.msg).toBe('oops');
  });

  it('each log call writes exactly one newline-terminated line', () => {
    const log = freshCreateLogger('test');
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
