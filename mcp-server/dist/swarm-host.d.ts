/**
 * Running a swarm on another Mac on the local network.
 *
 * The coordinator session, the plugin code, and the cycle state stay on this
 * Mac. The swarm's panes run in a clone on the worker, which this Mac reaches
 * over SSH; only third-party CLIs (ntm, tmux, pi, br, am, git) run there.
 * Ownership of the repo state alternates at wave boundaries:
 * {@link pushToSwarmHost} hands this checkout's commits and beads to the
 * worker before a wave, and {@link pullFromSwarmHost} brings the worker's
 * commits, bead changes, and completion reports back before the wave is
 * verified, so verification, review, and wrap-up keep reading this checkout.
 */
import { z } from 'zod';
import type { ExecFn } from './exec.js';
export declare const SWARM_HOST_RELATIVE_PATH: string;
/** The worker clone's branch. Its worktree tracks it through `receive.denyCurrentBranch=updateInstead`. */
export declare const SWARM_HOST_BRANCH = "flywheel-offload";
export declare const THIS_MAC_LABEL = "This Mac";
export declare const SwarmHostSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    name: z.ZodString;
    host: z.ZodString;
    address: z.ZodNullable<z.ZodString>;
    user: z.ZodString;
    identityFile: z.ZodNullable<z.ZodString>;
    repoPath: z.ZodString;
    ntmProject: z.ZodString;
    localBranch: z.ZodString;
    keepAwakePid: z.ZodNullable<z.ZodNumber>;
    preparedAt: z.ZodString;
}, z.core.$strip>;
export type SwarmHost = z.infer<typeof SwarmHostSchema>;
export type SshTarget = Pick<SwarmHost, 'host' | 'address' | 'user' | 'identityFile'>;
declare const RememberedHostSchema: z.ZodObject<{
    name: z.ZodString;
    host: z.ZodString;
    address: z.ZodNullable<z.ZodString>;
    user: z.ZodString;
    identityFile: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type HostCandidate = z.infer<typeof RememberedHostSchema>;
export interface MachineLoad {
    cores: number;
    memGB: number;
    load: number;
    onBattery: boolean;
    batteryPercent: number | null;
}
export type HostProbe = (MachineLoad & {
    ok: true;
    candidate: HostCandidate;
    diskFreeGB: number | null;
    home: string;
    projectsBase: string | null;
    tools: Record<string, string | null>;
    missingTools: string[];
    agentMail: boolean;
}) | {
    ok: false;
    candidate: HostCandidate;
    reason: 'unreachable' | 'auth' | 'host_key' | 'failed';
    detail: string;
};
export type SwarmSyncFailure = {
    ok: false;
    code: 'missing_prerequisite' | 'blocked_state' | 'cli_failure';
    reason: string;
    message: string;
    hint: string;
    details?: Record<string, unknown>;
};
export type SwarmSyncResult<T> = ({
    ok: true;
} & T) | SwarmSyncFailure;
export interface PullSummary {
    commits: 'up_to_date' | 'fast_forward' | 'merged';
    head: string;
    beads: 'merged' | 'skipped';
    completionReports: 'copied' | 'none';
}
export interface PushSummary {
    head: string;
    beads: 'mirrored' | 'merged' | 'skipped';
}
/** How the coordinator reaches the swarm's lanes: this Mac, or the worker over SSH. */
export interface SwarmLane {
    host: SwarmHost | null;
    /** Runs lane commands (which, pi auth check, ntm, br) where the panes run. */
    exec: ExecFn;
    /** Agent Mail project key and pane working directory. */
    projectKey: string;
    /** Scopes the Pi route-probe cache to the machine whose logins it records. */
    probeScope?: string;
    /** Lane detection checks `claude auth status` where the panes run. */
    verifyClaudeLogin: boolean;
}
export declare function readSwarmHost(cwd: string): Promise<SwarmHost | null>;
export declare function writeSwarmHost(cwd: string, host: SwarmHost): Promise<void>;
export declare function clearSwarmHost(cwd: string): Promise<void>;
/** Hosts chosen before, so a host whose mDNS advertisement dropped still shows up. */
export declare function readRememberedHosts(): Promise<HostCandidate[]>;
export declare function rememberHost(candidate: HostCandidate): Promise<void>;
/** A ref- and filename-safe id for a host. */
export declare function hostSlug(host: string): string;
export declare function shellQuote(value: string): string;
/** Where to connect: an IPv4 address checked against the hostname's known_hosts key, or the hostname itself. */
interface Route {
    address: string;
    alias: string | null;
}
/**
 * Resolve the hostname now, falling back to the last address it had. mDNS
 * names drop out for seconds at a time while the machine stays reachable.
 */
export declare function resolveRoute(target: SshTarget, resolve?: (host: string) => Promise<string>): Promise<Route & {
    resolved: string | null;
}>;
export declare function sshOptions(target: SshTarget, route: Route): string[];
/** A shell script for the worker: its PATH, then `cd` into the clone when one is given. */
export declare function remoteScript(repoPath: string | null, body: string): string;
/**
 * An {@link ExecFn} that runs each command on the worker, in `repoPath` when
 * one is given. `opts.cwd` is ignored: the worker has its own paths.
 */
export declare function makeSshExec(local: ExecFn, target: SshTarget, repoPath: string | null): ExecFn;
/**
 * How lane commands reach the panes. With no swarm host recorded, they run
 * here and the project key is this checkout.
 */
export declare function resolveSwarmLane(cwd: string, exec: ExecFn): Promise<SwarmLane>;
/** Instance names from `dns-sd -B` output lines such as `... Add  2  19 local.  _ssh._tcp.  Kevin’s MacBook Air`. */
export declare function parseDnsSdBrowse(stdout: string): string[];
/** The hostname in `dns-sd -L` output: `... can be reached at Kevins-MacBook-Air.local.:22 (interface 19)`. */
export declare function parseDnsSdLookup(stdout: string): string | null;
/**
 * Macs advertising SSH over Bonjour, plus hosts chosen before, minus this
 * Mac. `dns-sd` never exits on its own, so each call runs for a fixed window.
 */
export declare function findHostCandidates(exec: ExecFn, signal?: AbortSignal): Promise<HostCandidate[]>;
export declare function parseHostProbe(candidate: HostCandidate, stdout: string): Extract<HostProbe, {
    ok: true;
}>;
export declare function probeHost(exec: ExecFn, candidate: HostCandidate, signal?: AbortSignal): Promise<HostProbe>;
export declare function probeThisMac(exec: ExecFn, signal?: AbortSignal): Promise<MachineLoad>;
/** What a remote host can't do yet, in words the user can act on; empty when it can take a swarm. */
export declare function hostBlockers(probe: HostProbe): string[];
/** The usable host with the lowest load per core, when it's clearly lighter than this Mac. */
export declare function recommendHost(local: MachineLoad, probes: readonly HostProbe[]): HostProbe | null;
export interface AskQuestion {
    question: string;
    header: string;
    options: Array<{
        label: string;
        description: string;
    }>;
    multiSelect: false;
}
/**
 * The "where should the swarm run" question, or null when no other Mac can
 * take it. Labels are the hosts' names; `choose` accepts them as picks.
 */
export declare function buildSwarmHostQuestion(local: MachineLoad, probes: readonly HostProbe[]): AskQuestion | null;
/** Match a question answer (label, with or without "(Recommended)") or a hostname to a probe. */
export declare function matchHostPick(pick: string, probes: readonly HostProbe[]): HostProbe | 'this_mac' | null;
interface SyncContext {
    cwd: string;
    exec: ExecFn;
    signal?: AbortSignal;
}
/**
 * Bring the worker's commits, bead changes, and completion reports into this
 * checkout. Commits fast-forward or merge into {@link SwarmHost.localBranch};
 * beads merge three ways with `br sync --merge --force`, so each side keeps
 * its own changes and the newer edit wins where both touched one bead.
 */
export declare function pullFromSwarmHost(ctx: SyncContext, host: SwarmHost): Promise<SwarmSyncResult<PullSummary>>;
/**
 * Hand this checkout's commits and beads to the worker. Pull first: the push
 * only fast-forwards, and the worker clone must have no uncommitted edits.
 */
export declare function pushToSwarmHost(ctx: SyncContext, host: SwarmHost): Promise<SwarmSyncResult<PushSummary>>;
/**
 * Make `probe`'s Mac ready to host this checkout's swarm: a clone under its
 * ntm projects_base, this checkout's commits and beads, the coordinator's
 * Agent Mail identity there, and a `caffeinate` that keeps it awake.
 */
export declare function prepareSwarmHost(ctx: SyncContext & {
    coordinatorName?: string;
}, probe: Extract<HostProbe, {
    ok: true;
}>): Promise<SwarmSyncResult<{
    host: SwarmHost;
    pull: PullSummary | null;
    push: PushSummary;
    warnings: string[];
}>>;
/** Final pull, stop keeping the worker awake, and forget the host for this checkout. */
export declare function releaseSwarmHost(ctx: SyncContext, host: SwarmHost, opts: {
    sync: boolean;
}): Promise<SwarmSyncResult<{
    pull: PullSummary | null;
}>>;
/** What a tool reports about the swarm host after handing a wave to it. */
export interface SwarmHostHandoff {
    name: string;
    repoPath: string;
    ntmProject: string;
    synced: boolean;
    detail: string;
}
/** Push before a wave's prompts go out; a failure is reported, not thrown, so the wave's state stays put. */
export declare function handOffWave(ctx: SyncContext, host: SwarmHost): Promise<SwarmHostHandoff>;
/** Pull before verifying a wave. Thrown errors (timeouts) become a retryable failure. */
export declare function collectWave(ctx: SyncContext, host: SwarmHost): Promise<SwarmSyncResult<PullSummary>>;
export interface RunInvocation {
    checkout: string;
    subdir: string | null;
    timeoutMs: number;
    command: string[];
}
export declare function parseRunArgs(argv: readonly string[], cwd: string): {
    ok: true;
    run: RunInvocation;
} | {
    ok: false;
    error: string;
};
/** Runs a command where this checkout's swarm runs, passing its output and exit code through. */
export declare function runSwarmHostCli(argv: readonly string[], cwd?: string): Promise<number>;
export {};
//# sourceMappingURL=swarm-host.d.ts.map