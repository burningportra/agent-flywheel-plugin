import { z } from 'zod';
import { readCheckpoint, writeCheckpoint, clearCheckpoint } from './checkpoint.js';
import { createInitialState } from './types.js';
import { createLogger } from './logger.js';
const log = createLogger("state");
// ─── flywheel_review Zod contract (bead agent-flywheel-plugin-f0j) ─────
//
// The runtime accepts reviewer dispatch in four "shapes" that each map to an
// existing human workflow. Keeping the Zod schema in state.ts (rather than
// types.ts, which holds raw TS interfaces) puts the canonical validator
// alongside the rest of the flywheel state contracts — the skill layer and
// the MCP server both import from here so drift is impossible.
//
// Modes:
//   - "interactive"  — default; AskUserQuestion per finding (current behavior)
//   - "autofix"      — reviewers emit diffs + commit (gated behind green
//                      doctor + clean git tree; falls back to interactive
//                      when the gate fails)
//   - "report-only"  — reviewers write docs/reviews/<date>.md and exit
//   - "headless"     — CI-friendly exit-code signal per error count
export const ReviewModeSchema = z.enum([
    'autofix',
    'report-only',
    'headless',
    'interactive',
]);
export const ReviewActionSchema = z.enum(['hit-me', 'looks-good', 'skip']);
export const ReviewArgsSchema = z.object({
    cwd: z.string().min(1),
    beadId: z.string().min(1),
    action: ReviewActionSchema,
    /** Review-mode matrix; defaults to "interactive" for backwards compatibility. */
    mode: ReviewModeSchema.optional().default('interactive'),
    /** Caller asserts reviewers will not race on the same files. Defaults to false. */
    parallelSafe: z.boolean().optional().default(false),
});
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