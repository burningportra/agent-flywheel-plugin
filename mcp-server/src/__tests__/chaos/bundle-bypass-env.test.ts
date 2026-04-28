/**
 * Chaos: FW_SKILL_BUNDLE=off → always reads from disk regardless of bundle presence.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetSkillsBundleCache, getSkill } from '../../skills-bundle.js';
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

function writeBundleWithSkill(cwd: string, skillName: string, bundledBody: string): string {
  const bundlePath = join(cwd, 'mcp-server', 'dist', 'skills.bundle.json');
  const entry = {
    name: skillName,
    path: 'skills/start/SKILL.md',
    frontmatter: { name: skillName, description: 'bundled' },
    body: bundledBody,
    srcSha256: sha256Hex(Buffer.from(bundledBody, 'utf8')),
    sizeBytes: Buffer.byteLength(bundledBody, 'utf8'),
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
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
  return bundlePath;
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

describe('chaos/bundle-bypass-env', () => {
  it('returns source: disk when FW_SKILL_BUNDLE=off even with valid bundle present', async () => {
    process.env.FW_SKILL_BUNDLE = 'off';

    // Write disk skill
    const skillsDir = join(cwd, 'skills', 'start');
    mkdirSync(skillsDir, { recursive: true });
    const diskContent = '---\nname: agent-flywheel:start\ndescription: disk\n---\nDisk body\n';
    writeFileSync(join(skillsDir, 'SKILL.md'), diskContent);

    // Write a valid bundle with different body so we can distinguish source
    const bundlePath = writeBundleWithSkill(cwd, 'agent-flywheel:start', 'Bundle body only\n');

    const result = await getSkill('agent-flywheel:start', {
      repoRoot: cwd,
      bundlePath,
    });

    expect(result.source).toBe('disk');
    // Body comes from disk, not bundle
    expect(result.body).toContain('Disk body');
  });

  it('FW_SKILL_BUNDLE=OFF (uppercase) is also treated as off', async () => {
    process.env.FW_SKILL_BUNDLE = 'OFF';

    const skillsDir = join(cwd, 'skills', 'start');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'SKILL.md'),
      '---\nname: agent-flywheel:start\ndescription: d\n---\nDisk body\n',
    );

    const bundlePath = writeBundleWithSkill(cwd, 'agent-flywheel:start', 'Bundle body\n');

    const result = await getSkill('agent-flywheel:start', {
      repoRoot: cwd,
      bundlePath,
    });

    expect(result.source).toBe('disk');
  });

  it('FW_SKILL_BUNDLE unset → uses bundle normally', async () => {
    // No env var set
    const skillsDir = join(cwd, 'skills', 'start');
    mkdirSync(skillsDir, { recursive: true });
    const diskContent = '---\nname: agent-flywheel:start\ndescription: d\n---\nDisk body\n';
    writeFileSync(join(skillsDir, 'SKILL.md'), diskContent);

    const bundlePath = writeBundleWithSkill(cwd, 'agent-flywheel:start', 'Bundle body\n');

    const result = await getSkill('agent-flywheel:start', {
      repoRoot: cwd,
      bundlePath,
    });

    expect(result.source).toBe('bundle');
  });
});
