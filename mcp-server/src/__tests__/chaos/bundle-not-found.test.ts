/**
 * Chaos: getSkill for a nonexistent skill name → not_found error envelope.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetSkillsBundleCache, getSkill } from '../../skills-bundle.js';
import { FlywheelError } from '../../errors.js';
import { makeTmpCwd, cleanupTmpCwd } from './_helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJSON(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
  return '{' + parts.join(',') + '}';
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let cwd: string;

beforeEach(() => {
  cwd = makeTmpCwd();
  _resetSkillsBundleCache();
  delete process.env.FW_SKILL_BUNDLE;
});

afterEach(() => {
  cleanupTmpCwd(cwd);
  _resetSkillsBundleCache();
  delete process.env.FW_SKILL_BUNDLE;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('chaos/bundle-not-found', () => {
  it('throws FlywheelError with code not_found when skill absent from bundle and disk', async () => {
    // Bundle with a different skill
    const skillsDir = join(cwd, 'skills', 'start');
    mkdirSync(skillsDir, { recursive: true });
    const content = '---\nname: agent-flywheel:start\ndescription: other\n---\nOther body\n';
    writeFileSync(join(skillsDir, 'SKILL.md'), content);

    const relPath = 'skills/start/SKILL.md';
    const buf = Buffer.from(content, 'utf8');
    const body = 'Other body\n';
    const entry = {
      name: 'agent-flywheel:start',
      path: relPath,
      frontmatter: { name: 'agent-flywheel:start', description: 'other' },
      body,
      srcSha256: sha256Hex(buf),
      sizeBytes: Buffer.byteLength(body, 'utf8'),
      bundledAt: new Date().toISOString(),
    };
    const entries = [entry];
    const bundle = {
      bundleVersion: 1,
      generatedAt: new Date().toISOString(),
      generator: 'test',
      manifestSha256: sha256Hex(canonicalJSON(entries)),
      entries,
    };
    const bundlePath = join(cwd, 'mcp-server', 'dist', 'skills.bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');

    await expect(
      getSkill('agent-flywheel:does-not-exist', { repoRoot: cwd, bundlePath }),
    ).rejects.toThrow(FlywheelError);

    await expect(
      getSkill('agent-flywheel:does-not-exist', { repoRoot: cwd, bundlePath }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found with no bundle present and skill absent from disk', async () => {
    await expect(
      getSkill('agent-flywheel:ghost', {
        repoRoot: cwd,
        bundlePath: join(cwd, 'nonexistent.json'),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('not_found error includes skill name in message', async () => {
    let caught: unknown;
    try {
      await getSkill('agent-flywheel:phantom', {
        repoRoot: cwd,
        bundlePath: join(cwd, 'nonexistent.json'),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlywheelError);
    expect((caught as FlywheelError).message).toContain('phantom');
  });
});
