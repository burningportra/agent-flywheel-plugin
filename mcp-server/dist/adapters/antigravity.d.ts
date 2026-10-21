/**
 * Antigravity (`agy`) lane helpers: detect the CLI, list its models, turn a
 * model plus effort into the slug `agy models` prints, build the `ntm spawn
 * --agy` flag, and run `scripts/sync-agy.sh`, which mirrors this plugin into
 * Antigravity's plugin directory.
 *
 * `agy models` lists only effort-suffixed slugs (`gemini-4-argon-high`); there
 * is no bare `gemini-4-argon`, so a model without a suffix gets one.
 */
import type { ExecFn } from '../exec.js';
export declare const AGY_EFFORTS: readonly ["low", "medium", "high", "xhigh", "max"];
export type AgyEffort = (typeof AGY_EFFORTS)[number];
export declare const DEFAULT_AGY_EFFORT: AgyEffort;
/** Where `agy/manifest.json` sends the port when it names no target. */
export declare const DEFAULT_AGY_PORT_TARGET: string;
/** The running plugin's root: `src/adapters/` and `dist/adapters/` both sit two levels under `mcp-server/`. */
export declare const RUNNING_PLUGIN_ROOT: string;
export interface AgyCliStatus {
    available: boolean;
    /** True when `agy` is on PATH, even if `agy --version` failed. */
    installed: boolean;
    version?: string;
    path?: string;
    reason?: string;
}
export interface AgyModel {
    slug: string;
    name: string;
}
export type AgyModelsResult = {
    ok: true;
    models: AgyModel[];
} | {
    ok: false;
    reason: string;
};
export declare function detectAgyCli(exec: ExecFn, signal?: AbortSignal, timeout?: number): Promise<AgyCliStatus>;
/** Parses `agy models`: one `slug<TAB>display name` row per model, after a "Fetching…" banner. */
export declare function probeAgyModels(exec: ExecFn, signal?: AbortSignal, timeout?: number): Promise<AgyModelsResult>;
/**
 * `gemini-4-argon` + `high` → `gemini-4-argon-high`. A slug that already
 * ends in an effort keeps it; a bare model with no effort gets
 * {@link DEFAULT_AGY_EFFORT}.
 */
export declare function resolveAgySlug(model?: string, effort?: AgyEffort): string;
/** `ntm spawn` flags for `count` agy panes: `--agy=N`, or `--agy=N:<slug>` when a model or effort is given. */
export declare function buildAgyNtmArgs(count: number, model?: string, effort?: AgyEffort): string[];
/** True when this ntm's `spawn --help` lists `--agy` (ntm v1.37+). */
export declare function probeNtmAgySupport(exec: ExecFn, signal?: AbortSignal, timeout?: number): Promise<boolean>;
export type SyncAgyMode = 'check' | 'write' | 'prune';
export interface SyncAgySummary {
    ok: number;
    add: number;
    update: number;
    local: number;
    prune: number;
    total: number;
}
export interface SyncAgyReport {
    mode: SyncAgyMode;
    target: string;
    summary: SyncAgySummary;
    [key: string]: unknown;
}
export interface SyncAgyRun {
    /** 0 = in sync, 1 = drift or findings, 2 = usage or setup failure. */
    code: number;
    report?: SyncAgyReport;
    stderr: string;
}
/** The plugin root holding `scripts/sync-agy.sh`: `cwd` when it is this plugin's checkout, else the running plugin. */
export declare function findSyncAgyScript(cwd: string): {
    pluginRoot: string;
    script: string;
} | null;
/** The port target from `<pluginRoot>/agy/manifest.json`, with `~` expanded. */
export declare function resolveAgyPortTarget(pluginRoot: string): string;
export declare function runSyncAgy(exec: ExecFn, opts: {
    script: string;
    pluginRoot: string;
    mode: SyncAgyMode;
    target?: string;
    timeout: number;
    signal?: AbortSignal;
}): Promise<SyncAgyRun>;
export declare function describeSyncAgySummary(summary: SyncAgySummary): string;
export declare const AntigravityAdapter: {
    readonly detectAgyCli: typeof detectAgyCli;
    readonly probeAgyModels: typeof probeAgyModels;
    readonly resolveAgySlug: typeof resolveAgySlug;
    readonly buildAgyNtmArgs: typeof buildAgyNtmArgs;
    readonly probeNtmAgySupport: typeof probeNtmAgySupport;
};
//# sourceMappingURL=antigravity.d.ts.map