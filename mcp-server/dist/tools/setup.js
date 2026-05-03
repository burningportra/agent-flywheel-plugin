import { getAdapter } from '../adapters/platform/index.js';
/**
 * Build a {@link SetupReport} via the active adapter. Pure observation —
 * never mutates `.claude/settings.json` or any other on-disk state.
 *
 * @param adapter — optional override (tests / future multi-platform code)
 */
export function buildSetupReport(adapter = getAdapter()) {
    const pluginRoot = adapter.pluginRoot();
    return {
        platform: adapter.platform,
        registration: adapter.checkPluginRegistration(),
        hookDiagnostics: adapter.validateHooks(pluginRoot),
        installedVersion: adapter.getInstalledVersion(),
        pluginRoot,
    };
}
/**
 * `true` if every hook diagnostic is green AND the plugin is installed.
 * Used by the 3jv auto-pair to decide whether the post-setup doctor run is
 * worth triggering automatically.
 */
export function setupLooksHealthy(report) {
    if (report.registration.status !== 'installed')
        return false;
    return report.hookDiagnostics.every((d) => d.severity === 'green');
}
//# sourceMappingURL=setup.js.map