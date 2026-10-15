/**
 * Swarm-agent model diversity — Claude : Codex : Gemini at 1:1:1 via NTM.
 *
 * Responsibilities:
 *   1. Detect CLI availability (`which claude codex gemini`).
 *   2. Split N ready beads across available providers as floor(N/3) each
 *      with a priority-ordered remainder.
 *   3. Fall back gracefully when a CLI is missing and emit a warning so
 *      the coordinator can report degraded-mode to the user.
 *   4. Provide per-bead prompt adaptation via the three adapters.
 *
 * The public surface is the primary consumer contract for downstream
 * bead `1qn` (codex-rescue handoff). Treat it as stable.
 */

import type { ExecFn } from '../exec.js';
import { errMsg } from '../errors.js';
import { adaptPromptForClaude } from './claude-prompt.js';
import { adaptPromptForCodex } from './codex-prompt.js';
import { adaptPromptForGemini } from './gemini-prompt.js';
import type { AdaptedPrompt, BeadDispatchContext } from './codex-prompt.js';

export type ModelProvider = 'claude' | 'codex' | 'gemini';

/** Per-provider availability signal. */
export interface CliCapability {
  readonly provider: ModelProvider;
  readonly available: boolean;
  /** Resolved binary path when available. */
  readonly path?: string;
  /** Error text when unavailable (ENOENT or version probe failure). */
  readonly reason?: string;
}

export interface CapabilitiesMap {
  readonly claude: CliCapability;
  readonly codex: CliCapability;
  readonly gemini: CliCapability;
}

/** One lane in the split result — a provider + the beads assigned to it. */
export interface DispatchLane {
  readonly provider: ModelProvider;
  readonly beadIds: readonly string[];
}

/** Result of `splitBeadsByProvider`. */
export interface DispatchPlan {
  readonly lanes: readonly DispatchLane[];
  /** Warnings to surface to the coordinator (missing CLIs, skew, etc.). */
  readonly warnings: readonly string[];
  /** True when one or more preferred CLIs were missing and we fell back. */
  readonly degraded: boolean;
  /**
   * Assigned Claude:Codex:Gemini bead counts.
   * Six beads with all providers → "2:2:2".
   */
  readonly ratio: string;
}

// ─── CLI detection ────────────────────────────────────────────────────────

const PROVIDER_BINARIES: Record<ModelProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

/**
 * Probe `which <bin>` for each provider. A zero exit code and a non-empty
 * stdout line means the CLI is on $PATH. We deliberately do NOT call
 * `<bin> --version` here — some CLIs print a splash/upgrade prompt that
 * delays startup and inflates the caller's doctor budget. `which` is fast
 * and sufficient for routing decisions.
 */
export async function detectCliCapabilities(
  exec: ExecFn,
  opts: { timeout?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<CapabilitiesMap> {
  const timeout = opts.timeout ?? 1500;
  const probe = async (provider: ModelProvider): Promise<CliCapability> => {
    const bin = PROVIDER_BINARIES[provider];
    try {
      const res = await exec('which', [bin], {
        timeout,
        cwd: opts.cwd,
        signal: opts.signal,
      });
      const path = res.stdout.trim().split('\n')[0] ?? '';
      if (res.code === 0 && path.length > 0) {
        return { provider, available: true, path };
      }
      return {
        provider,
        available: false,
        reason:
          res.code !== 0
            ? `which ${bin} exited ${res.code}`
            : `which ${bin} returned no path`,
      };
    } catch (err) {
      return {
        provider,
        available: false,
        reason: errMsg(err),
      };
    }
  };

  const [claude, codex, gemini] = await Promise.all([
    probe('claude'),
    probe('codex'),
    probe('gemini'),
  ]);
  return { claude, codex, gemini };
}

// ─── Ratio math + split ───────────────────────────────────────────────────

/**
 * Priority order for remainder assignment when N % 3 != 0.
 *
 * Rationale:
 *   - Claude gets the first extra (it's the most reliable across bead
 *     shapes, so we'd rather bias toward it when we can't split evenly).
 *   - Codex gets the second extra (the user explicitly asked for codex
 *     parity and it handles TypeScript-heavy beads well).
 *   - Gemini gets the third (providing the second-perspective lane even
 *     when remainder = 0).
 *
 * Missing-provider transfers use the explicit fallback table below.
 */
const REMAINDER_PRIORITY: readonly ModelProvider[] = Object.freeze([
  'claude',
  'codex',
  'gemini',
]);

const FALLBACK_PRIORITY = {
  claude: ['codex', 'gemini'],
  codex: ['claude', 'gemini'],
  gemini: ['codex', 'claude'],
} as const satisfies Record<ModelProvider, readonly ModelProvider[]>;

/**
 * Split N beads into canonical Claude/Codex/Gemini shares, then transfer a
 * missing provider's complete share through the supported fallback order.
 *
 * Contract:
 *   - sum(lane.beadIds.length) == beadIds.length
 *   - lanes contain only providers with `available === true`
 *   - lane order is claude, codex, gemini (stable; skipped entries omit)
 *   - beads are handed out in the order supplied (assumed priority-sorted
 *     by caller: highest-priority → first lane slot)
 */
export function splitBeadsByProvider(
  beadIds: readonly string[],
  caps: CapabilitiesMap,
): DispatchPlan {
  const warnings: string[] = [];
  const availableProviders: ModelProvider[] = REMAINDER_PRIORITY.filter(
    (p) => caps[p].available,
  );

  if (availableProviders.length === 0) {
    return {
      lanes: [],
      warnings: [
        'no implementation CLI available (claude, codex, gemini all missing)',
      ],
      degraded: true,
      ratio: '0:0:0',
    };
  }

  const missing = REMAINDER_PRIORITY.filter((p) => !caps[p].available);
  const degraded = missing.length > 0;
  const n = beadIds.length;
  const preferredCounts = new Map<ModelProvider, number>();
  const baseline = Math.floor(n / REMAINDER_PRIORITY.length);
  for (const provider of REMAINDER_PRIORITY) {
    preferredCounts.set(provider, baseline);
  }

  let remainder = n - baseline * REMAINDER_PRIORITY.length;
  for (const p of REMAINDER_PRIORITY) {
    if (remainder === 0) break;
    preferredCounts.set(p, (preferredCounts.get(p) ?? 0) + 1);
    remainder--;
  }

  const assigned = new Map<ModelProvider, string[]>(
    REMAINDER_PRIORITY.map((provider) => [provider, []]),
  );
  let cursor = 0;
  for (const preferred of REMAINDER_PRIORITY) {
    const count = preferredCounts.get(preferred) ?? 0;
    const ids = beadIds.slice(cursor, cursor + count);
    cursor += count;
    if (ids.length === 0) continue;

    const fallback = FALLBACK_PRIORITY[preferred].find(
      (provider) => caps[provider].available,
    );
    const provider = caps[preferred].available ? preferred : fallback;
    if (!provider) continue;
    assigned.get(provider)?.push(...ids);

    if (provider !== preferred) {
      warnings.push(
        `${preferred} CLI not available${caps[preferred].reason ? ` (${caps[preferred].reason})` : ''}; reassigned ${ids.length} bead(s) to ${provider}`,
      );
    }
  }

  const lanes: DispatchLane[] = [];
  for (const provider of REMAINDER_PRIORITY) {
    const ids = assigned.get(provider) ?? [];
    if (ids.length > 0) lanes.push({ provider, beadIds: ids });
  }

  const ratio = REMAINDER_PRIORITY.map(
    (provider) => String(assigned.get(provider)?.length ?? 0),
  ).join(':');

  return { lanes, warnings, degraded, ratio };
}

// ─── Prompt adaptation facade ─────────────────────────────────────────────

/**
 * Pick the right adapter for a provider. Centralised so the dispatch
 * loop can `adaptPromptFor(lane.provider, ctx)` without importing all
 * three modules.
 */
export function adaptPromptFor(
  provider: ModelProvider,
  ctx: BeadDispatchContext,
): AdaptedPrompt {
  switch (provider) {
    case 'claude':
      return adaptPromptForClaude(ctx);
    case 'codex':
      return adaptPromptForCodex(ctx);
    case 'gemini':
      return adaptPromptForGemini(ctx);
  }
}

/**
 * Describe the capabilities map in a doctor-ready one-liner.
 *   All-available → "claude:gemini:codex available; ratio 1:1:1 achievable"
 *   Missing codex → "claude+gemini available; codex missing; ratio 1:0:1 achievable"
 */
export function describeCapabilities(caps: CapabilitiesMap): string {
  const avail = REMAINDER_PRIORITY.filter((p) => caps[p].available);
  const miss = REMAINDER_PRIORITY.filter((p) => !caps[p].available);
  const ratio = REMAINDER_PRIORITY.map((p) =>
    caps[p].available ? '1' : '0',
  ).join(':');
  const parts: string[] = [];
  parts.push(avail.length > 0 ? `${avail.join('+')} available` : 'no CLIs available');
  if (miss.length > 0) parts.push(`${miss.join('+')} missing`);
  parts.push(`ratio ${ratio} achievable`);
  return parts.join('; ');
}
