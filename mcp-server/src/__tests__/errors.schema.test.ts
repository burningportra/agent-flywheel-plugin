/**
 * Schema round-trip tests for the FlywheelErrorCode contract.
 *
 * Covers both the 16 legacy codes and the 10 v3.4.0 additions
 * (doctor / hotspot / postmortem / template / telemetry) and enforces
 * that `DEFAULT_RETRYABLE` keys match `FLYWHEEL_ERROR_CODES` exactly.
 */

import { describe, it, expect } from 'vitest';
import {
  FLYWHEEL_ERROR_CODES,
  FlywheelErrorCodeSchema,
  FlywheelToolErrorSchema,
  FlywheelStructuredErrorSchema,
  DEFAULT_RETRYABLE,
  makeFlywheelErrorResult,
  sanitizeCause,
} from '../errors.js';

// Legacy + v3.4.0 additions — kept explicit so adding codes without updating
// this test is a visible diff in the PR.
const LEGACY_CODES = [
  'missing_prerequisite',
  'invalid_input',
  'not_found',
  'cli_failure',
  'cli_not_available',
  'parse_failure',
  'exec_timeout',
  'exec_aborted',
  'blocked_state',
  'concurrent_write',
  'agent_mail_unreachable',
  'deep_plan_all_failed',
  'empty_plan',
  'already_closed',
  'unsupported_action',
  'internal_error',
] as const;

const V3_4_CODES = [
  'doctor_check_failed',
  'doctor_partial_report',
  'hotspot_parse_failure',
  'hotspot_bead_body_unparseable',
  'postmortem_empty_session',
  'postmortem_checkpoint_stale',
  'template_not_found',
  'template_placeholder_missing',
  'template_expansion_failed',
  'telemetry_store_failed',
] as const;

describe('FLYWHEEL_ERROR_CODES — v3.4.0 shape', () => {
  it('contains exactly the 16 legacy + 10 new codes (26 total)', () => {
    expect(FLYWHEEL_ERROR_CODES).toHaveLength(LEGACY_CODES.length + V3_4_CODES.length);
    expect(FLYWHEEL_ERROR_CODES).toHaveLength(26);
  });

  it('preserves legacy codes in order for v3.3.0 back-compat', () => {
    for (let i = 0; i < LEGACY_CODES.length; i++) {
      expect(FLYWHEEL_ERROR_CODES[i]).toBe(LEGACY_CODES[i]);
    }
  });

  it('appends the v3.4.0 codes after the legacy set', () => {
    const tail = FLYWHEEL_ERROR_CODES.slice(LEGACY_CODES.length);
    expect(tail).toEqual(V3_4_CODES);
  });

  it('every legacy code round-trips through FlywheelErrorCodeSchema.parse()', () => {
    for (const code of LEGACY_CODES) {
      expect(FlywheelErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it('every v3.4.0 code round-trips through FlywheelErrorCodeSchema.parse()', () => {
    for (const code of V3_4_CODES) {
      expect(FlywheelErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});

describe('DEFAULT_RETRYABLE — completeness invariant', () => {
  it('has an entry for every code in FLYWHEEL_ERROR_CODES (no missing keys)', () => {
    const keys = Object.keys(DEFAULT_RETRYABLE).sort();
    const codes = [...FLYWHEEL_ERROR_CODES].sort();
    expect(keys).toEqual(codes);
  });

  it('has no extra keys beyond FLYWHEEL_ERROR_CODES', () => {
    const codeSet = new Set<string>(FLYWHEEL_ERROR_CODES);
    for (const key of Object.keys(DEFAULT_RETRYABLE)) {
      expect(codeSet.has(key)).toBe(true);
    }
  });

  it('template_expansion_failed defaults to retryable=true (mid-reload is transient)', () => {
    expect(DEFAULT_RETRYABLE.template_expansion_failed).toBe(true);
  });

  it('telemetry_store_failed defaults to retryable=true (disk contention is transient)', () => {
    expect(DEFAULT_RETRYABLE.telemetry_store_failed).toBe(true);
  });

  it('other v3.4.0 codes default to retryable=false', () => {
    expect(DEFAULT_RETRYABLE.doctor_check_failed).toBe(false);
    expect(DEFAULT_RETRYABLE.doctor_partial_report).toBe(false);
    expect(DEFAULT_RETRYABLE.hotspot_parse_failure).toBe(false);
    expect(DEFAULT_RETRYABLE.hotspot_bead_body_unparseable).toBe(false);
    expect(DEFAULT_RETRYABLE.postmortem_empty_session).toBe(false);
    expect(DEFAULT_RETRYABLE.postmortem_checkpoint_stale).toBe(false);
    expect(DEFAULT_RETRYABLE.template_not_found).toBe(false);
    expect(DEFAULT_RETRYABLE.template_placeholder_missing).toBe(false);
  });
});

describe('FlywheelToolErrorSchema.parse — every code accepts a minimal error', () => {
  it('accepts a minimal error object for every legacy code', () => {
    for (const code of LEGACY_CODES) {
      const parsed = FlywheelToolErrorSchema.parse({ code, message: `test ${code}` });
      expect(parsed.code).toBe(code);
      expect(parsed.message).toBe(`test ${code}`);
    }
  });

  it('accepts a minimal error object for every v3.4.0 code', () => {
    for (const code of V3_4_CODES) {
      const parsed = FlywheelToolErrorSchema.parse({ code, message: `v3.4 test ${code}` });
      expect(parsed.code).toBe(code);
      expect(parsed.message).toBe(`v3.4 test ${code}`);
    }
  });

  it('rejects unknown codes at the tool-error boundary', () => {
    expect(() => FlywheelToolErrorSchema.parse({ code: 'made_up_code', message: 'x' })).toThrow();
  });
});

describe('makeFlywheelErrorResult — v3.4.0 codes produce valid structured envelopes', () => {
  it('every v3.4.0 code round-trips through FlywheelStructuredErrorSchema', () => {
    for (const code of V3_4_CODES) {
      const result = makeFlywheelErrorResult('flywheel_profile', 'idle', {
        code,
        message: `surface ${code}`,
      });
      // Never throws on a known code
      const parsed = FlywheelStructuredErrorSchema.parse(result.structuredContent);
      expect(parsed.data.error.code).toBe(code);
      expect(parsed.data.error.message).toBe(`surface ${code}`);
      // retryable is populated from DEFAULT_RETRYABLE
      expect(parsed.data.error.retryable).toBe(DEFAULT_RETRYABLE[code]);
    }
  });
});

describe('sanitizeCause — path-leak redaction', () => {
  it('redacts /Users/<name> home paths to ~', () => {
    const raw = "ENOENT: no such file or directory '/Users/kevtrinh/secret/file.json'";
    expect(sanitizeCause(raw)).not.toContain('kevtrinh');
    expect(sanitizeCause(raw)).toContain('~');
  });

  it('redacts /tmp, /var, /home absolute paths to a <path>/basename shape', () => {
    const raw = "stat /tmp/session-abc/run.log failed";
    const out = sanitizeCause(raw);
    expect(out).not.toContain('session-abc');
    expect(out).toContain('<path>');
  });

  it('caps output at 200 chars by default', () => {
    const raw = 'x'.repeat(5000);
    expect(sanitizeCause(raw).length).toBeLessThanOrEqual(200);
    expect(sanitizeCause(raw).endsWith('…')).toBe(true);
  });

  it('passes through short non-path messages unchanged', () => {
    const raw = 'connection refused';
    expect(sanitizeCause(raw)).toBe('connection refused');
  });

  it('classifyExecError-shaped messages get sanitized when makeFlywheelErrorResult wires cause', () => {
    const result = makeFlywheelErrorResult('flywheel_profile', 'idle', {
      code: 'cli_failure',
      message: 'br update failed',
      cause: "ENOENT: '/Users/kevtrinh/foo/bar'",
    });
    expect(result.structuredContent.data.error.cause).not.toContain('kevtrinh');
  });
});
