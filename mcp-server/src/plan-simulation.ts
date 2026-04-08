/**
 * Plan Execution Path Simulation
 *
 * Extends existing bead validation (cycle detection, orphan detection in beads.ts)
 * with execution ordering, parallel group computation, file conflict detection,
 * and missing file validation.
 */

import type { Bead } from './types.js';
import { extractArtifacts } from './beads.js';

// ─── Types (kept local to this module) ─────────────────────────

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

// ─── Conversion ────────────────────────────────────────────────

/**
 * Convert Bead[] to SimulatedBead[] using extractArtifacts for file paths.
 *
 * `depMap` maps bead ID → array of dependency IDs (beads this bead depends on).
 * Dependencies are passed separately because the br CLI's JSON output does not
 * embed dependency edges — they come from `br dep list`.
 */
export function beadsToSimulated(
  beads: Bead[],
  depMap: Map<string, string[]>,
): SimulatedBead[] {
  return beads.map((b) => ({
    id: b.id,
    title: b.title,
    deps: depMap.get(b.id) ?? [],
    files: extractArtifacts(b),
  }));
}

// ─── Topological Sort (Kahn's Algorithm) ───────────────────────

/**
 * Compute a valid execution order via Kahn's algorithm.
 * Returns ordered IDs (dependencies first).
 * Throws if cycles exist — caller should run cycle detection first.
 */
export function computeExecutionOrder(beads: SimulatedBead[]): string[] {
  if (beads.length === 0) return [];

  const idSet = new Set(beads.map((b) => b.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // dep → dependents

  for (const b of beads) {
    inDegree.set(b.id, 0);
    adjacency.set(b.id, []);
  }

  for (const b of beads) {
    for (const dep of b.deps) {
      if (!idSet.has(dep)) continue; // skip external deps
      inDegree.set(b.id, (inDegree.get(b.id) ?? 0) + 1);
      adjacency.get(dep)!.push(b.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dependent of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (order.length !== beads.length) {
    const ordered = new Set(order);
    const remaining = beads
      .filter((b) => !ordered.has(b.id))
      .map((b) => b.id);
    throw new Error(
      `Cycle detected — ${remaining.length} bead(s) could not be ordered: ${remaining.join(", ")}`,
    );
  }

  return order;
}

// ─── Parallel Groups ───────────────────────────────────────────

/**
 * Assign beads to execution levels by longest dependency chain depth.
 * Beads at the same level can execute in parallel.
 * Returns arrays of bead IDs grouped by level (level 0 first).
 */
export function computeParallelGroups(beads: SimulatedBead[]): string[][] {
  if (beads.length === 0) return [];

  const idSet = new Set(beads.map((b) => b.id));
  const beadMap = new Map(beads.map((b) => [b.id, b]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>(); // cycle guard

  function getLevel(id: string): number {
    if (levels.has(id)) return levels.get(id)!;

    const bead = beadMap.get(id);
    if (!bead || bead.deps.length === 0) {
      levels.set(id, 0);
      return 0;
    }

    if (visiting.has(id)) {
      // Break cycle — treat as root to avoid infinite recursion.
      // Caller should run cycle detection first; this is a safety net.
      levels.set(id, 0);
      return 0;
    }
    visiting.add(id);

    let maxDepLevel = -1;
    for (const dep of bead.deps) {
      if (!idSet.has(dep)) continue;
      maxDepLevel = Math.max(maxDepLevel, getLevel(dep));
    }

    visiting.delete(id);
    const level = maxDepLevel + 1;
    levels.set(id, level);
    return level;
  }

  for (const b of beads) {
    getLevel(b.id);
  }

  const maxLevel = Math.max(...levels.values());
  const groups: string[][] = Array.from({ length: maxLevel + 1 }, () => []);

  for (const [id, level] of levels) {
    groups[level].push(id);
  }

  return groups;
}

// ─── File Conflict Detection ───────────────────────────────────

/**
 * Detect file conflicts between beads in the SAME parallel group.
 * Sequential beads sharing files is fine — only parallel ones conflict.
 */
export function detectFileConflicts(
  beads: SimulatedBead[],
  parallelGroups: string[][],
): FileConflict[] {
  const beadMap = new Map(beads.map((b) => [b.id, b]));
  const conflicts: FileConflict[] = [];

  for (const group of parallelGroups) {
    if (group.length < 2) continue;

    // Map file → bead IDs that touch it within this group
    const fileToBeads = new Map<string, string[]>();

    for (const id of group) {
      const bead = beadMap.get(id);
      if (!bead) continue;
      for (const file of bead.files) {
        const existing = fileToBeads.get(file) ?? [];
        existing.push(id);
        fileToBeads.set(file, existing);
      }
    }

    for (const [file, ids] of fileToBeads) {
      if (ids.length > 1) {
        conflicts.push({ file, beadIds: ids });
      }
    }
  }

  return conflicts;
}

// ─── Missing File Detection ────────────────────────────────────

/**
 * Check that files referenced by beads exist in the repo.
 *
 * NOTE: Beads that *create* new files will appear as missing here.
 * Callers should treat results as warnings for new-file beads, not errors.
 */
export function detectMissingFiles(
  beads: SimulatedBead[],
  repoFiles: Set<string>,
): MissingFileRef[] {
  const missing: MissingFileRef[] = [];

  for (const bead of beads) {
    for (const file of bead.files) {
      if (!repoFiles.has(file)) {
        missing.push({ beadId: bead.id, file });
      }
    }
  }

  return missing;
}

// ─── Orchestrator ──────────────────────────────────────────────

/**
 * Run all simulation checks and return a consolidated result.
 */
export function simulateExecutionPaths(
  beads: SimulatedBead[],
  repoFiles: Set<string>,
): SimulationResult {
  const warnings: string[] = [];

  // Execution order (may throw on cycles)
  let executionOrder: string[];
  try {
    executionOrder = computeExecutionOrder(beads);
  } catch (err) {
    return {
      valid: false,
      executionOrder: [],
      parallelGroups: [],
      fileConflicts: [],
      missingFiles: [],
      warnings: [
        err instanceof Error ? err.message : "Cycle detected in bead dependencies",
      ],
    };
  }

  const parallelGroups = computeParallelGroups(beads);
  const fileConflicts = detectFileConflicts(beads, parallelGroups);
  const missingFiles = detectMissingFiles(beads, repoFiles);

  if (fileConflicts.length > 0) {
    warnings.push(
      `${fileConflicts.length} file conflict(s) between parallel beads`,
    );
  }
  if (missingFiles.length > 0) {
    warnings.push(
      `${missingFiles.length} file reference(s) to non-existent files`,
    );
  }

  const valid = fileConflicts.length === 0 && missingFiles.length === 0;

  return {
    valid,
    executionOrder,
    parallelGroups,
    fileConflicts,
    missingFiles,
    warnings,
  };
}

// ─── Report Formatting ─────────────────────────────────────────

/**
 * Format a SimulationResult as a human-readable markdown report.
 */
export function formatSimulationReport(result: SimulationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✅ **Simulation passed** — no structural issues detected.");
  } else {
    lines.push("⚠️ **Simulation found issues:**");
  }

  if (result.warnings.length > 0) {
    lines.push("");
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
  }

  if (result.fileConflicts.length > 0) {
    lines.push("");
    lines.push("### File Conflicts");
    lines.push(
      "These files are modified by multiple beads in the same parallel group:",
    );
    for (const c of result.fileConflicts) {
      lines.push(`- \`${c.file}\` — beads: ${c.beadIds.join(", ")}`);
    }
    lines.push(
      "\n*Fix: add a dependency edge between conflicting beads, or split them so files don't overlap.*",
    );
  }

  if (result.missingFiles.length > 0) {
    lines.push("");
    lines.push("### Missing Files");
    lines.push("These bead-referenced files were not found in the repo (may be new files to create):");
    for (const m of result.missingFiles) {
      lines.push(`- \`${m.file}\` (bead ${m.beadId})`);
    }
    lines.push(
      "\n*Fix: if a file is genuinely missing, update the path. If the bead creates a new file, this is expected.*",
    );
  }

  if (result.parallelGroups.length > 0) {
    lines.push("");
    lines.push("### Execution Plan");
    for (let i = 0; i < result.parallelGroups.length; i++) {
      const group = result.parallelGroups[i];
      lines.push(
        `- **Level ${i}** (${group.length} bead${group.length !== 1 ? "s" : ""}): ${group.join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}
