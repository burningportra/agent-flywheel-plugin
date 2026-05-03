/**
 * Platform-aware adapter contract for hook + plugin operations.
 *
 * Modeled on context-mode/src/adapters/* (see
 * docs/research/context-mode-explore.md §4-A). Today only Claude Code is
 * shipped; tomorrow Codex/Gemini/Cursor adapters can implement the same
 * surface without touching `tools/doctor.ts` or `tools/setup.ts`.
 *
 * Important constraints:
 *   - Methods MUST NOT throw. Return a `DiagnosticResult` row instead.
 *   - File-system probes MUST be synchronous (the doctor runs them under a
 *     2 s per-check timeout and parallelism cap).
 *   - Network operations are NOT permitted — the adapter is metadata-only.
 */
export type DiagnosticSeverity = 'green' | 'yellow' | 'red';
export interface DiagnosticResult {
    /** Stable identifier (e.g. `settings_json_present`, `hook_path_resolved`). */
    readonly id: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    /** Optional human-readable remediation pointer. */
    readonly hint?: string;
}
/** Plugin-registration verdict surfaced by the doctor. */
export interface PluginRegistrationStatus {
    /**
     * - `installed`   — plugin manifest found in the platform's plugin cache
     * - `standalone` — running from a checkout, not installed via `/plugin install`
     * - `missing`    — neither cache nor checkout located
     */
    readonly status: 'installed' | 'standalone' | 'missing';
    readonly message: string;
}
/** Worktree scan root descriptor (unchanged shape from doctor.ts). */
export interface WorktreeScanRoot {
    /** Path relative to repo root. */
    readonly relativePath: string;
    /** Human-readable label rendered in the doctor checklist. */
    readonly label: string;
    /**
     * `'direct'` — `.claude/worktrees/*` are real dirs.
     * `'gitfile'` — `.ntm/worktrees/*` contain a `.git` file pointing back.
     */
    readonly mode: 'direct' | 'gitfile';
}
/**
 * Platform contract. Implementations are pure metadata helpers — no
 * side-effects beyond `readFileSync` / `existsSync` calls.
 */
export interface HookAdapter {
    /** Stable platform identifier (e.g. `claude-code`). */
    readonly platform: string;
    /**
     * Absolute path to the plugin checkout (the `${CLAUDE_PLUGIN_ROOT}` value
     * for Claude Code), or `null` when the platform doesn't expose this.
     */
    pluginRoot(): string | null;
    /**
     * Absolute path to the *installed* plugin manifest (the cached copy in
     * `~/.claude/plugins/agent-flywheel/plugin.json` for Claude Code). Returns
     * `null` when the manifest cannot be located — used by the version-triple
     * check to skip that side rather than warn.
     */
    installedPluginManifestPath(): string | null;
    /**
     * Worktree directories the doctor should scan for orphans. Order is
     * preserved in the rendered output.
     */
    worktreeScanRoots(): readonly WorktreeScanRoot[];
    /**
     * Validate the on-disk hook configuration (e.g. `.claude/settings.json`).
     * MUST NOT mutate. Returns one row per assertion checked. An empty array
     * means "this platform has no hook config to validate".
     *
     * @param pluginRoot — typically the value of `pluginRoot()`; passed
     *                     explicitly so the doctor can re-use the value it
     *                     already resolved without paying a second lookup.
     */
    validateHooks(pluginRoot: string | null): readonly DiagnosticResult[];
    /**
     * Plugin-registration verdict — does this platform have the flywheel
     * registered, and from where?
     */
    checkPluginRegistration(): PluginRegistrationStatus;
    /**
     * Version string from the installed plugin manifest, or `null`. Equivalent
     * to `readManifestVersion(installedPluginManifestPath())` but encapsulated
     * here so future adapters can resolve "installed version" however their
     * platform exposes it.
     */
    getInstalledVersion(): string | null;
}
//# sourceMappingURL=HookAdapter.d.ts.map