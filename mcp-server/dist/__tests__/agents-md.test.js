import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../memory.js', () => ({
    onboardMemory: vi.fn(),
}));
import { onboardMemory } from '../memory.js';
import { ensureAgentMailSection, ensureCoreRules, resetAgentsMdScoreCache, scoreAgentsMd, } from '../agents-md.js';
let cwd;
beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'agents-md-test-'));
    resetAgentsMdScoreCache();
    vi.mocked(onboardMemory).mockClear();
});
afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
});
describe('ensureCoreRules', () => {
    it('creates AGENTS.md with header + core rules when file does not exist', async () => {
        await ensureCoreRules(cwd);
        const p = join(cwd, 'AGENTS.md');
        expect(existsSync(p)).toBe(true);
        const content = readFileSync(p, 'utf-8');
        expect(content).toContain('# AGENTS.md');
        expect(content).toContain('## Core Rules');
        expect(content).toContain('Override Prerogative');
        expect(content).toContain('No File Deletion');
        expect(content).toContain('Multi-Agent Awareness');
    });
    it('appends core rules when AGENTS.md exists without them', async () => {
        const p = join(cwd, 'AGENTS.md');
        writeFileSync(p, '# Existing\n\nSome body.\n', 'utf-8');
        await ensureCoreRules(cwd);
        const content = readFileSync(p, 'utf-8');
        expect(content).toContain('# Existing');
        expect(content).toContain('Some body.');
        expect(content).toContain('## Core Rules');
    });
    it('is idempotent — does not duplicate core rules section', async () => {
        const p = join(cwd, 'AGENTS.md');
        writeFileSync(p, '# X\n\n## Core Rules\n\nRule 0 — Override Prerogative\n', 'utf-8');
        await ensureCoreRules(cwd);
        await ensureCoreRules(cwd);
        const content = readFileSync(p, 'utf-8');
        const occurrences = content.match(/## Core Rules/g) ?? [];
        expect(occurrences.length).toBe(1);
    });
    it('normalises CRLF line endings on read so the marker is found', async () => {
        const p = join(cwd, 'AGENTS.md');
        writeFileSync(p, '# X\r\n\r\n## Core Rules\r\n\r\nRule 0\r\n', 'utf-8');
        await ensureCoreRules(cwd);
        const content = readFileSync(p, 'utf-8');
        expect((content.match(/## Core Rules/g) ?? []).length).toBe(1);
    });
});
describe('ensureAgentMailSection', () => {
    it('creates a full AGENTS.md (core + agent-mail + cass + br + bv) when file does not exist', async () => {
        await ensureAgentMailSection(cwd);
        const content = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8');
        expect(content).toContain('## Core Rules');
        expect(content).toContain('## MCP Agent Mail');
        expect(content).toContain('## Memory System: cass-memory');
        expect(content).toContain('## Beads CLI (br)');
        expect(content).toContain('## Beads Viewer (bv)');
    });
    it('invokes onboardMemory when creating a brand new AGENTS.md', async () => {
        await ensureAgentMailSection(cwd);
        expect(onboardMemory).toHaveBeenCalledTimes(1);
        expect(onboardMemory).toHaveBeenCalledWith(cwd);
    });
    it('does NOT invoke onboardMemory when appending to an existing AGENTS.md', async () => {
        const p = join(cwd, 'AGENTS.md');
        writeFileSync(p, '# Existing\n\n## Core Rules\n## MCP Agent Mail\n## Memory System: cass-memory\n## Beads CLI (br)\n## Beads Viewer (bv)\n', 'utf-8');
        await ensureAgentMailSection(cwd);
        expect(onboardMemory).not.toHaveBeenCalled();
    });
    it('appends only missing sections (does not duplicate existing ones)', async () => {
        const p = join(cwd, 'AGENTS.md');
        writeFileSync(p, '# Existing\n\n## Core Rules\n\nRule 0\n## Beads CLI (br)\n', 'utf-8');
        await ensureAgentMailSection(cwd);
        const content = readFileSync(p, 'utf-8');
        expect((content.match(/## Core Rules/g) ?? []).length).toBe(1);
        expect((content.match(/## Beads CLI \(br\)/g) ?? []).length).toBe(1);
        expect(content).toContain('## MCP Agent Mail');
        expect(content).toContain('## Memory System: cass-memory');
        expect(content).toContain('## Beads Viewer (bv)');
    });
});
describe('scoreAgentsMd', () => {
    it('returns score 0 and full missing list when AGENTS.md does not exist', () => {
        const result = scoreAgentsMd(cwd);
        expect(result.score).toBe(0);
        expect(result.hasCoreRules).toBe(false);
        expect(result.coreRuleCount).toBe(0);
        expect(result.hasCoordination).toBe(false);
        expect(result.hasMemory).toBe(false);
        expect(result.hasBr).toBe(false);
        expect(result.hasBv).toBe(false);
        expect(result.missing).toContain('AGENTS.md file');
    });
    it('returns 100 for a fully populated AGENTS.md', async () => {
        await ensureAgentMailSection(cwd);
        resetAgentsMdScoreCache();
        const result = scoreAgentsMd(cwd);
        expect(result.score).toBe(100);
        expect(result.hasCoreRules).toBe(true);
        expect(result.coreRuleCount).toBe(8);
        expect(result.hasCoordination).toBe(true);
        expect(result.hasMemory).toBe(true);
        expect(result.hasBr).toBe(true);
        expect(result.hasBv).toBe(true);
        expect(result.missing).toEqual([]);
    });
    it('reports partial score when only core rules are present', async () => {
        await ensureCoreRules(cwd);
        resetAgentsMdScoreCache();
        const result = scoreAgentsMd(cwd);
        expect(result.hasCoreRules).toBe(true);
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThan(100);
        expect(result.missing).toContain('Agent Mail coordination');
        expect(result.missing).toContain('CASS Memory');
        expect(result.missing).toContain('Beads CLI (br) docs');
        expect(result.missing).toContain('Beads Viewer (bv) docs');
    });
    it('memoizes results per cwd — second call returns same object reference', async () => {
        await ensureCoreRules(cwd);
        const r1 = scoreAgentsMd(cwd);
        const r2 = scoreAgentsMd(cwd);
        expect(r1).toBe(r2);
    });
    it('resetAgentsMdScoreCache forces a re-scan', async () => {
        await ensureCoreRules(cwd);
        const r1 = scoreAgentsMd(cwd);
        resetAgentsMdScoreCache();
        const r2 = scoreAgentsMd(cwd);
        expect(r1).not.toBe(r2);
        expect(r1).toEqual(r2);
    });
    it('flags missing core rules when only some keywords are present (under 6/8 threshold)', () => {
        writeFileSync(join(cwd, 'AGENTS.md'), '# X\n\nOverride Prerogative\nNo File Deletion\n', 'utf-8');
        const result = scoreAgentsMd(cwd);
        expect(result.hasCoreRules).toBe(false);
        expect(result.coreRuleCount).toBeLessThan(6);
    });
});
//# sourceMappingURL=agents-md.test.js.map