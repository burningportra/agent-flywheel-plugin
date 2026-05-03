/**
 * Orphan tender-daemon check (bead n3a).
 *
 * Detects `node tender-daemon.js` processes whose `--session <name>` no longer
 * exists in `tmux list-sessions`. Two zombie tender-daemons from prior
 * flywheel sessions (v3.11.0 + v3.11.1) silently accumulated for weeks
 * before being noticed via `pkill -TERM`. This check surfaces them as a
 * yellow doctor row with the exact PIDs and the cleanup command pre-baked
 * into the hint.
 *
 * Pure module: takes an ExecFn, never reaches into the process directly.
 */
import type { ExecFn } from '../exec.js';
import type { DoctorCheck } from '../types.js';
export declare const ORPHAN_TENDER_DAEMONS_CHECK_NAME: "orphan_tender_daemons";
interface TenderDaemonProcess {
    pid: number;
    session: string | null;
    rawCommand: string;
}
/**
 * Parse `ps -eo pid,command` output into tender-daemon process records.
 *
 * Expected line shape (the leading whitespace is normalized):
 *   ` 12345 node /path/to/tender-daemon.js --session my-session ...`
 *
 * Lines that don't reference `tender-daemon` are skipped. The session name
 * is parsed from `--session <name>` — when absent, `session` is null and
 * the row is reported as "no session arg" (still treated as an orphan
 * candidate, since a tender-daemon with no session can't be reaped via
 * tmux teardown).
 */
export declare function parseTenderDaemonProcesses(psOutput: string): TenderDaemonProcess[];
/**
 * Parse `tmux list-sessions -F '#S'` output into the set of session names.
 * Returns an empty set if tmux is absent or has no sessions.
 */
export declare function parseTmuxSessions(tmuxOutput: string): Set<string>;
/**
 * Classify tender-daemon processes against live tmux sessions. A daemon is
 * an orphan when its session is not in the live set, OR when it has no
 * session arg at all.
 */
export declare function classifyOrphans(daemons: TenderDaemonProcess[], liveSessions: Set<string>): TenderDaemonProcess[];
/**
 * Doctor check implementation. Never throws — returns a DoctorCheck row.
 */
export declare function checkOrphanTenderDaemons(exec: ExecFn, cwd: string, signal: AbortSignal, timeout: number, now: () => number): Promise<DoctorCheck>;
export {};
//# sourceMappingURL=orphan-tender-daemons.d.ts.map