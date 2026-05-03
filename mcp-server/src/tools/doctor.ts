/**
 * flywheel_doctor check engine — PURE (no server registration here; see I4).
 *
 * Executes a fixed battery of health checks in parallel via
 * `Promise.allSettled`, with:
 *   - per-check timeout (default 2s)
 *   - global sweep budget (default 10s) via AbortSignal short-circuit
 *   - concurrent-child-process cap (default 6) via a lightweight semaphore
 *
 * Individual check failures NEVER throw from `runDoctorChecks` — they become
 * `red` / `yellow` entries in the returned `DoctorReport`. The tool-level
 * envelope is built by the I4 registration wrapper.
 */

import { statSync, readdirSync, readFileSync, realpathSync, existsSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestMtime } from './shared.js';
import { makeExec, type ExecFn } from '../exec.js';
import { readCheckpoint } from '../checkpoint.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../errors.js';
import { readTelemetry } from '../telemetry.js';
import {
  detectCliCapabilities,
  describeCapabilities,
  type CapabilitiesMap,
  type ModelProvider,
} from '../adapters/model-diversity.js';
import { getAdapter } from '../adapters/platform/index.js';
import type { HookAdapter, WorktreeScanRoot } from '../adapters/platform/index.js';
import { resolveRealpathWithinRoot } from '../utils/path-safety.js';
import type {
  DoctorCheck,
  DoctorCheckSeverity,
  DoctorReport,
  ErrorCodeTelemetry,
} from '../types.js';

const log = createLogger('doctor');

// ─── Constants ────────────────────────────────────────────────────────────

/** Per-check exec timeout (ms). */
const PER_CHECK_TIMEOUT_MS = 2000;
/** Global sweep budget (ms). */
const TOTAL_SWEEP_BUDGET_MS = 10_000;
/** Max concurrent child processes. */
const MAX_CONCURRENCY = 6;
/** Worktree dirs older than this and already merged to main are stale. */
const STALE_WORKTREE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Worktree scan roots are now sourced from the active {@link HookAdapter}
 * rather than hardcoded here. The default Claude Code adapter still emits the
 * historical three roots (`.claude/worktrees`, `.ntm/worktrees`,
 * `.pi-flywheel/worktrees`); future Codex/Gemini adapters override.
 */
const WORKTREE_SCAN_ROOTS: readonly WorktreeScanRoot[] = getAdapter().worktreeScanRoots();

/** Canonical check names. Exported for test assertions. */
export const DOCTOR_CHECK_NAMES = [
  'mcp_connectivity',
  'agent_mail_liveness',
  'br_binary',
  'bv_binary',
  'ntm_binary',
  'cm_binary',
  'node_version',
  'git_status',
  'dist_drift',
  'orphaned_worktrees',
  'checkpoint_validity',
  // Swarm-agent model diversity (claude/codex/gemini at 1:1:1 via NTM).
  'claude_cli',
  'codex_cli',
  'gemini_cli',
  'swarm_model_ratio',
  // Codex companion app-server / ChatGPT-account compat (bead `cif`).
  'codex_config_compat',
  // Codex-rescue handoff observability (bead `agent-flywheel-plugin-1qn`).
  'rescues_last_30d',
  // Version-triple drift across mcp-server/package.json,
  // .claude-plugin/plugin.json, and the installed plugin cache.
  // Warn-only; recommends `/flywheel-setup` as the fix.
  'npm_marketplace_version_drift',
] as const;

export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];

// ─── Actionable hints ─────────────────────────────────────────────────────
// DoctorCheck.hint must be a human-readable remediation sentence, not an
// error code. These constants are used across probes so the rendered hint is
// always something the user can act on.

const DOCTOR_CHECK_FAILED_HINT =
  'Re-run `flywheel_doctor`; if the failure persists, set FW_LOG_LEVEL=debug and inspect the server log for the specific probe.';
const DOCTOR_PARTIAL_REPORT_HINT =
  'Sweep budget (default 10s) or external abort fired before this probe ran. Re-run, raise the timeout, or reduce concurrent load.';
const AGENT_MAIL_UNREACHABLE_HINT =
  'Start Agent Mail (see `/flywheel-setup`) and confirm it is bound to http://127.0.0.1:8765 before re-running doctor.';
const CLI_FAILURE_HINT =
  'The CLI was found on PATH but exited non-zero. Run it manually to see the error, or set FW_LOG_LEVEL=debug to capture stderr.';
const CLI_NOT_AVAILABLE_HINT =
  'Install the missing CLI and ensure it is on $PATH. `/flywheel-setup` prints the install commands for each required tool.';
const EXEC_TIMEOUT_HINT =
  'The probe exceeded its per-check timeout (default 2s). Re-run with a larger `perCheckTimeoutMs`, or investigate why the CLI is slow.';
const POSTMORTEM_CHECKPOINT_STALE_HINT =
  'Clear the stale checkpoint with `/flywheel-stop`, or resume it with `/start` once you have confirmed the recorded goal still applies.';
const CODEX_CONFIG_GPT5_HINT =
  'Comment out the `model = "..."` line in ~/.codex/config.toml. The codex-companion app-server path uses OpenAI API auth and rejects gpt-5*/gpt-5-codex on ChatGPT-account auth even though `codex exec` accepts them. Removing the override lets the app-server pick its built-in default.';
const VERSION_DRIFT_HINT =
  'Run `/flywheel-setup` (or `cd mcp-server && npm run version-sync`) to align the manifests. Warn-only — drift does not block the run.';

// ─── Public API ───────────────────────────────────────────────────────────

export interface DoctorOptions {
  /** Override per-check timeout (ms). */
  perCheckTimeoutMs?: number;
  /** Override total sweep budget (ms). */
  totalBudgetMs?: number;
  /** Override max concurrency. */
  maxConcurrency?: number;
  /** Override ExecFn (tests). Defaults to `makeExec(cwd)`. */
  exec?: ExecFn;
  /** Override clock for deterministic elapsed/timestamp (tests). */
  now?: () => number;
  /** Override path to ~/.codex/config.toml (tests). Pass a fixture path or
   * `null` to skip reading. Defaults to `~/.codex/config.toml`. */
  codexConfigPath?: string | null;
  /** Override path to the marketplace plugin manifest (tests). Defaults to
   * `<cwd>/.claude-plugin/plugin.json`. Pass `null` to treat as missing. */
  marketplaceManifestPath?: string | null;
  /** Override path to the installed plugin cache manifest (tests). When
   * undefined, the check probes `$CLAUDE_PLUGIN_ROOT/plugin.json` if set,
   * else `~/.claude/plugins/<name>/plugin.json`. Pass `null` to skip. */
  installedPluginManifestPath?: string | null;
}

/**
 * Run all 11 health checks in parallel. Never throws.
 *
 * If `signal` fires before any check completes, the returned report has
 * `partial: true`, empty `checks`, `overall: 'red'`, `elapsedMs: 0`.
 */
export async function runDoctorChecks(
  cwd: string,
  signal?: AbortSignal,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const now = options.now ?? Date.now;
  const perCheckTimeoutMs = options.perCheckTimeoutMs ?? PER_CHECK_TIMEOUT_MS;
  const totalBudgetMs = options.totalBudgetMs ?? TOTAL_SWEEP_BUDGET_MS;
  const maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
  const exec = options.exec ?? makeExec(cwd);

  const startMs = now();
  const timestamp = new Date(startMs).toISOString();

  // Pre-aborted: return minimal partial report without running anything.
  if (signal?.aborted) {
    return {
      version: 1,
      cwd,
      overall: 'red',
      criticalFails: 0,
      partial: true,
      checks: [],
      elapsedMs: 0,
      timestamp,
    };
  }

  // Compose a combined signal: external abort OR total-budget timeout.
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(
    () => budgetController.abort(),
    totalBudgetMs,
  );
  const externalAbort = () => budgetController.abort();
  if (signal) {
    if (signal.aborted) budgetController.abort();
    else signal.addEventListener('abort', externalAbort, { once: true });
  }
  const combined = budgetController.signal;

  const semaphore = new Semaphore(maxConcurrency);

  // Detect implementation-CLI capabilities once and share the result
  // across the four model-diversity checks (avoids spawning `which`
  // four separate times for the same answer).
  const swarmCapsPromise = detectCliCapabilities(exec, {
    timeout: perCheckTimeoutMs,
    cwd,
    signal: combined,
  }).catch(
    (err): CapabilitiesMap => ({
      claude: { provider: 'claude', available: false, reason: errMsg(err) },
      codex: { provider: 'codex', available: false, reason: errMsg(err) },
      gemini: { provider: 'gemini', available: false, reason: errMsg(err) },
    }),
  );

  const checkFns: Array<() => Promise<DoctorCheck>> = [
    () => checkMcpConnectivity(cwd, combined, now),
    () => checkAgentMailLiveness(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkBrBinary(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkBvBinary(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkNtmBinary(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkCmBinary(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkNodeVersion(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkGitStatus(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkDistDrift(cwd, combined, now),
    () => checkOrphanedWorktrees(exec, cwd, combined, perCheckTimeoutMs, now),
    () => checkCheckpointValidity(cwd, combined, now),
    () => checkSwarmModelCli('claude_cli', 'claude', swarmCapsPromise, combined, now),
    () => checkSwarmModelCli('codex_cli', 'codex', swarmCapsPromise, combined, now),
    () => checkSwarmModelCli('gemini_cli', 'gemini', swarmCapsPromise, combined, now),
    () => checkSwarmModelRatio(swarmCapsPromise, combined, now),
    () =>
      checkCodexConfigCompat(
        combined,
        now,
        options.codexConfigPath === undefined
          ? join(homedir(), '.codex', 'config.toml')
          : options.codexConfigPath,
      ),
    () => checkRescuesLast30d(exec, cwd, combined, perCheckTimeoutMs, now),
    () =>
      checkVersionTriple(cwd, combined, now, {
        installedManifestPath: options.installedPluginManifestPath,
        marketplaceManifestPath: options.marketplaceManifestPath,
      }),
  ];

  const wrapped = checkFns.map((fn, idx) =>
    semaphore.acquire().then(async (release) => {
      try {
        // If combined already aborted before acquire, short-circuit the check.
        if (combined.aborted) {
          return abortedCheck(DOCTOR_CHECK_NAMES[idx]!);
        }
        return await fn();
      } catch (err) {
        // Defensive — individual checks catch their own errors, but surface
        // any leak as a red row instead of rejecting.
        log.warn('doctor check threw', {
          check: DOCTOR_CHECK_NAMES[idx],
          err: errMsg(err),
        });
        return {
          name: DOCTOR_CHECK_NAMES[idx]!,
          severity: 'red' as DoctorCheckSeverity,
          message: 'check threw unexpectedly',
          hint: DOCTOR_CHECK_FAILED_HINT,
        };
      } finally {
        release();
      }
    }),
  );

  const settled = await Promise.allSettled(wrapped);
  const elapsedMs = now() - startMs;

  clearTimeout(budgetTimer);
  if (signal) signal.removeEventListener('abort', externalAbort);

  const checks: DoctorCheck[] = settled.map((r, idx) => {
    if (r.status === 'fulfilled') {
      // Attach durationMs if not already set.
      return r.value.durationMs === undefined
        ? { ...r.value, durationMs: elapsedMs }
        : r.value;
    }
    // Should never happen (wrapped catches), but fall back gracefully.
    return {
      name: DOCTOR_CHECK_NAMES[idx]!,
      severity: 'red' as DoctorCheckSeverity,
      message: `check rejected: ${String(r.reason)}`,
      hint: DOCTOR_CHECK_FAILED_HINT,
      durationMs: elapsedMs,
    };
  });

  const externallyAborted = signal?.aborted === true;
  const budgetExceeded =
    combined.aborted && !externallyAborted && elapsedMs >= totalBudgetMs;
  const partial = externallyAborted || budgetExceeded;

  const criticalFails = countCriticalFails(checks);

  return {
    version: 1,
    cwd,
    overall: severityFromCounts(checks, criticalFails),
    criticalFails,
    partial,
    checks,
    elapsedMs,
    timestamp,
  };
}

/**
 * Count of red-severity checks. The exit code of the slash-command CLI is
 * `1` iff this is > 0; yellow checks never gate.
 *
 * Mirrors context-mode/src/cli.ts's `criticalFails` accumulator. Centralizes
 * the previously ad-hoc severity counting so callers (and tests) can rely on
 * a single number.
 */
export function countCriticalFails(checks: DoctorCheck[]): number {
  return checks.reduce((n, c) => (c.severity === 'red' ? n + 1 : n), 0);
}

/**
 * Derive overall severity from the criticalFails counter and the presence of
 * any yellow row. Equivalent to `computeOverallSeverity` but parameterized
 * on the precomputed counter so callers don't double-walk the array.
 */
function severityFromCounts(
  checks: DoctorCheck[],
  criticalFails: number,
): DoctorCheckSeverity {
  if (criticalFails > 0) return 'red';
  if (checks.some((c) => c.severity === 'yellow')) return 'yellow';
  return 'green';
}

/**
 * Reduce a list of checks to a single overall severity.
 * - red if any check is red
 * - yellow if any check is yellow (and none red)
 * - green otherwise (including empty list — but empty-list callers usually
 *   set partial:true and override to red themselves)
 */
export function computeOverallSeverity(checks: DoctorCheck[]): DoctorCheckSeverity {
  if (checks.some((c) => c.severity === 'red')) return 'red';
  if (checks.some((c) => c.severity === 'yellow')) return 'yellow';
  return 'green';
}

// ─── Concurrency primitive ────────────────────────────────────────────────

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        this.available += 1;
        const next = this.waiters.shift();
        if (next) next();
      };
      const grant = () => {
        this.available -= 1;
        resolve(release);
      };
      if (this.available > 0) grant();
      else this.waiters.push(grant);
    });
  }
}

// ─── Check implementations ───────────────────────────────────────────────

function abortedCheck(name: string): DoctorCheck {
  return {
    name,
    severity: 'red',
    message: 'check aborted before execution',
    hint: DOCTOR_PARTIAL_REPORT_HINT,
    durationMs: 0,
  };
}

/**
 * 1. MCP connectivity.
 *
 * If this code is running, the MCP server is connected by definition — no
 * round-trip needed. We resolve the running module's own file via
 * `import.meta.url` and report its location. This works for both contributor
 * checkouts (running from `cwd/mcp-server/dist/`) and plugin installs (running
 * from `~/.claude/plugins/.../mcp-server/dist/`). Source/dist drift is a
 * separate check (`dist_drift`) — this one is purely proof-of-life.
 */
async function checkMcpConnectivity(
  cwd: string,
  signal: AbortSignal,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('mcp_connectivity');

  try {
    const runningModule = fileURLToPath(import.meta.url);
    if (!existsSync(runningModule)) {
      return {
        name: 'mcp_connectivity',
        severity: 'yellow',
        message: `running module path not on disk: ${runningModule}`,
        hint: DOCTOR_CHECK_FAILED_HINT,
        durationMs: now() - start,
      };
    }
    const localDist = resolveDoctorPath(
      cwd,
      join('mcp-server', 'dist', 'server.js'),
      'mcp-server/dist/server.js',
    );
    let cwdReal: string | null = null;
    try {
      cwdReal = realpathSync(cwd);
    } catch {
      cwdReal = null;
    }
    const isPluginInstall = !localDist.ok || cwdReal === null || !runningModule.startsWith(cwdReal);
    return {
      name: 'mcp_connectivity',
      severity: 'green',
      message: isPluginInstall
        ? 'server responded (plugin install)'
        : 'server responded (local checkout)',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'mcp_connectivity',
      severity: 'red',
      message: `mcp connectivity probe failed: ${errMsg(err)}`,
      hint: DOCTOR_CHECK_FAILED_HINT,
      durationMs: now() - start,
    };
  }
}

/** 2. Agent Mail liveness via HTTP probe to localhost:8765. */
async function checkAgentMailLiveness(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('agent_mail_liveness');

  try {
    const res = await exec(
      'curl',
      ['-s', '--max-time', '2', 'http://127.0.0.1:8765/health/liveness'],
      { timeout, cwd, signal },
    );
    if (res.code !== 0) {
      return {
        name: 'agent_mail_liveness',
        severity: 'red',
        message: 'Agent Mail liveness probe failed (connection refused)',
        hint: AGENT_MAIL_UNREACHABLE_HINT,
        durationMs: now() - start,
      };
    }
    const trimmed = res.stdout.trim();
    if (trimmed.includes('"status":"alive"') || trimmed.includes('"status": "alive"')) {
      return {
        name: 'agent_mail_liveness',
        severity: 'green',
        message: 'Agent Mail alive',
        durationMs: now() - start,
      };
    }
    return {
      name: 'agent_mail_liveness',
      severity: 'yellow',
      message: 'Agent Mail reachable but status is not "alive"',
      hint: AGENT_MAIL_UNREACHABLE_HINT,
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'agent_mail_liveness',
      severity: 'red',
      message: `Agent Mail liveness probe error: ${errMsg(err)}`,
      hint: AGENT_MAIL_UNREACHABLE_HINT,
      durationMs: now() - start,
    };
  }
}

/** 3. br binary (required). */
async function checkBrBinary(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  return checkBinary('br_binary', 'br', exec, cwd, signal, timeout, now, {
    requiredSeverity: 'red',
  });
}

/** 4. bv binary (optional — yellow if absent). */
async function checkBvBinary(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  return checkBinary('bv_binary', 'bv', exec, cwd, signal, timeout, now, {
    requiredSeverity: 'yellow',
  });
}

/** 5. ntm binary (optional). */
async function checkNtmBinary(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  return checkBinary('ntm_binary', 'ntm', exec, cwd, signal, timeout, now, {
    requiredSeverity: 'yellow',
  });
}

/** 6. cm (CASS) binary (optional). */
async function checkCmBinary(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  return checkBinary('cm_binary', 'cm', exec, cwd, signal, timeout, now, {
    requiredSeverity: 'yellow',
  });
}

async function checkBinary(
  checkName: string,
  binary: string,
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
  opts: { requiredSeverity: 'red' | 'yellow' },
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck(checkName);
  try {
    const res = await exec(binary, ['--version'], { timeout, cwd, signal });
    if (res.code === 0) {
      const version = res.stdout.trim().split('\n')[0] ?? '';
      return {
        name: checkName,
        severity: 'green',
        message: version ? `${binary} ${version}` : `${binary} present`,
        durationMs: now() - start,
      };
    }
    // Non-zero exit: some CLIs (e.g. ntm) don't accept --version. Fall back to
    // --help to confirm liveness before reporting the binary as broken.
    if (signal.aborted) return abortedCheck(checkName);
    const help = await exec(binary, ['--help'], { timeout, cwd, signal });
    if (help.code === 0) {
      return {
        name: checkName,
        severity: 'green',
        message: `${binary} present (no --version flag)`,
        durationMs: now() - start,
      };
    }
    return {
      name: checkName,
      severity: 'yellow',
      message: `${binary} --version returned code ${res.code}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  } catch (err) {
    const msg = errMsg(err);
    const isEnoent = /ENOENT|not found/i.test(msg);
    const isTimeout = /Timed out/.test(msg);
    if (isTimeout) {
      return {
        name: checkName,
        severity: 'yellow',
        message: `${binary} --version timed out`,
        hint: EXEC_TIMEOUT_HINT,
        durationMs: now() - start,
      };
    }
    if (isEnoent) {
      return {
        name: checkName,
        severity: opts.requiredSeverity,
        message: `${binary} not installed`,
        hint: CLI_NOT_AVAILABLE_HINT,
        durationMs: now() - start,
      };
    }
    return {
      name: checkName,
      severity: opts.requiredSeverity,
      message: `${binary} probe failed: ${msg}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  }
}

/** 7. node version report. */
async function checkNodeVersion(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('node_version');
  try {
    const res = await exec('node', ['--version'], { timeout, cwd, signal });
    if (res.code !== 0) {
      return {
        name: 'node_version',
        severity: 'red',
        message: `node --version exited ${res.code}`,
        hint: CLI_FAILURE_HINT,
        durationMs: now() - start,
      };
    }
    const version = res.stdout.trim();
    return {
      name: 'node_version',
      severity: 'green',
      message: `node ${version}`,
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'node_version',
      severity: 'red',
      message: `node --version failed: ${errMsg(err)}`,
      hint: CLI_NOT_AVAILABLE_HINT,
      durationMs: now() - start,
    };
  }
}

/** 8. git status — green when clean, yellow when dirty. */
async function checkGitStatus(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('git_status');
  try {
    const head = await exec('git', ['rev-parse', 'HEAD'], { timeout, cwd, signal });
    if (head.code !== 0) {
      return {
        name: 'git_status',
        severity: 'red',
        message: 'git rev-parse HEAD failed — not a git repo?',
        hint: CLI_FAILURE_HINT,
        durationMs: now() - start,
      };
    }
    const porcelain = await exec('git', ['status', '--porcelain'], {
      timeout,
      cwd,
      signal,
    });
    if (porcelain.code !== 0) {
      return {
        name: 'git_status',
        severity: 'yellow',
        message: 'git status --porcelain failed',
        hint: CLI_FAILURE_HINT,
        durationMs: now() - start,
      };
    }
    const dirtyLines = porcelain.stdout.split('\n').filter((l) => l.trim().length > 0);
    if (dirtyLines.length === 0) {
      return {
        name: 'git_status',
        severity: 'green',
        message: 'working tree clean',
        durationMs: now() - start,
      };
    }
    return {
      name: 'git_status',
      severity: 'yellow',
      message: `working tree dirty (${dirtyLines.length} changed file${dirtyLines.length === 1 ? '' : 's'})`,
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'git_status',
      severity: 'red',
      message: `git status probe failed: ${errMsg(err)}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  }
}

/** 9. dist-drift: src newer than dist → red. */
async function checkDistDrift(
  cwd: string,
  signal: AbortSignal,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('dist_drift');
  try {
    const srcDir = resolveDoctorPath(cwd, join('mcp-server', 'src'), 'mcp-server/src');
    const distDir = resolveDoctorPath(cwd, join('mcp-server', 'dist'), 'mcp-server/dist');
    if (!srcDir.ok) {
      return {
        name: 'dist_drift',
        severity: srcDir.reason === 'not_found' ? 'green' : 'yellow',
        message:
          srcDir.reason === 'not_found'
            ? 'no mcp-server/src/ — skipping dist drift check'
            : `dist drift probe refused path: ${srcDir.message}`,
        durationMs: now() - start,
      };
    }
    if (!distDir.ok) {
      return {
        name: 'dist_drift',
        severity: distDir.reason === 'not_found' ? 'red' : 'yellow',
        message:
          distDir.reason === 'not_found'
            ? 'mcp-server/dist/ missing — run `npm run build`'
            : `dist drift probe refused path: ${distDir.message}`,
        hint: DOCTOR_CHECK_FAILED_HINT,
        durationMs: now() - start,
      };
    }
    const srcMax = newestMtime(srcDir.realPath, (n) => n.endsWith('.ts'));
    const distMax = newestMtime(distDir.realPath);
    if (srcMax === null) {
      return {
        name: 'dist_drift',
        severity: 'green',
        message: 'no .ts files under mcp-server/src',
        durationMs: now() - start,
      };
    }
    if (distMax === null || srcMax > distMax) {
      return {
        name: 'dist_drift',
        severity: 'red',
        message: 'mcp-server/src is newer than dist — rebuild required',
        hint: DOCTOR_CHECK_FAILED_HINT,
        durationMs: now() - start,
      };
    }
    return {
      name: 'dist_drift',
      severity: 'green',
      message: 'dist is current with src',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'dist_drift',
      severity: 'yellow',
      message: `dist drift probe failed: ${errMsg(err)}`,
      hint: DOCTOR_CHECK_FAILED_HINT,
      durationMs: now() - start,
    };
  }
}

/** 10. Orphaned/stale worktrees under managed worktree roots. */
async function checkOrphanedWorktrees(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('orphaned_worktrees');
  try {
    const candidates: WorktreeCandidate[] = [];
    for (const root of WORKTREE_SCAN_ROOTS) {
      const dir = resolveDoctorPath(cwd, root.relativePath, root.label);
      if (!dir.ok) {
        if (dir.reason === 'not_found') continue;
        return {
          name: 'orphaned_worktrees',
          severity: 'yellow',
          message: `worktree probe refused path: ${dir.message}`,
          durationMs: now() - start,
        };
      }
      candidates.push(...collectWorktreeCandidates(dir.realPath, root.label, root.mode));
    }

    if (candidates.length === 0) {
      return {
        name: 'orphaned_worktrees',
        severity: 'green',
        message: 'no worktree directories present',
        durationMs: now() - start,
      };
    }

    const res = await exec('git', ['worktree', 'list', '--porcelain'], {
      timeout,
      cwd,
      signal,
    });
    if (res.code !== 0) {
      return {
        name: 'orphaned_worktrees',
        severity: 'yellow',
        message: 'git worktree list failed — cannot verify orphans',
        hint: CLI_FAILURE_HINT,
        durationMs: now() - start,
      };
    }
    const registered = parseGitWorktreeList(res.stdout);
    const orphans: string[] = [];
    const stale: string[] = [];
    const lockedStale: string[] = [];
    const nowMs = now();

    for (const candidate of candidates) {
      const record = registered.get(canonicalPath(candidate.path));
      if (!record) {
        orphans.push(candidate.displayName);
        continue;
      }
      if (!record.head || nowMs - candidate.mtimeMs < STALE_WORKTREE_AGE_MS) continue;
      const onMain = await isCommitOnMain(exec, cwd, signal, timeout, record.head);
      if (!onMain) continue;
      if (record.locked) {
        lockedStale.push(candidate.displayName);
      } else {
        stale.push(candidate.displayName);
      }
    }

    if (orphans.length === 0 && stale.length === 0 && lockedStale.length === 0) {
      return {
        name: 'orphaned_worktrees',
        severity: 'green',
        message: `${candidates.length} worktree${candidates.length === 1 ? '' : 's'} all registered and none stale (>3d, HEAD on main)`,
        durationMs: now() - start,
      };
    }
    const parts: string[] = [];
    if (orphans.length > 0) {
      parts.push(`${orphans.length} orphaned worktree dir${orphans.length === 1 ? '' : 's'}: ${orphans.join(', ')}`);
    }
    if (stale.length > 0) {
      parts.push(`${stale.length} stale worktree dir${stale.length === 1 ? '' : 's'} (HEAD on main, untouched >3d): ${stale.join(', ')}`);
    }
    if (lockedStale.length > 0) {
      parts.push(`${lockedStale.length} locked stale worktree dir${lockedStale.length === 1 ? '' : 's'} need${lockedStale.length === 1 ? 's' : ''} inspection: ${lockedStale.join(', ')}`);
    }
    return {
      name: 'orphaned_worktrees',
      severity: 'yellow',
      message: parts.join('; '),
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'orphaned_worktrees',
      severity: 'yellow',
      message: `worktree probe failed: ${errMsg(err)}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  }
}

/** 11. Checkpoint validity via readCheckpoint. */
async function checkCheckpointValidity(
  cwd: string,
  signal: AbortSignal,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('checkpoint_validity');
  try {
    const ckptPath = resolveDoctorPath(
      cwd,
      join('.pi-flywheel', 'checkpoint.json'),
      '.pi-flywheel/checkpoint.json',
    );
    if (!ckptPath.ok) {
      return {
        name: 'checkpoint_validity',
        severity: ckptPath.reason === 'not_found' ? 'green' : 'yellow',
        message:
          ckptPath.reason === 'not_found'
            ? 'no checkpoint — nothing to validate'
            : `checkpoint probe refused path: ${ckptPath.message}`,
        durationMs: now() - start,
      };
    }
    const res = readCheckpoint(cwd);
    if (res === null) {
      return {
        name: 'checkpoint_validity',
        severity: 'yellow',
        message: 'checkpoint present but unreadable (corrupt or schema mismatch)',
        hint: POSTMORTEM_CHECKPOINT_STALE_HINT,
        durationMs: now() - start,
      };
    }
    if (res.warnings.length > 0) {
      return {
        name: 'checkpoint_validity',
        severity: 'yellow',
        message: `checkpoint loaded with warnings: ${res.warnings.join('; ')}`,
        hint: POSTMORTEM_CHECKPOINT_STALE_HINT,
        durationMs: now() - start,
      };
    }
    return {
      name: 'checkpoint_validity',
      severity: 'green',
      message: 'checkpoint valid',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'checkpoint_validity',
      severity: 'yellow',
      message: `checkpoint probe failed: ${errMsg(err)}`,
      hint: POSTMORTEM_CHECKPOINT_STALE_HINT,
      durationMs: now() - start,
    };
  }
}

// ─── Swarm-agent model diversity checks ───────────────────────────────────

/**
 * 12-14. Per-provider CLI availability for the swarm-agent model
 * diversity feature. Yellow (not red) when missing — the wave can still
 * proceed via fallback to another provider; the doctor's
 * `swarm_model_ratio` synthesis check reports the achievable ratio.
 */
async function checkSwarmModelCli(
  checkName: 'claude_cli' | 'codex_cli' | 'gemini_cli',
  provider: ModelProvider,
  capsPromise: Promise<CapabilitiesMap>,
  signal: AbortSignal,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck(checkName);
  try {
    const caps = await capsPromise;
    const cap = caps[provider];
    if (cap.available) {
      return {
        name: checkName,
        severity: 'green',
        message: cap.path
          ? `${provider} cli at ${cap.path}`
          : `${provider} cli present`,
        durationMs: now() - start,
      };
    }
    return {
      name: checkName,
      severity: 'yellow',
      message: `${provider} cli not installed${cap.reason ? ` (${cap.reason})` : ''}`,
      hint: CLI_NOT_AVAILABLE_HINT,
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: checkName,
      severity: 'yellow',
      message: `${provider} cli probe failed: ${errMsg(err)}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  }
}

/**
 * 15. Synthesised swarm model ratio. Reports the Claude:Codex:Gemini
 * ratio achievable in this environment. Severity:
 *   - green when all three CLIs are present (1:1:1).
 *   - yellow when at least one is present but not all three.
 *   - red when none are present (no swarm dispatch possible).
 */
async function checkSwarmModelRatio(
  capsPromise: Promise<CapabilitiesMap>,
  signal: AbortSignal,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('swarm_model_ratio');
  try {
    const caps = await capsPromise;
    const description = describeCapabilities(caps);
    const availableCount = (
      ['claude', 'codex', 'gemini'] as const
    ).reduce((acc, p) => acc + (caps[p].available ? 1 : 0), 0);
    if (availableCount === 3) {
      return {
        name: 'swarm_model_ratio',
        severity: 'green',
        message: description,
        durationMs: now() - start,
      };
    }
    if (availableCount === 0) {
      return {
        name: 'swarm_model_ratio',
        severity: 'red',
        message: description,
        hint: CLI_NOT_AVAILABLE_HINT,
        durationMs: now() - start,
      };
    }
    return {
      name: 'swarm_model_ratio',
      severity: 'yellow',
      message: description,
      hint: CLI_NOT_AVAILABLE_HINT,
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'swarm_model_ratio',
      severity: 'yellow',
      message: `swarm ratio probe failed: ${errMsg(err)}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  }
}

// ─── Codex-rescue observability ───────────────────────────────────────────

/**
 * 16. `rescues_last_30d` — synthesised count of `/codex:rescue` handoff
 * events recorded in CASS over the last 30 days. The rescue branches in
 * `_planning.md` Phase 0.6, `_implement.md` stall section, and `_review.md`
 * Step 8.5 persist each handoff via `flywheel_memory(operation="store",
 * content=formatRescueEventForMemory(packet))` — that formatter emits the
 * canonical prefix `flywheel-rescue` which we count here.
 *
 * Severity:
 *   - green when 0–4 rescues in the window (normal operating volume).
 *   - yellow when 5–14 (frequent stalls — investigate hotspots).
 *   - red when 15+ (severe — indicates Claude lane degradation).
 *   - yellow if `cm` CLI is absent (cannot count, observability degraded).
 *
 * Read-only: only invokes `cm context`. Never mutates CASS.
 */
/**
 * Pure parser for ~/.codex/config.toml. Looks for the top-level `model`
 * key and reports its raw value (TOML-stripped quotes). Returns null if
 * the key is absent, commented out, or only set inside a [section].
 *
 * Intentionally simple — we only care about `model = "..."` at the root
 * level above the first `[section]` header. A real TOML parser would be
 * overkill for one key.
 *
 * Exported for test access only.
 */
export function parseCodexConfigTopLevelModel(content: string): string | null {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) return null;
    if (line.startsWith('#') || line.length === 0) continue;
    const m = /^model\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Models known to fail through the codex-companion app-server path on
 * ChatGPT-account auth (bead `cif`). These models work fine via
 * `codex exec` but the JSON-RPC `app-server` route uses OpenAI API auth
 * and rejects them with "model does not exist or you do not have access".
 */
const CODEX_INCOMPATIBLE_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /^gpt-5(\.|-|$)/i,
  /^o4-mini/i,
];

export function isCodexIncompatibleModel(model: string): boolean {
  return CODEX_INCOMPATIBLE_MODEL_PATTERNS.some((re) => re.test(model));
}

/**
 * 16. Codex companion app-server / ChatGPT-account compat (bead `cif`).
 *
 * The codex-companion's app-server transport rejects gpt-5* (and a few
 * other) models on ChatGPT-account auth — even though `codex exec`
 * accepts the same model on the same account. This silently breaks
 * `/codex-rescue` and any flywheel handoff. Detect the misconfiguration
 * upfront so the user gets a clear actionable hint instead of a stack of
 * "Reconnecting... 5/5" log lines.
 *
 * Severity:
 *   - green when no model line is set, or model is not in the broken set.
 *   - yellow when an incompatible model is the explicit top-level default.
 *
 * Pure read of ~/.codex/config.toml; no exec, no network. Missing file
 * (Codex not installed) is green — `codex_cli` check covers that case.
 */
async function checkCodexConfigCompat(
  signal: AbortSignal,
  now: () => number,
  configPath: string | null,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('codex_config_compat');
  if (configPath === null) {
    return {
      name: 'codex_config_compat',
      severity: 'green',
      message: 'codex config check disabled (codexConfigPath=null)',
      durationMs: now() - start,
    };
  }
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return {
      name: 'codex_config_compat',
      severity: 'green',
      message: `no ${configPath} — nothing to validate`,
      durationMs: now() - start,
    };
  }
  const model = parseCodexConfigTopLevelModel(content);
  if (model === null) {
    return {
      name: 'codex_config_compat',
      severity: 'green',
      message: 'no top-level `model = ...` override in ~/.codex/config.toml',
      durationMs: now() - start,
    };
  }
  if (isCodexIncompatibleModel(model)) {
    return {
      name: 'codex_config_compat',
      severity: 'yellow',
      message: `~/.codex/config.toml sets model="${model}" — codex-companion app-server will reject this on ChatGPT-account auth`,
      hint: CODEX_CONFIG_GPT5_HINT,
      durationMs: now() - start,
    };
  }
  return {
    name: 'codex_config_compat',
    severity: 'green',
    message: `~/.codex/config.toml model="${model}" — compatible with app-server`,
    durationMs: now() - start,
  };
}

async function checkRescuesLast30d(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('rescues_last_30d');
  try {
    // First confirm cm is available — synthesis is best-effort.
    const probe = await exec('cm', ['--version'], { timeout, cwd, signal });
    if (probe.code !== 0) {
      log.debug('rescues_last_30d cm version probe failed', {
        command: 'cm --version',
        exitCode: probe.code,
        stderr: probe.stderr.trim(),
      });
      const fallback = await localRescueCountFallback(cwd, now());
      if (fallback !== null) {
        return rescueCountCheck(
          fallback,
          now() - start,
          ' (local telemetry fallback; cm unavailable)',
        );
      }
      return {
        name: 'rescues_last_30d',
        severity: 'yellow',
        message: 'cm CLI unavailable — rescue counts unknown',
        hint: CLI_NOT_AVAILABLE_HINT,
        durationMs: now() - start,
      };
    }
    // `cm context` returns matching bullets as JSON; we count entries whose
    // body carries the canonical `flywheel-rescue` prefix AND whose embedded
    // `ts=` ISO timestamp falls within the last 30 days.
    const res = await exec('cm', ['context', 'flywheel-rescue', '--json'], {
      timeout,
      cwd,
      signal,
    });
    if (res.code !== 0) {
      log.debug('rescues_last_30d cm context failed', {
        command: 'cm context flywheel-rescue --json',
        exitCode: res.code,
        stderr: res.stderr.trim(),
      });
      const fallback = await localRescueCountFallback(cwd, now());
      if (fallback !== null) {
        return rescueCountCheck(
          fallback,
          now() - start,
          ' (local telemetry fallback; cm context failed)',
        );
      }
      return {
        name: 'rescues_last_30d',
        severity: 'yellow',
        message: 'cm context failed — rescue counts unknown',
        hint: CLI_FAILURE_HINT,
        durationMs: now() - start,
      };
    }
    const count = countRescueEntriesWithin30Days(res.stdout, now());
    return rescueCountCheck(count, now() - start);
  } catch (err) {
    log.debug('rescues_last_30d probe threw', {
      command: 'cm context flywheel-rescue --json',
      error: errMsg(err),
    });
    const fallback = await localRescueCountFallback(cwd, now());
    if (fallback !== null) {
      return rescueCountCheck(
        fallback,
        now() - start,
        ' (local telemetry fallback; cm context threw)',
      );
    }
    return {
      name: 'rescues_last_30d',
      severity: 'yellow',
      message: `rescue count probe failed: ${errMsg(err)}`,
      hint: CLI_FAILURE_HINT,
      durationMs: now() - start,
    };
  }
}

function rescueCountCheck(
  count: number,
  durationMs: number,
  sourceNote = '',
): DoctorCheck {
  if (count >= 15) {
    return {
      name: 'rescues_last_30d',
      severity: 'red',
      message: `${count} codex rescues in last 30d${sourceNote} — Claude lane likely degraded`,
      hint: DOCTOR_CHECK_FAILED_HINT,
      durationMs,
    };
  }
  if (count >= 5) {
    return {
      name: 'rescues_last_30d',
      severity: 'yellow',
      message: `${count} codex rescues in last 30d${sourceNote} — investigate stall hotspots`,
      hint: DOCTOR_CHECK_FAILED_HINT,
      durationMs,
    };
  }
  return {
    name: 'rescues_last_30d',
    severity: 'green',
    message: `${count} codex rescues in last 30d${sourceNote}`,
    durationMs,
  };
}

async function localRescueCountFallback(cwd: string, nowMs: number): Promise<number | null> {
  const telemetry = await readTelemetry({ cwd });
  if (telemetry === null) return null;
  return countLocalTelemetryRescuesWithin30Days(telemetry, nowMs);
}

function isRescueTelemetryCode(code: string): boolean {
  return /(?:^|[-_])(?:flywheel[-_])?(?:codex[-_])?rescue(?:[-_]|$)/i.test(code);
}

export function countLocalTelemetryRescuesWithin30Days(
  telemetry: ErrorCodeTelemetry,
  nowMs: number,
): number {
  const cutoff = nowMs - 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const event of telemetry.recentEvents ?? []) {
    if (!isRescueTelemetryCode(event.code)) continue;
    const ts = Date.parse(event.ts);
    if (Number.isFinite(ts) && ts >= cutoff) count++;
  }
  if (count > 0) return count;

  const sessionStart = Date.parse(telemetry.sessionStartIso);
  if (!Number.isFinite(sessionStart) || sessionStart < cutoff) return 0;
  return Object.entries(telemetry.counts ?? {}).reduce((acc, [code, n]) => {
    return isRescueTelemetryCode(code) ? acc + n : acc;
  }, 0);
}

/**
 * Count `flywheel-rescue` entries in a `cm context --json` payload whose
 * embedded `ts=` ISO timestamp falls within the last 30 days. Pure (no
 * I/O) and defensive — ignores unparseable rows rather than throwing.
 *
 * Exported for test access.
 */
export function countRescueEntriesWithin30Days(
  raw: string,
  nowMs: number,
): number {
  if (!raw.trim()) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  // Accept historical `cm search --json` shapes (bare array,
  // { bullets: [...] }) plus the cm 0.2.3 `cm context --json` wrapper
  // ({ data: { relevantBullets: [...], historySnippets: [...] } }).
  const bullets = extractRescueCandidateRows(parsed);
  const cutoff = nowMs - 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const b of bullets) {
    const body = b.content ?? b.text ?? b.snippet ?? '';
    if (!body.includes('flywheel-rescue')) continue;
    const tsMatch = /\bts=(\S+)/.exec(body);
    if (!tsMatch?.[1]) continue;
    const ts = Date.parse(tsMatch[1]);
    if (Number.isFinite(ts) && ts >= cutoff) count++;
  }
  return count;
}

type RescueCandidateRow = {
  content?: string;
  text?: string;
  snippet?: string;
};

function extractRescueCandidateRows(parsed: unknown): RescueCandidateRow[] {
  if (Array.isArray(parsed)) return parsed as RescueCandidateRow[];
  if (typeof parsed !== 'object' || parsed === null) return [];

  const root = parsed as {
    bullets?: unknown;
    relevantBullets?: unknown;
    historySnippets?: unknown;
    results?: unknown;
    data?: unknown;
  };
  const data = (
    typeof root.data === 'object' && root.data !== null
      ? root.data
      : {}
  ) as {
    bullets?: unknown;
    relevantBullets?: unknown;
    historySnippets?: unknown;
    results?: unknown;
  };

  const sources = [
    root.bullets,
    root.relevantBullets,
    root.historySnippets,
    root.results,
    data.bullets,
    data.relevantBullets,
    data.historySnippets,
    data.results,
  ];
  return sources.flatMap((value) => (Array.isArray(value) ? value as RescueCandidateRow[] : []));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface WorktreeCandidate {
  path: string;
  displayName: string;
  mtimeMs: number;
}

interface GitWorktreeRecord {
  head?: string;
  branch?: string;
  locked: boolean;
}

function resolveDoctorPath(
  cwd: string,
  relativePath: string,
  label: string,
): ReturnType<typeof resolveRealpathWithinRoot> {
  return resolveRealpathWithinRoot(relativePath, {
    root: cwd,
    label,
    rootLabel: 'cwd',
  });
}

function collectWorktreeCandidates(
  rootPath: string,
  label: string,
  mode: (typeof WORKTREE_SCAN_ROOTS)[number]['mode'],
): WorktreeCandidate[] {
  return mode === 'gitfile'
    ? collectGitfileWorktreeCandidates(rootPath, label)
    : collectDirectWorktreeCandidates(rootPath, label);
}

function collectDirectWorktreeCandidates(rootPath: string, label: string): WorktreeCandidate[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(rootPath, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const candidates: WorktreeCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidatePath = join(rootPath, entry.name);
    const candidate = makeWorktreeCandidate(candidatePath, `${label}/${entry.name}`);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function collectGitfileWorktreeCandidates(rootPath: string, label: string): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = [];
  const stack: Array<{ path: string; relParts: string[]; depth: number }> = [
    { path: rootPath, relParts: [], depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.relParts.length > 0 && hasGitMetadataFile(current.path)) {
      const candidate = makeWorktreeCandidate(
        current.path,
        `${label}/${current.relParts.join('/')}`,
      );
      if (candidate) candidates.push(candidate);
      continue;
    }
    if (current.depth >= 3) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      stack.push({
        path: join(current.path, entry.name),
        relParts: [...current.relParts, entry.name],
        depth: current.depth + 1,
      });
    }
  }

  return candidates;
}

function makeWorktreeCandidate(path: string, displayName: string): WorktreeCandidate | null {
  try {
    return {
      path,
      displayName,
      mtimeMs: statSync(path).mtimeMs,
    };
  } catch {
    return null;
  }
}

function hasGitMetadataFile(path: string): boolean {
  try {
    const stat = statSync(join(path, '.git'));
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

function parseGitWorktreeList(raw: string): Map<string, GitWorktreeRecord> {
  const records = new Map<string, GitWorktreeRecord>();
  let current:
    | {
        path: string;
        head?: string;
        branch?: string;
        locked: boolean;
      }
    | null = null;

  const finish = () => {
    if (!current) return;
    records.set(canonicalPath(current.path), {
      head: current.head,
      branch: current.branch,
      locked: current.locked,
    });
    current = null;
  };

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      finish();
      continue;
    }
    if (line.startsWith('worktree ')) {
      finish();
      current = {
        path: line.slice('worktree '.length).trim(),
        locked: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.startsWith('locked')) {
      current.locked = true;
    }
  }
  finish();

  return records;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function isCommitOnMain(
  exec: ExecFn,
  cwd: string,
  signal: AbortSignal,
  timeout: number,
  head: string,
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    const res = await exec('git', ['merge-base', '--is-ancestor', head, 'main'], {
      timeout,
      cwd,
      signal,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

// ─── version-triple drift check ───────────────────────────────────────────
// Compares (a) mcp-server/package.json, (b) .claude-plugin/plugin.json,
// (c) installed plugin cache plugin.json. Warn-only on any divergence;
// recommends `/flywheel-setup` as the fix path.

interface VersionTripleOpts {
  marketplaceManifestPath?: string | null;
  installedManifestPath?: string | null;
}

/**
 * Read a JSON manifest's `version` field. Returns `null` if the file is
 * missing, unreadable, or the field is absent/non-string. Never throws.
 */
export function readManifestVersion(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the installed plugin manifest path via the active platform
 * adapter. For Claude Code, that probes `$CLAUDE_PLUGIN_ROOT/plugin.json`
 * first then `~/.claude/plugins/agent-flywheel/plugin.json`. Returns `null`
 * when nothing is installed, so the version-triple check skips that side.
 *
 * Re-exported for tests that want the concrete default; callers should
 * usually go through {@link HookAdapter.installedPluginManifestPath} via
 * {@link getAdapter}.
 */
export function resolveInstalledPluginManifest(): string | null {
  return getAdapter().installedPluginManifestPath();
}

/**
 * Diff a manifest version triple. Returns the set of label pairs that
 * disagree (e.g. `['local↔marketplace', 'local↔installed']`). Pure — used
 * by the check probe and by tests.
 */
export function diffVersionTriple(triple: {
  local: string | null;
  marketplace: string | null;
  installed: string | null;
}): string[] {
  const drift: string[] = [];
  const { local, marketplace, installed } = triple;
  if (local && marketplace && local !== marketplace) {
    drift.push(`local(${local})↔marketplace(${marketplace})`);
  }
  if (local && installed && local !== installed) {
    drift.push(`local(${local})↔installed(${installed})`);
  }
  if (marketplace && installed && marketplace !== installed) {
    drift.push(`marketplace(${marketplace})↔installed(${installed})`);
  }
  return drift;
}

async function checkVersionTriple(
  cwd: string,
  signal: AbortSignal,
  now: () => number,
  opts: VersionTripleOpts,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('npm_marketplace_version_drift');

  const localPath = join(cwd, 'mcp-server', 'package.json');
  const marketplacePath =
    opts.marketplaceManifestPath === null
      ? null
      : opts.marketplaceManifestPath ?? join(cwd, '.claude-plugin', 'plugin.json');
  const installedPath =
    opts.installedManifestPath === null
      ? null
      : opts.installedManifestPath ?? resolveInstalledPluginManifest();

  const local = readManifestVersion(localPath);
  const marketplace = marketplacePath ? readManifestVersion(marketplacePath) : null;
  const installed = installedPath ? readManifestVersion(installedPath) : null;

  // If we can't read the local manifest at all, the cwd isn't a flywheel
  // checkout — skip the comparison rather than synthesize a warning. Other
  // checks (dist_drift, mcp_connectivity) flag a broken repo.
  if (!local) {
    return {
      name: 'npm_marketplace_version_drift',
      severity: 'green',
      message: `version triple not applicable (no mcp-server/package.json under ${cwd})`,
      durationMs: now() - start,
    };
  }

  const drift = diffVersionTriple({ local, marketplace, installed });
  if (drift.length === 0) {
    const seen = [
      `local=${local}`,
      marketplace ? `marketplace=${marketplace}` : 'marketplace=missing',
      installed ? `installed=${installed}` : 'installed=missing',
    ].join(' ');
    return {
      name: 'npm_marketplace_version_drift',
      severity: 'green',
      message: `versions aligned (${seen})`,
      durationMs: now() - start,
    };
  }

  return {
    name: 'npm_marketplace_version_drift',
    severity: 'yellow',
    message: `manifest version drift: ${drift.join(', ')}`,
    hint: VERSION_DRIFT_HINT,
    durationMs: now() - start,
  };
}

