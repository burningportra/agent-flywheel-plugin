/**
 * {@link HookAdapter} implementation for Claude Code.
 *
 * Encapsulates every Claude-Code-specific path that previously lived inline
 * in `tools/doctor.ts` (and reserved for `tools/setup.ts`):
 *
 *   - `${CLAUDE_PLUGIN_ROOT}` env probing
 *   - `~/.claude/plugins/agent-flywheel/plugin.json` cache lookup
 *   - `.claude/worktrees`, `.claude/settings.json` paths
 *
 * Behavior is identical to the pre-refactor inline logic; the adapter is a
 * pure scaffolding step so adding `GeminiCliAdapter` etc. is a one-file diff.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const CLAUDE_PLUGIN_NAME = 'agent-flywheel';
const CLAUDE_WORKTREE_ROOTS = [
    { relativePath: join('.claude', 'worktrees'), label: '.claude/worktrees', mode: 'direct' },
    { relativePath: join('.ntm', 'worktrees'), label: '.ntm/worktrees', mode: 'gitfile' },
    { relativePath: join('.pi-flywheel', 'worktrees'), label: '.pi-flywheel/worktrees', mode: 'direct' },
];
function readVersion(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed.version === 'string' ? parsed.version : null;
    }
    catch {
        return null;
    }
}
export class ClaudeCodeAdapter {
    platform = 'claude-code';
    pluginRoot() {
        const env = process.env.CLAUDE_PLUGIN_ROOT;
        return env && env.length > 0 ? env : null;
    }
    installedPluginManifestPath() {
        const root = this.pluginRoot();
        if (root) {
            const p = join(root, 'plugin.json');
            if (existsSync(p))
                return p;
        }
        const fallback = join(homedir(), '.claude', 'plugins', CLAUDE_PLUGIN_NAME, 'plugin.json');
        return existsSync(fallback) ? fallback : null;
    }
    worktreeScanRoots() {
        return CLAUDE_WORKTREE_ROOTS;
    }
    validateHooks(pluginRoot) {
        const out = [];
        if (!pluginRoot) {
            out.push({
                id: 'claude_plugin_root_unset',
                severity: 'yellow',
                message: '`CLAUDE_PLUGIN_ROOT` is not set — running outside Claude Code or without `/plugin install`',
                hint: 'Run `/flywheel-setup` from inside a Claude Code session, or install the plugin via `/plugin install`.',
            });
            return out;
        }
        const settingsPath = join(pluginRoot, '.claude', 'settings.json');
        if (!existsSync(settingsPath)) {
            out.push({
                id: 'settings_json_missing',
                severity: 'yellow',
                message: `${settingsPath} not found`,
                hint: 'Re-run `/flywheel-setup` to generate hook configuration.',
            });
            return out;
        }
        try {
            const raw = readFileSync(settingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !('hooks' in parsed) || parsed.hooks == null) {
                out.push({
                    id: 'settings_json_no_hooks',
                    severity: 'yellow',
                    message: 'settings.json present but has no `hooks` block',
                    hint: 'Re-run `/flywheel-setup` to wire flywheel PreToolUse/PostToolUse hooks.',
                });
            }
            else {
                out.push({
                    id: 'settings_json_ok',
                    severity: 'green',
                    message: 'settings.json present with hooks configured',
                });
            }
        }
        catch (err) {
            out.push({
                id: 'settings_json_invalid',
                severity: 'red',
                message: `settings.json is not valid JSON: ${err.message}`,
                hint: 'Restore from VCS or delete the file and re-run `/flywheel-setup`.',
            });
        }
        return out;
    }
    checkPluginRegistration() {
        const installed = this.installedPluginManifestPath();
        if (installed) {
            return {
                status: 'installed',
                message: `installed via /plugin install (manifest at ${installed})`,
            };
        }
        if (this.pluginRoot()) {
            return {
                status: 'standalone',
                message: 'CLAUDE_PLUGIN_ROOT is set but the plugin cache is missing',
            };
        }
        return {
            status: 'missing',
            message: 'no CLAUDE_PLUGIN_ROOT and no `~/.claude/plugins/agent-flywheel` — running outside Claude Code',
        };
    }
    getInstalledVersion() {
        const path = this.installedPluginManifestPath();
        return path ? readVersion(path) : null;
    }
}
//# sourceMappingURL=ClaudeCodeAdapter.js.map