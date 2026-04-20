import { verifyBeadsClosed } from '../beads.js';
import { makeToolError } from './shared.js';
import { classifyExecError } from '../errors.js';
import { createLogger } from '../logger.js';
const log = createLogger('verify-beads');
function okResult(phase, text, data) {
    return {
        content: [{ type: 'text', text }],
        structuredContent: {
            tool: 'flywheel_verify_beads',
            version: 1,
            status: 'ok',
            phase,
            data,
        },
    };
}
/**
 * flywheel_verify_beads — Reconcile a wave of beads after impl agents report back.
 *
 * For each bead ID:
 *   - if `br show` reports `closed`, count as verified.
 *   - if still open / in_progress / deferred, look for a commit referencing the
 *     bead ID via `git log --grep=<id> -1`. If a commit exists, run
 *     `br update --status closed` and record under `autoClosed`. If no commit
 *     exists, record under `unclosedNoCommit`.
 *   - if `br show` errors, record under `errors`.
 *
 * Updates `state.beadResults` for any newly-closed beads so subsequent
 * `flywheel_review` calls short-circuit cleanly.
 */
export async function runVerifyBeads(ctx, args) {
    const { exec, cwd, state, saveState, signal } = ctx;
    if (!Array.isArray(args.beadIds) || args.beadIds.length === 0) {
        return makeToolError('flywheel_verify_beads', state.phase, 'invalid_input', 'Error: beadIds must be a non-empty array of bead IDs.');
    }
    let report;
    try {
        report = await verifyBeadsClosed(exec, cwd, args.beadIds);
    }
    catch (err) {
        const classified = classifyExecError(err);
        log.error('verifyBeadsClosed threw', { err: String(err), code: classified.code });
        return makeToolError('flywheel_verify_beads', state.phase, classified.code, `Error verifying beads: ${classified.cause}`, {
            retryable: classified.retryable,
            hint: 'Check that br CLI is installed and beadIds are valid, then retry.',
            details: { beadIds: args.beadIds },
        });
    }
    const verified = [...report.closed];
    const autoClosed = [];
    const unclosedNoCommit = [];
    for (const straggler of report.stragglers) {
        const grepResult = await exec('git', ['log', `--grep=${straggler.id}`, '--oneline', '-1'], { cwd, timeout: 5000, signal });
        const commitLine = grepResult.code === 0 ? grepResult.stdout.trim() : '';
        const commitSha = commitLine.split(/\s+/)[0] ?? '';
        if (commitSha && /^[0-9a-f]{4,40}$/i.test(commitSha)) {
            const updateResult = await exec('br', ['update', straggler.id, '--status', 'closed'], { cwd, timeout: 5000, signal });
            if (updateResult.code === 0) {
                autoClosed.push({ beadId: straggler.id, commit: commitSha });
                verified.push(straggler.id);
            }
            else {
                report.errors[straggler.id] = `auto-close failed: ${updateResult.stderr || `exit ${updateResult.code}`}`;
                unclosedNoCommit.push(straggler);
            }
        }
        else {
            unclosedNoCommit.push(straggler);
        }
    }
    if (autoClosed.length > 0) {
        if (!state.beadResults)
            state.beadResults = {};
        for (const { beadId, commit } of autoClosed) {
            state.beadResults[beadId] = {
                beadId,
                status: 'success',
                summary: `Auto-closed by flywheel_verify_beads (commit: ${commit.slice(0, 7)})`,
            };
        }
        saveState(state);
    }
    const outcome = {
        verified,
        autoClosed,
        unclosedNoCommit,
        errors: report.errors,
    };
    const lines = [];
    lines.push(`Verified ${verified.length}/${args.beadIds.length} bead(s) closed.`);
    if (autoClosed.length > 0) {
        lines.push(`Auto-closed ${autoClosed.length} straggler(s) with matching commits:`);
        for (const { beadId, commit } of autoClosed) {
            lines.push(`  - ${beadId} → ${commit.slice(0, 7)}`);
        }
    }
    if (unclosedNoCommit.length > 0) {
        lines.push(`⚠️  ${unclosedNoCommit.length} straggler(s) without commits — needs attention:`);
        for (const s of unclosedNoCommit) {
            lines.push(`  - ${s.id} (status: ${s.status})`);
        }
    }
    if (Object.keys(report.errors).length > 0) {
        lines.push(`Errors:`);
        for (const [id, msg] of Object.entries(report.errors)) {
            lines.push(`  - ${id}: ${msg}`);
        }
    }
    return okResult(state.phase, lines.join('\n'), outcome);
}
//# sourceMappingURL=verify-beads.js.map