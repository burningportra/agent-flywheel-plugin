import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFlywheelConfig, loadFlywheelConfigWithWarnings, userConfigPath } from '../flywheel-config.js';
describe('flywheel.config.yaml lanes', () => {
    let repo;
    let configHome;
    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'flywheel-lanes-repo-'));
        configHome = mkdtempSync(join(tmpdir(), 'flywheel-lanes-home-'));
        vi.stubEnv('XDG_CONFIG_HOME', configHome);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(repo, { recursive: true, force: true });
        rmSync(configHome, { recursive: true, force: true });
    });
    function writeUserConfig(body) {
        mkdirSync(join(configHome, 'agent-flywheel'), { recursive: true });
        const file = join(configHome, 'agent-flywheel', 'flywheel.config.yaml');
        writeFileSync(file, body);
        return file;
    }
    it('turns every lane on by default', () => {
        expect(loadFlywheelConfig(repo).lanes).toEqual({ gemini: true, codex: true, pi: true });
    });
    it('reads the user-level file under XDG_CONFIG_HOME', () => {
        const file = writeUserConfig('lanes:\n  gemini: false\n');
        const result = loadFlywheelConfigWithWarnings(repo);
        expect(userConfigPath()).toBe(file);
        expect(result.userSource).toBe(file);
        expect(result.config.lanes).toEqual({ gemini: false, codex: true, pi: true });
        expect(result.warnings).toEqual([]);
    });
    it('lets a key set in the repo file win over the user file, key by key', () => {
        writeUserConfig('lanes:\n  gemini: false\n  codex: false\nconvergence:\n  gate_advance_wave: false\n');
        writeFileSync(join(repo, 'flywheel.config.yaml'), 'lanes:\n  gemini: true\n');
        const { lanes, convergence } = loadFlywheelConfig(repo);
        expect(lanes).toEqual({ gemini: true, codex: false, pi: true });
        expect(convergence.gate_advance_wave).toBe(false);
    });
    it('warns about a typo or a non-boolean lane, naming the user file it came from', () => {
        const file = writeUserConfig('lanes:\n  gemeni: false\n  pi: nope\n');
        const result = loadFlywheelConfigWithWarnings(repo);
        expect(result.config.lanes).toEqual({ gemini: true, codex: true, pi: true });
        expect(result.warnings).toEqual([
            expect.objectContaining({ kind: 'unknown_key', path: 'lanes.gemeni', suggestion: 'lanes.gemini', file }),
            expect.objectContaining({ kind: 'wrong_type', path: 'lanes.pi', file }),
        ]);
    });
    it('reads a repo that is the config home only once', () => {
        writeUserConfig('lanes:\n  gemeni: false\n');
        const result = loadFlywheelConfigWithWarnings(join(configHome, 'agent-flywheel'));
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).not.toHaveProperty('file');
    });
});
//# sourceMappingURL=flywheel-config-lanes.test.js.map