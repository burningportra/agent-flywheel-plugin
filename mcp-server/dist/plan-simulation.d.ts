/**
 * Plan Execution Path Simulation
 *
 * Extends existing bead validation (cycle detection, orphan detection in beads.ts)
 * with execution ordering, parallel group computation, file conflict detection,
 * and missing file validation.
 */
import type { Bead } from './types.js';
export interface SimulatedBead {
    id: string;
    title: string;
    deps: string[];
    files: string[];
}
export interface FileConflict {
    file: string;
    beadIds: string[];
}
export interface MissingFileRef {
    beadId: string;
    file: string;
}
export interface SimulationResult {
    valid: boolean;
    executionOrder: string[];
    parallelGroups: string[][];
    fileConflicts: FileConflict[];
    missingFiles: MissingFileRef[];
    warnings: string[];
}
/**
 * Convert Bead[] to SimulatedBead[] using extractArtifacts for file paths.
 *
 * `depMap` maps bead ID → array of dependency IDs (beads this bead depends on).
 * Dependencies are passed separately because the br CLI's JSON output does not
 * embed dependency edges — they come from `br dep list`.
 */
export declare function beadsToSimulated(beads: Bead[], depMap: Map<string, string[]>): SimulatedBead[];
/**
 * Compute a valid execution order via Kahn's algorithm.
 * Returns ordered IDs (dependencies first).
 * Throws if cycles exist — caller should run cycle detection first.
 */
export declare function computeExecutionOrder(beads: SimulatedBead[]): string[];
/**
 * Assign beads to execution levels by longest dependency chain depth.
 * Beads at the same level can execute in parallel.
 * Returns arrays of bead IDs grouped by level (level 0 first).
 */
export declare function computeParallelGroups(beads: SimulatedBead[]): string[][];
/**
 * Detect file conflicts between beads in the SAME parallel group.
 * Sequential beads sharing files is fine — only parallel ones conflict.
 */
export declare function detectFileConflicts(beads: SimulatedBead[], parallelGroups: string[][]): FileConflict[];
/**
 * Check that files referenced by beads exist in the repo.
 *
 * NOTE: Beads that *create* new files will appear as missing here.
 * Callers should treat results as warnings for new-file beads, not errors.
 */
export declare function detectMissingFiles(beads: SimulatedBead[], repoFiles: Set<string>): MissingFileRef[];
/**
 * Run all simulation checks and return a consolidated result.
 */
export declare function simulateExecutionPaths(beads: SimulatedBead[], repoFiles: Set<string>): SimulationResult;
/**
 * Format a SimulationResult as a human-readable markdown report.
 */
export declare function formatSimulationReport(result: SimulationResult): string;
//# sourceMappingURL=plan-simulation.d.ts.map