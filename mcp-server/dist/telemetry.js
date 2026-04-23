/**
 * Error-code telemetry aggregator (I7 — agent-flywheel-plugin-p55).
 *
 * - Module-level singleton Map: code → { count, ring buffer of recent entries }
 * - Re-entrancy guard via reentrancyDepth counter (prevents infinite recursion)
 * - Atomic spool writes (.tmp + rename) to .pi-flywheel/error-counts.json
 * - Dual-session merge via an O_EXCL .lock sentinel on the FINAL spool path,
 *   held across read→merge→rename so concurrent flushes serialize and counts
 *   sum correctly (v3.4.1 P1-3 fix from R1 release gate). Retries up to
 *   FLUSH_LOCK_MAX_ATTEMPTS times with FLUSH_LOCK_RETRY_MS backoff.
 * - Zod-validates before write; on failure, logs warn and skips write
 * - Never throws from recordErrorCode or flushTelemetry
 *
 * Memory-footprint bound (v3.4.1 P1-2 fix from R1 release gate):
 *   `maxEvents` is the GLOBAL ring-buffer cap across all codes, NOT per-code.
 *   `recordErrorCode` enforces the global cap by evicting oldest entries from
 *   the largest bucket once the global event count exceeds `maxEvents`.
 *   Worst-case in-memory footprint: maxEvents entries (~80 bytes each).
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
import { registerCliExecTelemetryHook } from './cli-exec.js';
import { ErrorCodeTelemetrySchema } from './types.js';
import { isFlywheelManagedPath } from './utils/fs-safety.js';
import { normalizeText } from './utils/text-normalize.js';
const log = createLogger('telemetry');
/** Module-level singleton aggregator */
const _aggregator = new Map();
/** Session start for this process instance */
let _sessionStartIso = new Date().toISOString();
/** Re-entrancy guard depth counter */
let _reentrancyDepth = 0;
// ─── Public: recordErrorCode ──────────────────────────────────
/**
 * Record an error code into the in-memory aggregator.
 * Fire-and-forget: never throws. No-op when called re-entrantly.
 *
 * Memory-footprint bound (v3.4.1 P1-2): after appending the new entry, this
 * function enforces a GLOBAL cap of `maxEvents` total ring entries across all
 * buckets (not per-bucket). When the global count exceeds the cap, the oldest
 * entries are evicted from the largest bucket. Counts (`bucket.count`) are
 * preserved — only the ring history is bounded.
 */
export function recordErrorCode(code, ctx, opts) {
    // Re-entrancy guard
    if (_reentrancyDepth > 0)
        return;
    _reentrancyDepth++;
    try {
        const maxEvents = opts?.maxEvents ?? 100;
        // Validate code is known (forward-compat: skip unknown codes on the write path)
        const parsed = FlywheelErrorCodeSchema.safeParse(code);
        if (!parsed.success)
            return;
        const ctxHash = ctx?.hashable != null
            ? createHash('sha256').update(ctx.hashable).digest('hex').slice(0, 8)
            : undefined;
        const entry = {
            code,
            ts: new Date().toISOString(),
            ...(ctxHash != null && { ctxHash }),
        };
        const bucket = _aggregator.get(code);
        if (bucket == null) {
            _aggregator.set(code, { count: 1, ring: [entry] });
        }
        else {
            bucket.count++;
            bucket.ring.push(entry);
        }
        // Global ring-buffer cap (P1-2): bound total events across all buckets.
        // Evict oldest entries from the largest bucket until under the cap.
        let totalEvents = 0;
        for (const b of _aggregator.values())
            totalEvents += b.ring.length;
        while (totalEvents > maxEvents) {
            let largest = null;
            for (const b of _aggregator.values()) {
                if (largest == null || b.ring.length > largest.ring.length)
                    largest = b;
            }
            // Defensive: if no bucket has entries, break (shouldn't happen since totalEvents > 0).
            if (largest == null || largest.ring.length === 0)
                break;
            largest.ring.shift();
            totalEvents--;
        }
        // Update session start if opts provides one
        if (opts?.sessionStartIso != null) {
            _sessionStartIso = opts.sessionStartIso;
        }
    }
    finally {
        _reentrancyDepth--;
    }
}
// ─── Internal helpers ─────────────────────────────────────────
function spoolDir(cwd) {
    return join(cwd, '.pi-flywheel');
}
function spoolPath(cwd) {
    return join(spoolDir(cwd), 'error-counts.json');
}
function tmpPath(cwd) {
    return join(spoolDir(cwd), `error-counts.${process.pid}.${Date.now()}.tmp`);
}
/**
 * Sidecar lock path co-located with the spool. v3.4.1 P1-3: held with O_EXCL
 * across read→merge→rename so two concurrent flushes serialize and counts sum
 * correctly. Stale-lock cleanup is conservative — we only unlink the lock at
 * the END of `withFlushLock` (whether success or failure inside the critical
 * section).
 */
function flushLockPath(cwd) {
    return join(spoolDir(cwd), 'error-counts.lock');
}
const FLUSH_LOCK_RETRY_MS = 25;
const FLUSH_LOCK_MAX_ATTEMPTS = 50; // ~1.25s total ceiling
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Acquire the cross-session flush lock and run `fn` while holding it.
 *
 * Implementation: `open(lockPath, 'wx')` (O_WRONLY | O_CREAT | O_EXCL) is the
 * sentinel — only one process at a time can create the lock file. Other
 * flushes retry with linear backoff. The lock is unlinked in `finally`,
 * including when `fn` throws.
 *
 * Returns the result of `fn`, or `null` if the lock could not be acquired
 * within `FLUSH_LOCK_MAX_ATTEMPTS`.
 */
async function withFlushLock(cwd, fn) {
    const lockPath = flushLockPath(cwd);
    if (!isFlywheelManagedPath(lockPath, cwd)) {
        log.warn('telemetry_store_failed: lock path outside .pi-flywheel allowlist', { lockPath, cwd });
        return null;
    }
    let fd;
    for (let attempt = 0; attempt < FLUSH_LOCK_MAX_ATTEMPTS; attempt++) {
        try {
            fd = await open(lockPath, 'wx'); // O_WRONLY | O_CREAT | O_EXCL
            break;
        }
        catch {
            fd = undefined;
            await sleep(FLUSH_LOCK_RETRY_MS);
        }
    }
    if (fd == null) {
        log.warn('telemetry_store_failed: could not acquire flush lock', {
            lockPath, attempts: FLUSH_LOCK_MAX_ATTEMPTS,
        });
        return null;
    }
    try {
        return await fn();
    }
    finally {
        try {
            await fd.close();
        }
        catch { /* ignore */ }
        try {
            await unlink(lockPath);
        }
        catch { /* ignore — already unlinked is fine */ }
    }
}
/** Build the current in-memory snapshot (bounded to maxCodes / maxEvents). */
function buildSnapshot(opts) {
    const maxCodes = opts.maxCodes ?? 20;
    const maxEvents = opts.maxEvents ?? 100;
    const sessionStartIso = opts.sessionStartIso ?? _sessionStartIso;
    // Sort by count desc, take top maxCodes
    const sorted = [..._aggregator.entries()].sort((a, b) => b[1].count - a[1].count);
    const topN = sorted.slice(0, maxCodes);
    const counts = {};
    const allEvents = [];
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
async function readExistingSpool(cwd) {
    try {
        const raw = await readFile(spoolPath(cwd), 'utf8');
        const parsed = ErrorCodeTelemetrySchema.safeParse(JSON.parse(normalizeText(raw)));
        if (!parsed.success)
            return null;
        return parsed.data;
    }
    catch {
        return null;
    }
}
/**
 * Merge the existing on-disk telemetry with our in-memory snapshot.
 * Counts are summed; ring events are interleaved by ts and truncated.
 */
function mergeSnapshots(existing, current, maxEvents) {
    // Merge counts (sum)
    const counts = { ...existing.counts };
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
async function atomicWriteExclusive(tmpFile, finalPath, content, cwd) {
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
    let fd;
    try {
        fd = await open(tmpFile, 'wx'); // wx = O_WRONLY | O_CREAT | O_EXCL
        await fd.writeFile(content, 'utf8');
        await fd.close();
        fd = undefined;
        await rename(tmpFile, finalPath);
        return true;
    }
    catch {
        if (fd != null) {
            try {
                await fd.close();
            }
            catch { /* ignore */ }
        }
        // Clean up the tmp file if it exists but rename failed
        try {
            await unlink(tmpFile);
        }
        catch { /* ignore */ }
        return false;
    }
}
// ─── Public: flushTelemetry ───────────────────────────────────
/**
 * Flush the in-memory aggregator to .pi-flywheel/error-counts.json.
 * Merges with existing spool (dual-session support).
 * Returns false on store failure (never throws).
 *
 * v3.4.1 P1-3: the read→merge→rename critical section is held under an
 * O_EXCL sentinel (`error-counts.lock`) on the FINAL spool path, so two
 * concurrent flushes serialize and counts sum correctly. The previous
 * implementation O_EXCL'd only the .tmp filename, which prevented two
 * processes from writing the same tmp simultaneously but did NOT prevent
 * two read-merge-rename cycles from racing and clobbering each other.
 */
export async function flushTelemetry(opts) {
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
        // Critical section under flush lock: read-existing → merge → rename.
        // Without this, two concurrent flushes both read the same baseline,
        // each compute their own merge, and the second rename clobbers the first.
        const result = await withFlushLock(opts.cwd, async () => {
            // Read existing spool and merge
            const existing = await readExistingSpool(opts.cwd);
            const merged = existing != null
                ? mergeSnapshots(existing, validated.data, maxEvents)
                : validated.data;
            // Apply maxCodes bound on merged result
            const topCodes = Object.entries(merged.counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, maxCodes);
            const boundedCounts = Object.fromEntries(topCodes);
            const boundedTelemetry = {
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
            // We hold the flush lock, so a single attempt is sufficient. The
            // remaining O_EXCL on the .tmp path is defence-in-depth against a
            // future refactor that drops the lock or runs concurrent flushes
            // within the same process (different test contexts, etc.).
            const wrote = await atomicWriteExclusive(tmp, spoolPath(opts.cwd), content, opts.cwd);
            if (!wrote) {
                log.warn('telemetry_store_failed: write failed under flush lock', {
                    cwd: opts.cwd,
                });
                return false;
            }
            return true;
        });
        // withFlushLock returns null when the lock could not be acquired.
        if (result === null)
            return false;
        return result;
    }
    catch (err) {
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
export async function readTelemetry(opts) {
    try {
        return await readExistingSpool(opts.cwd);
    }
    catch {
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
export function _resetTelemetryForTest() {
    _aggregator.clear();
    _sessionStartIso = new Date().toISOString();
    _reentrancyDepth = 0;
}
// ─── Self-registration with errors.ts hook ───────────────────
// Register the in-memory recorder so makeFlywheelErrorResult fires recordErrorCode.
// Safe: errors.ts does NOT import telemetry.ts, so no circular module graph.
registerTelemetryHook((code, ctx) => {
    const parsed = FlywheelErrorCodeSchema.safeParse(code);
    if (!parsed.success)
        return;
    recordErrorCode(parsed.data, ctx);
});
// ─── Self-registration with cli-exec.ts hook ─────────────────
// Register so resilientExec failure paths fire recordErrorCode.
// Safe: cli-exec.ts does NOT import telemetry.ts.
registerCliExecTelemetryHook((code) => {
    const parsed = FlywheelErrorCodeSchema.safeParse(code);
    if (!parsed.success)
        return;
    recordErrorCode(parsed.data);
});
//# sourceMappingURL=telemetry.js.map