/**
 * `swarm-spawn` starts a flywheel swarm: `ntm spawn` for the lanes NTM runs
 * (cc, cod, agy), then one tmux pane per Pi or Gemini pane in the same session
 * window, because ntm has no Pi agent type. Gemini panes are Pi on
 * gemini-4-argon; ntm's own gmi lane would start the gemini CLI. It prints
 * every pane's lane and tmux index as JSON so the coordinator can address
 * those panes with `ntm --robot-send --panes=<index>`.
 */
import { type ExecFn } from './exec.js';
declare const NTM_LANES: readonly ["cc", "cod", "agy"];
export type NtmLane = (typeof NTM_LANES)[number];
export type PiPaneLane = 'pi' | 'gmi';
export type SwarmLane = NtmLane | PiPaneLane;
export interface SwarmSpawnArgs {
    project: string;
    label: string;
    /** Raw NTM lane values (`2` or `2:opus`), passed through to ntm. */
    ntmLanes: Partial<Record<NtmLane, string>>;
    piCount: number;
    /** Pi panes cycle through these models. */
    piModels: string[];
    /** Gemini panes, each Pi on {@link GEMINI_LANE_MODEL}. */
    gmiCount: number;
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
export declare function laneModel(value: string | undefined): string | undefined;
/**
 * `agy models` lists only effort-suffixed slugs (`gemini-4-argon-high`), so a
 * bare model plus an effort becomes that slug. A slug that already carries an
 * effort suffix, or a bare model without one, is returned unchanged.
 */
export declare function resolveAgySlug(model: string, effort?: string): string;
/** Rewrites an `--agy` value to `N` or `N:<slug>`; undefined when the value isn't `N[:model[:effort]]`. */
export declare function normalizeAgyLaneValue(value: string): string | undefined;
export declare function parseSwarmSpawnArgs(argv: readonly string[], cwd: string): {
    ok: true;
    args: SwarmSpawnArgs;
} | {
    ok: false;
    error: string;
};
export declare function buildNtmSpawnArgs(args: SwarmSpawnArgs): string[];
export declare function buildPiPaneCommand(piBin: string, model: string, name: string): string[];
interface PiPane {
    lane: PiPaneLane;
    model: string;
    /** Pi session name. */
    name: string;
    /** `__pi_gmi_` rather than `__gmi_`: ntm treats `__gmi_N` as a gemini CLI pane and would respawn it as one. */
    title: string;
}
export declare function classifyPanes(listing: string, piPanes: ReadonlyMap<string, Pick<PiPane, 'lane' | 'model'>>, ntmLanes?: Partial<Record<NtmLane, string>>): SwarmPane[];
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