import { runVerifyBeads } from './verify-beads.js';
import { readyBeads } from '../beads.js';
import { recommendComposition } from '../swarm.js';
import { buildImplementerDispatch, } from '../adapters/implementer-dispatch.js';
import { makeOkToolResult, makeToolError } from './shared.js';
import { classifyExecError } from '../errors.js';
import { createLogger } from '../logger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCheckpoint } from '../checkpoint.js';
import { readConvergenceFromDisk, planSlugFromIdentifier, } from './convergence-tool.js';
import { loadFlywheelConfig } from '../flywheel-config.js';
import { applyBatchReviewVerdict, batchReviewsEnabled, countCommitsSinceLastBatchReview, shouldTriggerBatchReview, } from '../commit-batch.js';
import { filterBeadsForProgram, formatBeadProgramWarnings, goalBeadProgramLabel, resolveDispatchBeadProgramScope, } from './bead-program.js';
const log = createLogger('advance-wave');
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
function isAttestationRequired() {
    // Treat any non-empty value besides "0"/"false" as enabled. Empty / unset
    // means warn-only (Stage 1 default — duel-agreed: PI2 reveal-phase
    // concession that hard-blocking on day-one breaks in-flight workflows).
    const v = process.env.FW_ATTESTATION_REQUIRED?.trim().toLowerCase();
    return v != null && v !== '' && v !== '0' && v !== 'false';
}
/** Score threshold for the auto-approve recommendation. */
const AUTO_APPROVE_SCORE = 0.9;
/**
 * Compute the convergence-recommendation block for an advance-wave outcome.
 * Best-effort + side-effect-free: any I/O failure degrades to a "no_state"
 * outcome rather than failing the whole call (matches the observe pattern).
 */
async function computeConvergenceRecommendation(cwd) {
    let killSwitchOn = true;
    try {
        killSwitchOn = loadFlywheelConfig(cwd).convergence.gate_advance_wave;
    }
    catch {
        killSwitchOn = true;
    }
    if (!killSwitchOn) {
        return { armed: false, score: null, status: null, reason: 'kill_switch_off' };
    }
    let planDocument;
    try {
        const cp = readCheckpoint(cwd);
        planDocument = cp?.envelope.state.planDocument;
    }
    catch {
        /* no-op */
    }
    if (!planDocument) {
        return { armed: false, score: null, status: null, reason: 'no_active_plan' };
    }
    const slug = planSlugFromIdentifier(planDocument);
    let result;
    try {
        result = await readConvergenceFromDisk(cwd, slug);
    }
    catch {
        return { armed: false, score: null, status: null, reason: 'no_state' };
    }
    if (result.status !== 'ok') {
        return { armed: false, score: null, status: null, reason: 'no_state' };
    }
    const { state } = result.data;
    if (state.score >= AUTO_APPROVE_SCORE && state.status === 'converged') {
        return {
            armed: true,
            score: state.score,
            status: state.status,
            reason: 'auto_approve_recommended',
        };
    }
    return {
        armed: false,
        score: state.score,
        status: state.status,
        reason: 'below_threshold',
    };
}
async function applyLandedBatchReviews(cwd, state, signal) {
    const ranges = state.pendingBatchReviews ?? [];
    if (ranges.length === 0)
        return undefined;
    const filed = [];
    const pending = [];
    for (const shaRange of ranges) {
        try {
            const applied = await applyBatchReviewVerdict(cwd, state, shaRange, signal);
            if (applied.kind === 'pending')
                pending.push(shaRange);
            else
                filed.push({ shaRange, beadIds: applied.beadIds });
        }
        catch (err) {
            log.warn('batch review: filing beads failed; retrying on the next call', {
                shaRange,
                err: err instanceof Error ? err.message : String(err),
            });
            pending.push(shaRange);
        }
    }
    return { filed, pending };
}
async function findDueBatchReview(cwd, state, signal) {
    if (!batchReviewsEnabled(state))
        return undefined;
    const baseline = state.lastBatchReviewSha ?? state.cycleStartSha;
    if (!baseline) {
        log.warn('batch-review gate: no lastBatchReviewSha or cycleStartSha to count from; skipping gate');
        return undefined;
    }
    try {
        const count = await countCommitsSinceLastBatchReview(cwd, baseline, signal);
        if (!shouldTriggerBatchReview(state, count))
            return undefined;
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS, signal });
        const reviewSha = stdout.trim();
        if (!reviewSha)
            return undefined;
        return { kind: 'batch_review_due', reviewSha, lastBaselineSha: baseline, shaRange: `${baseline}..${reviewSha}` };
    }
    catch (err) {
        log.warn('batch-review gate: git failed; skipping gate', {
            err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}
function okResult(phase, text, data) {
    return makeOkToolResult('flywheel_advance_wave', phase, text, data);
}
export async function runAdvanceWave(ctx, args) {
    const { exec, cwd, state, saveState, signal } = ctx;
    if (!Array.isArray(args.closedBeadIds) || args.closedBeadIds.length === 0) {
        return makeToolError('flywheel_advance_wave', state.phase, 'invalid_input', 'Error: closedBeadIds must be a non-empty array of bead IDs from the completed wave.', { hint: 'Pass closedBeadIds as a non-empty string array — the wave of beads to verify before advancing.' });
    }
    // Step 1: verify the completed wave
    const verifyResult = await runVerifyBeads(ctx, { cwd, beadIds: args.closedBeadIds });
    const verification = verifyResult.structuredContent?.data;
    if (!verification || verifyResult.isError) {
        return verifyResult;
    }
    const convergenceRec = await computeConvergenceRecommendation(cwd);
    if (verification.unclosedNoCommit.length > 0) {
        const stragglerIds = verification.unclosedNoCommit.map((s) => s.id);
        const outcome = {
            verification,
            nextWave: null,
            waveComplete: false,
            needsEvidence: false,
            convergence: convergenceRec,
        };
        const lines = [
            `Wave incomplete: ${verification.unclosedNoCommit.length} bead(s) still open without commits.`,
            ...stragglerIds.map((id) => `  - ${id}`),
            'Resolve these before advancing to the next wave.',
        ];
        return okResult(state.phase, lines.join('\n'), outcome);
    }
    // Step 1.5: attestation gate (Stage 1 — warn-only by default).
    // `FW_ATTESTATION_REQUIRED=1` flips to hard-block.
    const required = isAttestationRequired();
    if (verification.invalidEvidence.length > 0 && required) {
        const ids = verification.invalidEvidence.map((e) => e.beadId);
        const summary = verification.invalidEvidence
            .map((e) => `${e.beadId}: ${e.code}`)
            .join('; ');
        return makeToolError('flywheel_advance_wave', state.phase, 'attestation_invalid', `Cannot advance wave — ${verification.invalidEvidence.length} bead(s) have invalid completion attestation: ${summary}`, {
            hint: 'Re-read the offending CompletionReport JSON, fix the schema or invariant violation (e.g. status=closed without beadClosedVerified=true), and rewrite the file before re-invoking flywheel_advance_wave.',
            details: { beadIds: ids, invalidEvidence: verification.invalidEvidence },
        });
    }
    if (verification.missingEvidence.length > 0 && required) {
        return makeToolError('flywheel_advance_wave', state.phase, 'attestation_missing', `Cannot advance wave — ${verification.missingEvidence.length} closed bead(s) missing completion attestation: ${verification.missingEvidence.join(', ')}`, {
            hint: 'Each closed bead must have a `.pi-flywheel/completion/<beadId>.json` file matching CompletionReportSchemaV1. Have the implementor write the report (see mcp-server/src/completion-report.ts) before re-invoking.',
            details: { beadIds: verification.missingEvidence },
        });
    }
    const needsEvidence = !required &&
        (verification.missingEvidence.length > 0 || verification.invalidEvidence.length > 0);
    // Step 1.6: file beads from batch-review verdicts that landed since the last
    // call, so they join this wave's frontier without the coordinator asking.
    const batchReviews = await applyLandedBatchReviews(cwd, state, signal);
    if (batchReviews)
        await saveState(state);
    // Step 1.7: a due batch review rides along with the next wave instead of
    // holding it.
    const batchReviewDue = await findDueBatchReview(cwd, state, signal);
    const reviewLines = [
        ...(batchReviews?.filed ?? []).map(({ shaRange, beadIds }) => (beadIds.length > 0
            ? `Batch review ${shaRange}: filed ${beadIds.length} bead(s) from its findings: ${beadIds.join(', ')}.`
            : `Batch review ${shaRange}: no findings.`)),
        ...(batchReviews?.pending ?? []).map((range) => `Batch review ${range}: waiting on the reviewer's verdict.`),
        ...(batchReviewDue
            ? [`Batch review due over ${batchReviewDue.shaRange}: call flywheel_review(action="batch_review", shaRange="${batchReviewDue.shaRange}") and hand its prompt to one reviewer while this wave runs.`]
            : []),
    ];
    const batchFields = {
        ...(batchReviewDue ? { nextStep: batchReviewDue } : {}),
        ...(batchReviews ? { batchReviews } : {}),
    };
    // Step 2: get ready beads for the next wave
    let ready;
    try {
        ready = await readyBeads(exec, cwd);
    }
    catch (err) {
        const classified = classifyExecError(err);
        log.error('readyBeads threw', { err: String(err), code: classified.code });
        return makeToolError('flywheel_advance_wave', state.phase, classified.code, `Error reading next frontier: ${classified.cause}`, {
            retryable: classified.retryable,
            hint: 'Check that br CLI is installed and operational, then retry.',
        });
    }
    const programWarnings = [];
    if (ready.length > 0) {
        const expectedLabel = state.beadProgramScope?.label ??
            (state.selectedGoal ? goalBeadProgramLabel(state.selectedGoal) : undefined);
        if (!expectedLabel) {
            return makeToolError('flywheel_advance_wave', state.phase, 'missing_prerequisite', 'Cannot dispatch the next wave because no selected goal or goal-program scope is recorded.', { hint: 'Call flywheel_select, then flywheel_approve_beads, before advancing a wave.' });
        }
        const resolvedProgram = await resolveDispatchBeadProgramScope(exec, cwd, state.beadProgramScope, expectedLabel, signal);
        if (!resolvedProgram.ok) {
            return makeToolError('flywheel_advance_wave', state.phase, resolvedProgram.code, resolvedProgram.message, {
                details: resolvedProgram.details,
                hint: 'Run `br list --all --limit 0 --json` manually, fix the CLI or JSON error, then retry.',
            });
        }
        if (state.beadProgramScope?.kind !== resolvedProgram.scope.kind ||
            state.beadProgramScope.label !== resolvedProgram.scope.label) {
            state.beadProgramScope = resolvedProgram.scope;
            saveState(state);
        }
        programWarnings.push(...resolvedProgram.warnings);
    }
    const scopedFrontier = filterBeadsForProgram(ready, state.beadProgramScope);
    ready = scopedFrontier.beads;
    programWarnings.push(...scopedFrontier.warnings);
    const formattedProgramWarnings = formatBeadProgramWarnings([...new Set(programWarnings)]);
    if (ready.length === 0) {
        const outcome = {
            verification,
            nextWave: null,
            waveComplete: true,
            needsEvidence,
            convergence: convergenceRec,
            ...batchFields,
        };
        return okResult(state.phase, [`Wave verified. Queue drained — no more beads to dispatch.${formattedProgramWarnings}`, ...reviewLines].join('\n'), outcome);
    }
    // Step 3: determine wave size from composition tier
    const composition = recommendComposition(ready.length);
    const maxWave = args.maxNextWave ?? composition.total;
    const waveCandidates = ready.slice(0, maxWave);
    const dispatch = await buildImplementerDispatch({
        exec,
        cwd,
        signal,
        beads: waveCandidates,
        coordinatorName: args.coordinatorName ?? 'Coordinator',
    });
    if (dispatch.prompts.length !== waveCandidates.length) {
        return makeToolError('flywheel_advance_wave', state.phase, 'cli_not_available', 'No implementation CLI is available for the next wave.', {
            details: { warnings: dispatch.warnings },
            hint: 'Install at least one of claude, codex, or pi, then retry flywheel_advance_wave.',
        });
    }
    const outcome = {
        verification,
        nextWave: {
            beadIds: waveCandidates.map((b) => b.id),
            ...dispatch,
        },
        waveComplete: true,
        needsEvidence,
        convergence: convergenceRec,
        ...batchFields,
    };
    const lines = [
        `Wave verified (${verification.verified.length}/${args.closedBeadIds.length} closed).`,
    ];
    if (formattedProgramWarnings)
        lines.push(formattedProgramWarnings.trim());
    if (needsEvidence) {
        if (verification.missingEvidence.length > 0) {
            lines.push(`⚠️  ${verification.missingEvidence.length} bead(s) advanced without completion attestation (Stage 1 warn-only — set FW_ATTESTATION_REQUIRED=1 to block).`);
        }
        if (verification.invalidEvidence.length > 0) {
            lines.push(`⚠️  ${verification.invalidEvidence.length} bead(s) advanced with invalid completion attestation (Stage 1 warn-only — set FW_ATTESTATION_REQUIRED=1 to block).`);
        }
    }
    if (convergenceRec.armed && convergenceRec.score !== null) {
        lines.push(`Convergence: score=${convergenceRec.score.toFixed(2)} (${convergenceRec.status}) — auto-approve recommended for the next-wave AskUserQuestion (operator still picks; never silent).`);
    }
    else if (convergenceRec.reason === 'kill_switch_off') {
        lines.push('Convergence gating disabled (flywheel.config.yaml > convergence.gate_advance_wave=false).');
    }
    else if (convergenceRec.score !== null) {
        lines.push(`Convergence: score=${convergenceRec.score.toFixed(2)} (${convergenceRec.status}) — below auto-approve threshold; operator picks normally.`);
    }
    if (dispatch.warnings.length > 0)
        lines.push(...dispatch.warnings.map((warning) => `Warning: ${warning}`));
    lines.push(`Next wave: ${waveCandidates.length} bead(s) dispatched across ${dispatch.lanes.length} lane(s).`);
    lines.push(...dispatch.prompts.map((prompt) => (`  - ${prompt.beadId} → ${prompt.lane} (${dispatch.complexity[prompt.beadId]})`)));
    lines.push(...reviewLines);
    return okResult(state.phase, lines.join('\n'), outcome);
}
//# sourceMappingURL=advance-wave.js.map