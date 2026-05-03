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
import { errMsg } from '../errors.js';
export const ORPHAN_TENDER_DAEMONS_CHECK_NAME = 'orphan_tender_daemons';
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
export function parseTenderDaemonProcesses(psOutput) {
    const out = [];
    for (const line of psOutput.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        if (!trimmed.includes('tender-daemon'))
            continue;
        const firstSpace = trimmed.indexOf(' ');
        if (firstSpace <= 0)
            continue;
        const pidPart = trimmed.slice(0, firstSpace);
        const pid = Number(pidPart);
        if (!Number.isFinite(pid) || pid <= 0)
            continue;
        const cmd = trimmed.slice(firstSpace + 1);
        const sessionMatch = /--session\s+(\S+)/.exec(cmd);
        out.push({ pid, session: sessionMatch ? sessionMatch[1] : null, rawCommand: cmd });
    }
    return out;
}
/**
 * Parse `tmux list-sessions -F '#S'` output into the set of session names.
 * Returns an empty set if tmux is absent or has no sessions.
 */
export function parseTmuxSessions(tmuxOutput) {
    const out = new Set();
    for (const line of tmuxOutput.split('\n')) {
        const name = line.trim();
        if (name.length > 0)
            out.add(name);
    }
    return out;
}
/**
 * Classify tender-daemon processes against live tmux sessions. A daemon is
 * an orphan when its session is not in the live set, OR when it has no
 * session arg at all.
 */
export function classifyOrphans(daemons, liveSessions) {
    return daemons.filter((d) => d.session === null || !liveSessions.has(d.session));
}
const ORPHAN_HINT_PREFIX = 'Stop them with `kill -TERM <pid>` (one PID per daemon). Re-run flywheel_doctor afterwards to confirm.';
/**
 * Doctor check implementation. Never throws — returns a DoctorCheck row.
 */
export async function checkOrphanTenderDaemons(exec, cwd, signal, timeout, now) {
    const start = now();
    if (signal.aborted) {
        return {
            name: ORPHAN_TENDER_DAEMONS_CHECK_NAME,
            severity: 'yellow',
            message: 'aborted before probe',
            durationMs: now() - start,
        };
    }
    let psOut = '';
    try {
        const ps = await exec('ps', ['-eo', 'pid,command'], { timeout, cwd, signal });
        if (ps.code !== 0) {
            return {
                name: ORPHAN_TENDER_DAEMONS_CHECK_NAME,
                severity: 'yellow',
                message: `ps -eo pid,command failed (exit ${ps.code})`,
                hint: 'Verify ps is on PATH and the user has permission to enumerate processes.',
                durationMs: now() - start,
            };
        }
        psOut = ps.stdout;
    }
    catch (err) {
        return {
            name: ORPHAN_TENDER_DAEMONS_CHECK_NAME,
            severity: 'yellow',
            message: `ps probe failed: ${errMsg(err)}`,
            durationMs: now() - start,
        };
    }
    const daemons = parseTenderDaemonProcesses(psOut);
    if (daemons.length === 0) {
        return {
            name: ORPHAN_TENDER_DAEMONS_CHECK_NAME,
            severity: 'green',
            message: 'no tender-daemons running',
            durationMs: now() - start,
        };
    }
    // tmux is best-effort. If it's missing or empty, every daemon with a
    // --session arg is treated as orphan (since we can't prove its session
    // exists). That matches the operator-feedback intent: surface stragglers,
    // never silently accept them.
    let liveSessions = new Set();
    try {
        const tmux = await exec('tmux', ['list-sessions', '-F', '#S'], { timeout, cwd, signal });
        if (tmux.code === 0)
            liveSessions = parseTmuxSessions(tmux.stdout);
    }
    catch {
        // tmux not installed or no server → liveSessions stays empty.
    }
    const orphans = classifyOrphans(daemons, liveSessions);
    if (orphans.length === 0) {
        return {
            name: ORPHAN_TENDER_DAEMONS_CHECK_NAME,
            severity: 'green',
            message: `${daemons.length} tender-daemon${daemons.length === 1 ? '' : 's'} running, all sessions live`,
            durationMs: now() - start,
        };
    }
    const summary = orphans
        .map((o) => `pid ${o.pid}${o.session ? ` (session ${o.session})` : ' (no session arg)'}`)
        .join(', ');
    const killCmd = `kill -TERM ${orphans.map((o) => o.pid).join(' ')}`;
    return {
        name: ORPHAN_TENDER_DAEMONS_CHECK_NAME,
        severity: 'yellow',
        message: `${orphans.length} orphan tender-daemon${orphans.length === 1 ? '' : 's'} detected: ${summary}`,
        hint: `${ORPHAN_HINT_PREFIX} Suggested one-shot: \`${killCmd}\`.`,
        durationMs: now() - start,
    };
}
//# sourceMappingURL=orphan-tender-daemons.js.map