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
//# sourceMappingURL=mutex.js.map