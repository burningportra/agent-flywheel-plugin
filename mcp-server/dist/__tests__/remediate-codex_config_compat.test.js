/**
 * Backup-already-exists collision path for the codex_config_compat
 * remediation handler.
 *
 * Bead: claude-orchestrator-32py (reality-check-2026-05-15-followup).
 *
 * The handler writes a timestamped backup at
 * `~/.codex/config.toml.bak.<ms-precision-ISO>` before mutating the original.
 * ISO timestamps with millisecond precision make collisions extremely unlikely
 * in practice, but the code path that handles the collision was previously
 * untested. This file pins the behavior:
 *
 *   - `writeAtomic` uses `rename(2)` which on POSIX replaces an existing
 *     target atomically. So a backup-path collision is resolved by *silent
 *     overwrite* of the prior backup with the current original content.
 *     The handler still succeeds (`stepsRun: 2`), and the new backup
 *     contains the pre-mutation original.
 *
 * If the collision policy ever changes (suffix-increment, error-out, etc.),
 * this test will fail loudly and the new contract needs to be picked
 * deliberately.
 *
 * Happy-path / buildPlan / verifyProbe / parser-agreement coverage lives in
 * `__tests__/tools/remediate-codex-config.test.ts`; this file scopes
 * narrowly to the collision branch only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConfigCompatHandler } from '../tools/remediations/codex_config_compat.js';
const noopExec = async () => ({ code: 0, stdout: '', stderr: '' });
function makeCtx(cwd) {
    return { cwd, exec: noopExec, signal: new AbortController().signal };
}
function withFakeHome() {
    const home = mkdtempSync(join(tmpdir(), 'codex-config-collision-'));
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
// Mirror of the private `backupPathFor` in the handler — must stay in sync.
function expectedBackupPath(target, tsIso) {
    return `${target}.bak.${tsIso.replace(/[:.]/g, '-')}`;
}
describe('codexConfigCompatHandler.execute — backup collision', () => {
    let fake;
    const PINNED_ISO = '2026-05-15T12:34:56.789Z';
    beforeEach(() => {
        fake = withFakeHome();
        // Pin Date so the backup filename is deterministic and we can pre-create
        // a colliding file at the exact path the handler will pick.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(PINNED_ISO));
    });
    afterEach(() => {
        vi.useRealTimers();
        fake.restore();
    });
    it('overwrites a pre-existing backup at the same timestamped path (writeAtomic rename semantics)', async () => {
        const target = join(fake.home, CONFIG_REL);
        const original = 'model = "gpt-5.5"\nverbose = true\n';
        writeFileSync(target, original);
        // Pre-create a backup at the exact path the handler will compute.
        const bakPath = expectedBackupPath(target, PINNED_ISO);
        const stalePriorContent = '# stale backup from a prior remediate run\n';
        writeFileSync(bakPath, stalePriorContent);
        expect(existsSync(bakPath)).toBe(true);
        expect(readFileSync(bakPath, 'utf8')).toBe(stalePriorContent);
        const result = await codexConfigCompatHandler.execute(makeCtx('/tmp'));
        // Handler still succeeds end-to-end — backup write + rewrite both ran.
        expect(result.stepsRun).toBe(2);
        expect(result.stderr).toBeUndefined();
        expect(result.stdout).toMatch(/commented out line 1/);
        expect(result.stdout).toContain(bakPath);
        // The colliding backup was silently replaced with the pre-mutation
        // original via rename(2). The stale prior content is gone — that is the
        // current contract.
        expect(readFileSync(bakPath, 'utf8')).toBe(original);
        expect(readFileSync(bakPath, 'utf8')).not.toBe(stalePriorContent);
        // The original config has the model line commented out as usual.
        const after = readFileSync(target, 'utf8');
        expect(after.split('\n')[0]).toBe('# model = "gpt-5.5"');
        expect(after.split('\n')[1]).toBe('verbose = true');
    });
});
//# sourceMappingURL=remediate-codex_config_compat.test.js.map