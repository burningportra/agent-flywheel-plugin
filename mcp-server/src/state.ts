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

export async function saveState(cwd: string, state: FlywheelState): Promise<boolean> {
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

export function clearState(cwd: string): void {
  clearCheckpoint(cwd);
}

// ─── flywheel_memory operation classifier ──────────────────────
//
// The runtime dispatcher for `flywheel_memory` lives in
// `src/tools/memory-tool.ts`. This helper is the *contract surface* that
// state.ts re-exports so future maintainers can:
//
//   1. discover the canonical operation set without grepping through tool
//      handlers, and
//   2. expand the switch in one place when new operations land.
//
// Bead 71x added "draft_solution_doc". Parallel bead `bve` will land
// "refresh_learnings" (compound-engineering sweep) — its case is stubbed
// here as a clean expansion point so neither bead has to touch the
// classifier shape.
//
// Keep the strings here in lockstep with `MemoryArgs.operation` in
// `types.ts` and the `enum` in `server.ts`.

export type FlywheelMemoryOperation =
  | 'search'
  | 'store'
  | 'draft_postmortem'
  | 'draft_solution_doc'
  // | 'refresh_learnings'  // reserved for bead `bve` — uncomment when ready
  ;

export interface FlywheelMemoryOperationDescriptor {
  /** Canonical name. */
  name: FlywheelMemoryOperation;
  /** Whether this op writes to CASS / disk. False for read-only/draft ops. */
  mutates: boolean;
  /** Whether this op needs the cm CLI to be installed. */
  requiresCmCli: boolean;
  /** Short human-readable summary surfaced in error hints. */
  summary: string;
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
export function classifyMemoryOperation(
  op: string,
): FlywheelMemoryOperationDescriptor | null {
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
        summary:
          'Synthesise a docs/solutions/ markdown entry paired with a CASS entry_id (read-only — caller writes the file).',
      };
    // case 'refresh_learnings':
    //   return { ... };  // bead `bve` slot — keep this stub.
    default:
      return null;
  }
}
