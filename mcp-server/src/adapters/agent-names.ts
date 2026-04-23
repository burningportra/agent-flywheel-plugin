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
export const AGENT_NAME_ADJECTIVES: readonly string[] = Object.freeze([
  'Coral',
  'Silent',
  'Amber',
  'Bright',
  'Clever',
  'Dusky',
  'Eager',
  'Fierce',
  'Gentle',
  'Hidden',
  'Iron',
  'Jade',
  'Keen',
  'Lively',
  'Misty',
  'Noble',
  'Ochre',
  'Placid',
  'Quiet',
  'Rapid',
  'Stoic',
  'Tidal',
  'Umber',
  'Vivid',
  'Windy',
  'Xenial',
  'Yellow',
  'Zephyr',
  'Autumn',
  'Boreal',
  'Crimson',
  'Distant',
  'Ember',
  'Frosted',
  'Golden',
  'Hushed',
  'Indigo',
  'Jagged',
  'Kindled',
  'Luminous',
]);

/** Noun pool — 40 entries, all CamelCase-safe. */
export const AGENT_NAME_NOUNS: readonly string[] = Object.freeze([
  'Dune',
  'Harbor',
  'Fjord',
  'Grove',
  'Ridge',
  'Meadow',
  'Canyon',
  'Brook',
  'Vale',
  'Peak',
  'Cove',
  'Glade',
  'Spire',
  'Cliff',
  'Reef',
  'Island',
  'Lagoon',
  'Summit',
  'Trail',
  'Orchard',
  'Pasture',
  'Basin',
  'Delta',
  'Estuary',
  'Prairie',
  'Tundra',
  'Oasis',
  'Haven',
  'Anchor',
  'Beacon',
  'Compass',
  'Ember',
  'Feather',
  'Garnet',
  'Horizon',
  'Lantern',
  'Mariner',
  'Nomad',
  'Pilgrim',
  'Ranger',
]);

/**
 * Total unique combinations available in the pool.
 * Exposed for doctor reporting / telemetry ("name pool capacity").
 */
export const AGENT_NAME_POOL_SIZE: number =
  AGENT_NAME_ADJECTIVES.length * AGENT_NAME_NOUNS.length;

/**
 * FNV-1a 32-bit hash — deterministic, dependency-free.
 * Good enough for uniform pool indexing; NOT a security primitive.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned.
  return h >>> 0;
}

/**
 * Deterministic pick from the pool given a stable seed (e.g. pane id,
 * bead id, or their concatenation). Same seed → same name, always.
 * Different seeds collide with probability 1 / POOL_SIZE (~0.001).
 */
export function pickAgentName(seed: string): string {
  if (seed.length === 0) {
    // Avoid hash(0) always mapping to the same name when callers accidentally
    // pass empty strings — jiggle with a constant.
    seed = 'flywheel-default-seed';
  }
  const h = hash32(seed);
  const adj = AGENT_NAME_ADJECTIVES[h % AGENT_NAME_ADJECTIVES.length]!;
  // Use the upper bits for the noun to avoid correlation between halves.
  const noun = AGENT_NAME_NOUNS[(h >>> 8) % AGENT_NAME_NOUNS.length]!;
  return `${adj}${noun}`;
}

/** Non-deterministic pick — use when you don't need reproducibility. */
export function randomAgentName(): string {
  const adj =
    AGENT_NAME_ADJECTIVES[
      Math.floor(Math.random() * AGENT_NAME_ADJECTIVES.length)
    ]!;
  const noun =
    AGENT_NAME_NOUNS[Math.floor(Math.random() * AGENT_NAME_NOUNS.length)]!;
  return `${adj}${noun}`;
}

/**
 * Allocate N distinct names deterministically from a base seed.
 * Guarantees no intra-batch collisions up to POOL_SIZE.
 */
export function allocateAgentNames(count: number, baseSeed: string): string[] {
  if (count < 0) throw new Error('count must be >= 0');
  if (count > AGENT_NAME_POOL_SIZE) {
    throw new Error(
      `requested ${count} names but pool only holds ${AGENT_NAME_POOL_SIZE}`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let salt = 0;
  while (out.length < count) {
    const candidate = pickAgentName(`${baseSeed}#${salt}`);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
    salt++;
    // Defensive cap: break if we've clearly exceeded what the pool supports.
    if (salt > AGENT_NAME_POOL_SIZE * 4) {
      throw new Error(
        `failed to allocate ${count} unique names after ${salt} probes`,
      );
    }
  }
  return out;
}
