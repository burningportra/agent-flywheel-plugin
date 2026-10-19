/**
 * Swarm-agent model diversity — Claude : Pi : Gemini at 1:1:1, with Codex
 * as the fallback that takes Pi's share. Pi runs on a model the user picks
 * through `flywheel_pi_models`, on one of their own logins or the Vercel AI
 * Gateway. The Gemini lane is Pi too, always on gemini-4-argon through the
 * gateway; the gemini CLI never runs. A lane switched off under `lanes:` in
 * flywheel.config.yaml hands its share down the same fallback order without
 * counting as degraded.
 *
 * Responsibilities:
 *   1. Detect CLI availability (`which claude codex pi`, plus the route
 *      credentials of the Pi and Gemini lanes and the lane switches in
 *      flywheel.config.yaml).
 *   2. Split N ready beads across available providers as floor(N/3) each
 *      with a priority-ordered remainder.
 *   3. Fall back gracefully when a CLI is missing and emit a warning so
 *      the coordinator can report degraded-mode to the user.
 *   4. Provide per-bead prompt adaptation for every dispatch provider.
 *
 * The public surface is the primary consumer contract for downstream
 * bead `1qn` (codex-rescue handoff). Treat it as stable.
 */

import type { ExecFn } from '../exec.js';
import type { SwarmMix } from '../types.js';
import { errMsg } from '../errors.js';
import { loadFlywheelConfig } from '../flywheel-config.js';
import { checkPiLaneReady, checkPiProviderAuth, GEMINI_LANE_MODEL, providerOf } from '../pi-models.js';
import { adaptPromptForClaude, adaptPromptForGemini, adaptPromptForPi } from './claude-prompt.js';
import { adaptPromptForCodex } from './codex-prompt.js';
import type { AdaptedPrompt, BeadDispatchContext } from './codex-prompt.js';

export type ModelProvider = 'claude' | 'codex' | 'gemini' | 'pi';

/** Per-provider availability signal. */
export interface CliCapability {
  readonly provider: ModelProvider;
  readonly available: boolean;
  /** Resolved binary path when the binary is on PATH, even if it isn't ready. */
  readonly path?: string;
  /** Error text when unavailable (ENOENT or version probe failure). */
  readonly reason?: string;
  /** True when the user switched this lane off in flywheel.config.yaml. */
  readonly disabled?: boolean;
}

export interface CapabilitiesMap {
  readonly claude: CliCapability;
  readonly codex: CliCapability;
  readonly gemini: CliCapability;
  readonly pi: CliCapability;
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
   * Assigned Claude:Pi:Gemini bead counts.
   * Six beads with all providers → "2:2:2".
   */
  readonly ratio: string;
}

// ─── CLI detection ────────────────────────────────────────────────────────

const PROVIDER_BINARIES: Record<ModelProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'pi',
  pi: 'pi',
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
  opts: {
    timeout?: number;
    cwd?: string;
    signal?: AbortSignal;
    probeScope?: string;
    /** On another Mac, cc panes need a login there; this session's own login proves nothing. */
    verifyClaudeLogin?: boolean;
  } = {},
): Promise<CapabilitiesMap> {
  const timeout = opts.timeout ?? 1500;
  const lanes = loadFlywheelConfig(opts.cwd ?? process.cwd()).lanes;
  const switchedOff = (provider: ModelProvider): boolean =>
    provider !== 'claude' && !lanes[provider];
  const probe = async (provider: ModelProvider): Promise<CliCapability> => {
    if (switchedOff(provider)) {
      return { provider, available: false, disabled: true, reason: 'disabled in flywheel.config.yaml' };
    }
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

  // Pi counts only when a route it would run on has credentials.
  const probePi = async (): Promise<CliCapability> => {
    const found = await probe('pi');
    if (!found.available) return found;
    const auth = await checkPiLaneReady(exec, { cwd: opts.cwd, signal: opts.signal, timeout: 10_000, probeScope: opts.probeScope });
    return auth.ready
      ? found
      : { ...found, available: false, reason: `pi auth check: ${auth.detail}` };
  };

  // The Gemini lane needs the gateway credentials its one model runs on.
  const probeGemini = async (): Promise<CliCapability> => {
    const found = await probe('gemini');
    if (!found.available) return found;
    const auth = await checkPiProviderAuth(exec, providerOf(GEMINI_LANE_MODEL), {
      cwd: opts.cwd,
      signal: opts.signal,
      timeout: 10_000,
    });
    return auth.ready
      ? found
      : { ...found, available: false, reason: `pi auth check: ${auth.provider} ${auth.detail}` };
  };

  const probeClaude = async (): Promise<CliCapability> => {
    const found = await probe('claude');
    if (!found.available || !opts.verifyClaudeLogin) return found;
    try {
      const status = await exec('claude', ['auth', 'status'], { timeout: 15_000, cwd: opts.cwd, signal: opts.signal });
      if (/"loggedIn"\s*:\s*true/.test(status.stdout)) return found;
      return { ...found, available: false, reason: 'claude is not logged in there (claude auth status)' };
    } catch (err) {
      return { ...found, available: false, reason: `claude auth status: ${errMsg(err)}` };
    }
  };

  const [claude, codex, gemini, pi] = await Promise.all([
    probeClaude(),
    probe('codex'),
    probeGemini(),
    probePi(),
  ]);
  return { claude, codex, gemini, pi };
}

// ─── Ratio math + split ───────────────────────────────────────────────────

export const PRIMARY_PROVIDERS = ['claude', 'pi', 'gemini'] as const;

const ROUTING_PROVIDERS: readonly ModelProvider[] = Object.freeze([
  'claude',
  'pi',
  'gemini',
  'codex',
]);

const FALLBACK_PRIORITY = {
  claude: ['pi', 'gemini', 'codex'],
  pi: ['codex', 'gemini', 'claude'],
  gemini: ['pi', 'codex', 'claude'],
} as const satisfies Record<(typeof PRIMARY_PROVIDERS)[number], readonly ModelProvider[]>;

/**
 * Split N beads into canonical Claude/Pi/Gemini shares, then transfer a
 * missing provider's complete share through the supported fallback order.
 *
 * Contract:
 *   - sum(lane.beadIds.length) == beadIds.length
 *   - lanes contain only providers with `available === true`
 *   - a disabled provider's share moves like a missing one's, silently
 *   - lane order is claude, pi, gemini, codex (stable; skipped entries omit)
 *   - beads are handed out in the order supplied (assumed priority-sorted
 *     by caller: highest-priority → first lane slot)
 */
export function splitBeadsByProvider(
  beadIds: readonly string[],
  caps: CapabilitiesMap,
): DispatchPlan {
  const warnings: string[] = [];
  const availableProviders: ModelProvider[] = ROUTING_PROVIDERS.filter(
    (p) => caps[p].available,
  );

  if (availableProviders.length === 0) {
    return {
      lanes: [],
      warnings: [
        'no implementation CLI available (claude, pi, gemini, codex all missing)',
      ],
      degraded: true,
      ratio: '0:0:0',
    };
  }

  const missing = PRIMARY_PROVIDERS.filter((p) => !caps[p].available && !caps[p].disabled);
  const degraded = missing.length > 0;
  const n = beadIds.length;
  const preferredCounts = new Map<ModelProvider, number>();
  const baseline = Math.floor(n / PRIMARY_PROVIDERS.length);
  for (const provider of PRIMARY_PROVIDERS) {
    preferredCounts.set(provider, baseline);
  }

  let remainder = n - baseline * PRIMARY_PROVIDERS.length;
  for (const p of PRIMARY_PROVIDERS) {
    if (remainder === 0) break;
    preferredCounts.set(p, (preferredCounts.get(p) ?? 0) + 1);
    remainder--;
  }

  const assigned = new Map<ModelProvider, string[]>(
    ROUTING_PROVIDERS.map((provider) => [provider, []]),
  );
  let cursor = 0;
  for (const preferred of PRIMARY_PROVIDERS) {
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

    if (provider !== preferred && !caps[preferred].disabled) {
      warnings.push(
        `${preferred} lane not available${caps[preferred].reason ? ` (${caps[preferred].reason})` : ''}; reassigned ${ids.length} bead(s) to ${provider}`,
      );
    }
  }

  const lanes: DispatchLane[] = [];
  for (const provider of ROUTING_PROVIDERS) {
    const ids = assigned.get(provider) ?? [];
    if (ids.length > 0) lanes.push({ provider, beadIds: ids });
  }

  const ratio = PRIMARY_PROVIDERS.map(
    (provider) => String(assigned.get(provider)?.length ?? 0),
  ).join(':');

  return { lanes, warnings, degraded, ratio };
}

/** Each lane's `swarm-spawn.js` flag name. */
const SPAWN_LANE: Record<ModelProvider, string> = {
  claude: 'cc',
  pi: 'pi',
  gemini: 'gmi',
  codex: 'cod',
};

/**
 * The lanes a swarm of `panes` panes gets on this host, split the way
 * implementation waves split beads. Undefined when no lane is usable.
 */
export function swarmMixFor(caps: CapabilitiesMap, panes = 6): SwarmMix | undefined {
  const slots = Array.from({ length: panes }, (_, i) => String(i));
  const lanes = splitBeadsByProvider(slots, caps).lanes.map((lane) => ({
    name: SPAWN_LANE[lane.provider],
    panes: lane.beadIds.length,
  }));
  if (lanes.length === 0) return undefined;
  return {
    label: `${lanes.map((l) => l.name).join(':')} ${lanes.map((l) => l.panes).join(':')}`,
    spawnFlags: lanes.map((l) => `--${l.name}=${l.panes}`).join(' '),
  };
}

// ─── Prompt adaptation facade ─────────────────────────────────────────────

/**
 * Pick the right adapter for a provider. Centralised so the dispatch
 * loop can `adaptPromptFor(lane.provider, ctx)` without importing all
 * provider modules.
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
    case 'pi':
      return adaptPromptForPi(ctx);
  }
}

/**
 * Describe the capabilities map in a doctor-ready one-liner.
 *   All-available → "claude+pi+gemini available; ratio 1:1:1 achievable"
 *   Missing pi    → "claude+gemini available; pi missing; ratio 1:0:1 achievable; codex fallback available"
 *   Gemini off    → "claude+pi available; gemini disabled; ratio 1:1:0 achievable; codex fallback available"
 */
export function describeCapabilities(caps: CapabilitiesMap): string {
  const avail = PRIMARY_PROVIDERS.filter((p) => caps[p].available);
  const off = PRIMARY_PROVIDERS.filter((p) => caps[p].disabled);
  const miss = PRIMARY_PROVIDERS.filter((p) => !caps[p].available && !caps[p].disabled);
  const ratio = PRIMARY_PROVIDERS.map((p) =>
    caps[p].available ? '1' : '0',
  ).join(':');
  const parts: string[] = [];
  parts.push(avail.length > 0 ? `${avail.join('+')} available` : 'no CLIs available');
  if (miss.length > 0) parts.push(`${miss.join('+')} missing`);
  if (off.length > 0) parts.push(`${off.join('+')} disabled`);
  parts.push(`ratio ${ratio} achievable`);
  if (caps.codex.available) parts.push('codex fallback available');
  return parts.join('; ');
}
