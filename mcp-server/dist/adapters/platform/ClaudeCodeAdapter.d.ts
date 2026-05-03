import type { DiagnosticResult, HookAdapter, PluginRegistrationStatus, WorktreeScanRoot } from './HookAdapter.js';
export declare class ClaudeCodeAdapter implements HookAdapter {
    readonly platform = "claude-code";
    pluginRoot(): string | null;
    installedPluginManifestPath(): string | null;
    worktreeScanRoots(): readonly WorktreeScanRoot[];
    validateHooks(pluginRoot: string | null): readonly DiagnosticResult[];
    checkPluginRegistration(): PluginRegistrationStatus;
    getInstalledVersion(): string | null;
}
//# sourceMappingURL=ClaudeCodeAdapter.d.ts.map