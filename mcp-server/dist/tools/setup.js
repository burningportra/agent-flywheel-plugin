import { getAdapter } from '../adapters/platform/index.js';
import { runDoctorChecks } from './doctor.js';
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
/**
 * Build a setup report and (when setup looks healthy) chase it with a
 * full doctor sweep — adopts context-mode pattern E so the user sees a
 * green-checklist confirmation immediately after setup runs, instead of
 * having to invoke `/flywheel-doctor` separately.
 *
 * The doctor sweep runs **in-process** (no child `node ...` spawn) so the
 * runtime, env, and CLAUDE_PLUGIN_ROOT are exactly the ones setup just
 * worked against — no surprise drift between the two checks.
 */
export async function runSetupAndVerify(cwd, opts = {}) {
    const adapter = opts.adapter ?? getAdapter();
    const setupReport = buildSetupReport(adapter);
    const healthy = setupLooksHealthy(setupReport);
    if (!healthy && !opts.runDoctorOnUnhealthy) {
        return {
            setupReport,
            doctorReport: null,
            criticalFails: 0,
            verdict: 'setup_unhealthy',
            remediation: 'Setup itself reported issues — fix the hook/registration diagnostics above before re-running. Run `/flywheel-setup` again, or `/plugin install` if registration is missing.',
        };
    }
    const doctorReport = await runDoctorChecks(cwd, opts.signal, opts.doctorOptions ?? {});
    const criticalFails = doctorReport.criticalFails;
    if (criticalFails > 0) {
        return {
            setupReport,
            doctorReport,
            criticalFails,
            verdict: 'critical',
            remediation: 'Doctor found critical failures after setup — re-run `/flywheel-setup`, then `/flywheel-doctor` to confirm. If the same red rows persist, check the `hint` field of each failing check.',
        };
    }
    if (doctorReport.overall === 'yellow') {
        return {
            setupReport,
            doctorReport,
            criticalFails,
            verdict: 'warnings',
        };
    }
    return {
        setupReport,
        doctorReport,
        criticalFails,
        verdict: 'ok',
    };
}
//# sourceMappingURL=setup.js.map