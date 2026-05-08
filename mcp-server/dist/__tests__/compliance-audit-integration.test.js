import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runComplianceAudit } from '../tools/compliance-audit.js';
const RUN = process.env.RUN_INTEGRATION === '1';
const describeMaybe = RUN ? describe : describe.skip;
function brList(cwd) {
    const out = execSync('br list --json', { cwd, encoding: 'utf8' });
    try {
        const parsed = JSON.parse(out);
        if (!Array.isArray(parsed)) {
            throw new Error('br list --json did not return an array');
        }
        return parsed;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to parse br list --json output: ${message}`);
    }
}
function findBead(cwd, title) {
    const bead = brList(cwd).find((candidate) => candidate.title === title);
    if (!bead) {
        throw new Error(`missing fixture bead with title: ${title}`);
    }
    return bead;
}
function execSyncIn(cwd, command) {
    execSync(command, { cwd, stdio: 'pipe' });
}
describeMaybe('compliance audit - integration', () => {
    it('runs the real skill against a 2-bead fixture project', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'fw-comp-int-'));
        try {
            execSyncIn(tmp, 'git init -q');
            execSyncIn(tmp, 'git config user.email integration@example.com');
            execSyncIn(tmp, 'git config user.name Integration');
            execSyncIn(tmp, 'br init');
            execSyncIn(tmp, 'br create "Add greeting function" --type task --description "Implement greet(name) returning Hello, name!. Add unit test." --priority 2');
            execSyncIn(tmp, 'br create "Add greet+farewell" --type task --description "Implement greet() AND farewell(). Both must have unit tests." --priority 2');
            const beadA = findBead(tmp, 'Add greeting function');
            const beadB = findBead(tmp, 'Add greet+farewell');
            mkdirSync(join(tmp, 'src'), { recursive: true });
            mkdirSync(join(tmp, 'tests'), { recursive: true });
            writeFileSync(join(tmp, 'src/greet.js'), 'export const greet = (name) => `Hello, ${name}!`;\n');
            writeFileSync(join(tmp, 'tests/greet.test.js'), "import { greet } from '../src/greet.js';\nimport { test } from 'node:test';\nimport assert from 'node:assert';\ntest('greet', () => assert.strictEqual(greet('World'), 'Hello, World!'));\n");
            writeFileSync(join(tmp, 'src/greet2.js'), 'export const greet = (name) => `Hi ${name}`;\n');
            execSyncIn(tmp, 'git add .');
            execSyncIn(tmp, 'git commit -q -m "impl"');
            execSyncIn(tmp, `br update ${beadA.id} --status closed`);
            execSyncIn(tmp, `br update ${beadB.id} --status closed`);
            const exec = async (bin, args, opts = {}) => {
                const result = await execa(bin, args, {
                    cwd: opts.cwd,
                    timeout: opts.timeout,
                    signal: opts.signal,
                    reject: false,
                });
                return {
                    code: result.exitCode ?? 0,
                    stdout: result.stdout,
                    stderr: result.stderr,
                };
            };
            const ctx = {
                exec,
                cwd: tmp,
                state: {},
                saveState: async () => true,
                clearState: () => undefined,
            };
            const result = await runComplianceAudit(ctx, {
                cwd: tmp,
                beadIds: [beadA.id, beadB.id],
                threshold: 700,
            });
            const data = result.structuredContent.data;
            expect(data.status).toBe('ok');
            expect(data.passed).toHaveLength(1);
            expect(data.failed).toHaveLength(1);
            const passedIds = data.passed.map((passed) => passed.beadId);
            const failedIds = data.failed.map((failed) => failed.beadId);
            expect(passedIds).toContain(beadA.id);
            expect(failedIds).toContain(beadB.id);
            const postBeadB = brList(tmp).find((bead) => bead.id === beadB.id);
            expect(postBeadB?.status).toBe('open');
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }, 30 * 60 * 1000);
});
//# sourceMappingURL=compliance-audit-integration.test.js.map