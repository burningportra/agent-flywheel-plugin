import { makeFlywheelErrorResult } from './errors.js';
import type { FlywheelToolName, FlywheelPhase } from './types.js';

const _inFlight = new Set<string>();

export function acquireBeadMutex(key: string): boolean {
  if (_inFlight.has(key)) return false;
  _inFlight.add(key);
  return true;
}

export function releaseBeadMutex(key: string): void {
  _inFlight.delete(key);
}

export function makeConcurrentWriteError(
  tool: FlywheelToolName,
  phase: FlywheelPhase,
  key: string,
) {
  return makeFlywheelErrorResult(tool, phase, {
    code: 'concurrent_write',
    message: `Another invocation is in-flight for ${key}. Retry after the current operation completes.`,
    retryable: true,
    hint: 'Another invocation is in-flight; retry in 250-1000ms.',
    details: { mutexKey: key },
  });
}

export function _resetForTest(): void {
  _inFlight.clear();
}
