import { createLogger } from './logger.js';
const log = createLogger('bv-runner');
/** Default per-call budget for `bv --robot-*` (ms). */
export const BV_ROBOT_TIMEOUT_MS = 5000;
export async function runBvRobot(exec, cwd, mode, opts = {}) {
    const flag = `--robot-${mode}`;
    const timeout = opts.timeout ?? BV_ROBOT_TIMEOUT_MS;
    const signal = opts.signal;
    if (signal?.aborted) {
        return { available: false, data: null, warning: `bv ${flag} skipped: aborted` };
    }
    let result;
    try {
        result = await exec('bv', [flag], { cwd, timeout, signal });
    }
    catch (err) {
        // Spawn failure (bv missing) or timeout — ExecFn rejects on both.
        log.warn(`bv ${flag} unavailable`, { err: String(err) });
        return { available: false, data: null, warning: `bv ${flag} unavailable: ${String(err)}` };
    }
    if (result.code !== 0) {
        log.warn(`bv ${flag} exited non-zero`, { code: result.code, stderr: result.stderr.slice(0, 200) });
        return {
            available: false,
            data: null,
            warning: `bv ${flag} exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`,
        };
    }
    try {
        return { available: true, data: JSON.parse(result.stdout), raw: result.stdout };
    }
    catch (err) {
        log.warn(`bv ${flag} output unparsable`, { err: String(err) });
        return { available: false, data: null, warning: `bv ${flag} output is not JSON` };
    }
}
//# sourceMappingURL=bv-runner.js.map