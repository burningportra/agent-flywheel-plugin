/**
 * Adapter-driven setup helpers.
 *
 * The user-facing `/flywheel-setup` flow lives in `commands/flywheel-setup.md`
 * and `skills/flywheel-setup/SKILL.md` — there is no MCP tool today. This
 * module exposes the platform-aware probes the slash command (and the 3jv
 * setup→doctor auto-pair) can call without hardcoding `.claude/...` paths.
 *
 * Everything here delegates to the active {@link HookAdapter} from
 * {@link getAdapter}; substituting a future Gemini/Cursor adapter is the
 * only edit needed to add platform support.
 */
import type { DiagnosticResult, HookAdapter, PluginRegistrationStatus } from '../adapters/platform/index.js';
export interface SetupReport {
    readonly platform: string;
    readonly registration: PluginRegistrationStatus;
    readonly hookDiagnostics: readonly DiagnosticResult[];
    readonly installedVersion: string | null;
    readonly pluginRoot: string | null;
}
/**
 * Build a {@link SetupReport} via the active adapter. Pure observation —
 * never mutates `.claude/settings.json` or any other on-disk state.
 *
 * @param adapter — optional override (tests / future multi-platform code)
 */
export declare function buildSetupReport(adapter?: HookAdapter): SetupReport;
/**
 * `true` if every hook diagnostic is green AND the plugin is installed.
 * Used by the 3jv auto-pair to decide whether the post-setup doctor run is
 * worth triggering automatically.
 */
export declare function setupLooksHealthy(report: SetupReport): boolean;
//# sourceMappingURL=setup.d.ts.map