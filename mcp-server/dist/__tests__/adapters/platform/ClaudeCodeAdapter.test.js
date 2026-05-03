import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../../../adapters/platform/ClaudeCodeAdapter.js';
import { detectPlatform, getAdapter } from '../../../adapters/platform/detect.js';
import { buildSetupReport, setupLooksHealthy } from '../../../tools/setup.js';
function makeTmp(prefix = 'cca-') {
    return mkdtempSync(join(tmpdir(), prefix));
}
function cleanup(p) {
    try {
        rmSync(p, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
}
describe('ClaudeCodeAdapter — pluginRoot / installedPluginManifestPath', () => {
    const originalRoot = process.env.CLAUDE_PLUGIN_ROOT;
    afterEach(() => {
        if (originalRoot === undefined)
            delete process.env.CLAUDE_PLUGIN_ROOT;
        else
            process.env.CLAUDE_PLUGIN_ROOT = originalRoot;
    });
    it('returns null pluginRoot when CLAUDE_PLUGIN_ROOT is unset/empty', () => {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        expect(new ClaudeCodeAdapter().pluginRoot()).toBeNull();
        process.env.CLAUDE_PLUGIN_ROOT = '';
        expect(new ClaudeCodeAdapter().pluginRoot()).toBeNull();
    });
    it('returns the env value when CLAUDE_PLUGIN_ROOT is set', () => {
        process.env.CLAUDE_PLUGIN_ROOT = '/tmp/fake-plugin-root';
        expect(new ClaudeCodeAdapter().pluginRoot()).toBe('/tmp/fake-plugin-root');
    });
    it('resolves installedPluginManifestPath from CLAUDE_PLUGIN_ROOT when present', () => {
        const dir = makeTmp();
        try {
            writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
            process.env.CLAUDE_PLUGIN_ROOT = dir;
            const adapter = new ClaudeCodeAdapter();
            expect(adapter.installedPluginManifestPath()).toBe(join(dir, 'plugin.json'));
            expect(adapter.getInstalledVersion()).toBe('9.9.9');
        }
        finally {
            cleanup(dir);
        }
    });
    it('returns null when neither CLAUDE_PLUGIN_ROOT manifest nor home cache exists', () => {
        const dir = makeTmp();
        try {
            // CLAUDE_PLUGIN_ROOT points at empty dir → no plugin.json there.
            process.env.CLAUDE_PLUGIN_ROOT = dir;
            const adapter = new ClaudeCodeAdapter();
            // Path resolution falls back to ~/.claude/plugins/agent-flywheel/plugin.json;
            // we can't easily nuke that for the dev machine, so only assert that the
            // env-pointed path is NOT returned (it doesn't exist).
            expect(adapter.installedPluginManifestPath()).not.toBe(join(dir, 'plugin.json'));
        }
        finally {
            cleanup(dir);
        }
    });
});
describe('ClaudeCodeAdapter — worktreeScanRoots', () => {
    it('returns the historical 3-root list', () => {
        const roots = new ClaudeCodeAdapter().worktreeScanRoots();
        expect(roots.map((r) => r.label)).toEqual([
            '.claude/worktrees',
            '.ntm/worktrees',
            '.pi-flywheel/worktrees',
        ]);
        // .ntm uses gitfile mode (registered worktrees), the other two are direct.
        expect(roots.find((r) => r.label === '.ntm/worktrees').mode).toBe('gitfile');
        expect(roots.find((r) => r.label === '.claude/worktrees').mode).toBe('direct');
    });
});
describe('ClaudeCodeAdapter — validateHooks', () => {
    it('yellow when pluginRoot is null', () => {
        const out = new ClaudeCodeAdapter().validateHooks(null);
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('yellow');
        expect(out[0].id).toBe('claude_plugin_root_unset');
    });
    it('yellow when settings.json is missing under pluginRoot', () => {
        const dir = makeTmp();
        try {
            const out = new ClaudeCodeAdapter().validateHooks(dir);
            expect(out[0].severity).toBe('yellow');
            expect(out[0].id).toBe('settings_json_missing');
        }
        finally {
            cleanup(dir);
        }
    });
    it('yellow when settings.json has no hooks block', () => {
        const dir = makeTmp();
        try {
            mkdirSync(join(dir, '.claude'), { recursive: true });
            writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
            const out = new ClaudeCodeAdapter().validateHooks(dir);
            expect(out[0].id).toBe('settings_json_no_hooks');
            expect(out[0].severity).toBe('yellow');
        }
        finally {
            cleanup(dir);
        }
    });
    it('green when settings.json present with hooks', () => {
        const dir = makeTmp();
        try {
            mkdirSync(join(dir, '.claude'), { recursive: true });
            writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
            const out = new ClaudeCodeAdapter().validateHooks(dir);
            expect(out[0].id).toBe('settings_json_ok');
            expect(out[0].severity).toBe('green');
        }
        finally {
            cleanup(dir);
        }
    });
    it('red when settings.json is malformed JSON', () => {
        const dir = makeTmp();
        try {
            mkdirSync(join(dir, '.claude'), { recursive: true });
            writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json');
            const out = new ClaudeCodeAdapter().validateHooks(dir);
            expect(out[0].id).toBe('settings_json_invalid');
            expect(out[0].severity).toBe('red');
        }
        finally {
            cleanup(dir);
        }
    });
});
describe('ClaudeCodeAdapter — checkPluginRegistration', () => {
    const originalRoot = process.env.CLAUDE_PLUGIN_ROOT;
    afterEach(() => {
        if (originalRoot === undefined)
            delete process.env.CLAUDE_PLUGIN_ROOT;
        else
            process.env.CLAUDE_PLUGIN_ROOT = originalRoot;
    });
    it('reports installed when plugin manifest is reachable', () => {
        const dir = makeTmp();
        try {
            writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ version: '1.2.3' }));
            process.env.CLAUDE_PLUGIN_ROOT = dir;
            const status = new ClaudeCodeAdapter().checkPluginRegistration();
            expect(status.status).toBe('installed');
            expect(status.message).toContain('installed');
        }
        finally {
            cleanup(dir);
        }
    });
    it('reports standalone when CLAUDE_PLUGIN_ROOT is set but cache missing', () => {
        const dir = makeTmp();
        try {
            // No plugin.json under dir, AND no fallback cache (we can't guarantee
            // the home cache is empty on dev machines, so only assert the message
            // does NOT incorrectly say "missing" when CLAUDE_PLUGIN_ROOT is set).
            process.env.CLAUDE_PLUGIN_ROOT = dir;
            const status = new ClaudeCodeAdapter().checkPluginRegistration();
            // If the home cache happens to exist → installed; otherwise → standalone.
            expect(['installed', 'standalone']).toContain(status.status);
        }
        finally {
            cleanup(dir);
        }
    });
});
describe('detectPlatform / getAdapter', () => {
    const original = process.env.FLYWHEEL_PLATFORM;
    afterEach(() => {
        if (original === undefined)
            delete process.env.FLYWHEEL_PLATFORM;
        else
            process.env.FLYWHEEL_PLATFORM = original;
    });
    it('honors FLYWHEEL_PLATFORM=claude-code', () => {
        process.env.FLYWHEEL_PLATFORM = 'claude-code';
        expect(detectPlatform()).toBe('claude-code');
    });
    it('returns claude-code by default', () => {
        delete process.env.FLYWHEEL_PLATFORM;
        expect(detectPlatform()).toBe('claude-code');
    });
    it('getAdapter returns ClaudeCodeAdapter instance', () => {
        expect(getAdapter()).toBeInstanceOf(ClaudeCodeAdapter);
        expect(getAdapter('claude-code')).toBeInstanceOf(ClaudeCodeAdapter);
    });
});
describe('buildSetupReport / setupLooksHealthy', () => {
    it('builds a report from the supplied adapter', () => {
        const adapter = new ClaudeCodeAdapter();
        const report = buildSetupReport(adapter);
        expect(report.platform).toBe('claude-code');
        expect(['installed', 'standalone', 'missing']).toContain(report.registration.status);
        expect(Array.isArray(report.hookDiagnostics)).toBe(true);
    });
    it('setupLooksHealthy is false when registration is not "installed"', () => {
        expect(setupLooksHealthy({
            platform: 'claude-code',
            registration: { status: 'missing', message: '' },
            hookDiagnostics: [],
            installedVersion: null,
            pluginRoot: null,
        })).toBe(false);
    });
    it('setupLooksHealthy is true when installed AND every diagnostic is green', () => {
        expect(setupLooksHealthy({
            platform: 'claude-code',
            registration: { status: 'installed', message: '' },
            hookDiagnostics: [{ id: 'x', severity: 'green', message: '' }],
            installedVersion: '1.0.0',
            pluginRoot: '/tmp/x',
        })).toBe(true);
    });
    it('setupLooksHealthy is false when any diagnostic is yellow/red', () => {
        expect(setupLooksHealthy({
            platform: 'claude-code',
            registration: { status: 'installed', message: '' },
            hookDiagnostics: [
                { id: 'x', severity: 'green', message: '' },
                { id: 'y', severity: 'yellow', message: '' },
            ],
            installedVersion: '1.0.0',
            pluginRoot: '/tmp/x',
        })).toBe(false);
    });
});
// Suppress unused-import lint in tip-line workspaces.
void homedir;
//# sourceMappingURL=ClaudeCodeAdapter.test.js.map