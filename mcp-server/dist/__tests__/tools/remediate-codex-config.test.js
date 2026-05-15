/**
 * Unit specs for the codex_config_compat remediation handler.
 *
 * Bead: claude-orchestrator-3s58 (reality-check-2026-05-15).
 *
 * Coverage:
 *   1. Pure helper `commentOutTopLevelModel` — comments only the top-level
 *      `model = "..."` line; ignores lines inside `[sections]`; no-ops on
 *      already-commented or absent lines.
 *   2. buildPlan branches — missing file, no model, compatible model,
 *      incompatible model.
 *   3. execute path — writes a backup, atomically rewrites the original,
 *      backup contains the original content, original now has the line
 *      commented.
 *   4. execute is a no-op when the model is absent or compatible.
 *   5. verifyProbe flips green after a successful execute (round-trip via
 *      the doctor's pure parser).
 *   6. Parser/matcher agreement — the handler's matcher and the doctor's
 *      parser see the same set of "top-level model" lines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConfigCompatHandler, commentOutTopLevelModel, } from '../../tools/remediations/codex_config_compat.js';
import { parseCodexConfigTopLevelModel } from '../../tools/doctor.js';
const noopExec = async () => ({ code: 0, stdout: '', stderr: '' });
function makeCtx(cwd) {
    return { cwd, exec: noopExec, signal: new AbortController().signal };
}
/** Stash + override HOME so the handler's `homedir()` points at a tmpdir. */
function withFakeHome() {
    const home = mkdtempSync(join(tmpdir(), 'codex-config-test-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    return {
        home,
        restore: () => {
            if (originalHome === undefined)
                delete process.env.HOME;
            else
                process.env.HOME = originalHome;
            try {
                rmSync(home, { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        },
    };
}
const CONFIG_REL = '.codex/config.toml';
describe('commentOutTopLevelModel (pure helper)', () => {
    it('comments a bare top-level model line', () => {
        const { rewritten, changedLine, changedLineNumber } = commentOutTopLevelModel('model = "gpt-5.5"\n');
        expect(changedLine).toBe('model = "gpt-5.5"');
        expect(changedLineNumber).toBe(1);
        expect(rewritten.split('\n')[0]).toBe('# model = "gpt-5.5"');
    });
    it('preserves leading whitespace on the commented line', () => {
        const { rewritten, changedLine } = commentOutTopLevelModel('  model = "gpt-5"\n');
        expect(changedLine).toBe('  model = "gpt-5"');
        expect(rewritten.split('\n')[0]).toBe('#   model = "gpt-5"');
    });
    it('preserves trailing comment on the commented line', () => {
        const { rewritten, changedLine } = commentOutTopLevelModel('model = "gpt-5" # legacy\n');
        expect(changedLine).toBe('model = "gpt-5" # legacy');
        expect(rewritten.split('\n')[0]).toBe('# model = "gpt-5" # legacy');
    });
    it('skips lines below a [section] header', () => {
        const input = '[profiles.gpt5]\nmodel = "gpt-5"\n';
        const { rewritten, changedLine } = commentOutTopLevelModel(input);
        expect(changedLine).toBeNull();
        expect(rewritten).toBe(input);
    });
    it('does not comment an already-commented line', () => {
        const input = '# model = "gpt-5"\n';
        const { rewritten, changedLine } = commentOutTopLevelModel(input);
        expect(changedLine).toBeNull();
        expect(rewritten).toBe(input);
    });
    it('no-ops on a config with no model line', () => {
        const input = 'verbose = true\napproval_policy = "trusted"\n';
        const { rewritten, changedLine } = commentOutTopLevelModel(input);
        expect(changedLine).toBeNull();
        expect(rewritten).toBe(input);
    });
    it('only comments the FIRST top-level model line (idempotency anchor)', () => {
        const input = 'model = "gpt-5.5"\nmodel = "o4-mini"\n';
        const { rewritten, changedLineNumber } = commentOutTopLevelModel(input);
        expect(changedLineNumber).toBe(1);
        const lines = rewritten.split('\n');
        expect(lines[0]).toBe('# model = "gpt-5.5"');
        // Second line stays untouched — doctor parser only reads the first match too.
        expect(lines[1]).toBe('model = "o4-mini"');
    });
});
describe('codexConfigCompatHandler.buildPlan', () => {
    let fake;
    beforeEach(() => {
        fake = withFakeHome();
    });
    afterEach(() => {
        fake.restore();
    });
    it('no config file → "nothing to remediate" non-mutating plan', async () => {
        const plan = await codexConfigCompatHandler.buildPlan(makeCtx('/tmp'));
        expect(plan.mutating).toBe(false);
        expect(plan.steps).toEqual([]);
        expect(plan.description.toLowerCase()).toContain('nothing to remediate');
    });
    it('config with no model → "already compatible" non-mutating plan', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'verbose = true\n');
        const plan = await codexConfigCompatHandler.buildPlan(makeCtx('/tmp'));
        expect(plan.mutating).toBe(false);
        expect(plan.steps).toEqual([]);
        expect(plan.description.toLowerCase()).toContain('already compatible');
    });
    it('compatible model (e.g. claude-3.5) → non-mutating plan', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'model = "claude-3.5-sonnet"\n');
        const plan = await codexConfigCompatHandler.buildPlan(makeCtx('/tmp'));
        expect(plan.mutating).toBe(false);
        expect(plan.description).toContain('claude-3.5-sonnet');
    });
    it('incompatible model (gpt-5.5) → mutating + reversible plan', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'model = "gpt-5.5"\nverbose = true\n');
        const plan = await codexConfigCompatHandler.buildPlan(makeCtx('/tmp'));
        expect(plan.mutating).toBe(true);
        expect(plan.reversible).toBe(true);
        expect(plan.steps.length).toBeGreaterThanOrEqual(1);
        expect(plan.description).toContain('gpt-5.5');
    });
});
describe('codexConfigCompatHandler.execute', () => {
    let fake;
    beforeEach(() => {
        fake = withFakeHome();
    });
    afterEach(() => {
        fake.restore();
    });
    it('rewrites the config and writes a timestamped backup', async () => {
        const target = join(fake.home, CONFIG_REL);
        const original = 'model = "gpt-5.5"\nverbose = true\n';
        writeFileSync(target, original);
        const result = await codexConfigCompatHandler.execute(makeCtx('/tmp'));
        expect(result.stepsRun).toBe(2);
        expect(result.stdout).toMatch(/commented out line 1/);
        // Backup file present, content matches the original.
        const codexDir = join(fake.home, '.codex');
        const bakFiles = readdirSync(codexDir).filter((f) => f.startsWith('config.toml.bak.'));
        expect(bakFiles).toHaveLength(1);
        const bakPath = join(codexDir, bakFiles[0]);
        expect(readFileSync(bakPath, 'utf8')).toBe(original);
        // Original now has the model line commented out; rest untouched.
        const after = readFileSync(target, 'utf8');
        expect(after.split('\n')[0]).toBe('# model = "gpt-5.5"');
        expect(after.split('\n')[1]).toBe('verbose = true');
    });
    it('is a no-op when no config exists', async () => {
        const result = await codexConfigCompatHandler.execute(makeCtx('/tmp'));
        expect(result.stepsRun).toBe(0);
    });
    it('is a no-op when the model is already compatible', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'model = "claude-3.5-sonnet"\n');
        const result = await codexConfigCompatHandler.execute(makeCtx('/tmp'));
        expect(result.stepsRun).toBe(0);
    });
    it('is a no-op when no top-level model is set', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), '[profiles.gpt5]\nmodel = "gpt-5"\n');
        const result = await codexConfigCompatHandler.execute(makeCtx('/tmp'));
        expect(result.stepsRun).toBe(0);
    });
});
describe('codexConfigCompatHandler.verifyProbe', () => {
    let fake;
    beforeEach(() => {
        fake = withFakeHome();
    });
    afterEach(() => {
        fake.restore();
    });
    it('is green when config is absent', async () => {
        expect(await codexConfigCompatHandler.verifyProbe(makeCtx('/tmp'))).toBe(true);
    });
    it('is green when no top-level model is set', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'verbose = true\n');
        expect(await codexConfigCompatHandler.verifyProbe(makeCtx('/tmp'))).toBe(true);
    });
    it('is green when model is compatible', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'model = "claude-3.5-sonnet"\n');
        expect(await codexConfigCompatHandler.verifyProbe(makeCtx('/tmp'))).toBe(true);
    });
    it('is red when model is incompatible', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'model = "gpt-5.5"\n');
        expect(await codexConfigCompatHandler.verifyProbe(makeCtx('/tmp'))).toBe(false);
    });
    it('flips from red → green after execute (round-trip)', async () => {
        writeFileSync(join(fake.home, CONFIG_REL), 'model = "gpt-5.5"\nverbose = true\n');
        expect(await codexConfigCompatHandler.verifyProbe(makeCtx('/tmp'))).toBe(false);
        await codexConfigCompatHandler.execute(makeCtx('/tmp'));
        expect(await codexConfigCompatHandler.verifyProbe(makeCtx('/tmp'))).toBe(true);
    });
});
describe('parser / matcher agreement (regression guard)', () => {
    // The doctor's parser and the handler's regex MUST identify the same
    // "top-level model" lines. Drift between them would let the parser surface
    // yellow on lines the handler can't rewrite.
    const cases = [
        'model = "gpt-5"',
        '  model = "gpt-5"',
        'model = "gpt-5" # trailing',
    ];
    for (const line of cases) {
        it(`both see top-level model in: ${JSON.stringify(line)}`, () => {
            const content = `${line}\n`;
            expect(parseCodexConfigTopLevelModel(content)).not.toBeNull();
            const { changedLine } = commentOutTopLevelModel(content);
            expect(changedLine).not.toBeNull();
        });
    }
    // Negative cases — both should NOT see a top-level model.
    const negativeCases = [
        '# model = "gpt-5"',
        '[profiles.gpt5]\nmodel = "gpt-5"',
        'verbose = true',
    ];
    for (const input of negativeCases) {
        it(`both ignore non-top-level model in: ${JSON.stringify(input)}`, () => {
            const content = `${input}\n`;
            expect(parseCodexConfigTopLevelModel(content)).toBeNull();
            const { changedLine } = commentOutTopLevelModel(content);
            expect(changedLine).toBeNull();
        });
    }
});
//# sourceMappingURL=remediate-codex-config.test.js.map