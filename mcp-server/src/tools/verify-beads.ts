import type { McpToolResult, ToolContext, VerifyBeadsArgs } from '../types.js';
import { verifyBeadsClosed, type BeadStraggler } from '../beads.js';
import { makeOkToolResult, makeToolError } from './shared.js';
import { classifyExecError } from '../errors.js';
import { createLogger } from '../logger.js';
import { readCompletionReport, validateCompletionReport } from '../completion-report.js';

const log = createLogger('verify-beads');

/**
 * One entry per bead whose attestation failed schema or cross-bead validation.
 * `code` is the underlying read/validate error code; downstream `advance-wave`
 * surfaces this in its `attestation_invalid` error envelope.
 */
export type InvalidEvidenceCode =
  | 'invalid_json'
  | 'schema_invalid'
  | 'bead_id_mismatch'
  | 'closed_without_verification'
  | 'path_escapes_cwd'
  | 'status_mismatch';

export interface InvalidEvidenceEntry {
  beadId: string;
  code: InvalidEvidenceCode;
  message: string;
}

export interface VerifyBeadsOutcome {
  /** Bead IDs that `br show` confirms as closed. */
  verified: string[];
  /** Bead IDs that were stragglers but had a matching commit and were auto-closed. */
  autoClosed: Array<{ beadId: string; commit: string }>;
  /** Bead IDs that are still open and have no matching commit — needs human attention. */
  unclosedNoCommit: BeadStraggler[];
  /** Bead IDs whose `br show` failed, mapped to error message. */
  errors: Record<string, string>;
  /**
   * Bead IDs that are closed (or auto-closed) but have no
   * `.pi-flywheel/completion/<beadId>.json` attestation file.
   *
   * Stage 1 surface — `flywheel_advance_wave` warns by default and only blocks
   * when `FW_ATTESTATION_REQUIRED=1`. Empty array means every closed bead has
   * a present attestation file (parse/validation status reported separately
   * in `invalidEvidence`).
   */
  missingEvidence: string[];
  /**
   * Bead IDs whose attestation file exists but failed schema or cross-bead
   * validation. See `InvalidEvidenceEntry.code` for the specific failure.
   *
   * Empty array means every present attestation parsed cleanly and matched
   * its bead.
   */
  invalidEvidence: InvalidEvidenceEntry[];
}

function okResult(phase: string, text: string, data: VerifyBeadsOutcome): McpToolResult {
  return makeOkToolResult('flywheel_verify_beads', phase, text, data);
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
export async function runVerifyBeads(
  ctx: ToolContext,
  args: VerifyBeadsArgs
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  if (!Array.isArray(args.beadIds) || args.beadIds.length === 0) {
    return makeToolError(
      'flywheel_verify_beads',
      state.phase,
      'invalid_input',
      'Error: beadIds must be a non-empty array of bead IDs.',
      { hint: 'Pass beadIds as a non-empty string array — the wave of beads to reconcile (e.g. ["abc-1","abc-2"]).' },
    );
  }

  let report;
  try {
    report = await verifyBeadsClosed(exec, cwd, args.beadIds);
  } catch (err: unknown) {
    const classified = classifyExecError(err);
    log.error('verifyBeadsClosed threw', { err: String(err), code: classified.code });
    return makeToolError(
      'flywheel_verify_beads',
      state.phase,
      classified.code,
      `Error verifying beads: ${classified.cause}`,
      {
        retryable: classified.retryable,
        hint: 'Check that br CLI is installed and beadIds are valid, then retry.',
        details: { beadIds: args.beadIds },
      }
    );
  }

  const verified: string[] = [...report.closed];
  const autoClosed: Array<{ beadId: string; commit: string }> = [];
  const unclosedNoCommit: BeadStraggler[] = [];

  for (const straggler of report.stragglers) {
    const grepResult = await exec(
      'git',
      ['log', `--grep=${straggler.id}`, '--oneline', '-1'],
      { cwd, timeout: 5000, signal }
    );
    const commitLine = grepResult.code === 0 ? grepResult.stdout.trim() : '';
    const commitSha = commitLine.split(/\s+/)[0] ?? '';

    if (commitSha && /^[0-9a-f]{4,40}$/i.test(commitSha)) {
      const updateResult = await exec(
        'br',
        ['update', straggler.id, '--status', 'closed'],
        { cwd, timeout: 5000, signal }
      );
      if (updateResult.code === 0) {
        autoClosed.push({ beadId: straggler.id, commit: commitSha });
        verified.push(straggler.id);
      } else {
        report.errors[straggler.id] = `auto-close failed: ${updateResult.stderr || `exit ${updateResult.code}`}`;
        unclosedNoCommit.push(straggler);
      }
    } else {
      unclosedNoCommit.push(straggler);
    }
  }

  if (autoClosed.length > 0) {
    if (!state.beadResults) state.beadResults = {};
    for (const { beadId, commit } of autoClosed) {
      state.beadResults[beadId] = {
        beadId,
        status: 'success',
        summary: `Auto-closed by flywheel_verify_beads (commit: ${commit.slice(0, 7)})`,
      };
    }
    saveState(state);
  }

  // Attestation evidence — read `.pi-flywheel/completion/<beadId>.json` for
  // every bead the implementor reports closed (whether `br` already confirmed
  // closed or we auto-closed via commit grep). Stragglers without commits are
  // skipped — no implementor has claimed completion yet.
  const missingEvidence: string[] = [];
  const invalidEvidence: InvalidEvidenceEntry[] = [];
  for (const beadId of verified) {
    const read = await readCompletionReport(cwd, beadId);
    if (!read.ok) {
      if (read.error.code === 'not_found') {
        missingEvidence.push(beadId);
      } else {
        invalidEvidence.push({
          beadId,
          code: read.error.code,
          message: read.error.message,
        });
      }
      continue;
    }
    const validated = validateCompletionReport(read.report, { id: beadId }, { cwd });
    if (!validated.ok) {
      const issue = validated.issues[0];
      invalidEvidence.push({
        beadId,
        code: issue.code,
        message: validated.issues.map((i) => i.message).join('; '),
      });
    }
  }

  const outcome: VerifyBeadsOutcome = {
    verified,
    autoClosed,
    unclosedNoCommit,
    errors: report.errors,
    missingEvidence,
    invalidEvidence,
  };

  const lines: string[] = [];
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
  if (missingEvidence.length > 0) {
    lines.push(`⚠️  ${missingEvidence.length} closed bead(s) missing completion attestation:`);
    for (const id of missingEvidence) {
      lines.push(`  - ${id} (.pi-flywheel/completion/${id}.json not found)`);
    }
  }
  if (invalidEvidence.length > 0) {
    lines.push(`⚠️  ${invalidEvidence.length} closed bead(s) with invalid completion attestation:`);
    for (const e of invalidEvidence) {
      lines.push(`  - ${e.beadId}: ${e.code} — ${e.message}`);
    }
  }

  return okResult(state.phase, lines.join('\n'), outcome);
}
