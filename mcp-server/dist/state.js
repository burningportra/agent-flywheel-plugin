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
    const ok = await writeCheckpoint(cwd, state);
    if (!ok) {
        log.warn('saveState failed — checkpoint not persisted', {
            code: 'partial_state',
            phase: state.phase,
            cwd,
        });
    }
    return ok;
}
export function clearState(cwd) {
    clearCheckpoint(cwd);
}
/**
 * Classify a flywheel_memory operation. Returns null for unknown strings —
 * callers should treat null as `invalid_input` and surface the hint.
 *
 * NOTE: This is a pure lookup; do not perform side effects here. The actual
 * dispatch (calling `draftPostmortem`, `cm add`, etc.) lives in
 * `src/tools/memory-tool.ts`. This function exists so state.ts can act as
 * the single source of truth for *which* operations exist, leaving
 * `runMemory` to decide *how* each is executed.
 */
export function classifyMemoryOperation(op) {
    switch (op) {
        case 'search':
            return {
                name: 'search',
                mutates: false,
                requiresCmCli: true,
                summary: 'Find prior CASS entries by query (or list when query absent).',
            };
        case 'store':
            return {
                name: 'store',
                mutates: true,
                requiresCmCli: true,
                summary: 'Persist a new CASS entry — returns the new entry id.',
            };
        case 'draft_postmortem':
            return {
                name: 'draft_postmortem',
                mutates: false,
                requiresCmCli: false,
                summary: 'Synthesise a read-only post-mortem from git + agent-mail.',
            };
        case 'draft_solution_doc':
            return {
                name: 'draft_solution_doc',
                mutates: false,
                requiresCmCli: false,
                summary: 'Synthesise a docs/solutions/ markdown entry paired with a CASS entry_id (read-only — caller writes the file).',
            };
        case 'refresh_learnings':
            // Bead `bve`: compound-engineering refresh sweep — pure read of
            // docs/solutions/*.md → 5-vector overlap scorer → Keep / Update /
            // Consolidate / Replace / Delete decisions. Read-only at this layer
            // (the skill owns archival). Does NOT touch CASS, so cm CLI is not
            // required. See `src/refresh-learnings.ts` for the algorithm.
            return {
                name: 'refresh_learnings',
                mutates: false,
                requiresCmCli: false,
                summary: 'Sweep docs/solutions/ and classify entries Keep / Update / Consolidate / Replace / Delete (caller archives — never auto-deletes).',
            };
        default:
            return null;
    }
}
//# sourceMappingURL=state.js.map