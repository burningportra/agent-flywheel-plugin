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
     * The achievable Claude:Codex:Gemini ratio given capabilities.
     * All-available → "1:1:1". If only claude+gemini → "1:0:1", etc.
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
}): Promise<CapabilitiesMap>;
/**
 * Split N beads across available providers with the floor(N/3) + priority
 * remainder rule. Missing CLIs are dropped from the lane set and their
 * would-be share is redistributed by priority.
 *
 * Contract:
 *   - sum(lane.beadIds.length) == beadIds.length
 *   - lanes contain only providers with `available === true`
 *   - lane order is claude, codex, gemini (stable; skipped entries omit)
 *   - beads are handed out in the order supplied (assumed priority-sorted
 *     by caller: highest-priority → first lane slot)
 */
export declare function splitBeadsByProvider(beadIds: readonly string[], caps: CapabilitiesMap): DispatchPlan;
/**
 * Pick the right adapter for a provider. Centralised so the dispatch
 * loop can `adaptPromptFor(lane.provider, ctx)` without importing all
 * three modules.
 */
export declare function adaptPromptFor(provider: ModelProvider, ctx: BeadDispatchContext): AdaptedPrompt;
/**
 * Describe the capabilities map in a doctor-ready one-liner.
 *   All-available → "claude:gemini:codex available; ratio 1:1:1 achievable"
 *   Missing codex → "claude+gemini available; codex missing; ratio 1:0:1 achievable"
 */
export declare function describeCapabilities(caps: CapabilitiesMap): string;
//# sourceMappingURL=model-diversity.d.ts.map