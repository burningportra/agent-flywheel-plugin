import { readCheckpoint, writeCheckpoint, clearCheckpoint } from './checkpoint.js';
import { createInitialState, type OrchestratorState } from './types.js';
import { createLogger } from './logger.js';
import { VERSION } from './version.js';

const log = createLogger("state");

export function loadState(cwd: string): OrchestratorState {
  const result = readCheckpoint(cwd);
  if (result && result.envelope.state.phase !== 'idle' && result.envelope.state.phase !== 'complete') {
    for (const w of result.warnings) log.warn(w);
    return result.envelope.state;
  }
  return createInitialState();
}

export function saveState(cwd: string, state: OrchestratorState): Promise<void> {
  return writeCheckpoint(cwd, state, VERSION).then(() => undefined);
}

export function clearState(cwd: string): void {
  clearCheckpoint(cwd);
}
