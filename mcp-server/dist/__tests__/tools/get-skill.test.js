/**
 * Tests for the flywheel_get_skill MCP tool handler (T17).
 * Covers: schema validation, tool result shape, bundle hit, not_found.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetSkillsBundleCache } from '../../skills-bundle.js';
import { runGetSkill } from '../../tools/get-skill.js';
import { makeState } from '../helpers/mocks.js';
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
function makeCtx(cwd) {
    const exec = async () => ({ code: 0, stdout: '', stderr: '' });
    const state = makeState();
    return {
        exec,
        cwd,
        state,
        saveState: () => { },
        clearState: () => { },
    };
}
function makeTmpEnv() {
    const dir = mkdtempSync(join(tmpdir(), 't17-tool-'));
    const skillsDir = join(dir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
    const bundlePath = join(dir, 'mcp-server', 'dist', 'skills.bundle.json');
    return { dir, bundlePath, skillsDir };
}
function writeAndBundleSkill(tmp, skillKey, content) {
    const shortName = skillKey.replace(/^agent-flywheel:/, '');
    const skillDir = join(tmp.skillsDir, shortName);
    mkdirSync(skillDir, { recursive: true });
    const absPath = join(skillDir, 'SKILL.md');
    writeFileSync(absPath, content, 'utf8');
    const relPath = absPath.replace(tmp.dir + '/', '');
    const buf = Buffer.from(content, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let body = content;
    if (lines[0]?.trim() === '---') {
        const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        if (closeIdx !== -1)
            body = lines.slice(closeIdx + 1).join('\n');
    }
    const entry = {
        name: skillKey,
        path: relPath,
        frontmatter: { name: skillKey, description: 'test' },
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
    writeFileSync(tmp.bundlePath, JSON.stringify(bundle, null, 2) + '\n');
}
// ─── Setup / teardown ─────────────────────────────────────────────────────────
let tmp;
beforeEach(() => {
    tmp = makeTmpEnv();
    _resetSkillsBundleCache();
    delete process.env.FW_SKILL_BUNDLE;
    // Pin the plugin install root so the tool resolves bundle/skills from
    // tmp instead of walking up to the real flywheel repo.
    process.env.CLAUDE_PLUGIN_ROOT = tmp.dir;
});
afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
    _resetSkillsBundleCache();
    delete process.env.FW_SKILL_BUNDLE;
    delete process.env.CLAUDE_PLUGIN_ROOT;
});
// ─── Schema validation ────────────────────────────────────────────────────────
describe('flywheel_get_skill schema validation', () => {
    it('rejects input missing name field', async () => {
        const ctx = makeCtx(tmp.dir);
        const result = await runGetSkill(ctx, { cwd: tmp.dir });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc?.data?.error).toMatchObject({
            code: 'invalid_input',
        });
    });
    it('rejects name not matching <plugin>:<skill> pattern', async () => {
        const ctx = makeCtx(tmp.dir);
        const result = await runGetSkill(ctx, { cwd: tmp.dir, name: 'badformat' });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc?.data?.error).toMatchObject({
            code: 'invalid_input',
        });
    });
    it('rejects name with uppercase characters', async () => {
        const ctx = makeCtx(tmp.dir);
        const result = await runGetSkill(ctx, { cwd: tmp.dir, name: 'Agent-Flywheel:Start' });
        expect(result.isError).toBe(true);
    });
});
// ─── Tool result shape ────────────────────────────────────────────────────────
describe('flywheel_get_skill result shape', () => {
    it('returns { name, frontmatter, body, source } for existing skill', async () => {
        const content = '---\nname: agent-flywheel:start\ndescription: test skill\n---\nSkill body here\n';
        writeAndBundleSkill(tmp, 'agent-flywheel:start', content);
        const ctx = makeCtx(tmp.dir);
        const result = await runGetSkill(ctx, { cwd: tmp.dir, name: 'agent-flywheel:start' });
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent;
        expect(sc?.status).toBe('ok');
        expect(sc?.tool).toBe('flywheel_get_skill');
        const data = sc?.data;
        expect(data?.kind).toBe('skill');
        const skill = data?.skill;
        expect(skill).toMatchObject({
            name: 'agent-flywheel:start',
            source: 'bundle',
        });
        expect(typeof skill?.body).toBe('string');
        expect(typeof skill?.frontmatter).toBe('object');
    });
    it('returns not_found error envelope for missing skill', async () => {
        const ctx = makeCtx(tmp.dir);
        const result = await runGetSkill(ctx, { cwd: tmp.dir, name: 'agent-flywheel:nonexistent' });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc?.data?.error).toMatchObject({
            code: 'not_found',
        });
    });
    it('text content includes skill name and source', async () => {
        const content = '---\nname: agent-flywheel:start\ndescription: test\n---\nBody text\n';
        writeAndBundleSkill(tmp, 'agent-flywheel:start', content);
        const ctx = makeCtx(tmp.dir);
        const result = await runGetSkill(ctx, { cwd: tmp.dir, name: 'agent-flywheel:start' });
        const text = result.content[0]?.text ?? '';
        expect(text).toContain('agent-flywheel:start');
        expect(text).toContain('bundle');
    });
});
// ─── Regression: c9l — plugin-install-root resolution ────────────────────────
//
// Before c9l: the tool passed ctx.cwd as repoRoot, so calling from any project
// outside the plugin install (where there is no mcp-server/dist/skills.bundle.json
// and no skills/ dir) returned "not found in bundle or on disk". Now the tool
// resolves bundle + disk fallback from CLAUDE_PLUGIN_ROOT (or auto-detect) and
// ignores ctx.cwd entirely.
describe('flywheel_get_skill ignores caller cwd (c9l regression)', () => {
    it('resolves bundle from CLAUDE_PLUGIN_ROOT when cwd points elsewhere', async () => {
        const content = '---\nname: agent-flywheel:start\ndescription: test\n---\nStart skill body that is more than 100 chars long so callers know they got the canonical body and not a stub pointer.\n';
        writeAndBundleSkill(tmp, 'agent-flywheel:start', content);
        // Caller's cwd is some unrelated directory with no bundle/skills.
        const fakeProjectDir = mkdtempSync(join(tmpdir(), 't17-caller-cwd-'));
        try {
            const ctx = makeCtx(fakeProjectDir);
            const result = await runGetSkill(ctx, { cwd: fakeProjectDir, name: 'agent-flywheel:start' });
            expect(result.isError).toBeFalsy();
            const sc = result.structuredContent;
            const skill = sc?.data?.skill;
            expect(skill?.name).toBe('agent-flywheel:start');
            expect(skill?.source).toBe('bundle');
            expect(typeof skill?.body).toBe('string');
            expect((skill?.body).length).toBeGreaterThan(100);
        }
        finally {
            rmSync(fakeProjectDir, { recursive: true, force: true });
        }
    });
    it('resolves all 10 start-flow skill names from a single bundle', async () => {
        const startNames = [
            'agent-flywheel:start',
            'agent-flywheel:start_planning',
            'agent-flywheel:start_beads',
            'agent-flywheel:start_implement',
            'agent-flywheel:start_review',
            'agent-flywheel:start_wrapup',
            'agent-flywheel:start_reality_check',
            'agent-flywheel:start_deslop',
            'agent-flywheel:start_saturation',
            'agent-flywheel:start_inflight_prompt',
        ];
        // Build a bundle containing all 10 entries.
        const entries = startNames.map((name) => {
            const shortName = name.replace(/^agent-flywheel:/, '');
            const body = `Body for ${name}. Padded to comfortably exceed the 100-char minimum bar that the integration test asserts as the lower bound for non-stub responses.`;
            const content = `---\nname: ${name}\ndescription: test\n---\n${body}\n`;
            const skillDir = join(tmp.skillsDir, shortName);
            mkdirSync(skillDir, { recursive: true });
            const absPath = join(skillDir, 'SKILL.md');
            writeFileSync(absPath, content, 'utf8');
            const relPath = absPath.replace(tmp.dir + '/', '');
            return {
                name,
                path: relPath,
                frontmatter: { name, description: 'test' },
                body,
                srcSha256: sha256Hex(Buffer.from(content, 'utf8')),
                sizeBytes: Buffer.byteLength(body, 'utf8'),
                bundledAt: new Date().toISOString(),
            };
        });
        const manifestSha256 = sha256Hex(canonicalJSON(entries));
        const bundle = {
            bundleVersion: 1,
            generatedAt: new Date().toISOString(),
            generator: 'test',
            manifestSha256,
            entries,
        };
        writeFileSync(tmp.bundlePath, JSON.stringify(bundle, null, 2) + '\n');
        _resetSkillsBundleCache();
        const fakeProjectDir = mkdtempSync(join(tmpdir(), 't17-caller-cwd-'));
        try {
            for (const name of startNames) {
                const ctx = makeCtx(fakeProjectDir);
                const result = await runGetSkill(ctx, { cwd: fakeProjectDir, name });
                expect(result.isError, `expected ok for ${name}`).toBeFalsy();
                const sc = result.structuredContent;
                const skill = sc?.data?.skill;
                expect(skill?.name, `name mismatch for ${name}`).toBe(name);
                expect((skill?.body).length, `short body for ${name}`).toBeGreaterThan(100);
            }
        }
        finally {
            rmSync(fakeProjectDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=get-skill.test.js.map