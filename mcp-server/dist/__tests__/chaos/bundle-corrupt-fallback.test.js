/**
 * Chaos: bundle with bad manifestSha256 → source: disk fallback + bundle_integrity_failed log.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSkillsBundleCache, getSkill } from '../../skills-bundle.js';
import { makeTmpCwd, cleanupTmpCwd } from './_helpers.js';
// ─── Helpers ──────────────────────────────────────────────────────────────────
function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
function canonicalJSON(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map((v) => canonicalJSON(v)).join(',') + ']';
    const obj = value;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
    return '{' + parts.join(',') + '}';
}
// ─── Setup / teardown ─────────────────────────────────────────────────────────
let cwd;
beforeEach(() => {
    cwd = makeTmpCwd();
    _resetSkillsBundleCache();
    delete process.env.FW_SKILL_BUNDLE;
});
afterEach(() => {
    cleanupTmpCwd(cwd);
    _resetSkillsBundleCache();
    delete process.env.FW_SKILL_BUNDLE;
    vi.restoreAllMocks();
});
// ─── Tests ────────────────────────────────────────────────────────────────────
describe('chaos/bundle-corrupt-fallback', () => {
    it('falls back to disk and emits bundle_integrity_failed when manifestSha256 is wrong', async () => {
        // Write a disk skill so fallback has something to return
        const skillsDir = join(cwd, 'skills', 'start');
        mkdirSync(skillsDir, { recursive: true });
        const diskContent = '---\nname: agent-flywheel:start\ndescription: disk skill\n---\nDisk body\n';
        writeFileSync(join(skillsDir, 'SKILL.md'), diskContent);
        // Build a bundle with WRONG manifestSha256
        const relPath = 'skills/start/SKILL.md';
        const buf = Buffer.from(diskContent, 'utf8');
        const body = 'Disk body\n';
        const entry = {
            name: 'agent-flywheel:start',
            path: relPath,
            frontmatter: { name: 'agent-flywheel:start', description: 'disk skill' },
            body,
            srcSha256: sha256Hex(buf),
            sizeBytes: Buffer.byteLength(body, 'utf8'),
            bundledAt: new Date().toISOString(),
        };
        const entries = [entry];
        // Intentionally wrong sha
        const corruptManifestSha = 'deadbeef'.repeat(8);
        const bundle = {
            bundleVersion: 1,
            generatedAt: new Date().toISOString(),
            generator: 'test',
            manifestSha256: corruptManifestSha,
            entries,
        };
        const bundlePath = join(cwd, 'mcp-server', 'dist', 'skills.bundle.json');
        writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        const warnSpy = vi.spyOn(process.stderr, 'write');
        const result = await getSkill('agent-flywheel:start', {
            repoRoot: cwd,
            bundlePath,
        });
        // Must fall back to disk
        expect(result.source).toBe('disk');
        expect(result.name).toBe('agent-flywheel:start');
        // Must emit bundle_integrity_failed log
        const allLogs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allLogs).toContain('bundle_integrity_failed');
    });
    it('cache is invalidated after integrity failure so next call retries from disk', async () => {
        const skillsDir = join(cwd, 'skills', 'start');
        mkdirSync(skillsDir, { recursive: true });
        writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: agent-flywheel:start\ndescription: d\n---\nBody\n');
        const bundlePath = join(cwd, 'mcp-server', 'dist', 'skills.bundle.json');
        const badBundle = {
            bundleVersion: 1,
            generatedAt: new Date().toISOString(),
            generator: 'test',
            manifestSha256: 'badhash'.repeat(9),
            entries: [],
        };
        writeFileSync(bundlePath, JSON.stringify(badBundle, null, 2) + '\n');
        // Two calls — both must reach disk (cache never populated for corrupt bundle)
        const r1 = await getSkill('agent-flywheel:start', { repoRoot: cwd, bundlePath });
        const r2 = await getSkill('agent-flywheel:start', { repoRoot: cwd, bundlePath });
        expect(r1.source).toBe('disk');
        expect(r2.source).toBe('disk');
    });
});
//# sourceMappingURL=bundle-corrupt-fallback.test.js.map