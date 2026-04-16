import { readCheckpoint, writeCheckpoint, clearCheckpoint } from './checkpoint.js';
import { createInitialState } from './types.js';
import { createLogger } from './logger.js';
const log = createLogger("state");
export function loadState(cwd) {
    const result = readCheckpoint(cwd);
    if (result && result.envelope.state.phase !== 'idle' && result.envelope.state.phase !== 'complete') {
        for (const w of result.warnings)
            log.warn(w);
        return result.envelope.state;
    }
    return createInitialState();
}
export async function saveState(cwd, state) {
    await writeCheckpoint(cwd, state);
}
export function clearState(cwd) {
    clearCheckpoint(cwd);
}
//# sourceMappingURL=state.js.map