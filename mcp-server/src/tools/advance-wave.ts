import type { McpToolResult, ToolContext, AdvanceWaveArgs, Bead, FlywheelState } from '../types.js';
import type { VerifyBeadsOutcome } from './verify-beads.js';
import { runVerifyBeads } from './verify-beads.js';
import { readyBeads } from '../beads.js';
import { recommendComposition } from '../swarm.js';
import {
  buildImplementerDispatch,
  type ImplementerDispatch,
} from '../adapters/implementer-dispatch.js';
import { makeOkToolResult, makeToolError } from './shared.js';
import { classifyExecError } from '../errors.js';
import { createLogger } from '../logger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCheckpoint } from '../checkpoint.js';
import {
  readConvergenceFromDisk,
  planSlugFromIdentifier,
} from './convergence-tool.js';
import { loadFlywheelConfig } from '../flywheel-config.js';
import { collectWave, handOffWave, resolveSwarmLane, type SwarmHostHandoff } from '../swarm-host.js';
import {
  applyBatchReviewVerdict,
  batchReviewsEnabled,
  countCommitsSinceLastBatchReview,
  shouldTriggerBatchReview,
} from '../commit-batch.js';
import {
  filterBeadsForProgram,
  formatBeadProgramWarnings,
  goalBeadProgramLabel,
  resolveDispatchBeadProgramScope,
} from './bead-program.js';
import {
  appendVerificationLedger,
  assessVerification,
  computePatchId,
  readCompletionReport,
  type VerificationBlock,
} from '../completion-report.js';
import type { ExecFn } from '../exec.js';
import type { CheckpointState } from '../state.js';

const log = createLogger('advance-wave');
const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const PATCH_ID_TIMEOUT_MS = 30_000;

type VerificationFailureCode = 'verification_failed' | 'verification_sha_drift' | 'verification_missing';

export interface VerificationGateFailure {
  beadId: string;
  code: VerificationFailureCode;
  message: string;
}

export interface VerificationGateResult {
  checked: string[];
  failures: VerificationGateFailure[];
  /** Beads whose verified change now sits on different commits with the same patch id. */
  rebased: Array<{ beadId: string; fromHeadSha: string; toHeadSha: string }>;
}

/** Most severe first: a failed verdict outranks a stale one, which outranks none. */
const VERIFICATION_FAILURE_ORDER: VerificationFailureCode[] = [
  'verification_failed',
  'verification_sha_drift',
  'verification_missing',
];

export function isVerificationRequired(state: FlywheelState): boolean {
  return (state as CheckpointState).potetoMode === true ||
    process.env.FW_VERIFICATION_REQUIRED?.trim() === '1';
}

/**
 * The commits that carry a verified bead's change on the current branch.
 * The verified range itself when its head is still an ancestor of HEAD;
 * otherwise (rebase, amend) the commits on HEAD whose message names the bead,
 * from the parent of the oldest to the newest. Null when neither exists.
 */
async function currentBeadRange(
  exec: ExecFn,
  cwd: string,
  beadId: string,
  block: VerificationBlock,
  signal: AbortSignal | undefined,
): Promise<{ baseSha: string; headSha: string } | null> {
  const opts = { cwd, timeout: GIT_TIMEOUT_MS, signal };
  const ancestor = await exec('git', ['merge-base', '--is-ancestor', block.headSha, 'HEAD'], opts);
  if (ancestor.code === 0) return { baseSha: block.baseSha, headSha: block.headSha };

  const logResult = await exec('git', ['log', '--format=%H', '--fixed-strings', `--grep=${beadId}`, 'HEAD'], opts);
  const commits = logResult.code === 0 ? logResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  if (commits.length === 0) return null;
  const parent = await exec('git', ['rev-parse', '--verify', `${commits[commits.length - 1]}^`], opts);
  if (parent.code !== 0) return null;
  return { baseSha: parent.stdout.trim(), headSha: commits[0] };
}

/**
 * Check that every bead carries an independent `verified` verdict that still
 * matches the code on this branch, by patch id, so a rebase keeps the verdict
 * and an edit after verification voids it. Each verdict change this finds
 * (stale, or carried to new commits) is appended to the verification ledger.
 */
export async function checkWaveVerification(opts: {
  exec: ExecFn;
  cwd: string;
  beadIds: string[];
  ledgerPath?: string;
  signal?: AbortSignal;
}): Promise<VerificationGateResult> {
  const { exec, cwd, beadIds, ledgerPath, signal } = opts;
  const failures: VerificationGateFailure[] = [];
  const rebased: VerificationGateResult['rebased'] = [];

  const record = async (beadId: string, verification: VerificationBlock): Promise<void> => {
    try {
      await appendVerificationLedger(cwd, { beadId, verification, recordedAt: new Date().toISOString() }, { ledgerPath });
    } catch (err: unknown) {
      log.warn('verification ledger append failed', { beadId, err: err instanceof Error ? err.message : String(err) });
    }
  };

  for (const beadId of beadIds) {
    const read = await readCompletionReport(cwd, beadId);
    const block = read.ok ? read.report.verification : undefined;
    if (block?.verdict !== 'verified') {
      const assessed = assessVerification(block, { headSha: '', patchId: null });
      if (!assessed.ok) {
        failures.push({
          beadId,
          code: assessed.code,
          message: read.ok ? assessed.message : `no readable completion report (${read.error.code})`,
        });
      }
      continue;
    }

    const range = await currentBeadRange(exec, cwd, beadId, block, signal);
    if (!range) {
      const message = `verified head ${block.headSha} is not on HEAD and no commit on HEAD names ${beadId}`;
      failures.push({ beadId, code: 'verification_sha_drift', message });
      await record(beadId, { ...block, verdict: 'needs-verification', evidence: [message] });
      continue;
    }

    let patchId: string | null;
    try {
      patchId = await computePatchId(exec, cwd, range.baseSha, range.headSha, { timeout: PATCH_ID_TIMEOUT_MS, signal });
    } catch (err: unknown) {
      const message = `could not compute the patch id of ${range.baseSha}..${range.headSha}: ${err instanceof Error ? err.message : String(err)}`;
      failures.push({ beadId, code: 'verification_sha_drift', message });
      continue;
    }

    const assessed = assessVerification(block, { headSha: range.headSha, patchId });
    if (!assessed.ok) {
      failures.push({ beadId, code: assessed.code, message: assessed.message });
      await record(beadId, {
        ...block,
        ...range,
        verdict: 'needs-verification',
        patchId: patchId ?? undefined,
        evidence: [assessed.message],
      });
      continue;
    }
    if (assessed.rebased) {
      rebased.push({ beadId, fromHeadSha: block.headSha, toHeadSha: range.headSha });
      await record(beadId, {
        ...block,
        ...range,
        evidence: [`patch id carried from ${block.headSha} to ${range.headSha} by flywheel_advance_wave`],
      });
    }
  }

  failures.sort((a, b) => VERIFICATION_FAILURE_ORDER.indexOf(a.code) - VERIFICATION_FAILURE_ORDER.indexOf(b.code));
  return { checked: [...beadIds], failures, rebased };
}

export interface AdvanceWaveOutcome {
  verification: VerifyBeadsOutcome;
  nextWave: ({
    beadIds: string[];
  } & ImplementerDispatch) | null;
  waveComplete: boolean;
  /**
   * Stage 1 attestation rollout flag. `true` when one or more closed beads
   * have missing or invalid completion attestation AND the
   * `FW_ATTESTATION_REQUIRED` env var is NOT set. Surfaces the warning to
   * the caller without blocking advance.
   *
   * When `FW_ATTESTATION_REQUIRED=1`, missing/invalid evidence becomes a
   * hard error (`attestation_missing` / `attestation_invalid`) instead.
   */
  needsEvidence: boolean;
  /**
   * Convergence-driven auto-approve recommendation (B-AC2 §12.4).
   *
   * `armed: true` when the active plan's convergence score ≥ 0.90 AND the
   * `flywheel.config.yaml > convergence.gate_advance_wave` kill-switch is on.
   * Per README §Design Philosophy #3 the *decision* is still the operator's
   * — this only surfaces a "Recommended" label for the next-wave question.
   * Never silent advancement.
   */
  convergence?: {
    armed: boolean;
    score: number | null;
    status: string | null;
    reason:
      | 'auto_approve_recommended'
      | 'below_threshold'
      | 'no_state'
      | 'kill_switch_off'
      | 'no_active_plan';
  };
  /**
   * Set when `commitBatchThreshold` commits have landed since the batch-review
   * baseline. The wave still advances: the coordinator dispatches `nextWave`
   * as usual and sends one reviewer over `shaRange` alongside it, via
   * `flywheel_review(action: "batch_review", shaRange)`.
   */
  nextStep?: {
    kind: 'batch_review_due';
    /** HEAD at gate time, the end of the range. */
    reviewSha: string;
    /** `lastBatchReviewSha`, or `cycleStartSha` before the first review. */
    lastBaselineSha: string;
    /** `<lastBaselineSha>..<reviewSha>`, ready to pass to `flywheel_review`. */
    shaRange: string;
  };
  /** Batch reviews this call found in `pendingBatchReviews`: beads filed from
   *  verdicts that landed, and ranges still waiting on their reviewer. */
  /** Set when the swarm runs on another Mac: whether this wave's commits and beads reached it. */
  swarmHost?: SwarmHostHandoff;
  /** Set when poteto mode or `FW_VERIFICATION_REQUIRED=1` ran the verification gate and it passed. */
  verificationGate?: Pick<VerificationGateResult, 'checked' | 'rebased'>;
  batchReviews?: {
    filed: Array<{ shaRange: string; beadIds: string[] }>;
    pending: string[];
  };
}

function isAttestationRequired(): boolean {
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
async function computeConvergenceRecommendation(
  cwd: string,
): Promise<NonNullable<AdvanceWaveOutcome['convergence']>> {
  let killSwitchOn = true;
  try {
    killSwitchOn = loadFlywheelConfig(cwd).convergence.gate_advance_wave;
  } catch {
    killSwitchOn = true;
  }
  if (!killSwitchOn) {
    return { armed: false, score: null, status: null, reason: 'kill_switch_off' };
  }
  let planDocument: string | undefined;
  try {
    const cp = readCheckpoint(cwd);
    planDocument = cp?.envelope.state.planDocument;
  } catch {
    /* no-op */
  }
  if (!planDocument) {
    return { armed: false, score: null, status: null, reason: 'no_active_plan' };
  }
  const slug = planSlugFromIdentifier(planDocument);
  let result;
  try {
    result = await readConvergenceFromDisk(cwd, slug);
  } catch {
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

async function applyLandedBatchReviews(
  cwd: string,
  state: FlywheelState,
  signal: AbortSignal | undefined,
): Promise<AdvanceWaveOutcome['batchReviews']> {
  const ranges = state.pendingBatchReviews ?? [];
  if (ranges.length === 0) return undefined;
  const filed: Array<{ shaRange: string; beadIds: string[] }> = [];
  const pending: string[] = [];
  for (const shaRange of ranges) {
    try {
      const applied = await applyBatchReviewVerdict(cwd, state, shaRange, signal);
      if (applied.kind === 'pending') pending.push(shaRange);
      else filed.push({ shaRange, beadIds: applied.beadIds });
    } catch (err: unknown) {
      log.warn('batch review: filing beads failed; retrying on the next call', {
        shaRange,
        err: err instanceof Error ? err.message : String(err),
      });
      pending.push(shaRange);
    }
  }
  return { filed, pending };
}

async function findDueBatchReview(
  cwd: string,
  state: FlywheelState,
  signal: AbortSignal | undefined,
): Promise<AdvanceWaveOutcome['nextStep']> {
  if (!batchReviewsEnabled(state)) return undefined;
  const baseline = state.lastBatchReviewSha ?? state.cycleStartSha;
  if (!baseline) {
    log.warn('batch-review gate: no lastBatchReviewSha or cycleStartSha to count from; skipping gate');
    return undefined;
  }
  try {
    const count = await countCommitsSinceLastBatchReview(cwd, baseline, signal);
    if (!shouldTriggerBatchReview(state, count)) return undefined;
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS, signal });
    const reviewSha = stdout.trim();
    if (!reviewSha) return undefined;
    return { kind: 'batch_review_due', reviewSha, lastBaselineSha: baseline, shaRange: `${baseline}..${reviewSha}` };
  } catch (err: unknown) {
    log.warn('batch-review gate: git failed; skipping gate', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function okResult(phase: string, text: string, data: AdvanceWaveOutcome): McpToolResult {
  return makeOkToolResult('flywheel_advance_wave', phase, text, data);
}

export async function runAdvanceWave(
  ctx: ToolContext,
  args: AdvanceWaveArgs,
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  if (!Array.isArray(args.closedBeadIds) || args.closedBeadIds.length === 0) {
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'invalid_input',
      'Error: closedBeadIds must be a non-empty array of bead IDs from the completed wave.',
      { hint: 'Pass closedBeadIds as a non-empty string array — the wave of beads to verify before advancing.' },
    );
  }

  // Step 0: the wave ran on a swarm host, so its commits, bead closes, and reports come back first.
  const lane = await resolveSwarmLane(cwd, exec);
  const collected = lane.host ? await collectWave({ cwd, exec, signal }, lane.host) : undefined;
  if (collected && !collected.ok) {
    return makeToolError('flywheel_advance_wave', state.phase, collected.code, collected.message, {
      hint: collected.hint,
      retryable: collected.code === 'cli_failure' || collected.reason === 'host_unreachable',
      details: { reason: collected.reason, ...collected.details },
    });
  }

  // Step 1: verify the completed wave
  const verifyResult = await runVerifyBeads(ctx, { cwd, beadIds: args.closedBeadIds });
  const verification = (verifyResult.structuredContent as any)?.data as VerifyBeadsOutcome | undefined;

  if (!verification || verifyResult.isError) {
    return verifyResult;
  }

  const convergenceRec = await computeConvergenceRecommendation(cwd);

  if (verification.unclosedNoCommit.length > 0) {
    const stragglerIds = verification.unclosedNoCommit.map((s) => s.id);
    const outcome: AdvanceWaveOutcome = {
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
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'attestation_invalid',
      `Cannot advance wave — ${verification.invalidEvidence.length} bead(s) have invalid completion attestation: ${summary}`,
      {
        hint: 'Re-read the offending CompletionReport JSON, fix the schema or invariant violation (e.g. status=closed without beadClosedVerified=true), and rewrite the file before re-invoking flywheel_advance_wave.',
        details: { beadIds: ids, invalidEvidence: verification.invalidEvidence },
      },
    );
  }
  if (verification.missingEvidence.length > 0 && required) {
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'attestation_missing',
      `Cannot advance wave — ${verification.missingEvidence.length} closed bead(s) missing completion attestation: ${verification.missingEvidence.join(', ')}`,
      {
        hint: 'Each closed bead must have a `.pi-flywheel/completion/<beadId>.json` file matching CompletionReportSchemaV1. Have the implementor write the report (see mcp-server/src/completion-report.ts) before re-invoking.',
        details: { beadIds: verification.missingEvidence },
      },
    );
  }
  const needsEvidence =
    !required &&
    (verification.missingEvidence.length > 0 || verification.invalidEvidence.length > 0);

  // Step 1.55: poteto mode / FW_VERIFICATION_REQUIRED=1 — every closed bead
  // needs an independent `verified` verdict that still matches its code.
  let verificationGate: AdvanceWaveOutcome['verificationGate'];
  if (isVerificationRequired(state)) {
    const closedIds = [...new Set([
      ...verification.verified,
      ...verification.autoClosed.map((entry) => entry.beadId),
    ])];
    const gate = await checkWaveVerification({
      exec,
      cwd,
      beadIds: closedIds,
      ledgerPath: (state as CheckpointState).verificationLedgerPath,
      signal,
    });
    if (gate.failures.length > 0) {
      const code = gate.failures[0].code;
      return makeToolError(
        'flywheel_advance_wave',
        state.phase,
        code,
        `Cannot advance wave — ${gate.failures.length} closed bead(s) lack a current verified verdict: ${gate.failures.map((f) => `${f.beadId} (${f.code}: ${f.message})`).join('; ')}`,
        {
          hint: 'Have an independent verifier run flywheel_approve_beads(action: "verify-bead") on each listed bead against the current HEAD, then call flywheel_advance_wave again.',
          details: { failures: gate.failures, rebased: gate.rebased },
        },
      );
    }
    verificationGate = { checked: gate.checked, rebased: gate.rebased };
  }
  const gateFields: Pick<AdvanceWaveOutcome, 'verificationGate'> = verificationGate ? { verificationGate } : {};
  const gateLine = verificationGate
    ? [`Verification gate: ${verificationGate.checked.length} bead(s) verified against HEAD${verificationGate.rebased.length > 0 ? `, ${verificationGate.rebased.length} carried across a rebase by patch id` : ''}.`]
    : [];

  // Step 1.6: file beads from batch-review verdicts that landed since the last
  // call, so they join this wave's frontier without the coordinator asking.
  const batchReviews = await applyLandedBatchReviews(cwd, state, signal);
  if (batchReviews) await saveState(state);

  // Step 1.7: a due batch review rides along with the next wave instead of
  // holding it.
  const batchReviewDue = await findDueBatchReview(cwd, state, signal);
  const reviewLines = [
    ...(batchReviews?.filed ?? []).map(({ shaRange, beadIds }) => (
      beadIds.length > 0
        ? `Batch review ${shaRange}: filed ${beadIds.length} bead(s) from its findings: ${beadIds.join(', ')}.`
        : `Batch review ${shaRange}: no findings.`
    )),
    ...(batchReviews?.pending ?? []).map((range) => `Batch review ${range}: waiting on the reviewer's verdict.`),
    ...(batchReviewDue
      ? [`Batch review due over ${batchReviewDue.shaRange}: call flywheel_review(action="batch_review", shaRange="${batchReviewDue.shaRange}") and hand its prompt to one reviewer while this wave runs.`]
      : []),
  ];
  const batchFields: Pick<AdvanceWaveOutcome, 'nextStep' | 'batchReviews'> = {
    ...(batchReviewDue ? { nextStep: batchReviewDue } : {}),
    ...(batchReviews ? { batchReviews } : {}),
  };

  // Step 2: get ready beads for the next wave
  let ready: Bead[];
  try {
    ready = await readyBeads(exec, cwd);
  } catch (err: unknown) {
    const classified = classifyExecError(err);
    log.error('readyBeads threw', { err: String(err), code: classified.code });
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      classified.code,
      `Error reading next frontier: ${classified.cause}`,
      {
        retryable: classified.retryable,
        hint: 'Check that br CLI is installed and operational, then retry.',
      },
    );
  }
  const programWarnings: string[] = [];
  if (ready.length > 0) {
    const expectedLabel = state.beadProgramScope?.label ??
      (state.selectedGoal ? goalBeadProgramLabel(state.selectedGoal) : undefined);
    if (!expectedLabel) {
      return makeToolError(
        'flywheel_advance_wave',
        state.phase,
        'missing_prerequisite',
        'Cannot dispatch the next wave because no selected goal or goal-program scope is recorded.',
        { hint: 'Call flywheel_select, then flywheel_approve_beads, before advancing a wave.' },
      );
    }
    const resolvedProgram = await resolveDispatchBeadProgramScope(
      exec,
      cwd,
      state.beadProgramScope,
      expectedLabel,
      signal,
    );
    if (!resolvedProgram.ok) {
      return makeToolError(
        'flywheel_advance_wave',
        state.phase,
        resolvedProgram.code,
        resolvedProgram.message,
        {
          details: resolvedProgram.details,
          hint: 'Run `br list --all --limit 0 --json` manually, fix the CLI or JSON error, then retry.',
        },
      );
    }
    if (
      state.beadProgramScope?.kind !== resolvedProgram.scope.kind ||
      state.beadProgramScope.label !== resolvedProgram.scope.label
    ) {
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
    const outcome: AdvanceWaveOutcome = {
      verification,
      nextWave: null,
      waveComplete: true,
      needsEvidence,
      convergence: convergenceRec,
      ...batchFields,
      ...gateFields,
    };
    return okResult(
      state.phase,
      [`Wave verified. Queue drained — no more beads to dispatch.${formattedProgramWarnings}`, ...gateLine, ...reviewLines].join('\n'),
      outcome,
    );
  }

  // Step 3: determine wave size from composition tier
  const composition = recommendComposition(ready.length);
  const maxWave = args.maxNextWave ?? composition.total;
  const waveCandidates = ready.slice(0, maxWave);

  const dispatch = await buildImplementerDispatch({
    exec: lane.exec,
    cwd,
    signal,
    beads: waveCandidates,
    coordinatorName: args.coordinatorName ?? 'Coordinator',
    projectKey: lane.projectKey,
    probeScope: lane.probeScope,
    verifyClaudeLogin: lane.verifyClaudeLogin,
  });
  if (dispatch.prompts.length !== waveCandidates.length) {
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'cli_not_available',
      'No implementation CLI is available for the next wave.',
      {
        details: { warnings: dispatch.warnings },
        hint: 'Install at least one of claude, codex, or pi, then retry flywheel_advance_wave.',
      },
    );
  }

  const swarmHost = lane.host ? await handOffWave({ cwd, exec, signal }, lane.host) : undefined;
  const outcome: AdvanceWaveOutcome = {
    verification,
    nextWave: {
      beadIds: waveCandidates.map((b) => b.id),
      ...dispatch,
    },
    waveComplete: true,
    needsEvidence,
    convergence: convergenceRec,
    ...batchFields,
    ...gateFields,
    ...(swarmHost ? { swarmHost } : {}),
  };

  const lines = [
    `Wave verified (${verification.verified.length}/${args.closedBeadIds.length} closed).`,
    ...gateLine,
  ];
  if (formattedProgramWarnings) lines.push(formattedProgramWarnings.trim());
  if (needsEvidence) {
    if (verification.missingEvidence.length > 0) {
      lines.push(`⚠️  ${verification.missingEvidence.length} bead(s) advanced without completion attestation (Stage 1 warn-only — set FW_ATTESTATION_REQUIRED=1 to block).`);
    }
    if (verification.invalidEvidence.length > 0) {
      lines.push(`⚠️  ${verification.invalidEvidence.length} bead(s) advanced with invalid completion attestation (Stage 1 warn-only — set FW_ATTESTATION_REQUIRED=1 to block).`);
    }
  }
  if (convergenceRec.armed && convergenceRec.score !== null) {
    lines.push(
      `Convergence: score=${convergenceRec.score.toFixed(2)} (${convergenceRec.status}) — auto-approve recommended for the next-wave AskUserQuestion (operator still picks; never silent).`,
    );
  } else if (convergenceRec.reason === 'kill_switch_off') {
    lines.push(
      'Convergence gating disabled (flywheel.config.yaml > convergence.gate_advance_wave=false).',
    );
  } else if (convergenceRec.score !== null) {
    lines.push(
      `Convergence: score=${convergenceRec.score.toFixed(2)} (${convergenceRec.status}) — below auto-approve threshold; operator picks normally.`,
    );
  }
  if (dispatch.warnings.length > 0) lines.push(...dispatch.warnings.map((warning) => `Warning: ${warning}`));
  if (swarmHost) {
    lines.push(swarmHost.synced
      ? `Swarm host ${swarmHost.name}: ${swarmHost.detail}.`
      : `⚠️  The swarm host ${swarmHost.name} didn't get this wave: ${swarmHost.detail}`);
  }
  lines.push(`Next wave: ${waveCandidates.length} bead(s) dispatched across ${dispatch.lanes.length} lane(s).`);
  lines.push(...dispatch.prompts.map((prompt) => (
    `  - ${prompt.beadId} → ${prompt.lane} (${dispatch.complexity[prompt.beadId]})`
  )));
  lines.push(...reviewLines);

  return okResult(state.phase, lines.join('\n'), outcome);
}
