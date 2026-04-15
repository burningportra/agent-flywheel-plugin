import { readCheckpoint, writeCheckpoint, clearCheckpoint } from './checkpoint.js';
import { createInitialState, type FlywheelState } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger("state");

export function loadState(cwd: string): FlywheelState {
  const result = readCheckpoint(cwd);
  if (result && result.envelope.state.phase !== 'idle' && result.envelope.state.phase !== 'complete') {
    for (const w of result.warnings) log.warn(w);
    return result.envelope.state;
  }
  return createInitialState();
}

export async function saveState(cwd: string, state: FlywheelState): Promise<void> {
  await writeCheckpoint(cwd, state);
}

export function clearState(cwd: string): void {
  clearCheckpoint(cwd);
}
