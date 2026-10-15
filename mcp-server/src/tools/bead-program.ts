import { createHash } from 'node:crypto';

import type { Bead, BeadProgramScope } from '../types.js';

export const FLYWHEEL_GOAL_LABEL_PREFIX = 'flywheel-goal:';

export interface ResolvedBeadProgram {
  scope: Extract<BeadProgramScope, { kind: 'tagged' | 'legacy' }>;
  beads: Bead[];
  warnings: string[];
}

export function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plan';
}

export function goalBeadProgramLabel(goal: string): string {
  const normalizedGoal = goal.trim();
  const hash = createHash('sha256').update(normalizedGoal).digest('hex').slice(0, 8);
  return `${FLYWHEEL_GOAL_LABEL_PREFIX}${slugifyGoal(normalizedGoal)}:${hash}`;
}

export function beadHasProgramLabel(bead: Bead, label: string): boolean {
  return bead.labels?.includes(label) ?? false;
}

export function isFlywheelGoalLabel(label: string): boolean {
  return label.startsWith(FLYWHEEL_GOAL_LABEL_PREFIX);
}

function hasAnyFlywheelGoalLabel(beads: readonly Bead[]): boolean {
  return beads.some((bead) => bead.labels?.some(isFlywheelGoalLabel) ?? false);
}

function activeBeads(beads: readonly Bead[]): Bead[] {
  return beads.filter((bead) => bead.status === 'open' || bead.status === 'in_progress');
}

export function resolveBeadProgram(
  allBeads: readonly Bead[],
  expectedLabel: string,
): ResolvedBeadProgram {
  if (!hasAnyFlywheelGoalLabel(allBeads)) {
    const beads = activeBeads(allBeads);
    return {
      scope: { kind: 'legacy', label: expectedLabel },
      beads,
      warnings: [
        `No ${FLYWHEEL_GOAL_LABEL_PREFIX} labels exist; using legacy repository-wide scope for ${beads.length} active bead(s). Ownership across goals cannot be verified. Expected label: ${expectedLabel}.`,
      ],
    };
  }

  const beads = activeBeads(allBeads).filter((bead) =>
    beadHasProgramLabel(bead, expectedLabel),
  );
  const untagged = activeBeads(allBeads).filter((bead) =>
    !(bead.labels?.some(isFlywheelGoalLabel) ?? false),
  );
  const warnings: string[] = [];

  if (beads.length === 0) {
    warnings.push(
      `No active beads match ${expectedLabel}; repository-wide fallback is disabled because other goal-program labels exist.`,
    );
  }
  if (untagged.length > 0) {
    warnings.push(
      `Excluded ${untagged.length} untagged active bead(s) from ${expectedLabel}: ${untagged.map((bead) => bead.id).join(', ')}.`,
    );
  }

  return {
    scope: { kind: 'tagged', label: expectedLabel },
    beads,
    warnings,
  };
}

export function filterBeadsForProgram(
  beads: readonly Bead[],
  scope: BeadProgramScope | undefined,
): { beads: Bead[]; warnings: string[] } {
  if (!scope || scope.kind === 'legacy') {
    return {
      beads: [...beads],
      warnings: [
        `Goal-program scope is ${scope?.kind ?? 'missing'}; using legacy repository-wide ready frontier.`,
      ],
    };
  }

  return {
    beads: beads.filter((bead) => beadHasProgramLabel(bead, scope.label)),
    warnings: [],
  };
}

export function formatBeadProgramWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) return '';
  return `\n\n${warnings.map((warning) => `Warning: ${warning}`).join('\n')}`;
}
