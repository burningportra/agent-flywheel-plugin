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
/**
 * Probe `which <bin>` for each provider. A zero exit code and a non-empty
 * stdout line means the CLI is on $PATH. We deliberately do NOT call
 * `<bin> --version` here — some CLIs print a splash/upgrade prompt that
 * delays startup and inflates the caller's doctor budget. `which` is fast
 * and sufficient for routing decisions.
 */
export declare function detectCliCapabilities(exec: ExecFn, opts?: {
    timeout?: number;
    cwd?: string;
    signal?: AbortSignal;
    probeScope?: string;
    /** On another Mac, cc panes need a login there; this session's own login proves nothing. */
    verifyClaudeLogin?: boolean;
}): Promise<CapabilitiesMap>;
export declare const PRIMARY_PROVIDERS: readonly ["claude", "pi", "gemini"];
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
export declare function splitBeadsByProvider(beadIds: readonly string[], caps: CapabilitiesMap): DispatchPlan;
/**
 * The lanes a swarm of `panes` panes gets on this host, split the way
 * implementation waves split beads. Undefined when no lane is usable.
 */
export declare function swarmMixFor(caps: CapabilitiesMap, panes?: number): SwarmMix | undefined;
/**
 * Pick the right adapter for a provider. Centralised so the dispatch
 * loop can `adaptPromptFor(lane.provider, ctx)` without importing all
 * provider modules.
 */
export declare function adaptPromptFor(provider: ModelProvider, ctx: BeadDispatchContext): AdaptedPrompt;
/**
 * Describe the capabilities map in a doctor-ready one-liner.
 *   All-available → "claude+pi+gemini available; ratio 1:1:1 achievable"
 *   Missing pi    → "claude+gemini available; pi missing; ratio 1:0:1 achievable; codex fallback available"
 *   Gemini off    → "claude+pi available; gemini disabled; ratio 1:1:0 achievable; codex fallback available"
 */
export declare function describeCapabilities(caps: CapabilitiesMap): string;
//# sourceMappingURL=model-diversity.d.ts.map