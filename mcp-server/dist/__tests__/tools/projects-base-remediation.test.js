/**
 * T6.1 — projects_base_misconfig remediation contract tests.
 *
 * Covers the pure helper `remediateProjectsBase` directly (dry-run / execute
 * / skip) plus the `projectsBaseMisconfigHandler` registry shape. Execute
 * mode uses a real tmp directory so the symlink syscall is exercised; no
 * mutation lands outside `os.tmpdir()`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { remediateProjectsBase, projectsBaseMisconfigHandler, } from '../../tools/remediations/projects_base_misconfig.js';
describe('remediateProjectsBase (T6.1)', () => {
    let scratch;
    let cwdDir;
    let ntmBase;
    beforeEach(() => {
        scratch = mkdtempSync(join(tmpdir(), 'fw-t61-'));
        cwdDir = join(scratch, 'my-project');
        ntmBase = join(scratch, 'ntm-base');
        mkdirSync(cwdDir);
        mkdirSync(ntmBase);
    });
    afterEach(() => {
        rmSync(scratch, { recursive: true, force: true });
    });
    it('dry-run returns the ln -s command without symlinking', async () => {
        const result = await remediateProjectsBase({
            cwd: cwdDir,
            ntmBase,
            mode: 'dry-run',
        });
        const expectedTarget = join(ntmBase, basename(cwdDir));
        expect(result.executed).toBe(false);
        expect(result.target).toBe(expectedTarget);
        expect(result.command).toBe(`ln -s "${cwdDir}" "${expectedTarget}"`);
        expect(existsSync(expectedTarget)).toBe(false);
    });
    it('skip mode behaves like dry-run (no mutation)', async () => {
        const result = await remediateProjectsBase({
            cwd: cwdDir,
            ntmBase,
            mode: 'skip',
        });
        expect(result.executed).toBe(false);
        expect(existsSync(result.target)).toBe(false);
    });
    it('execute mode creates the symlink and reports executed=true', async () => {
        const result = await remediateProjectsBase({
            cwd: cwdDir,
            ntmBase,
            mode: 'execute',
        });
        expect(result.executed).toBe(true);
        expect(existsSync(result.target)).toBe(true);
        expect(lstatSync(result.target).isSymbolicLink()).toBe(true);
    });
    it('execute mode is idempotent when target already exists', async () => {
        // First call creates it…
        await remediateProjectsBase({ cwd: cwdDir, ntmBase, mode: 'execute' });
        // …second call must not throw EEXIST.
        const second = await remediateProjectsBase({
            cwd: cwdDir,
            ntmBase,
            mode: 'execute',
        });
        expect(second.executed).toBe(true);
        expect(existsSync(second.target)).toBe(true);
    });
    it('handles ntmBase paths with and without a trailing slash', async () => {
        const slashed = `${ntmBase}/`;
        const result = await remediateProjectsBase({
            cwd: cwdDir,
            ntmBase: slashed,
            mode: 'dry-run',
        });
        expect(result.target).toBe(`${ntmBase}/${basename(cwdDir)}`);
    });
});
describe('projectsBaseMisconfigHandler (T6.1 registry shape)', () => {
    it('declares mutating + reversible flags on the handler', () => {
        expect(projectsBaseMisconfigHandler.mutating).toBe(true);
        expect(projectsBaseMisconfigHandler.reversible).toBe(true);
        expect(typeof projectsBaseMisconfigHandler.description).toBe('string');
        expect(typeof projectsBaseMisconfigHandler.buildPlan).toBe('function');
        expect(typeof projectsBaseMisconfigHandler.execute).toBe('function');
        expect(typeof projectsBaseMisconfigHandler.verifyProbe).toBe('function');
    });
    it('buildPlan returns an empty step list when ntm config show fails', async () => {
        const plan = await projectsBaseMisconfigHandler.buildPlan({
            cwd: '/nonexistent/proj',
            // Stub `exec` to behave like ntm-not-installed (non-zero exit).
            exec: async () => ({ code: 127, stdout: '', stderr: 'ntm: not found' }),
        });
        expect(plan.steps).toEqual([]);
        expect(plan.mutating).toBe(false);
    });
});
//# sourceMappingURL=projects-base-remediation.test.js.map