import { type CapabilitiesMap } from './model-diversity.js';
import { type BeadComplexity } from '../model-routing.js';
import type { ExecFn } from '../exec.js';
import type { Bead } from '../types.js';
export type NtmImplementationLane = 'cc' | 'cod' | 'gmi' | 'pi';
export interface ImplementerLane {
    readonly lane: NtmImplementationLane;
    readonly beadIds: readonly string[];
}
export interface ImplementerPrompt {
    readonly beadId: string;
    readonly lane: NtmImplementationLane;
    readonly agentName: string;
    readonly prompt: string;
}
export interface ImplementerDispatch {
    readonly lanes: readonly ImplementerLane[];
    readonly prompts: readonly ImplementerPrompt[];
    readonly complexity: Readonly<Record<string, BeadComplexity>>;
    readonly warnings: readonly string[];
    readonly degraded: boolean;
}
export interface BuildImplementerDispatchArgs {
    readonly exec: ExecFn;
    readonly cwd: string;
    readonly beads: readonly Bead[];
    readonly coordinatorName: string;
    readonly signal?: AbortSignal;
    readonly capabilities?: CapabilitiesMap;
    /** Agent Mail project key; a swarm host's clone when the panes run there. Defaults to `cwd`. */
    readonly projectKey?: string;
    readonly probeScope?: string;
    readonly verifyClaudeLogin?: boolean;
    readonly potetoMode?: boolean;
}
export declare function buildImplementerDispatch(args: BuildImplementerDispatchArgs): Promise<ImplementerDispatch>;
//# sourceMappingURL=implementer-dispatch.d.ts.map