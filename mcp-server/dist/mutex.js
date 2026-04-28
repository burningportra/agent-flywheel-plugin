import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeFlywheelErrorResult } from './errors.js';
const _inFlight = new Set();
export function acquireBeadMutex(key) {
    if (_inFlight.has(key))
        return false;
    _inFlight.add(key);
    return true;
}
export function releaseBeadMutex(key) {
    _inFlight.delete(key);
}
export function makeConcurrentWriteError(tool, phase, key) {
    return makeFlywheelErrorResult(tool, phase, {
        code: 'concurrent_write',
        message: `Another invocation is in-flight for ${key}. Retry after the current operation completes.`,
        retryable: true,
        hint: 'Another invocation is in-flight; retry in 250-1000ms.',
        details: { mutexKey: key },
    });
}
export function _resetForTest() {
    _inFlight.clear();
}
/**
 * File-lock-aware mutex for `flywheel_remediate`. Uses both an in-process Set
 * and an exclusive `.pi-flywheel/remediate.lock` file (atomic O_EXCL create).
 * Returns the absolute lock-file path on success, or null on contention.
 */
export async function acquireRemediateLock(cwd, checkName) {
    const memKey = `remediate:${checkName}`;
    if (!acquireBeadMutex(memKey))
        return null;
    const lockPath = join(cwd, '.pi-flywheel', 'remediate.lock');
    try {
        await mkdir(dirname(lockPath), { recursive: true });
        // wx flag = O_EXCL | O_CREAT; throws EEXIST if file exists.
        await writeFile(lockPath, JSON.stringify({ checkName, pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' });
        return lockPath;
    }
    catch (err) {
        releaseBeadMutex(memKey);
        if (err?.code === 'EEXIST')
            return null;
        throw err;
    }
}
export async function releaseRemediateLock(checkName, lockPath) {
    releaseBeadMutex(`remediate:${checkName}`);
    if (lockPath == null)
        return;
    try {
        await unlink(lockPath);
    }
    catch { /* best-effort cleanup */ }
}
//# sourceMappingURL=mutex.js.map