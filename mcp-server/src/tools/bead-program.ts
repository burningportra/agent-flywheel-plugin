import { createHash } from 'node:crypto';

import type { ExecFn } from '../exec.js';
import { isActiveBeadStatus } from '../bead-status.js';
import { formatSkippedBrRows, parseBrList } from '../parsers.js';
import type { Bead, BeadProgramScope } from '../types.js';

export const FLYWHEEL_GOAL_LABEL_PREFIX = 'flywheel-goal:';

// `br create` rejects labels over 50 characters: prefix (14) + slug + ':' + hash (8).
const BR_LABEL_MAX_LENGTH = 50;
const GOAL_LABEL_HASH_LENGTH = 8;
const GOAL_LABEL_SLUG_MAX_LENGTH =
  BR_LABEL_MAX_LENGTH - FLYWHEEL_GOAL_LABEL_PREFIX.length - 1 - GOAL_LABEL_HASH_LENGTH;

export interface ResolvedBeadProgram {
  scope: Extract<BeadProgramScope, { kind: 'tagged' | 'legacy' }>;
  beads: Bead[];
  /** Active beads with no goal-program label; empty in legacy mode, where every active bead is in scope. */
  untaggedIds: string[];
  warnings: string[];
}

export type DispatchBeadProgramResolution =
  | {
      ok: true;
      scope: Extract<BeadProgramScope, { kind: 'tagged' | 'legacy' }>;
      warnings: string[];
    }
  | {
      ok: false;
      code: 'cli_failure' | 'parse_failure';
      message: string;
      details: Record<string, unknown>;
    };

export function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plan';
}

export function goalBeadProgramLabel(goal: string): string {
  const normalizedGoal = goal.trim();
  const hash = createHash('sha256').update(normalizedGoal).digest('hex').slice(0, GOAL_LABEL_HASH_LENGTH);
  const slug = slugifyGoal(normalizedGoal)
    .slice(0, GOAL_LABEL_SLUG_MAX_LENGTH)
    .replace(/-+$/, '') || 'plan';
  return `${FLYWHEEL_GOAL_LABEL_PREFIX}${slug}:${hash}`;
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
  return beads.filter((bead) => isActiveBeadStatus(bead.status));
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
      untaggedIds: [],
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
    untaggedIds: untagged.map((bead) => bead.id),
    warnings,
  };
}

export async function resolveDispatchBeadProgramScope(
  exec: ExecFn,
  cwd: string,
  scope: BeadProgramScope | undefined,
  expectedLabel: string,
  signal?: AbortSignal,
): Promise<DispatchBeadProgramResolution> {
  if (scope?.kind === 'tagged') {
    return { ok: true, scope, warnings: [] };
  }

  const args = ['list', '--all', '--limit', '0', '--json'];
  const result = await exec('br', args, { cwd, timeout: 10_000, signal });
  if (result.code !== 0) {
    return {
      ok: false,
      code: 'cli_failure',
      message: `Could not refresh goal-program ownership before dispatch: ${result.stderr}`,
      details: { command: `br ${args.join(' ')}`, stderr: result.stderr },
    };
  }

  const parsed = parseBrList(result.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'parse_failure',
      message: `Could not parse goal-program ownership before dispatch: ${parsed.error}`,
      details: { command: `br ${args.join(' ')}`, parseError: parsed.error },
    };
  }

  const program = resolveBeadProgram(parsed.data, expectedLabel);
  return {
    ok: true,
    scope: program.scope,
    warnings: [...formatSkippedBrRows(parsed.skipped), ...program.warnings],
  };
}

export function filterBeadsForProgram(
  beads: readonly Bead[],
  scope: BeadProgramScope | undefined,
): { beads: Bead[]; warnings: string[] } {
  if (!scope || scope.kind === 'legacy') {
    const tagged = beads.filter((bead) =>
      bead.labels?.some(isFlywheelGoalLabel) ?? false,
    );
    return {
      beads: beads.filter((bead) =>
        !(bead.labels?.some(isFlywheelGoalLabel) ?? false),
      ),
      warnings: [
        `Goal-program scope is ${scope?.kind ?? 'missing'}; using the legacy repository-wide ready frontier for untagged beads only.`,
        ...(tagged.length > 0
          ? [`Excluded ${tagged.length} tagged ready bead(s) discovered after legacy scope resolution: ${tagged.map((bead) => bead.id).join(', ')}.`]
          : []),
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
