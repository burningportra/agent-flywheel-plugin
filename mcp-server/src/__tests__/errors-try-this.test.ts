import { describe, it, expect } from 'vitest';
import {
  FLYWHEEL_ERROR_CODES,
  DEFAULT_HINTS,
  DEFAULT_TRY_THIS,
} from '../errors-try-this.js';

/**
 * T1.1 coverage gate — every FlywheelErrorCode MUST carry both a
 * non-empty narrative `hint` (DEFAULT_HINTS) and an imperative,
 * paste-ready `try_this` (DEFAULT_TRY_THIS). The TypeScript `Record`
 * already enforces presence at compile time; this runtime check
 * additionally catches accidental empty strings and the substring-of-
 * code-name anti-pattern that would defeat the agent-ergonomics intent.
 */
describe('error meta coverage (T1.1)', () => {
  it.each(FLYWHEEL_ERROR_CODES)('code %s has non-empty hint', (code) => {
    const hint = DEFAULT_HINTS[code];
    expect(hint, `hint missing for ${code}`).toBeDefined();
    expect(hint, `hint empty for ${code}`).not.toBe('');
  });

  it.each(FLYWHEEL_ERROR_CODES)('code %s has non-empty try_this', (code) => {
    const tryThis = DEFAULT_TRY_THIS[code];
    expect(tryThis, `try_this missing for ${code}`).toBeDefined();
    expect(tryThis, `try_this empty for ${code}`).not.toBe('');
  });

  it('every code is keyed in both dicts (no orphans)', () => {
    const codes = new Set<string>(FLYWHEEL_ERROR_CODES);
    expect(new Set(Object.keys(DEFAULT_HINTS))).toEqual(codes);
    expect(new Set(Object.keys(DEFAULT_TRY_THIS))).toEqual(codes);
  });
});
