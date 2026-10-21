import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, McpToolResult, Bead, ApproveArgs, ApproveStopReason, FlywheelPhase, ToolNextStep, HotspotMatrix } from '../types.js';
import { computeConvergenceScore, computeBeadQualityScore, formatBeadQualityScore, makeChoiceOption, makeNextToolStep, makeToolResult } from './shared.js';
import { getRefinementModel } from '../model-detection.js';
import { buildBeadCreationPrompt } from './bead-prompt.js';
import { buildImplementerDispatch } from '../adapters/implementer-dispatch.js';
import { handOffWave, resolveSwarmLane } from '../swarm-host.js';
import { errMsg, makeFlywheelErrorResult } from '../errors.js';
import { acquireBeadMutex, releaseBeadMutex, makeConcurrentWriteError } from '../mutex.js';
import { formatSkippedBrRows, parseBrList } from '../parsers.js';
import { computeHotspotMatrix, type HotspotInputBead } from '../plan-simulation.js';
import { runBvRobot } from '../bv-runner.js';
import {
  appendVerificationLedger,
  computePatchId,
  readCompletionReport,
  writeCompletionReport,
} from '../completion-report.js';
import { createLogger } from '../logger.js';
import { normalizeText } from '../utils/text-normalize.js';
import { resolveDuelProvenanceInstructions } from '../duel-provenance.js';
import { auditBeadCreation } from '../beads.js';
import {
  filterBeadsForProgram,
  formatBeadProgramWarnings,
  goalBeadProgramLabel,
  resolveBeadProgram,
} from './bead-program.js';

const log = createLogger('approve');

function planGitDiffReviewPrompt(planText: string): string {
  return `Carefully review this entire plan for me and come up with your best revisions in terms of better architecture, new features, changed features, etc. to make it better, more robust/reliable, more performant, more compelling/useful, etc. For each proposed change, give me your detailed analysis and rationale/justification for why it would make the project better along with the git-diff style change versus the original plan shown below:

${planText}`;
}

function planIntegrationPrompt(planText: string, revisions: string): string {
  return `OK, now integrate these revisions to the markdown plan in-place; use ultrathink and be meticulous. At the end, you can tell me which changes you wholeheartedly agree with, which you somewhat agree with, and which you disagree with:

## Original Plan
${planText}

## Proposed Revisions
${revisions}`;
}

// Module-level bead snapshot for change tracking
type BeadSnapshot = Map<string, { title: string; descFingerprint: string }>;
let _lastBeadSnapshot: BeadSnapshot | undefined;

/**
 * Bead agent-flywheel-plugin-jl5 — cap for the converge-polish loop
 * (July 2026 Complete Guide §6x Polish). The loop also stops early after
 * 2 consecutive zero-change rounds (steady state).
 */
export const MAX_POLISH_ROUNDS = 6;

function descFingerprint(desc: string): string {
  return `${desc.length}:${desc.slice(0, 50)}`;
}

function snapshotBeads(beads: Bead[]): BeadSnapshot {
  const snap: BeadSnapshot = new Map();
  for (const b of beads) {
    snap.set(b.id, { title: b.title, descFingerprint: descFingerprint(b.description) });
  }
  return snap;
}

function countChanges(prev: BeadSnapshot, curr: BeadSnapshot): number {
  let changes = 0;
  for (const id of curr.keys()) if (!prev.has(id)) changes++;
  for (const id of prev.keys()) if (!curr.has(id)) changes++;
  for (const [id, entry] of curr) {
    const old = prev.get(id);
    if (old && (old.title !== entry.title || old.descFingerprint !== entry.descFingerprint)) changes++;
  }
  return changes;
}

type ApprovalTarget = 'plan' | 'beads';
type SizeAssessment = 'too_short' | 'short' | 'detailed';

/**
 * Bead agent-flywheel-plugin-jl5 — widened approve args.
 *
 * `converge-polish` (6x Polish convergence loop) and `verify-bead`
 * (independent SHA + patch-id verification) are handled inside this module.
 * The MCP inputSchema enum in server.ts is intentionally untouched here —
 * the follow-up wiring bead extends it. Callers holding a narrow
 * `ApproveArgs` still satisfy this interface.
 */
export interface ExtendedApproveArgs extends Omit<ApproveArgs, 'action'> {
  action: ApproveArgs['action'] | 'converge-polish' | 'verify-bead';
  /** Required when action='verify-bead': bead whose completion report to verify. */
  beadId?: string;
}

type ApproveStructuredContent = {
  tool: 'flywheel_approve_beads';
  version: 1;
  status: 'ok' | 'error';
  phase: FlywheelPhase;
  approvalTarget: ApprovalTarget;
  nextStep?: ToolNextStep;
  data: Record<string, unknown>;
};

const ADVANCED_ACTIONS = ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'] as const;

function makeApproveResult(
  text: string,
  phase: FlywheelPhase,
  approvalTarget: ApprovalTarget,
  data: Record<string, unknown>,
  nextStep?: ToolNextStep
): McpToolResult<ApproveStructuredContent> {
  return makeToolResult(text, {
    tool: 'flywheel_approve_beads',
    version: 1,
    status: 'ok',
    phase,
    approvalTarget,
    nextStep,
    data,
  });
}

function makeApproveError(
  message: string,
  phase: FlywheelPhase,
  approvalTarget: ApprovalTarget,
  code: 'missing_prerequisite' | 'invalid_input' | 'not_found' | 'cli_failure' | 'cli_not_available' | 'parse_failure' | 'blocked_state' | 'unsupported_action' | 'internal_error' | 'rubric_missing',
  details?: Record<string, unknown>,
  hint?: string,
): McpToolResult<ApproveStructuredContent> {
  const base = makeFlywheelErrorResult('flywheel_approve_beads', phase, {
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(details ? { details } : {}),
  });
  return {
    ...base,
    structuredContent: {
      ...base.structuredContent,
      approvalTarget,
    } as ApproveStructuredContent,
  };
}

function getConvergenceData(state: ToolContext['state'], score: number | undefined): Record<string, unknown> {
  return {
    round: state.polishRound,
    changes: [...state.polishChanges],
    converged: state.polishConverged,
    score,
  };
}

function getQualityData(beads: Bead[]): Record<string, unknown> {
  const beadQuality = computeBeadQualityScore(beads);
  return {
    score: beadQuality.score,
    summary: formatBeadQualityScore(beadQuality),
  };
}

function getSizeAssessment(lineCount: number): SizeAssessment {
  if (lineCount < 300) return 'too_short';
  if (lineCount < 600) return 'short';
  return 'detailed';
}

function readPlanForCreationAudit(cwd: string, planPath: string | undefined): string | undefined {
  if (!planPath) return undefined;
  const absolutePlanPath = planPath.startsWith('/') ? planPath : join(cwd, planPath);
  if (!existsSync(absolutePlanPath)) return undefined;

  try {
    return normalizeText(readFileSync(absolutePlanPath, 'utf8'));
  } catch (error: unknown) {
    log.warn('Unable to read plan for bead creation audit', {
      planPath,
      error: errMsg(error),
    });
    return undefined;
  }
}

function getBeadApprovalData(
  ctx: Pick<ToolContext, 'cwd' | 'state'>,
  beads: Bead[],
  score: number | undefined,
  matrix?: HotspotMatrix,
): Record<string, unknown> {
  const { cwd, state } = ctx;
  const plan = readPlanForCreationAudit(cwd, state.planDocument);

  return {
    activeBeadIds: [...(state.activeBeadIds ?? [])],
    convergence: getConvergenceData(state, score),
    quality: getQualityData(beads),
    creationAudit: auditBeadCreation(plan, beads),
    ...(matrix ? { matrix } : {}),
  };
}

/**
 * Map br CLI beads (which carry a `description` field) into the input shape
 * expected by `computeHotspotMatrix` (which expects `body`).
 *
 * **Gate 1 finding:** without this mapping, every bead enters
 * `computeHotspotMatrix` with `body: undefined` and the matrix silently
 * returns empty rows, causing the coordinator-serial recommendation to be
 * missed. Do not remove this adapter.
 */
export function beadsToHotspotInput(beads: Bead[]): HotspotInputBead[] {
  return beads.map((b) => ({
    id: b.id,
    title: b.title,
    body: b.description, // CRITICAL: description → body (Gate 1)
  }));
}

/**
 * Render a compact text summary of the hotspot matrix — top 3 hot files by
 * contention count. Used in the MCP `content[]` block to surface contention
 * to the user before they pick start/polish/reject.
 */
export function formatHotspotSummary(matrix: HotspotMatrix): string {
  if (matrix.rows.length === 0) {
    return 'No shared-file contention detected across beads.';
  }
  const top = [...matrix.rows]
    .sort((a, b) => b.contentionCount - a.contentionCount || (a.file < b.file ? -1 : 1))
    .slice(0, 3);
  const lines = ['Shared-write contention detected:'];
  for (const row of top) {
    lines.push(
      `  ${row.file} (${row.contentionCount} bead${row.contentionCount === 1 ? '' : 's'}: ${row.beadIds.join(', ')}) — ${row.severity}`,
    );
  }
  lines.push(`Recommendation: ${matrix.recommendation}.`);
  return lines.join('\n');
}

/**
 * Is the hotspot matrix severe enough to warrant the 4-option menu
 * (med/high rows) per the I5 plan spec?
 */
export function shouldOfferCoordinatorSerial(matrix: HotspotMatrix): boolean {
  return matrix.recommendation === 'coordinator-serial' || matrix.maxContention >= 2;
}

/**
 * flywheel_approve_beads — Review and approve bead graph before implementation.
 *
 * action="start"    — Approve beads and launch implementation
 * action="polish"   — Request another refinement round
 * action="reject"   — Reject and stop the flywheel
 * action="advanced" — Advanced refinement (requires advancedAction param)
 */
export async function runApprove(ctx: ToolContext, args: ExtendedApproveArgs): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  if (!state.selectedGoal) {
    return makeApproveError(
      'Error: No goal selected. Call flywheel_select first.',
      state.phase,
      'beads',
      'missing_prerequisite',
      { requiredTool: 'flywheel_select' },
      'Call flywheel_select with the chosen goal before flywheel_approve_beads.',
    );
  }

  // ── v3.13.0 outcome-grading: remediation action (T20) ────────
  // Branches before bead-list refresh because remediation CREATES a new
  // bead from a verdict criterion; existing bead state is irrelevant to
  // the create call. T11 (`_wrapup.md` Step 9.5 Iterate branch) calls
  // this once per failing criterion.
  if (args.action === 'remediate') {
    return handleRemediate(ctx, args);
  }

  // ── Bead agent-flywheel-plugin-jl5: independent verification (TBD) ──
  // Branches before the bead-list refresh like remediate: verification
  // reads a completion report + git state, not the bead graph.
  if (args.action === 'verify-bead') {
    return handleVerifyBead(ctx, args);
  }

  // ── Plan approval mode (when phase is awaiting_plan_approval) ──
  if (
    (state.phase === 'awaiting_plan_approval' || (state.phase === 'planning' && state.planDocument)) &&
    state.planDocument
  ) {
    return handlePlanApproval(ctx, args);
  }

  // ── Bead approval mode ─────────────────────────────────────────
  // Read current beads from br CLI
  const brListResult = await exec('br', ['list', '--all', '--limit', '0', '--json'], { cwd, timeout: 10000, signal });
  if (brListResult.code !== 0) {
    return makeApproveError(
      `Error reading beads: ${brListResult.stderr}\n\nEnsure \`br\` CLI is installed and \`br init\` has been run in this directory.`,
      state.phase,
      'beads',
      'cli_failure',
      {
        command: 'br list --all --limit 0 --json',
        stderr: brListResult.stderr,
      },
      'Install the br CLI and run `br init` in the repo root, then retry flywheel_approve_beads.',
    );
  }

  let allBeads: Bead[] = [];
  let skippedRowWarnings: string[] = [];
  const parsed = parseBrList(brListResult.stdout);
  if (parsed.ok) {
    allBeads = parsed.data;
    skippedRowWarnings = formatSkippedBrRows(parsed.skipped);
    if (parsed.skipped.length > 0) log.warn('Skipped unreadable br list rows', { skipped: parsed.skipped });
  } else {
    log.warn('Failed to parse br list output', { error: parsed.error });
    return makeApproveError(
      `Error: Could not parse br list output: ${parsed.error}`,
      state.phase,
      'beads',
      'parse_failure',
      { command: 'br list --all --limit 0 --json', parseError: parsed.error },
      'Run `br list --all --limit 0 --json` manually to inspect output; upgrade br CLI if the JSON shape drifted.',
    );
  }

  const expectedProgramLabel = state.beadProgramScope?.label ?? goalBeadProgramLabel(state.selectedGoal);
  const program = resolveBeadProgram(allBeads, expectedProgramLabel);
  const beads = program.beads;
  const programWarnings = formatBeadProgramWarnings([...skippedRowWarnings, ...program.warnings]);
  state.beadProgramScope = program.scope;
  if (!beads.some((bead) => bead.id === state.currentBeadId)) {
    state.currentBeadId = null;
  }

  if (beads.length === 0) {
    state.activeBeadIds = [];
    saveState(state);
    return makeApproveResult(
      `No open beads found for ${expectedProgramLabel}. Create beads first using:\n\`\`\`bash\nbr create --title "..." --description "..." --labels "${expectedProgramLabel}"\n\`\`\`${programWarnings}\n\nThen call \`flywheel_approve_beads\` again.`,
      state.phase,
      'beads',
      {
        kind: 'beads_missing',
        activeBeadIds: [],
        readyForApproval: false,
      },
      makeNextToolStep('run_cli', 'Create at least one open bead with br create before returning to flywheel_approve_beads.')
    );
  }

  // Track polish round changes
  const isRefining = state.phase === 'refining_beads';
  if (isRefining) {
    const currentSnapshot = snapshotBeads(beads);
    if (_lastBeadSnapshot) {
      const changes = countChanges(_lastBeadSnapshot, currentSnapshot);
      state.polishChanges.push(changes);
      if (!state.polishOutputSizes) state.polishOutputSizes = [];
      state.polishOutputSizes.push(beads.reduce((s, b) => s + b.description.length, 0));
      state.polishRound++;
      if (state.polishChanges.length >= 2) {
        const pc = state.polishChanges;
        state.polishConverged = pc[pc.length - 1] === 0 && pc[pc.length - 2] === 0;
      }
    }
    _lastBeadSnapshot = currentSnapshot;
  } else if (!_lastBeadSnapshot) {
    _lastBeadSnapshot = snapshotBeads(beads);
  }

  state.activeBeadIds = beads.map(b => b.id);
  state.phase = 'awaiting_bead_approval';
  saveState(state);

  // Compute hotspot matrix (I5). Bead.description → HotspotInputBead.body
  // adapter is REQUIRED — see beadsToHotspotInput docstring / Gate 1 finding.
  const matrix = computeHotspotMatrix(beadsToHotspotInput(beads));

  const round = state.polishRound;
  const convergenceScore = state.polishChanges.length >= 3
    ? computeConvergenceScore(state.polishChanges, state.polishOutputSizes)
    : undefined;

  if (convergenceScore !== undefined) {
    state.polishConvergenceScore = convergenceScore;
    saveState(state);
  }

  // Format bead list
  const beadList = formatBeadList(beads);
  const changesInfo = state.polishChanges.length > 0
    ? `\nPolish history: ${state.polishChanges.map((n, i) => `R${i + 1}: ${n} change${n !== 1 ? 's' : ''}`).join(', ')}`
    : '';
  // Polish-round header: convergence is primary, quality shown alongside so
  // operators see both numbers move (or don't) round-to-round.
  const headlineQuality = computeBeadQualityScore(beads);
  const convergenceInfo = convergenceScore !== undefined
    ? `\n📈 **Convergence ${(convergenceScore * 100).toFixed(0)} / Quality ${(headlineQuality.score * 100).toFixed(0)}** — ${
        convergenceScore >= 0.75
          ? '✅ diminishing returns, ready to implement'
          : convergenceScore >= 0.50
          ? 'still converging, another round recommended'
          : 'low convergence, more polishing needed'
      }`
    : '';
  const roundHeader = round > 0
    ? `\nPolish round ${round}${changesInfo}${convergenceInfo}${state.polishConverged ? '\nSteady-state reached.' : ''}`
    : '';

  // ── Polish bounds (P2.4 / 2p5) ────────────────────────────────
  // Compute defaults at the call site so tests can override per-call.
  const untilConvergence = args.until_convergence_score ?? 0.85;
  const maxRounds = args.max_rounds ?? 5;

  // ── Handle action ─────────────────────────────────────────────
  if (args.action === 'reject') {
    _lastBeadSnapshot = undefined;
    state.phase = 'idle';
    saveState(state);
    return makeApproveResult(
      'Beads rejected. Flywheel stopped. Call `flywheel_profile` to start over.',
      state.phase,
      'beads',
      {
        kind: 'approval_rejected',
        action: 'reject',
        stop_reason: 'manual_reject' satisfies ApproveStopReason,
        activeBeadIds: [],
      },
      makeNextToolStep('call_tool', 'Restart flywheel from profiling if you want to try again.', {
        tool: 'flywheel_profile',
      })
    );
  }

  if (args.action === 'polish') {
    // Auto-bound the polish loop. Two stop conditions:
    //   1. convergence ≥ until_convergence_score → convergence_reached
    //   2. polishRound ≥ max_rounds              → max_rounds_hit
    // When either trips, route the operator to `action: start` instead of
    // scheduling another (wasteful) polish round. The stop_reason is
    // surfaced verbatim so callers can decide programmatically whether to
    // start, reject, or override with a higher max_rounds.
    if (convergenceScore !== undefined && convergenceScore >= untilConvergence) {
      return makeApproveResult(
        `**Polish bound reached: convergence ${(convergenceScore * 100).toFixed(0)} ≥ ${(untilConvergence * 100).toFixed(0)}.** Skipping further polish rounds.${roundHeader}\n\nNEXT: call \`flywheel_approve_beads\` with action="start" to launch implementation, or pass a higher \`until_convergence_score\` to keep polishing.`,
        state.phase,
        'beads',
        {
          kind: 'polish_bound_reached',
          action: 'polish',
          stop_reason: 'convergence_reached' satisfies ApproveStopReason,
          convergenceScore,
          untilConvergence,
          maxRounds,
          round,
          activeBeadIds: state.activeBeadIds,
        },
        makeNextToolStep('call_tool', 'Polish loop converged — start implementation.', {
          tool: 'flywheel_approve_beads',
          argsSchemaHint: { action: 'start' },
        }),
      );
    }
    if (round >= maxRounds) {
      return makeApproveResult(
        `**Polish bound reached: round ${round} ≥ max_rounds ${maxRounds}.** Skipping further polish rounds.${roundHeader}\n\nNEXT: call \`flywheel_approve_beads\` with action="start" to launch implementation, or pass a higher \`max_rounds\` to keep polishing.`,
        state.phase,
        'beads',
        {
          kind: 'polish_bound_reached',
          action: 'polish',
          stop_reason: 'max_rounds_hit' satisfies ApproveStopReason,
          convergenceScore,
          untilConvergence,
          maxRounds,
          round,
          activeBeadIds: state.activeBeadIds,
        },
        makeNextToolStep('call_tool', 'Polish loop hit max_rounds — start implementation.', {
          tool: 'flywheel_approve_beads',
          argsSchemaHint: { action: 'start' },
        }),
      );
    }
    return handlePolish(ctx, beads, round, false, matrix);
  }

  if (args.action === 'advanced') {
    return handleAdvanced(ctx, beads, round, args.advancedAction, matrix);
  }

  // ── Bead agent-flywheel-plugin-jl5: 6x Polish convergence loop ──
  if (args.action === 'converge-polish') {
    return handleConvergePolish(ctx, beads);
  }

  // action === 'start' — launch implementation. stop_reason is "manual_start"
  // because the polish loop was terminated by an explicit operator decision.
  return handleStart(
    ctx,
    beads,
    roundHeader,
    beadList,
    convergenceScore,
    matrix,
    args.coordinatorName ?? 'Coordinator',
    programWarnings,
  );
}

async function handlePlanApproval(ctx: ToolContext, args: ExtendedApproveArgs): Promise<McpToolResult> {
  const { cwd, state, saveState } = ctx;
  const planPath = state.planDocument!;

  // Try to read the plan from docs/plans/ first, then cwd-relative
  let plan = '';
  const absPath = planPath.startsWith('/') ? planPath : join(cwd, planPath);
  if (existsSync(absPath)) {
    plan = normalizeText(readFileSync(absPath, 'utf8'));
  } else {
    return makeApproveError(
      `Error: Plan document not found at \`${planPath}\`.\n\nGenerate the plan first using \`flywheel_plan\`, then call \`flywheel_approve_beads\` again.`,
      state.phase,
      'plan',
      'not_found',
      { planDocument: planPath },
      'Run flywheel_plan to generate the plan document, then retry flywheel_approve_beads.',
    );
  }

  const lineCount = plan.split('\n').length;
  const planRound = state.planRefinementRound ?? 0;
  const sizeAssessment = getSizeAssessment(lineCount);

  const sizeGate = lineCount < 100
    ? `\nPlan too short (${lineCount} lines) — needs substantial content before creating beads.`
    : lineCount < 300
    ? `\nPlan is short (${lineCount} lines) — consider adding more detail.`
    : `\nPlan length: ${lineCount} lines.`;

  if (args.action === 'reject') {
    state.planDocument = undefined;
    state.planRefinementRound = 0;
    state.phase = 'idle';
    saveState(state);
    return makeApproveResult(
      'Plan rejected. Flywheel stopped.',
      state.phase,
      'plan',
      {
        kind: 'approval_rejected',
        action: 'reject',
        planDocument: undefined,
      }
    );
  }

  if (args.action === 'git-diff-review') {
    state.phase = 'planning';
    state.planRefinementRound = planRound + 1;
    saveState(state);

    const reviewPrompt = planGitDiffReviewPrompt(plan);
    const integrationHint = `After collecting the reviewer's proposed revisions, call \`flywheel_approve_beads\` again — the tool will then prompt you to integrate them using \`planIntegrationPrompt\`.`;
    return makeApproveResult(
      `**📝 Git-diff review pass (round ${planRound + 1})**\n\nSpawn a fresh reviewer agent with this prompt:\n\n---\n${reviewPrompt}\n---\n\nCollect the reviewer's proposed changes. Then spawn an integration agent with:\n\`\`\`\n${planIntegrationPrompt('<original plan from ' + planPath + '>', '<reviewer proposed revisions>')}\n\`\`\`\n\nHave the integration agent save the merged plan back to \`${planPath}\`, then call \`flywheel_approve_beads\` again.\n\n${sizeGate}\n\n${integrationHint}`,
      state.phase,
      'plan',
      {
        kind: 'plan_refinement_requested',
        action: 'git-diff-review',
        planDocument: planPath,
        lineCount,
        sizeAssessment,
        planRefinementRound: state.planRefinementRound,
        refinementModel: undefined,
      },
      makeNextToolStep('spawn_agents', 'Run the git-diff plan review and integration cycle, then return to flywheel_approve_beads.')
    );
  }

  if (args.action === 'polish') {
    state.phase = 'planning';
    state.planRefinementRound = planRound + 1;
    saveState(state);

    const refinementModel = getRefinementModel(planRound);
    return makeApproveResult(
      `**NEXT: Refine the plan (round ${planRound + 1}) using model \`${refinementModel}\`.**\n\nRead the plan at \`${planPath}\`, critique it, and improve it. Focus on:\n- Missing implementation details\n- Underspecified acceptance criteria\n- Gaps in testing strategy\n- Edge cases not covered\n\nAfter improving, save the updated plan back to \`${planPath}\`, then call \`flywheel_approve_beads\` again.\n\nAlternatively, use \`action: "git-diff-review"\` for a git-diff style review cycle that proposes targeted changes with rationale.\n\n${sizeGate}`,
      state.phase,
      'plan',
      {
        kind: 'plan_refinement_requested',
        action: 'polish',
        planDocument: planPath,
        lineCount,
        sizeAssessment,
        planRefinementRound: state.planRefinementRound,
        refinementModel,
      },
      makeNextToolStep('generate_artifact', 'Revise the existing plan document and save it back before returning to flywheel_approve_beads.')
    );
  }

  // action === 'start' — approve plan and transition to bead creation
  state.phase = 'creating_beads';
  state.planRefinementRound = 0;
  saveState(state);

  const beadPrompt = buildPlanToBeadsPrompt(plan, state.selectedGoal!, planPath, state);

  return makeApproveResult(
    `**Plan approved!** (${lineCount} lines)${sizeGate}\n\n**NEXT: Create beads from the plan using \`br create\` and \`br dep add\`, then call \`flywheel_approve_beads\` with action="start" to launch implementation.**\n\n---\n\n${beadPrompt}`,
    state.phase,
    'plan',
    {
      kind: 'plan_approved',
      planDocument: planPath,
      lineCount,
      sizeAssessment,
      planRefinementRound: state.planRefinementRound,
      readyForBeadCreation: true,
    },
    makeNextToolStep('run_cli', 'Create beads from the approved plan with br create / br dep add, then return to flywheel_approve_beads action="start".')
  );
}

function buildPlanToBeadsPrompt(
  plan: string,
  goal: string,
  planPath: string,
  state: ToolContext['state'],
): string {
  const preview = plan.slice(0, 2000) + (plan.length > 2000 ? '\n...(read full plan from file)' : '');
  const provenance = resolveDuelProvenanceInstructions(state, { path: planPath, content: plan });
  return buildBeadCreationPrompt({
    goal,
    planPath,
    planPreview: preview,
    provenance,
    nextAction: `After creating all beads, call \`flywheel_approve_beads\` with action="start" to review and launch.`,
  });
}

async function handleStart(
  ctx: ToolContext,
  beads: Bead[],
  roundHeader: string,
  beadList: string,
  convergenceScore: number | undefined,
  matrix: HotspotMatrix,
  coordinatorName: string,
  programWarnings: string,
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  // Get ready beads (unblocked by dependencies)
  const brReadyResult = await exec('br', ['ready', '--limit', '0', '--json'], { cwd, timeout: 10000, signal });
  let ready: Bead[] = [];

  if (brReadyResult.code === 0) {
    const readyParsed = parseBrList(brReadyResult.stdout);
    if (readyParsed.ok) {
      ready = filterBeadsForProgram(readyParsed.data, state.beadProgramScope).beads;
      if (readyParsed.skipped.length > 0) log.warn('Skipped unreadable br ready rows', { skipped: readyParsed.skipped });
    } else {
      log.warn('Failed to parse br ready output', { error: readyParsed.error });
    }
  }

  if (ready.length === 0) {
    return makeApproveResult(
      `Beads approved! But no ready beads found for this goal (all may be blocked).${programWarnings}\n\nRun \`br ready\` or \`br dep cycles\` to diagnose.\n\n${beadList}`,
      state.phase,
      'beads',
      {
        kind: 'beads_approved',
        launchMode: 'blocked',
        readyCount: 0,
        currentBeadId: undefined,
        readyBeads: [],
        ...getBeadApprovalData(ctx, beads, convergenceScore, matrix),
        readiness: {
          blocked: true,
          message: 'No ready beads found after approval.',
        },
      },
      makeNextToolStep('run_cli', 'Diagnose blocked beads with br ready or br dep cycles, then return to flywheel_approve_beads.')
    );
  }

  const lane = await resolveSwarmLane(cwd, exec);
  const dispatch = await buildImplementerDispatch({
    exec: lane.exec,
    cwd,
    signal,
    beads: ready,
    coordinatorName,
    projectKey: lane.projectKey,
    probeScope: lane.probeScope,
    verifyClaudeLogin: lane.verifyClaudeLogin,
  });
  if (dispatch.prompts.length !== ready.length) {
    return makeApproveError(
      'No implementation CLI is available for the first wave.',
      state.phase,
      'beads',
      'cli_not_available',
      { warnings: dispatch.warnings },
      'Install at least one of claude, codex, or pi, then retry flywheel_approve_beads.',
    );
  }

  const promptByBeadId = new Map(
    dispatch.prompts.map((prompt) => [prompt.beadId, prompt]),
  );
  const promptFor = (beadId: string) => {
    const prompt = promptByBeadId.get(beadId);
    if (!prompt) throw new Error(`missing implementer prompt for bead ${beadId}`);
    return prompt;
  };
  const dispatchData = {
    lanes: dispatch.lanes,
    prompts: dispatch.prompts,
    dispatch: {
      degraded: dispatch.degraded,
      warnings: dispatch.warnings,
    },
  };

  // Acquire per-cwd mutex for the start action
  const mutexKey = `approve-start:${cwd}`;
  if (!acquireBeadMutex(mutexKey)) {
    return makeConcurrentWriteError('flywheel_approve_beads', state.phase, mutexKey);
  }

  try {
    // Mark ready beads as in_progress with partial rollback on failure
    const transitioned: string[] = [];
    for (const bead of ready) {
      const updateResult = await exec('br', ['update', bead.id, '--status', 'in_progress'], { cwd, timeout: 5000, signal });
      if (updateResult.code !== 0) {
        // Rollback already-transitioned beads
        for (const id of transitioned) {
          await exec('br', ['update', id, '--status', 'open'], { cwd, timeout: 5000, signal });
        }
        return makeApproveError(
          `Failed to mark bead ${bead.id} as in_progress: ${updateResult.stderr || `exit ${updateResult.code}`}. Rolled back ${transitioned.length} bead(s).`,
          state.phase,
          'beads',
          'cli_failure',
          {
            failedBeadId: bead.id,
            rolledBack: transitioned,
            stderr: updateResult.stderr,
          },
          'Run `br update <id> --status in_progress` manually to inspect the failure, then retry flywheel_approve_beads.',
        );
      }
      transitioned.push(bead.id);
    }

    _lastBeadSnapshot = undefined;
    state.beadResults = {};
    state.beadReviews = {};
    state.beadReviewPassCounts = {};
    state.beadHitMeTriggered = {};
    state.beadHitMeCompleted = {};
    state.iterationRound = 0;
    state.currentGateIndex = 0;
    state.phase = 'implementing';
    state.currentBeadId = ready[0].id;
    saveState(state);
  } finally {
    releaseBeadMutex(mutexKey);
  }
  // The panes read beads and code from the host's clone, so it gets the in_progress marks too.
  const swarmHost = lane.host ? await handOffWave({ cwd, exec, signal }, lane.host) : undefined;
  const hostNote = swarmHost && !swarmHost.synced
    ? `\n\n⚠️ The swarm host ${swarmHost.name} didn't get this wave: ${swarmHost.detail}`
    : '';

  // Headline polish metric: convergence is the truth signal (does another
  // round actually move the bead set?). Quality is a heuristic floor that
  // can plateau even when convergence is high — surface both, lead with
  // convergence when defined. The 3-weakest list moves to a footnote so
  // operators don't mistake it for a gating signal (P1.1).
  const beadQuality = computeBeadQualityScore(beads);
  const qualityPct = (beadQuality.score * 100).toFixed(0);
  const headlineNote = convergenceScore !== undefined
    ? `\n📈 **Convergence ${(convergenceScore * 100).toFixed(0)} / Quality ${qualityPct}** ${
        convergenceScore >= 0.75 ? '✅' : convergenceScore >= 0.50 ? '(converging)' : '(low)'
      } ${beadQuality.label}`
    : `\n📊 **Quality ${qualityPct}** ${beadQuality.label}`;
  const weakBeadFootnote = beadQuality.weakBeads.length > 0
    ? `\n   _3 weakest: ${beadQuality.weakBeads.slice(0, 3).join(' | ')}_`
    : '';
  const convergenceNote = headlineNote;
  const qualityNote = weakBeadFootnote;

  // Hotspot matrix summary (I5). Shown when contention is med/high; otherwise
  // the line is omitted so the legacy-friendly output stays compact.
  const offerCoordinatorSerial = shouldOfferCoordinatorSerial(matrix);
  const hotspotNote = offerCoordinatorSerial ? `\n\n${formatHotspotSummary(matrix)}` : '';

  if (ready.length === 1) {
    const bead = ready[0];
    return makeApproveResult(
      `**Beads approved!** ${beads.length} total.${convergenceNote}${qualityNote}${roundHeader}${programWarnings}${hostNote}

**NEXT: Send \`data.prompts[0].prompt\` as-is to the \`${promptFor(bead.id).lane}\` implementation lane, then call \`flywheel_review\` when it finishes.**

${beadList}`,
      state.phase,
      'beads',
      {
        kind: 'beads_approved',
        launchMode: 'sequential',
        readyCount: 1,
        currentBeadId: state.currentBeadId,
        stop_reason: 'manual_start' satisfies ApproveStopReason,
        readyBeads: [{
          id: bead.id,
          title: bead.title,
          launchInstruction: 'implement',
          agentName: promptFor(bead.id).agentName,
        }],
        ...dispatchData,
        ...(swarmHost ? { swarmHost } : {}),
        ...getBeadApprovalData(ctx, beads, convergenceScore, matrix),
      },
      makeNextToolStep('spawn_agents', 'Send the server-built prompt to one implementation pane, then call flywheel_review with its summary.')
    );
  }

  // 4-option menu when contention warrants it; otherwise legacy spawn-parallel nextStep.
  const nextStep = offerCoordinatorSerial
    ? makeNextToolStep(
        'present_choices',
        'Shared-file contention detected across ready beads — pick a launch mode.',
        {
          options: [
            makeChoiceOption(
              'approve-beads-coordinator-serial',
              'Coordinator-serial launch (one bead at a time, contention-safe)',
              {
                tool: 'flywheel_approve_beads',
                args: { action: 'start' },
              },
            ),
            makeChoiceOption(
              'approve-beads-swarm',
              'Swarm (parallel — ignore contention)',
              {
                tool: 'flywheel_approve_beads',
                args: { action: 'start' },
              },
            ),
            makeChoiceOption('approve-beads-polish', 'Polish (refine beads to remove overlap)', {
              tool: 'flywheel_approve_beads',
              args: { action: 'polish' },
            }),
            makeChoiceOption('approve-beads-reject', 'Reject (stop flywheel)', {
              tool: 'flywheel_approve_beads',
              args: { action: 'reject' },
            }),
          ],
        },
      )
    : makeNextToolStep(
        'spawn_agents',
        'Spawn one implementation agent per ready bead, then call flywheel_review for each completed bead.',
      );

  return makeApproveResult(
    `**Beads approved!** ${beads.length} total, ${ready.length} ready now.${convergenceNote}${qualityNote}${roundHeader}${hotspotNote}${programWarnings}${hostNote}

**NEXT: Spawn the counts in \`data.lanes\`, send each \`data.prompts[].prompt\` as-is to its lane, then call \`flywheel_review\` for each completed bead.**

${beadList}`,
    state.phase,
    'beads',
    {
      kind: 'beads_approved',
      launchMode: 'parallel',
      readyCount: ready.length,
      currentBeadId: state.currentBeadId,
      stop_reason: 'manual_start' satisfies ApproveStopReason,
      readyBeads: ready.map((bead) => ({
        id: bead.id,
        title: bead.title,
        launchInstruction: 'spawn-agent',
        agentName: promptFor(bead.id).agentName,
      })),
      ...dispatchData,
      ...(swarmHost ? { swarmHost } : {}),
      ...getBeadApprovalData(ctx, beads, convergenceScore, matrix),
    },
    nextStep,
  );
}

function handlePolish(ctx: ToolContext, beads: Bead[], round: number, fresh: boolean, matrix?: HotspotMatrix): McpToolResult {
  const { cwd, state, saveState } = ctx;
  state.phase = 'refining_beads';
  saveState(state);

  const model = getRefinementModel(round);
  const compactList = beads.map(b => `• ${b.id}: ${b.title}`).join('\n');
  const sharedData = {
    kind: 'bead_refinement_requested',
    action: 'polish',
    refinementMode: fresh ? 'fresh-agent' : 'same-agent',
    ...getBeadApprovalData(ctx, beads, state.polishConvergenceScore, matrix),
    advancedActions: [...ADVANCED_ACTIONS],
  };

  if (fresh) {
    return makeApproveResult(
      `**NEXT: Spawn a fresh refinement agent (round ${round + 1}), then call \`flywheel_approve_beads\` with action="start" or action="polish" again.**

Use model \`${model}\` for diverse perspective (prevents taste convergence).

The agent should:
1. Run \`br list --json\` to read all beads
2. Review each bead for WHAT/WHY/HOW completeness
3. Use \`br update <id> --description "..."\` to improve weak beads
4. Check for missing dependencies with \`br dep list <id>\`

Current beads (${beads.length} total):\n${compactList}\n\ncd ${cwd}`,
      state.phase,
      'beads',
      sharedData,
      makeNextToolStep('spawn_agents', 'Spawn a fresh refinement agent, update the bead graph, then return to flywheel_approve_beads.')
    );
  }

  return makeApproveResult(
    `**NEXT: Review and refine the beads (round ${round + 1}), then call \`flywheel_approve_beads\` again.**

For each bead, check:
- WHAT: Are implementation steps concrete and specific?
- WHY: Is the business/technical rationale clear?
- HOW: Are the exact files listed?
- Dependencies: Are dep relationships correct?

Use \`br update <id> --description "..."\` to improve, \`br show <id>\` for details.
Use \`br dep add/remove\` to fix dependency graph.

After refining, call \`flywheel_approve_beads\` with action="start" or action="polish".

Current beads (${beads.length} total):\n${compactList}\n\ncd ${cwd}`,
    state.phase,
    'beads',
    sharedData,
    makeNextToolStep('present_choices', 'Refine the bead graph, then either approve implementation or request another bead refinement pass.', {
      options: [
        makeChoiceOption('approve-beads-start', 'Approve beads and launch implementation', {
          tool: 'flywheel_approve_beads',
          args: { action: 'start' },
        }),
        makeChoiceOption('approve-beads-polish', 'Request another bead refinement round', {
          tool: 'flywheel_approve_beads',
          args: { action: 'polish' },
        }),
      ],
    })
  );
}

function handleAdvanced(
  ctx: ToolContext,
  beads: Bead[],
  round: number,
  advancedAction?: string,
  matrix?: HotspotMatrix,
): McpToolResult {
  const { cwd, state, saveState } = ctx;

  if (!advancedAction) {
    return makeApproveError(
      `Error: advancedAction is required when action="advanced". Options: fresh-agent, same-agent, blunder-hunt, dedup, cross-model, graph-fix`,
      state.phase,
      'beads',
      'invalid_input',
      {
        action: 'advanced',
        validAdvancedActions: [...ADVANCED_ACTIONS],
      },
      'Re-call with action="advanced" and advancedAction set to one of: fresh-agent, same-agent, blunder-hunt, dedup, cross-model, graph-fix.',
    );
  }

  const compactList = beads.map(b => `• ${b.id}: ${b.title}`).join('\n');

  if (advancedAction === 'fresh-agent') {
    return handlePolish(ctx, beads, round, true, matrix);
  }

  if (advancedAction === 'same-agent') {
    return handlePolish(ctx, beads, round, false, matrix);
  }

  if (advancedAction === 'blunder-hunt') {
    state.phase = 'refining_beads';
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**NEXT: Run the pass below and repeat until a pass finds nothing new (at most 5 passes), then call \`flywheel_approve_beads\` again.**

### Blunder Hunt Pass
Read all beads via \`br list --json\`. Look for: incomplete descriptions, missing files, circular dependencies, wrong priorities, vague acceptance criteria. Fix anything suspicious.

cd ${cwd}

Current beads:
${compactList}`,
      }],
    };
  }

  if (advancedAction === 'dedup') {
    state.phase = 'refining_beads';
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**NEXT: Run a deduplication pass on all beads, then call \`flywheel_approve_beads\` again.**

Check all open beads for overlap or redundancy:
1. \`br list --json\` — read all beads
2. For each pair of similar beads: merge the weaker one into the stronger
3. Close duplicates: \`br update <id> --status closed\`
4. Transfer dependencies: \`br dep add <survivor> <deps-of-closed>\` (positional: downstream first, then upstream)

Report what was merged. Then call \`flywheel_approve_beads\`.

cd ${cwd}

Current beads:\n${compactList}`,
      }],
    };
  }

  if (advancedAction === 'cross-model') {
    state.phase = 'refining_beads';
    saveState(state);

    const altModel = getRefinementModel(round + 1);
    return {
      content: [{
        type: 'text',
        text: `**NEXT: Spawn a cross-model review agent using \`${altModel}\`, then call \`flywheel_approve_beads\` again.**

The cross-model agent should:
1. Read all beads: \`br list --json\`
2. Review from a critical, external perspective
3. List specific improvements (not vague suggestions)
4. After the review, apply suggestions via \`br update\`

Current beads:\n${compactList}\n\ncd ${cwd}`,
      }],
    };
  }

  if (advancedAction === 'graph-fix') {
    state.phase = 'refining_beads';
    saveState(state);

    return makeApproveResult(
      `**NEXT: Diagnose and fix the bead dependency graph, then call \`flywheel_approve_beads\` again.**

Check for:
1. **Cycles:** \`br dep cycles\` — if any, remove the cycle-causing dep
2. **Orphans:** Beads with no dependencies that should be grouped
3. **Bottlenecks:** Beads that block many others — consider splitting
4. **Missing deps:** Beads that should depend on others but don't

Fix issues with \`br dep add/remove\`, then call \`flywheel_approve_beads\`.

cd ${cwd}

Current beads:\n${compactList}`,
      state.phase,
      'beads',
      {
        kind: 'bead_refinement_requested',
        action: 'advanced',
        refinementMode: 'graph-fix',
        ...getBeadApprovalData(ctx, beads, state.polishConvergenceScore, matrix),
        advancedActions: [...ADVANCED_ACTIONS],
      },
      makeNextToolStep('run_cli', 'Diagnose and repair bead dependencies with br dep commands, then return to flywheel_approve_beads.')
    );
  }

  return makeApproveError(
    `Unknown advancedAction: "${advancedAction}". Valid options: ${ADVANCED_ACTIONS.join(', ')}.`,
    state.phase,
    'beads',
    'unsupported_action',
    {
      advancedAction,
      validAdvancedActions: [...ADVANCED_ACTIONS],
    },
    `Pass advancedAction as one of: ${ADVANCED_ACTIONS.join(', ')}.`,
  );
}

// ─── v3.13.0 outcome-grading remediation (T20) ───────────────────────────

/**
 * Render the §"Remediation Bead Template" body for one failing criterion.
 * Verbatim from `docs/plans/2026-05-08-outcome-grading-synthesized.md`.
 */
function renderRemediationBeadBody(args: NonNullable<ApproveArgs['remediation']>): string {
  const { planSlug, iteration, criterionId, criterionDescription, status, evidence, gaps } = args;
  const verdictPath = `.pi-flywheel/plans/${planSlug}/grading/iteration-${iteration}.json`;
  const gapLines = gaps.length === 0 ? '- (no gaps recorded — grader returned empty list)' : gaps.map((g) => `- ${g}`).join('\n');
  return [
    '## Source',
    '',
    `- Verdict: \`${verdictPath}\``,
    `- Criterion: \`${criterionId}\``,
    `- Status: \`${status}\``,
    '',
    '## Rubric criterion',
    '',
    criterionDescription,
    '',
    '## Evidence from grader',
    '',
    evidence || '(no evidence recorded — grader returned empty string)',
    '',
    '## Gaps to close',
    '',
    gapLines,
    '',
    '## Acceptance criteria',
    '',
    '- Each listed gap is addressed or explicitly documented as out of scope.',
    '- Relevant tests/build/lint commands pass.',
    `- The next outcome grade marks \`${criterionId}\` as met, or the remaining gap is justified in the verdict.`,
    '',
  ].join('\n');
}

/**
 * Truncate a criterion description to fit a `br create --title` argument.
 * Same shortening rule as bead-creation prompts elsewhere — first line,
 * ≤80 chars total title length.
 */
function shortenForTitle(description: string, maxLen: number): string {
  const firstLine = description.split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= maxLen) return firstLine;
  return `${firstLine.slice(0, maxLen - 1)}…`;
}

async function handleRemediate(
  ctx: ToolContext,
  args: ExtendedApproveArgs,
): Promise<McpToolResult<ApproveStructuredContent>> {
  const { exec, cwd, state, saveState, signal } = ctx;
  const r = args.remediation;

  if (!r) {
    return makeApproveError(
      'Error: action="remediate" requires the `remediation` payload (planSlug, iteration, criterionId, criterionDescription, status, evidence, gaps).',
      state.phase,
      'beads',
      'invalid_input',
      { action: 'remediate' },
      'Pass the `remediation` object built from the failing-criterion verdict; T11 (_wrapup.md Step 9.5 Iterate) renders it from PerCriterionVerdict + rubric.md.',
    );
  }
  if (!r.planSlug || !r.criterionId || !r.criterionDescription) {
    return makeApproveError(
      'Error: remediation.planSlug, remediation.criterionId, and remediation.criterionDescription are all required and non-empty.',
      state.phase,
      'beads',
      'invalid_input',
      {
        action: 'remediate',
        planSlugSet: Boolean(r.planSlug),
        criterionIdSet: Boolean(r.criterionId),
        criterionDescriptionSet: Boolean(r.criterionDescription),
      },
      'Look up the criterion description from .pi-flywheel/plans/<slug>/rubric.md before calling — PerCriterionVerdict carries only the id.',
    );
  }

  const titleHead = `Outcome remediation ${r.criterionId}`;
  const titleTailRoom = Math.max(20, 80 - titleHead.length - 2);
  const title = `${titleHead}: ${shortenForTitle(r.criterionDescription, titleTailRoom)}`;
  const description = renderRemediationBeadBody(r);
  const programLabel = state.beadProgramScope?.kind === 'tagged' || state.beadProgramScope?.kind === 'unresolved'
    ? state.beadProgramScope.label
    : undefined;
  const createArgs = [
    'create',
    '--title', title,
    '--description', description,
    '--priority', '2',
    '--type', 'task',
  ];
  if (programLabel) createArgs.push('--labels', programLabel);

  const create = await exec(
    'br',
    createArgs,
    { cwd, timeout: 10000, signal },
  );
  if (create.code !== 0) {
    return makeApproveError(
      `Error creating remediation bead: ${create.stderr || `exit ${create.code}`}`,
      state.phase,
      'beads',
      'cli_failure',
      {
        command: 'br create (remediation)',
        criterionId: r.criterionId,
        stderr: create.stderr,
      },
      'Run `br list --json` manually; if br is unhealthy fix the CLI before calling action="remediate" again.',
    );
  }

  // Increment iteration round so the next grade call records iteration N+1.
  state.iterationRound = (state.iterationRound ?? 0) + 1;
  saveState(state);

  return makeApproveResult(
    `Remediation bead created for criterion \`${r.criterionId}\` (status: ${r.status}). iterationRound is now ${state.iterationRound}. Repeat with action="remediate" for each remaining failing criterion, then loop back to Step 6 (implementation).`,
    state.phase,
    'beads',
    {
      kind: 'remediation_bead_created',
      action: 'remediate',
      criterionId: r.criterionId,
      planSlug: r.planSlug,
      iteration: r.iteration,
      title,
      iterationRound: state.iterationRound,
    },
    makeNextToolStep(
      'call_tool',
      'Repeat for each remaining failing criterion, then re-run flywheel_approve_beads(action="start") to launch the next implementation wave.',
      {
        tool: 'flywheel_approve_beads',
        argsSchemaHint: { action: 'remediate', remediation: '<failing criterion>' },
      },
    ),
  );
}

// ─── Bead agent-flywheel-plugin-jl5: converge-polish + verify-bead ─────────

const GIT_SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * 6x Polish convergence loop. Each call snapshots the bead graph against
 * the previous call (the bead-mode flow primes the snapshot on first sight,
 * so round 1 already compares). Converges on 2 consecutive zero-change
 * rounds or when polishRound hits MAX_POLISH_ROUNDS. Enriches the response with best-effort `bvInsights`
 * (unavailable bv degrades to a warning, never a failure).
 */
async function handleConvergePolish(ctx: ToolContext, beads: Bead[]): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;
  const currentSnapshot = snapshotBeads(beads);
  if (_lastBeadSnapshot) {
    state.polishChanges.push(countChanges(_lastBeadSnapshot, currentSnapshot));
  }
  _lastBeadSnapshot = currentSnapshot;
  state.polishRound = Math.min((state.polishRound ?? 0) + 1, MAX_POLISH_ROUNDS);

  const pc = state.polishChanges;
  const steadyState = pc.length >= 2 && pc[pc.length - 1] === 0 && pc[pc.length - 2] === 0;
  if (steadyState || state.polishRound >= MAX_POLISH_ROUNDS) {
    state.polishConverged = true;
  }
  saveState(state);

  const bv = await runBvRobot(exec, cwd, 'insights', { signal });
  const quality = computeBeadQualityScore(beads);
  const history = pc.length > 0
    ? pc.map((n, i) => `R${i + 1}: ${n} change${n !== 1 ? 's' : ''}`).join(', ')
    : '(baseline established — no comparison yet)';
  const header = `**Polish round ${state.polishRound}/${MAX_POLISH_ROUNDS}** (${history}) — quality ${(quality.score * 100).toFixed(0)} ${quality.label}`;

  const bvNote = bv.available
    ? `\n\nBV insights attached in \`data.bvInsights\`.`
    : `\n\nBV insights unavailable: ${bv.warning}`;

  if (state.polishConverged) {
    const reason = steadyState ? '2 consecutive zero-change rounds (steady state)' : `round cap ${MAX_POLISH_ROUNDS} reached`;
    return makeApproveResult(
      `${header}\n\n**Polish converged: ${reason}.**${bvNote}\n\nNEXT: call \`flywheel_approve_beads\` with action="start" to launch implementation.`,
      state.phase,
      'beads',
      {
        kind: 'polish_converged',
        action: 'converge-polish',
        stop_reason: (steadyState ? 'convergence_reached' : 'max_rounds_hit') satisfies ApproveStopReason,
        polishRound: state.polishRound,
        polishConverged: true,
        changes: [...pc],
        bvInsights: bv.available ? bv.data : null,
        ...(bv.warning ? { bvWarning: bv.warning } : {}),
        quality: { score: quality.score, summary: formatBeadQualityScore(quality) },
        activeBeadIds: state.activeBeadIds,
      },
      makeNextToolStep('call_tool', 'Polish loop converged — start implementation.', {
        tool: 'flywheel_approve_beads',
        argsSchemaHint: { action: 'start' },
      }),
    );
  }
  return makeApproveResult(
    `${header}${bvNote}\n\nNEXT: refine the beads, then call \`flywheel_approve_beads\` with action="converge-polish" again.`,
    state.phase,
    'beads',
    {
      kind: 'polish_round_complete',
      action: 'converge-polish',
      polishRound: state.polishRound,
      polishConverged: false,
      changes: [...pc],
      bvInsights: bv.available ? bv.data : null,
      ...(bv.warning ? { bvWarning: bv.warning } : {}),
      quality: { score: quality.score, summary: formatBeadQualityScore(quality) },
      activeBeadIds: state.activeBeadIds,
    },
    makeNextToolStep('call_tool', 'Keep polishing, then re-run converge-polish.', {
      tool: 'flywheel_approve_beads',
      argsSchemaHint: { action: 'converge-polish' },
    }),
  );
}

/**
 * Independent bead verification. Reads `.pi-flywheel/completion/<beadId>.json`,
 * resolves HEAD, computes the `patchId` over base..head, stamps
 * `report.verification` (`verified` iff a patch id exists, else
 * `verification-failed`), persists the report, and appends to
 * `.pi-flywheel/ledger.tsv`. Never writes a schema-invalid report: bad SHAs
 * or git failures return `cli_failure` before any write.
 */
async function handleVerifyBead(
  ctx: ToolContext,
  args: ExtendedApproveArgs,
): Promise<McpToolResult> {
  const { exec, cwd, state, signal } = ctx;
  const beadId = args.beadId?.trim();
  if (!beadId) {
    return makeApproveError(
      'Error: action="verify-bead" requires `beadId`.',
      state.phase,
      'beads',
      'invalid_input',
      { action: 'verify-bead' },
      'Pass the bead id whose .pi-flywheel/completion/<beadId>.json report should be verified.',
    );
  }
  const read = await readCompletionReport(cwd, beadId);
  if (!read.ok) {
    return makeApproveError(
      `Error: cannot verify bead ${beadId}: ${read.error.message}`,
      state.phase,
      'beads',
      read.error.code === 'not_found' ? 'not_found' : 'parse_failure',
      { action: 'verify-bead', beadId },
      'The implementer must write the completion report before independent verification.',
    );
  }
  let headSha: string;
  try {
    const head = await exec('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000, signal });
    if (head.code !== 0) throw new Error(head.stderr.trim() || `exit ${head.code}`);
    headSha = head.stdout.trim();
  } catch (err) {
    return makeApproveError(
      `Error: cannot resolve HEAD for verification: ${errMsg(err)}`,
      state.phase,
      'beads',
      'cli_failure',
      { action: 'verify-bead', beadId },
      'Run `git rev-parse HEAD` in the project directory to diagnose.',
    );
  }
  const baseSha = read.report.verification?.baseSha ?? state.cycleStartSha ?? headSha;
  if (!GIT_SHA_RE.test(baseSha) || !GIT_SHA_RE.test(headSha)) {
    return makeApproveError(
      `Error: non-SHA base/head for verification (base=${baseSha.slice(0, 12)} head=${headSha.slice(0, 12)}).`,
      state.phase,
      'beads',
      'cli_failure',
      { action: 'verify-bead', beadId },
      'Verification needs hex SHAs; check state.cycleStartSha and the report verification block.',
    );
  }
  let patchId: string | null = null;
  let patchError: string | undefined;
  try {
    patchId = await computePatchId(exec, cwd, baseSha, headSha, { timeout: 30000, signal });
  } catch (err) {
    patchError = errMsg(err);
  }
  const verifiedAt = new Date().toISOString();
  const verifier = args.coordinatorName ?? 'flywheel_approve_beads';
  // Schema requires patchId when verified; a missing/empty diff can only be
  // recorded as verification-failed.
  const verdict: 'verified' | 'verification-failed' = patchId ? 'verified' : 'verification-failed';
  const verification = {
    verdict,
    baseSha,
    headSha,
    ...(patchId ? { patchId } : {}),
    verifier,
    verifiedAt,
    evidence: patchError
      ? [`patch-id failed: ${patchError}`]
      : [`patch ${patchId} over ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`],
  };
  const updated = { ...read.report, verification };
  let reportPath: string;
  let ledgerPath: string;
  try {
    ({ path: reportPath } = await writeCompletionReport(cwd, updated));
    ({ path: ledgerPath } = await appendVerificationLedger(cwd, { beadId, verification }));
  } catch (err) {
    return makeApproveError(
      `Error: verification computed (${verdict}) but persistence failed: ${errMsg(err)}`,
      state.phase,
      'beads',
      'cli_failure',
      { action: 'verify-bead', beadId, verdict },
      'Check .pi-flywheel/ directory permissions and disk space, then retry.',
    );
  }
  return makeApproveResult(
    `**Bead ${beadId} verification: ${verdict}.** head=${headSha.slice(0, 12)} patch=${patchId ?? '(none)'}\nReport: \`${reportPath}\` — ledger: \`${ledgerPath}\``,
    state.phase,
    'beads',
    {
      kind: 'bead_verified',
      action: 'verify-bead',
      beadId,
      verdict,
      headSha,
      patchId,
      reportPath,
      ledgerPath,
    },
    makeNextToolStep(
      'call_tool',
      verdict === 'verified' ? 'Verification recorded — continue the wave.' : 'Verification failed — inspect the evidence, fix, and re-verify.',
    ),
  );
}

function formatBeadList(beads: Bead[]): string {
  const childIds = new Set(beads.filter(b => b.parent).map(b => b.id));
  const byParent = new Map<string, Bead[]>();
  for (const b of beads) {
    if (b.parent) {
      const children = byParent.get(b.parent) ?? [];
      children.push(b);
      byParent.set(b.parent, children);
    }
  }

  const lines: string[] = [];
  for (const b of beads) {
    if (childIds.has(b.id)) continue;
    lines.push(`**${b.id}: ${b.title}**`);
    lines.push(`   ${b.description.split('\n').slice(0, 2).join('\n   ')}`);
    const children = byParent.get(b.id);
    if (children) {
      for (const child of children) {
        lines.push(`   ↳ **${child.id}: ${child.title}**`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
