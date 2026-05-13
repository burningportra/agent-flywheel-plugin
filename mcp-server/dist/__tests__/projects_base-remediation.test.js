import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remediateProjectsBase, projectsBaseMisconfigHandler, } from '../tools/remediations/projects_base_misconfig.js';
import { REMEDIATION_REGISTRY } from '../tools/remediate.js';
function makeTmp() {
    const tmp = mkdtempSync(join(tmpdir(), 't61-'));
    return { tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}
function mockExec(ntmBase) {
    return async (cmd, args) => {
        if (cmd === 'ntm' && args[0] === 'config' && args[1] === 'show') {
            if (ntmBase === null)
                return { code: 1, stdout: '', stderr: 'ntm: not found' };
            return { code: 0, stdout: `projects_base = "${ntmBase}"\n`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    };
}
describe('remediateProjectsBase (T6.1) — pure helper', () => {
    it('dry-run returns ln command but does not create the symlink', async () => {
        const { tmp, cleanup } = makeTmp();
        try {
            const ntmBase = join(tmp, 'ntm-base');
            const cwd = join(tmp, 'proj');
            const result = await remediateProjectsBase({ cwd, ntmBase, mode: 'dry-run' });
            expect(result.command).toBe(`ln -s "${cwd}" "${ntmBase}/proj"`);
            expect(result.executed).toBe(false);
            expect(existsSync(result.target)).toBe(false);
        }
        finally {
            cleanup();
        }
    });
    it('skip mode returns the ln command but does not create the symlink', async () => {
        const { tmp, cleanup } = makeTmp();
        try {
            const result = await remediateProjectsBase({
                cwd: join(tmp, 'proj'),
                ntmBase: join(tmp, 'ntm-base'),
                mode: 'skip',
            });
            expect(result.executed).toBe(false);
        }
        finally {
            cleanup();
        }
    });
    it('execute mode creates a working symlink under ntmBase', async () => {
        const { tmp, cleanup } = makeTmp();
        try {
            const ntmBase = join(tmp, 'ntm-base');
            mkdirSync(ntmBase);
            const cwd = join(tmp, 'proj');
            mkdirSync(cwd); // symlink target must exist for existsSync to follow
            const result = await remediateProjectsBase({ cwd, ntmBase, mode: 'execute' });
            expect(result.executed).toBe(true);
            expect(existsSync(result.target)).toBe(true);
        }
        finally {
            cleanup();
        }
    });
    it('execute mode is idempotent when symlink already exists', async () => {
        const { tmp, cleanup } = makeTmp();
        try {
            const ntmBase = join(tmp, 'ntm-base');
            mkdirSync(ntmBase);
            const cwd = join(tmp, 'proj');
            mkdirSync(cwd);
            const target = join(ntmBase, 'proj');
            symlinkSync(cwd, target); // pre-existing
            const result = await remediateProjectsBase({ cwd, ntmBase, mode: 'execute' });
            expect(result.executed).toBe(true);
            expect(existsSync(result.target)).toBe(true);
        }
        finally {
            cleanup();
        }
    });
});
describe('projectsBaseMisconfigHandler (T6.1) — doctor integration', () => {
    it('is registered in REMEDIATION_REGISTRY under projects_base_misconfig', () => {
        expect(REMEDIATION_REGISTRY['projects_base_misconfig']).toBeDefined();
        expect(REMEDIATION_REGISTRY['projects_base_misconfig']).toBe(projectsBaseMisconfigHandler);
    });
    it('buildPlan returns an empty plan when ntm is absent', async () => {
        const ctx = {
            cwd: '/tmp/fake',
            exec: mockExec(null),
            signal: new AbortController().signal,
        };
        const plan = await projectsBaseMisconfigHandler.buildPlan(ctx);
        expect(plan.steps).toEqual([]);
        expect(plan.mutating).toBe(false);
    });
    it('buildPlan returns a 1-step ln command when symlink is missing', async () => {
        const { tmp, cleanup } = makeTmp();
        try {
            const ntmBase = join(tmp, 'ntm-base');
            const cwd = join(tmp, 'my-proj');
            const ctx = {
                cwd,
                exec: mockExec(ntmBase),
                signal: new AbortController().signal,
            };
            const plan = await projectsBaseMisconfigHandler.buildPlan(ctx);
            expect(plan.steps.length).toBe(1);
            expect(plan.steps[0]).toMatch(/^ln -s "/);
            expect(plan.mutating).toBe(true);
            expect(plan.reversible).toBe(true);
        }
        finally {
            cleanup();
        }
    });
    it('execute creates the symlink and verifyProbe returns true afterwards', async () => {
        const { tmp, cleanup } = makeTmp();
        try {
            const ntmBase = join(tmp, 'ntm-base');
            mkdirSync(ntmBase);
            const cwd = join(tmp, 'my-proj');
            mkdirSync(cwd);
            const ctx = {
                cwd,
                exec: mockExec(ntmBase),
                signal: new AbortController().signal,
            };
            const result = await projectsBaseMisconfigHandler.execute(ctx);
            expect(result.stepsRun).toBe(1);
            expect(await projectsBaseMisconfigHandler.verifyProbe(ctx)).toBe(true);
        }
        finally {
            cleanup();
        }
    });
});
//# sourceMappingURL=projects_base-remediation.test.js.map