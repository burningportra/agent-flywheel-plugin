/**
 * P-001 (pass-5 second-order finding) — validateToolArgs must reject
 * invalid enum values BEFORE dispatch reaches the runner.
 *
 * Why: pre-P-001, a bad enum value (e.g. flywheel_review action:"review"
 * vs the valid hit-me|looks-good|skip) would slip through validation.
 * The runner's required-field check fired next and surfaced an error
 * about the WRONG field. Discovered in the pass-5 fresh-eyes simulation
 * transcript at audit/agent_simulations/post_pass_5/.
 */

import { describe, it, expect } from 'vitest';
import { validateToolArgs } from '../server.js';

describe('P-001 — validateToolArgs enum check', () => {
  it('rejects an invalid action enum on flywheel_review BEFORE dispatch', () => {
    const err = validateToolArgs('flywheel_review', {
      cwd: '/tmp',
      beadId: 'fake-1',
      action: 'review', // not in the enum; valid: hit-me|looks-good|skip
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('action');
    expect(err?.reason).toBe('invalid_enum_value');
    expect(err?.message).toContain('"hit-me"');
    expect(err?.message).toContain('"looks-good"');
    expect(err?.message).toContain('"skip"');
    expect(err?.message).toContain('got "review"');
  });

  it('rejects an invalid action enum on flywheel_approve_beads', () => {
    const err = validateToolArgs('flywheel_approve_beads', {
      cwd: '/tmp',
      action: 'approve', // not in enum
    });
    expect(err?.reason).toBe('invalid_enum_value');
    expect(err?.field).toBe('action');
  });

  it('rejects an invalid mode enum on flywheel_plan', () => {
    const err = validateToolArgs('flywheel_plan', {
      cwd: '/tmp',
      mode: 'super-deep', // not in enum
    });
    expect(err?.reason).toBe('invalid_enum_value');
    expect(err?.field).toBe('mode');
  });

  it('accepts a valid enum value', () => {
    const err = validateToolArgs('flywheel_review', {
      cwd: '/tmp',
      beadId: 'fake-1',
      action: 'hit-me',
    });
    expect(err).toBeNull();
  });

  it('skips the enum check when the field is omitted (optional case)', () => {
    // mode is optional on flywheel_plan; not passing it must not trigger
    // an enum error.
    const err = validateToolArgs('flywheel_plan', {
      cwd: '/tmp',
    });
    expect(err).toBeNull();
  });

  it('still surfaces missing-required-parameter (not enum) when the required field is absent', () => {
    // action is required on flywheel_approve_beads. Omitting it should
    // surface 'missing_required_parameter', NOT 'invalid_enum_value'.
    const err = validateToolArgs('flywheel_approve_beads', {
      cwd: '/tmp',
    });
    expect(err?.reason).toBe('missing_required_parameter');
    expect(err?.field).toBe('action');
  });

  it('returns null for tools the validator does not recognize', () => {
    const err = validateToolArgs('made_up_tool', {});
    expect(err).toBeNull();
  });
});
