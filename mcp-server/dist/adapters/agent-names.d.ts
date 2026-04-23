/**
 * Adjective+Noun agent name pool for Agent Mail bootstrap.
 *
 * BACKGROUND
 * ----------
 * The Agent Mail server rejects descriptive role-based names like
 * "research-coordinator" — it requires adjective+noun compounds in
 * CamelCase form (e.g. "CoralDune", "SilentHarbor"). See memory file
 * `.claude/projects/.../memory/feedback_agent_mail_naming.md`.
 *
 * This module exposes a stable pool (≥30 adjectives × ≥30 nouns =
 * ≥900 combinations) so a single 14-bead swarm wave will not produce
 * collisions. It also provides `pickAgentName(seed)` to derive a
 * deterministic name from a pane/bead identifier — useful for tests.
 *
 * USAGE
 * -----
 *   import { pickAgentName, randomAgentName } from '.../adapters/agent-names.js';
 *   const name = pickAgentName(`cc-1-${beadId}`);       // deterministic
 *   const name = randomAgentName();                       // non-deterministic
 *
 * The spawner should hand the chosen name to the impl agent via the
 * Step 0 Agent Mail bootstrap prompt so `macro_start_session` registers
 * with an acceptable identity.
 */
/** Adjective pool — 40 entries, all CamelCase-safe. */
export declare const AGENT_NAME_ADJECTIVES: readonly string[];
/** Noun pool — 40 entries, all CamelCase-safe. */
export declare const AGENT_NAME_NOUNS: readonly string[];
/**
 * Total unique combinations available in the pool.
 * Exposed for doctor reporting / telemetry ("name pool capacity").
 */
export declare const AGENT_NAME_POOL_SIZE: number;
/**
 * Deterministic pick from the pool given a stable seed (e.g. pane id,
 * bead id, or their concatenation). Same seed → same name, always.
 * Different seeds collide with probability 1 / POOL_SIZE (~0.001).
 */
export declare function pickAgentName(seed: string): string;
/** Non-deterministic pick — use when you don't need reproducibility. */
export declare function randomAgentName(): string;
/**
 * Allocate N distinct names deterministically from a base seed.
 * Guarantees no intra-batch collisions up to POOL_SIZE.
 */
export declare function allocateAgentNames(count: number, baseSeed: string): string[];
//# sourceMappingURL=agent-names.d.ts.map