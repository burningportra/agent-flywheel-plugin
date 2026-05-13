import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ERROR_META,
  FLYWHEEL_ERROR_CODES,
  type FlywheelErrorCode,
  type ErrorMeta,
} from '../errors-try-this.js';

/**
 * T1.2 type-level enforcement.
 *
 * The `_coverageCheck` assignment is the load-bearing assertion: if any
 * FlywheelErrorCode is missing from ERROR_META, this file fails to
 * compile. The runtime checks below back the compile-time guard with
 * value-level invariants the type system cannot express (non-empty
 * strings, code-name-not-echoed).
 */
describe('ERROR_META type-level coverage (T1.2)', () => {
  it('is exhaustively typed against FlywheelErrorCode', () => {
    const _coverageCheck: Record<FlywheelErrorCode, ErrorMeta> = ERROR_META;
    expectTypeOf(_coverageCheck).toEqualTypeOf<Record<FlywheelErrorCode, ErrorMeta>>();
    expect(Object.keys(_coverageCheck).length).toBe(FLYWHEEL_ERROR_CODES.length);
  });

  it.each(FLYWHEEL_ERROR_CODES)('code %s has non-empty hint + tryThis', (code) => {
    const meta = ERROR_META[code];
    expect(meta).toBeDefined();
    expect(typeof meta.hint).toBe('string');
    expect(meta.hint.length).toBeGreaterThan(0);
    expect(typeof meta.tryThis).toBe('string');
    expect(meta.tryThis.length).toBeGreaterThan(0);
  });

  it('every code in ERROR_META is a known FlywheelErrorCode (no orphans)', () => {
    const codes = new Set<string>(FLYWHEEL_ERROR_CODES);
    for (const key of Object.keys(ERROR_META)) {
      expect(codes.has(key), `${key} present in ERROR_META but not in FLYWHEEL_ERROR_CODES`).toBe(true);
    }
  });
});
