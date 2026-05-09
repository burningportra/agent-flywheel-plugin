/**
 * R-008 — strict-key validation + Levenshtein-1 typo suggestion for
 * flywheel.config.yaml. Currently warn-only (no fail-loud); upgrading
 * to fail-loud is tracked for v4.0.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFlywheelConfig,
  loadFlywheelConfigWithWarnings,
  suggestKey,
  DEFAULT_CONFIG,
} from '../flywheel-config.js';

describe('R-008 — suggestKey (Levenshtein-1)', () => {
  it('returns the closest known key for a 1-edit typo', () => {
    expect(suggestKey('convergance', ['convergence', 'unrelated'])).toBe('convergence');
    expect(suggestKey('gate_advance_wav', ['gate_advance_wave', 'frob'])).toBe('gate_advance_wave');
  });

  it('returns undefined when no key is within distance 1', () => {
    expect(suggestKey('totally_unrelated', ['convergence'])).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(suggestKey('', ['convergence'])).toBeUndefined();
  });

  it('exact match returns the key itself (distance 0 < 2)', () => {
    expect(suggestKey('convergence', ['convergence', 'other'])).toBe('convergence');
  });
});

describe('R-008 — loadFlywheelConfigWithWarnings', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'flywheel-config-r008-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns DEFAULT_CONFIG with no warnings when no config file exists', () => {
    const result = loadFlywheelConfigWithWarnings(tmp);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings).toEqual([]);
  });

  it('loads a clean valid config without warnings', () => {
    writeFileSync(join(tmp, 'flywheel.config.yaml'), `convergence:\n  gate_advance_wave: false\n`);
    const result = loadFlywheelConfigWithWarnings(tmp);
    expect(result.config.convergence.gate_advance_wave).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('typo "convergance" surfaces unknown_key warning with suggestion="convergence"', () => {
    writeFileSync(
      join(tmp, 'flywheel.config.yaml'),
      `convergance:\n  gate_advance_wave: false\n`,
    );
    const result = loadFlywheelConfigWithWarnings(tmp);
    // Defaults still load — warn-only stage means the gate is NOT silently disabled.
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      kind: 'unknown_key',
      path: 'convergance',
      suggestion: 'convergence',
    });
    expect(result.warnings[0].message).toContain('did you mean "convergence"');
  });

  it('nested typo "gate_advance_wav" surfaces convergence.gate_advance_wave suggestion', () => {
    writeFileSync(
      join(tmp, 'flywheel.config.yaml'),
      `convergence:\n  gate_advance_wav: false\n`,
    );
    const result = loadFlywheelConfigWithWarnings(tmp);
    // Defaults loaded for the recognized field (gate stays true).
    expect(result.config.convergence.gate_advance_wave).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      kind: 'unknown_key',
      path: 'convergence.gate_advance_wav',
      suggestion: 'convergence.gate_advance_wave',
    });
  });

  it('completely-unknown key warns without a suggestion', () => {
    writeFileSync(
      join(tmp, 'flywheel.config.yaml'),
      `totally_made_up_section:\n  whatever: true\n`,
    );
    const result = loadFlywheelConfigWithWarnings(tmp);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      kind: 'unknown_key',
      path: 'totally_made_up_section',
    });
    expect(result.warnings[0].suggestion).toBeUndefined();
  });

  it('wrong-type value for gate_advance_wave warns and falls back to default', () => {
    writeFileSync(
      join(tmp, 'flywheel.config.yaml'),
      `convergence:\n  gate_advance_wave: maybe\n`,
    );
    const result = loadFlywheelConfigWithWarnings(tmp);
    expect(result.config.convergence.gate_advance_wave).toBe(true); // default
    const wrongType = result.warnings.find((w) => w.kind === 'wrong_type');
    expect(wrongType, 'expected a wrong_type warning').toBeDefined();
    expect(wrongType?.path).toBe('convergence.gate_advance_wave');
  });

  it('loadFlywheelConfig (legacy thin wrapper) still returns just the config', () => {
    writeFileSync(join(tmp, 'flywheel.config.yaml'), `convergence:\n  gate_advance_wave: false\n`);
    const config = loadFlywheelConfig(tmp);
    expect(config.convergence.gate_advance_wave).toBe(false);
  });
});
