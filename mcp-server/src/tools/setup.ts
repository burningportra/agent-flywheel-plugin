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
import type {
  DiagnosticResult,
  HookAdapter,
  PluginRegistrationStatus,
} from '../adapters/platform/index.js';
import { getAdapter } from '../adapters/platform/index.js';
import type { DoctorReport } from '../types.js';
import { runDoctorChecks, type DoctorOptions } from './doctor.js';

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
export function buildSetupReport(adapter: HookAdapter = getAdapter()): SetupReport {
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
export function setupLooksHealthy(report: SetupReport): boolean {
  if (report.registration.status !== 'installed') return false;
  return report.hookDiagnostics.every((d) => d.severity === 'green');
}

// ─── Setup → Doctor auto-pair (claude-orchestrator-3jv) ────────────────────

export interface SetupAndVerifyOptions {
  /** Override the platform adapter (tests / future multi-platform). */
  readonly adapter?: HookAdapter;
  /**
   * When `true`, run doctor even if `setupLooksHealthy` reports false.
   * Defaults to `false`: if setup itself looks broken we surface the
   * setup remediation hints first and skip the doctor sweep, mirroring
   * context-mode/src/cli.ts upgrade()'s gate (no doctor on failed install).
   */
  readonly runDoctorOnUnhealthy?: boolean;
  /** Forwarded to {@link runDoctorChecks} (test fixtures). */
  readonly doctorOptions?: DoctorOptions;
  /** External abort signal forwarded to the doctor sweep. */
  readonly signal?: AbortSignal;
}

export interface SetupAndVerifyResult {
  readonly setupReport: SetupReport;
  /**
   * `null` when the doctor sweep was skipped because setup itself looked
   * unhealthy (and `runDoctorOnUnhealthy` was not set).
   */
  readonly doctorReport: DoctorReport | null;
  /** Mirrors `doctorReport.criticalFails`; `0` when doctor is skipped. */
  readonly criticalFails: number;
  /**
   * Aggregate verdict:
   *   - `ok`              — setup healthy + doctor green
   *   - `warnings`        — setup healthy + doctor yellow (no red rows)
   *   - `setup_unhealthy` — setup probes failed (doctor skipped by default)
   *   - `critical`        — doctor surfaced ≥1 red row
   */
  readonly verdict: 'ok' | 'warnings' | 'setup_unhealthy' | 'critical';
  /** Human-readable next-step hint when not `ok`. */
  readonly remediation?: string;
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
export async function runSetupAndVerify(
  cwd: string,
  opts: SetupAndVerifyOptions = {},
): Promise<SetupAndVerifyResult> {
  const adapter = opts.adapter ?? getAdapter();
  const setupReport = buildSetupReport(adapter);
  const healthy = setupLooksHealthy(setupReport);

  if (!healthy && !opts.runDoctorOnUnhealthy) {
    return {
      setupReport,
      doctorReport: null,
      criticalFails: 0,
      verdict: 'setup_unhealthy',
      remediation:
        'Setup itself reported issues — fix the hook/registration diagnostics above before re-running. Run `/flywheel-setup` again, or `/plugin install` if registration is missing.',
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
      remediation:
        'Doctor found critical failures after setup — re-run `/flywheel-setup`, then `/flywheel-doctor` to confirm. If the same red rows persist, check the `hint` field of each failing check.',
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
