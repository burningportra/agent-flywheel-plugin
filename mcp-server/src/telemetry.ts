/**
 * Error-code telemetry aggregator (I7 — agent-flywheel-plugin-p55).
 *
 * - Module-level singleton Map: code → { count, ring buffer of last maxEvents entries }
 * - Re-entrancy guard via reentrancyDepth counter (prevents infinite recursion)
 * - Atomic spool writes (.tmp + rename) to .pi-flywheel/error-counts.json
 * - Dual-session merge via O_EXCL on the .tmp file (retry once after 50ms)
 * - Zod-validates before write; on failure, logs warn and skips write
 * - Never throws from recordErrorCode or flushTelemetry
 *
 * Self-registers with errors.ts via registerTelemetryHook and with cli-exec.ts
 * via registerCliExecTelemetryHook so that makeFlywheelErrorResult and
 * resilientExec automatically fire recordErrorCode. No circular dependency:
 * neither errors.ts nor cli-exec.ts imports this module.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { FlywheelErrorCodeSchema, registerTelemetryHook } from './errors.js';
import type { FlywheelErrorCode } from './errors.js';
import { registerCliExecTelemetryHook } from './cli-exec.js';
import { ErrorCodeTelemetrySchema } from './types.js';
import type { ErrorCodeTelemetry } from './types.js';
import { isFlywheelManagedPath } from './utils/fs-safety.js';

const log = createLogger('telemetry');

// ─── Public API types ─────────────────────────────────────────

export interface TelemetryOptions {
  /** Base directory; spool lives at <cwd>/.pi-flywheel/error-counts.json */
  cwd: string;
  /** Defaults to new Date().toISOString() */
  sessionStartIso?: string;
  /** Ring buffer size; default 100 */
  maxEvents?: number;
  /** Top-N tracking; default 20 */
  maxCodes?: number;
}

// ─── In-memory state ──────────────────────────────────────────

interface RingEntry {
  code: string;
  ts: string;
  ctxHash?: string;
}

interface CodeBucket {
  count: number;
  ring: RingEntry[];
}

/** Module-level singleton aggregator */
const _aggregator: Map<FlywheelErrorCode, CodeBucket> = new Map();

/** Session start for this process instance */
let _sessionStartIso: string = new Date().toISOString();

/** Re-entrancy guard depth counter */
let _reentrancyDepth = 0;

// ─── Public: recordErrorCode ──────────────────────────────────

/**
 * Record an error code into the in-memory aggregator.
 * Fire-and-forget: never throws. No-op when called re-entrantly.
 */
export function recordErrorCode(
  code: FlywheelErrorCode,
  ctx?: { hashable?: string },
  opts?: TelemetryOptions,
): void {
  // Re-entrancy guard
  if (_reentrancyDepth > 0) return;
  _reentrancyDepth++;
  try {
    const maxEvents = opts?.maxEvents ?? 100;

    // Validate code is known (forward-compat: skip unknown codes on the write path)
    const parsed = FlywheelErrorCodeSchema.safeParse(code);
    if (!parsed.success) return;

    const ctxHash = ctx?.hashable != null
      ? createHash('sha256').update(ctx.hashable).digest('hex').slice(0, 8)
      : undefined;

    const entry: RingEntry = {
      code,
      ts: new Date().toISOString(),
      ...(ctxHash != null && { ctxHash }),
    };

    const bucket = _aggregator.get(code);
    if (bucket == null) {
      _aggregator.set(code, { count: 1, ring: [entry] });
    } else {
      bucket.count++;
      bucket.ring.push(entry);
      if (bucket.ring.length > maxEvents) {
        bucket.ring = bucket.ring.slice(bucket.ring.length - maxEvents);
      }
    }

    // Update session start if opts provides one
    if (opts?.sessionStartIso != null) {
      _sessionStartIso = opts.sessionStartIso;
    }
  } finally {
    _reentrancyDepth--;
  }
}

// ─── Internal helpers ─────────────────────────────────────────

function spoolDir(cwd: string): string {
  return join(cwd, '.pi-flywheel');
}

function spoolPath(cwd: string): string {
  return join(spoolDir(cwd), 'error-counts.json');
}

function tmpPath(cwd: string): string {
  return join(spoolDir(cwd), `error-counts.${process.pid}.${Date.now()}.tmp`);
}

/** Build the current in-memory snapshot (bounded to maxCodes / maxEvents). */
function buildSnapshot(opts: TelemetryOptions): ErrorCodeTelemetry {
  const maxCodes = opts.maxCodes ?? 20;
  const maxEvents = opts.maxEvents ?? 100;
  const sessionStartIso = opts.sessionStartIso ?? _sessionStartIso;

  // Sort by count desc, take top maxCodes
  const sorted = [..._aggregator.entries()].sort((a, b) => b[1].count - a[1].count);
  const topN = sorted.slice(0, maxCodes);

  const counts: Record<string, number> = {};
  const allEvents: RingEntry[] = [];

  for (const [code, bucket] of topN) {
    counts[code] = bucket.count;
    allEvents.push(...bucket.ring);
  }

  // Sort events by ts, keep last maxEvents
  allEvents.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const recentEvents = allEvents.slice(-maxEvents).map((e) => ({
    code: e.code,
    ts: e.ts,
    ...(e.ctxHash != null && { ctxHash: e.ctxHash }),
  }));

  return {
    version: 1,
    sessionStartIso,
    counts,
    recentEvents,
  };
}

/**
 * Read and parse the existing spool file.
 * Returns null if missing or unparseable.
 */
async function readExistingSpool(cwd: string): Promise<ErrorCodeTelemetry | null> {
  try {
    const raw = await readFile(spoolPath(cwd), 'utf8');
    const parsed = ErrorCodeTelemetrySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Merge the existing on-disk telemetry with our in-memory snapshot.
 * Counts are summed; ring events are interleaved by ts and truncated.
 */
function mergeSnapshots(
  existing: ErrorCodeTelemetry,
  current: ErrorCodeTelemetry,
  maxEvents: number,
): ErrorCodeTelemetry {
  // Merge counts (sum)
  const counts: Record<string, number> = { ...existing.counts };
  for (const [code, cnt] of Object.entries(current.counts)) {
    counts[code] = (counts[code] ?? 0) + cnt;
  }

  // Interleave events by ts, keep last maxEvents
  const combined = [...existing.recentEvents, ...current.recentEvents];
  combined.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const recentEvents = combined.slice(-maxEvents);

  // Use the earlier sessionStartIso
  const sessionStartIso = existing.sessionStartIso < current.sessionStartIso
    ? existing.sessionStartIso
    : current.sessionStartIso;

  return {
    version: 1,
    sessionStartIso,
    counts,
    recentEvents,
  };
}

/**
 * Attempt an atomic write using O_EXCL to guard concurrent access.
 * Returns true on success, false on lock conflict.
 */
async function atomicWriteExclusive(tmpFile: string, finalPath: string, content: string, cwd: string): Promise<boolean> {
  // Defence-in-depth: refuse if either path escapes `.pi-flywheel/`. Both
  // paths are produced by spoolPath/tmpPath which hard-code the subdir,
  // but this guard catches future refactors that accidentally leak a
  // user-controlled value into either arg.
  if (!isFlywheelManagedPath(tmpFile, cwd) || !isFlywheelManagedPath(finalPath, cwd)) {
    log.warn('telemetry_store_failed: path outside .pi-flywheel allowlist', {
      tmpFile, finalPath, cwd,
    });
    return false;
  }
  let fd: import('node:fs/promises').FileHandle | undefined;
  try {
    fd = await open(tmpFile, 'wx'); // wx = O_WRONLY | O_CREAT | O_EXCL
    await fd.writeFile(content, 'utf8');
    await fd.close();
    fd = undefined;
    await rename(tmpFile, finalPath);
    return true;
  } catch {
    if (fd != null) {
      try { await fd.close(); } catch { /* ignore */ }
    }
    // Clean up the tmp file if it exists but rename failed
    try { await unlink(tmpFile); } catch { /* ignore */ }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public: flushTelemetry ───────────────────────────────────

/**
 * Flush the in-memory aggregator to .pi-flywheel/error-counts.json.
 * Merges with existing spool (dual-session support).
 * Returns false on store failure (never throws).
 */
export async function flushTelemetry(opts: TelemetryOptions): Promise<boolean> {
  const maxEvents = opts.maxEvents ?? 100;
  const maxCodes = opts.maxCodes ?? 20;

  try {
    // Ensure spool directory exists
    await mkdir(spoolDir(opts.cwd), { recursive: true });

    const current = buildSnapshot(opts);

    // Validate the shape before writing
    const validated = ErrorCodeTelemetrySchema.safeParse(current);
    if (!validated.success) {
      log.warn('telemetry_store_failed: snapshot failed Zod validation', {
        error: validated.error.message,
      });
      return false;
    }

    // Read existing spool and merge
    const existing = await readExistingSpool(opts.cwd);
    const merged = existing != null
      ? mergeSnapshots(existing, validated.data, maxEvents)
      : validated.data;

    // Apply maxCodes bound on merged result
    const topCodes = Object.entries(merged.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCodes);
    const boundedCounts: Record<string, number> = Object.fromEntries(topCodes);
    const boundedTelemetry: ErrorCodeTelemetry = {
      ...merged,
      counts: boundedCounts,
      recentEvents: merged.recentEvents.slice(-maxEvents),
    };

    // Final Zod validation before write
    const finalValidated = ErrorCodeTelemetrySchema.safeParse(boundedTelemetry);
    if (!finalValidated.success) {
      log.warn('telemetry_store_failed: merged snapshot failed Zod validation', {
        error: finalValidated.error.message,
      });
      return false;
    }

    const content = JSON.stringify(finalValidated.data, null, 2);
    const tmp = tmpPath(opts.cwd);

    // First attempt
    let wrote = await atomicWriteExclusive(tmp, spoolPath(opts.cwd), content, opts.cwd);
    if (!wrote) {
      // Retry once after 50ms
      await sleep(50);
      const tmp2 = tmpPath(opts.cwd);
      wrote = await atomicWriteExclusive(tmp2, spoolPath(opts.cwd), content, opts.cwd);
      if (!wrote) {
        log.warn('telemetry_store_failed: concurrent write conflict after retry', {
          cwd: opts.cwd,
        });
        return false;
      }
    }

    return true;
  } catch (err) {
    log.warn('telemetry_store_failed: unexpected error during flush', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ─── Public: readTelemetry ────────────────────────────────────

/**
 * Read the current spool from disk.
 * Returns null if file is absent or unparseable.
 * Tolerates unknown codes (forward-compat contract).
 */
export async function readTelemetry(opts: TelemetryOptions): Promise<ErrorCodeTelemetry | null> {
  try {
    return await readExistingSpool(opts.cwd);
  } catch {
    return null;
  }
}

// ─── Internal: reset for tests ────────────────────────────────

/**
 * Reset the module-level aggregator and session start.
 * Exported for test use only — do not call from production code.
 *
 * @internal
 */
export function _resetTelemetryForTest(): void {
  _aggregator.clear();
  _sessionStartIso = new Date().toISOString();
  _reentrancyDepth = 0;
}

// ─── Self-registration with errors.ts hook ───────────────────
// Register the in-memory recorder so makeFlywheelErrorResult fires recordErrorCode.
// Safe: errors.ts does NOT import telemetry.ts, so no circular module graph.
registerTelemetryHook((code, ctx) => {
  const parsed = FlywheelErrorCodeSchema.safeParse(code);
  if (!parsed.success) return;
  recordErrorCode(parsed.data, ctx);
});

// ─── Self-registration with cli-exec.ts hook ─────────────────
// Register so resilientExec failure paths fire recordErrorCode.
// Safe: cli-exec.ts does NOT import telemetry.ts.
registerCliExecTelemetryHook((code) => {
  const parsed = FlywheelErrorCodeSchema.safeParse(code);
  if (!parsed.success) return;
  recordErrorCode(parsed.data);
});
