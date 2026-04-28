/**
 * Unit tests for loadSkillsBundle + getSkill (T17).
 * Covers: loader success/failure, cache, integrity, disk fallback.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSkillsBundleCache, getSkill, loadSkillsBundle, } from '../skills-bundle.js';
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
function makeTmpEnv() {
    const dir = mkdtempSync(join(tmpdir(), 't17-bundle-'));
    const skillsDir = join(dir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
    const bundlePath = join(dir, 'mcp-server', 'dist', 'skills.bundle.json');
    return { dir, bundlePath, skillsDir };
}
function writeSkillFile(skillsDir, skillName, content) {
    const dir = join(skillsDir, skillName);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'SKILL.md');
    writeFileSync(p, content, 'utf8');
    return p;
}
function buildBundle(entries, overrideManifestSha) {
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const manifestSha256 = overrideManifestSha ?? sha256Hex(canonicalJSON(sorted));
    return {
        bundleVersion: 1,
        generatedAt: new Date().toISOString(),
        generator: 'test',
        manifestSha256,
        entries: sorted,
    };
}
function makeEntry(repoRoot, skillsDir, skillName, content) {
    const absPath = writeSkillFile(skillsDir, skillName.replace(/^agent-flywheel:/, ''), content);
    const relPath = absPath.replace(repoRoot + '/', '');
    const buf = Buffer.from(content, 'utf8');
    // Parse body (strip frontmatter)
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let body = content;
    if (lines[0]?.trim() === '---') {
        const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        if (closeIdx !== -1) {
            body = lines.slice(closeIdx + 1).join('\n');
        }
    }
    return {
        name: skillName,
        path: relPath,
        frontmatter: { name: skillName, description: 'test skill' },
        body,
        srcSha256: sha256Hex(buf),
        sizeBytes: Buffer.byteLength(body, 'utf8'),
        bundledAt: new Date().toISOString(),
    };
}
// ─── Setup / teardown ─────────────────────────────────────────────────────────
let tmp;
beforeEach(() => {
    tmp = makeTmpEnv();
    _resetSkillsBundleCache();
    delete process.env.FW_SKILL_BUNDLE;
});
afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
    _resetSkillsBundleCache();
    delete process.env.FW_SKILL_BUNDLE;
    vi.restoreAllMocks();
});
// ─── loadSkillsBundle ─────────────────────────────────────────────────────────
describe('loadSkillsBundle', () => {
    it('returns parsed bundle for a valid bundle path', () => {
        const content = '---\nname: agent-flywheel:start\n---\nBody text\n';
        const entry = makeEntry(tmp.dir, tmp.skillsDir, 'agent-flywheel:start', content);
        const bundle = buildBundle([entry]);
        writeFileSync(tmp.bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        const result = loadSkillsBundle(tmp.bundlePath);
        expect(result).not.toBeNull();
        expect(result.bundleVersion).toBe(1);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].name).toBe('agent-flywheel:start');
    });
    it('returns null for a missing bundle path', () => {
        const result = loadSkillsBundle(join(tmp.dir, 'nonexistent.json'));
        expect(result).toBeNull();
    });
    it('returns null and emits bundle_integrity_failed for bad manifestSha256', () => {
        const content = '---\nname: agent-flywheel:start\n---\nBody\n';
        const entry = makeEntry(tmp.dir, tmp.skillsDir, 'agent-flywheel:start', content);
        const bundle = buildBundle([entry], 'deadbeef'.repeat(8));
        writeFileSync(tmp.bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        const warnSpy = vi.spyOn(process.stderr, 'write');
        const result = loadSkillsBundle(tmp.bundlePath);
        expect(result).toBeNull();
        const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('bundle_integrity_failed');
    });
    it('invalidates module-level cache on integrity failure', () => {
        const content = '---\nname: agent-flywheel:start\n---\nBody\n';
        const entry = makeEntry(tmp.dir, tmp.skillsDir, 'agent-flywheel:start', content);
        // First: valid bundle — populates cache
        const validBundle = buildBundle([entry]);
        writeFileSync(tmp.bundlePath, JSON.stringify(validBundle, null, 2) + '\n');
        const first = loadSkillsBundle(tmp.bundlePath);
        expect(first).not.toBeNull();
        // Overwrite with corrupt bundle
        const corruptBundle = buildBundle([entry], 'deadbeef'.repeat(8));
        writeFileSync(tmp.bundlePath, JSON.stringify(corruptBundle, null, 2) + '\n');
        // Must bust cache, not return stale cached result
        const second = loadSkillsBundle(tmp.bundlePath);
        expect(second).toBeNull();
    });
    it('serves cached bundle on repeated calls with same path', () => {
        const content = '---\nname: agent-flywheel:start\n---\nBody\n';
        const entry = makeEntry(tmp.dir, tmp.skillsDir, 'agent-flywheel:start', content);
        const bundle = buildBundle([entry]);
        writeFileSync(tmp.bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        const spy = vi.spyOn(process.stderr, 'write');
        loadSkillsBundle(tmp.bundlePath);
        loadSkillsBundle(tmp.bundlePath);
        // Integrity log should appear at most once (only first load)
        const warnLogs = spy.mock.calls
            .map((c) => String(c[0]))
            .filter((l) => l.includes('bundle_integrity_failed'));
        expect(warnLogs).toHaveLength(0);
    });
});
// ─── getSkill ─────────────────────────────────────────────────────────────────
describe('getSkill', () => {
    it('returns source: bundle when valid bundle has the skill', async () => {
        const content = '---\nname: agent-flywheel:start\ndescription: test\n---\nBody text here\n';
        const entry = makeEntry(tmp.dir, tmp.skillsDir, 'agent-flywheel:start', content);
        const bundle = buildBundle([entry]);
        writeFileSync(tmp.bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        const result = await getSkill('agent-flywheel:start', {
            repoRoot: tmp.dir,
            bundlePath: tmp.bundlePath,
        });
        expect(result.source).toBe('bundle');
        expect(result.name).toBe('agent-flywheel:start');
        expect(result.body).toBeTruthy();
    });
    it('returns source: disk when bundle is absent (null)', async () => {
        // Write a disk skill only
        const content = '---\nname: agent-flywheel:start\ndescription: disk skill\n---\nDisk body\n';
        writeSkillFile(tmp.skillsDir, 'start', content);
        const result = await getSkill('agent-flywheel:start', {
            repoRoot: tmp.dir,
            bundlePath: join(tmp.dir, 'nonexistent.json'),
        });
        expect(result.source).toBe('disk');
        expect(result.name).toBe('agent-flywheel:start');
    });
    it('throws not_found when skill missing from both bundle and disk', async () => {
        await expect(getSkill('agent-flywheel:nonexistent', {
            repoRoot: tmp.dir,
            bundlePath: join(tmp.dir, 'nonexistent.json'),
        })).rejects.toMatchObject({ code: 'not_found' });
    });
});
//# sourceMappingURL=skills-bundle.test.js.map