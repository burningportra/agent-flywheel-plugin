/**
 * Chaos: bundle entry srcSha256 differs from current disk file → staleWarn: true,
 * but skill is still served from bundle (source: 'bundle').
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
describe('chaos/bundle-stale-warns', () => {
    it('returns staleWarn: true and source: bundle when disk file differs from srcSha256', async () => {
        const skillsDir = join(cwd, 'skills', 'start');
        mkdirSync(skillsDir, { recursive: true });
        // Content at bundle-build time
        const originalContent = '---\nname: agent-flywheel:start\ndescription: orig\n---\nOriginal body\n';
        writeFileSync(join(skillsDir, 'SKILL.md'), originalContent);
        const relPath = 'skills/start/SKILL.md';
        const origBuf = Buffer.from(originalContent, 'utf8');
        const body = 'Original body\n';
        const entry = {
            name: 'agent-flywheel:start',
            path: relPath,
            frontmatter: { name: 'agent-flywheel:start', description: 'orig' },
            body,
            srcSha256: sha256Hex(origBuf), // sha of original content
            sizeBytes: Buffer.byteLength(body, 'utf8'),
            bundledAt: new Date().toISOString(),
        };
        const entries = [entry];
        const manifestSha256 = sha256Hex(canonicalJSON(entries));
        const bundle = {
            bundleVersion: 1,
            generatedAt: new Date().toISOString(),
            generator: 'test',
            manifestSha256,
            entries,
        };
        const bundlePath = join(cwd, 'mcp-server', 'dist', 'skills.bundle.json');
        writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        // Now modify the disk file so its sha differs from the bundled srcSha256
        const modifiedContent = '---\nname: agent-flywheel:start\ndescription: modified\n---\nModified body\n';
        writeFileSync(join(skillsDir, 'SKILL.md'), modifiedContent);
        const warnSpy = vi.spyOn(process.stderr, 'write');
        const result = await getSkill('agent-flywheel:start', {
            repoRoot: cwd,
            bundlePath,
        });
        // Still served from bundle
        expect(result.source).toBe('bundle');
        // But flagged as stale
        expect(result.staleWarn).toBe(true);
        // Body comes from bundle (original), not disk
        expect(result.body).toContain('Original body');
        // Stale warn log emitted
        const allLogs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allLogs).toContain('bundle_stale');
    });
    it('returns staleWarn: undefined when disk file matches srcSha256', async () => {
        const skillsDir = join(cwd, 'skills', 'start');
        mkdirSync(skillsDir, { recursive: true });
        const content = '---\nname: agent-flywheel:start\ndescription: fresh\n---\nFresh body\n';
        writeFileSync(join(skillsDir, 'SKILL.md'), content);
        const relPath = 'skills/start/SKILL.md';
        const buf = Buffer.from(content, 'utf8');
        const body = 'Fresh body\n';
        const entry = {
            name: 'agent-flywheel:start',
            path: relPath,
            frontmatter: { name: 'agent-flywheel:start', description: 'fresh' },
            body,
            srcSha256: sha256Hex(buf),
            sizeBytes: Buffer.byteLength(body, 'utf8'),
            bundledAt: new Date().toISOString(),
        };
        const entries = [entry];
        const manifestSha256 = sha256Hex(canonicalJSON(entries));
        const bundle = {
            bundleVersion: 1,
            generatedAt: new Date().toISOString(),
            generator: 'test',
            manifestSha256,
            entries,
        };
        const bundlePath = join(cwd, 'mcp-server', 'dist', 'skills.bundle.json');
        writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        const result = await getSkill('agent-flywheel:start', {
            repoRoot: cwd,
            bundlePath,
        });
        expect(result.source).toBe('bundle');
        expect(result.staleWarn).toBeFalsy();
    });
});
//# sourceMappingURL=bundle-stale-warns.test.js.map