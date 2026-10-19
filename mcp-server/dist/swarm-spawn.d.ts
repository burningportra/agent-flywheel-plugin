/**
 * `swarm-spawn` starts a flywheel swarm: `ntm spawn` for the lanes NTM runs
 * (cc, cod, gmi), then one tmux pane per Pi lane in the same session window,
 * because ntm has no Pi agent type. It prints every pane's lane and tmux
 * index as JSON so the coordinator can address Pi panes with
 * `ntm --robot-send --panes=<index>`.
 */
import { type ExecFn } from './exec.js';
declare const NTM_LANES: readonly ["cc", "cod", "gmi"];
export type NtmLane = (typeof NTM_LANES)[number];
export type SwarmLane = NtmLane | 'pi';
export interface SwarmSpawnArgs {
    project: string;
    label: string;
    /** Raw NTM lane values (`2` or `2:opus`), passed through to ntm. */
    ntmLanes: Partial<Record<NtmLane, string>>;
    piCount: number;
    /** One model per Pi pane; the last one repeats when there are more panes than models. */
    piModels: string[];
    piName: string;
    ntmArgs: string[];
    cwd: string;
}
export interface SwarmPane {
    lane: SwarmLane | 'unknown';
    index: number;
    paneId: string;
    title: string;
    model?: string;
}
export interface SwarmSpawnResult {
    session: string;
    panes: SwarmPane[];
    errors: string[];
}
export declare function laneCount(value: string | undefined): number;
export declare function parseSwarmSpawnArgs(argv: readonly string[], cwd: string): {
    ok: true;
    args: SwarmSpawnArgs;
} | {
    ok: false;
    error: string;
};
export declare function buildNtmSpawnArgs(args: SwarmSpawnArgs): string[];
export declare function buildPiPaneCommand(piBin: string, model: string, name: string): string[];
export declare function classifyPanes(listing: string, piPanes: ReadonlyMap<string, string>): SwarmPane[];
export declare function spawnSwarm(args: SwarmSpawnArgs, exec: ExecFn): Promise<SwarmSpawnResult>;
export interface SwarmSpawnDeps {
    exec?: ExecFn;
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
export declare function runCli(argv: string[], deps?: SwarmSpawnDeps): Promise<number>;
export {};
//# sourceMappingURL=swarm-spawn.d.ts.map