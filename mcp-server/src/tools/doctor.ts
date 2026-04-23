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

import { existsSync, statSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { makeExec, type ExecFn } from '../exec.js';
import { readCheckpoint } from '../checkpoint.js';
import { createLogger } from '../logger.js';
import {
  detectCliCapabilities,
  describeCapabilities,
  type CapabilitiesMap,
  type ModelProvider,
} from '../adapters/model-diversity.js';
import type {
  DoctorCheck,
  DoctorCheckSeverity,
  DoctorReport,
} from '../types.js';

const log = createLogger('doctor');

// ─── Constants ────────────────────────────────────────────────────────────

/** Per-check exec timeout (ms). */
const PER_CHECK_TIMEOUT_MS = 2000;
/** Global sweep budget (ms). */
const TOTAL_SWEEP_BUDGET_MS = 10_000;
/** Max concurrent child processes. */
const MAX_CONCURRENCY = 6;

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
] as const;

export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];

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
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          name: DOCTOR_CHECK_NAMES[idx]!,
          severity: 'red' as DoctorCheckSeverity,
          message: 'check threw unexpectedly',
          hint: 'doctor_check_failed',
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
      hint: 'doctor_check_failed',
      durationMs: elapsedMs,
    };
  });

  const externallyAborted = signal?.aborted === true;
  const budgetExceeded =
    combined.aborted && !externallyAborted && elapsedMs >= totalBudgetMs;
  const partial = externallyAborted || budgetExceeded;

  return {
    version: 1,
    cwd,
    overall: computeOverallSeverity(checks),
    partial,
    checks,
    elapsedMs,
    timestamp,
  };
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
    hint: 'doctor_partial_report',
    durationMs: 0,
  };
}

/**
 * 1. MCP connectivity.
 *
 * Calling `flywheel_profile` directly from inside this module would create a
 * circular import (server → doctor → profile → server types). Instead we
 * check that the compiled `dist/server.js` exists and is at least as fresh as
 * the source. This is a structural proxy, not a true round-trip.
 */
async function checkMcpConnectivity(
  cwd: string,
  signal: AbortSignal,
  now: () => number,
): Promise<DoctorCheck> {
  const start = now();
  if (signal.aborted) return abortedCheck('mcp_connectivity');

  const distServer = join(cwd, 'mcp-server', 'dist', 'server.js');
  const srcServer = join(cwd, 'mcp-server', 'src', 'server.ts');

  try {
    if (!existsSync(distServer)) {
      return {
        name: 'mcp_connectivity',
        severity: 'red',
        message: 'mcp-server/dist/server.js not found — run `npm run build`',
        hint: 'doctor_check_failed',
        durationMs: now() - start,
      };
    }
    if (existsSync(srcServer)) {
      const distMtime = statSync(distServer).mtimeMs;
      const srcMtime = statSync(srcServer).mtimeMs;
      if (srcMtime > distMtime) {
        return {
          name: 'mcp_connectivity',
          severity: 'yellow',
          message: 'server.ts newer than dist/server.js — rebuild recommended',
          hint: 'doctor_check_failed',
          durationMs: now() - start,
        };
      }
    }
    return {
      name: 'mcp_connectivity',
      severity: 'green',
      message: 'mcp-server build artefacts present and current',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'mcp_connectivity',
      severity: 'red',
      message: `mcp connectivity probe failed: ${errMsg(err)}`,
      hint: 'doctor_check_failed',
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
        hint: 'agent_mail_unreachable',
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
      hint: 'agent_mail_unreachable',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'agent_mail_liveness',
      severity: 'red',
      message: `Agent Mail liveness probe error: ${errMsg(err)}`,
      hint: 'agent_mail_unreachable',
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
    // Non-zero but not ENOENT — binary exists but --version failed.
    return {
      name: checkName,
      severity: 'yellow',
      message: `${binary} --version returned code ${res.code}`,
      hint: 'cli_failure',
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
        hint: 'exec_timeout',
        durationMs: now() - start,
      };
    }
    if (isEnoent) {
      return {
        name: checkName,
        severity: opts.requiredSeverity,
        message: `${binary} not installed`,
        hint: 'cli_not_available',
        durationMs: now() - start,
      };
    }
    return {
      name: checkName,
      severity: opts.requiredSeverity,
      message: `${binary} probe failed: ${msg}`,
      hint: 'cli_failure',
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
        hint: 'cli_failure',
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
      hint: 'cli_not_available',
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
        hint: 'cli_failure',
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
        hint: 'cli_failure',
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
      hint: 'cli_failure',
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
    const srcDir = join(cwd, 'mcp-server', 'src');
    const distDir = join(cwd, 'mcp-server', 'dist');
    if (!existsSync(srcDir)) {
      return {
        name: 'dist_drift',
        severity: 'green',
        message: 'no mcp-server/src/ — skipping dist drift check',
        durationMs: now() - start,
      };
    }
    if (!existsSync(distDir)) {
      return {
        name: 'dist_drift',
        severity: 'red',
        message: 'mcp-server/dist/ missing — run `npm run build`',
        hint: 'doctor_check_failed',
        durationMs: now() - start,
      };
    }
    const srcMax = newestMtime(srcDir, (n) => n.endsWith('.ts'));
    const distMax = newestMtime(distDir);
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
        hint: 'doctor_check_failed',
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
      hint: 'doctor_check_failed',
      durationMs: now() - start,
    };
  }
}

/** 10. Orphaned worktrees under .claude/worktrees/. */
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
    const dir = join(cwd, '.claude', 'worktrees');
    if (!existsSync(dir)) {
      return {
        name: 'orphaned_worktrees',
        severity: 'green',
        message: 'no .claude/worktrees/ directory',
        durationMs: now() - start,
      };
    }
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    if (entries.length === 0) {
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
        hint: 'cli_failure',
        durationMs: now() - start,
      };
    }
    const registered = new Set<string>();
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const path = line.slice('worktree '.length).trim();
        const name = path.split('/').pop();
        if (name) registered.add(name);
      }
    }
    const orphans = entries.filter((name) => !registered.has(name));
    if (orphans.length === 0) {
      return {
        name: 'orphaned_worktrees',
        severity: 'green',
        message: `${entries.length} worktree${entries.length === 1 ? '' : 's'} all registered`,
        durationMs: now() - start,
      };
    }
    return {
      name: 'orphaned_worktrees',
      severity: 'yellow',
      message: `${orphans.length} orphaned worktree dir${orphans.length === 1 ? '' : 's'}: ${orphans.join(', ')}`,
      hint: 'cli_failure',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'orphaned_worktrees',
      severity: 'yellow',
      message: `worktree probe failed: ${errMsg(err)}`,
      hint: 'cli_failure',
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
    const ckptPath = join(cwd, '.pi-flywheel', 'checkpoint.json');
    if (!existsSync(ckptPath)) {
      return {
        name: 'checkpoint_validity',
        severity: 'green',
        message: 'no checkpoint — nothing to validate',
        durationMs: now() - start,
      };
    }
    const res = readCheckpoint(cwd);
    if (res === null) {
      return {
        name: 'checkpoint_validity',
        severity: 'yellow',
        message: 'checkpoint present but unreadable (corrupt or schema mismatch)',
        hint: 'postmortem_checkpoint_stale',
        durationMs: now() - start,
      };
    }
    if (res.warnings.length > 0) {
      return {
        name: 'checkpoint_validity',
        severity: 'yellow',
        message: `checkpoint loaded with warnings: ${res.warnings.join('; ')}`,
        hint: 'postmortem_checkpoint_stale',
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
      hint: 'postmortem_checkpoint_stale',
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
      hint: 'cli_not_available',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: checkName,
      severity: 'yellow',
      message: `${provider} cli probe failed: ${errMsg(err)}`,
      hint: 'cli_failure',
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
        hint: 'cli_not_available',
        durationMs: now() - start,
      };
    }
    return {
      name: 'swarm_model_ratio',
      severity: 'yellow',
      message: description,
      hint: 'cli_not_available',
      durationMs: now() - start,
    };
  } catch (err) {
    return {
      name: 'swarm_model_ratio',
      severity: 'yellow',
      message: `swarm ratio probe failed: ${errMsg(err)}`,
      hint: 'cli_failure',
      durationMs: now() - start,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walk a directory and return the newest mtime (ms) across matching files.
 * Skips node_modules, .git, and dot-directories.
 * Returns null if nothing matched.
 */
function newestMtime(
  root: string,
  filter: (name: string) => boolean = () => true,
): number | null {
  let max: number | null = null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile() && filter(e.name)) {
        try {
          const m = statSync(full).mtimeMs;
          if (max === null || m > max) max = m;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return max;
}
