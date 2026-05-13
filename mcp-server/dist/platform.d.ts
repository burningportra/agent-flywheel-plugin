/**
 * Cross-platform process-control wrappers shared by remediation handlers
 * (T6.1 / T6.2 from the v3.16.0 noob-onboarding plan).
 *
 * The Node `process.kill(pid, signal)` API exists on every supported
 * platform, but Windows ignores POSIX signals and instead routes signal 0
 * + Ctrl-C/Ctrl-Break via a separate path. To keep the remediation handlers
 * simple, callers funnel through these helpers and get a uniform
 * `{ alive, terminated, error }` shape on every OS.
 */
export interface KillOutcome {
    pid: number;
    /** True when the process accepted SIGTERM (or Windows graceful close). */
    signalled: boolean;
    /** True when the process is gone after the grace window. */
    terminated: boolean;
    /** True when a follow-up SIGKILL/forceful close was issued. */
    escalated: boolean;
    /** Captured stderr/error string when the signal call threw. */
    error?: string;
}
export interface KillOptions {
    /** Milliseconds to wait between SIGTERM and the liveness re-probe (default 1000). */
    graceMs?: number;
    /** Test injection for the actual kill primitive. */
    killFn?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
    /** Test injection for sleep. */
    sleepFn?: (ms: number) => Promise<void>;
}
/**
 * Probe whether a pid is alive without altering it. `process.kill(pid, 0)`
 * throws ESRCH when the process is gone; we treat any throw as "not
 * alive" to stay defensive across platforms.
 */
export declare function isAlive(pid: number, killFn?: KillOptions['killFn']): boolean;
/**
 * Terminate a single pid using the SIGTERM → wait → SIGKILL escalation
 * required by the T6.2 spec. Always resolves; never throws.
 */
export declare function terminate(pid: number, opts?: KillOptions): Promise<KillOutcome>;
export declare function terminateMany(pids: number[], opts?: KillOptions): Promise<KillOutcome[]>;
//# sourceMappingURL=platform.d.ts.map