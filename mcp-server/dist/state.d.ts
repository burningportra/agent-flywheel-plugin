import { type FlywheelState } from './types.js';
export declare function loadState(cwd: string): FlywheelState;
export declare function saveState(cwd: string, state: FlywheelState): Promise<boolean>;
export declare function clearState(cwd: string): void;
export type FlywheelMemoryOperation = 'search' | 'store' | 'draft_postmortem' | 'draft_solution_doc' | 'refresh_learnings';
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
export declare function classifyMemoryOperation(op: string): FlywheelMemoryOperationDescriptor | null;
//# sourceMappingURL=state.d.ts.map