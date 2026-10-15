import { SWARM_MODELS } from "./model-detection.js";

// ─── Types ──────────────────────────────────────────────────

export interface SwarmComposition {
  /** Total agent count. */
  total: number;
  /** Recommended model distribution. */
  models: Array<{ model: string; count: number }>;
  /** Reasoning for the recommendation. */
  rationale: string;
}

// ─── Agent Composition ──────────────────────────────────────

/** Recommend agent composition based on open bead count. */
export function recommendComposition(openBeadCount: number): SwarmComposition {
  if (openBeadCount >= 400) {
    return {
      total: 10,
      models: [
        { model: SWARM_MODELS.opus, count: 4 },
        { model: SWARM_MODELS.codex, count: 4 },
        { model: SWARM_MODELS.haiku, count: 2 },
      ],
      rationale: `${openBeadCount} open beads — large project, full swarm recommended`,
    };
  }
  if (openBeadCount >= 100) {
    return {
      total: 8,
      models: [
        { model: SWARM_MODELS.opus, count: 3 },
        { model: SWARM_MODELS.codex, count: 3 },
        { model: SWARM_MODELS.haiku, count: 2 },
      ],
      rationale: `${openBeadCount} open beads — medium project, moderate swarm`,
    };
  }
  return {
    total: 3,
    models: [
      { model: SWARM_MODELS.opus, count: 1 },
      { model: SWARM_MODELS.codex, count: 1 },
      { model: SWARM_MODELS.haiku, count: 1 },
    ],
    rationale: `${openBeadCount} open beads — small project, minimal swarm`,
  };
}
