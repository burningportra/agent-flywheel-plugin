import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, McpToolResult, Bead, ApproveArgs, ApproveStopReason, FlywheelPhase, ToolNextStep, HotspotMatrix, TemplateExpansionInput } from '../types.js';
import { computeConvergenceScore, computeBeadQualityScore, formatBeadQualityScore, makeChoiceOption, makeNextToolStep, makeToolResult, pickRefinementModel } from './shared.js';
import { makeFlywheelErrorResult } from '../errors.js';
import { acquireBeadMutex, releaseBeadMutex, makeConcurrentWriteError } from '../mutex.js';
import { planGitDiffReviewPrompt, planIntegrationPrompt } from '../prompts.js';
import { withCassContext } from '../feedback.js';
import { parseBrList } from '../parsers.js';
import { computeHotspotMatrix, type HotspotInputBead } from '../plan-simulation.js';
import { createLogger } from '../logger.js';
import { expandTemplate } from '../bead-templates.js';
import { parseTemplateHint } from '../deep-plan.js';
import { normalizeText } from '../utils/text-normalize.js';

const log = createLogger('approve');

// Module-level bead snapshot for change tracking
type BeadSnapshot = Map<string, { title: string; descFingerprint: string }>;
let _lastBeadSnapshot: BeadSnapshot | undefined;

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
  code: 'missing_prerequisite' | 'invalid_input' | 'not_found' | 'cli_failure' | 'parse_failure' | 'blocked_state' | 'unsupported_action' | 'internal_error',
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

function getBeadApprovalData(
  state: ToolContext['state'],
  beads: Bead[],
  score: number | undefined,
  matrix?: HotspotMatrix,
): Record<string, unknown> {
  return {
    activeBeadIds: [...(state.activeBeadIds ?? [])],
    convergence: getConvergenceData(state, score),
    quality: getQualityData(beads),
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

// ─── I9: Approve-time template expansion ──────────────────────
//
// Helper is additive to the bead-creation path — I5's hotspot wiring
// (beadsToHotspotInput / formatHotspotSummary / shouldOfferCoordinatorSerial)
// runs against already-created beads and is untouched by this code.

/**
 * Bead spec as produced by the synthesizer / plan-to-beads prompt, before it
 * becomes a concrete `Bead` via `br create`. Template hints are optional;
 * beads without a `template` hint flow through as free-form.
 */
export interface BeadPlanSpec {
  id?: string;
  title: string;
  /** Optional synthesizer-emitted hint, e.g. `"foundation-with-fresh-eyes-gate@1"`. */
  template?: string;
  /** Free-form description used when no template hint is present. */
  description?: string;
  /** Structured inputs passed to `expandTemplate` when `template` is set. */
  scope?: string;
  acceptance?: string;
  test_plan?: string;
  /** Catch-all for template-specific placeholders (`PARENT_WAVE_BEADS`, `TARGET_FILE`, …). */
  extraPlaceholders?: Record<string, string>;
}

/**
 * Discriminated expansion outcome for a single bead spec.
 *
 * - `status: 'expanded'` — template hint parsed and rendered cleanly; the
 *   `description` field holds the rendered body.
 * - `status: 'passthrough'` — no hint or malformed hint; the bead uses the
 *   caller-supplied `description` unchanged.
 * - `status: 'error'` — template hint parsed but expansion failed; the
 *   structured `errorResult` is a ready-to-return MCP tool envelope.
 */
export type BeadExpansionOutcome =
  | { status: 'expanded'; title: string; description: string; usedTemplate: { id: string; version: number } }
  | { status: 'passthrough'; title: string; description: string }
  | {
      status: 'error';
      title: string;
      code: 'template_not_found' | 'template_placeholder_missing' | 'template_expansion_failed';
      detail: string;
      errorResult: McpToolResult;
    };

/**
 * Map a `BeadPlanSpec` to the placeholder record `expandTemplate` expects.
 *
 * I8 synthesizer-emitted templates use UPPERCASE placeholder names
 * (`{{TITLE}}`, `{{SCOPE}}`, `{{ACCEPTANCE}}`, `{{TEST_PLAN}}`), while the
 * wire-flat `TemplateExpansionInput` uses lowercase keys (`title`, `scope`, …)
 * so the MCP boundary stays ergonomic for agents. This adapter emits both
 * cases — every lowercase canonical key is also exposed as its uppercase
 * sibling so both v3.4.0 I8 templates and any future lowercase-keyed
 * templates can consume the same spec without bespoke mapping.
 *
 * Extra placeholders (`PARENT_WAVE_BEADS`, `TARGET_FILE`, …) pass through
 * their original casing — the synthesizer controls those names.
 */
function buildTemplateInput(spec: BeadPlanSpec): TemplateExpansionInput {
  const input: TemplateExpansionInput = {};
  const canonicalPairs: Array<[string, string | undefined]> = [
    ['title', spec.title],
    ['scope', spec.scope],
    ['acceptance', spec.acceptance],
    ['test_plan', spec.test_plan],
  ];
  for (const [lowerKey, value] of canonicalPairs) {
    if (typeof value !== 'string') continue;
    input[lowerKey] = value;
    input[lowerKey.toUpperCase()] = value;
  }
  if (spec.extraPlaceholders) {
    for (const [k, v] of Object.entries(spec.extraPlaceholders)) {
      if (typeof v === 'string') input[k] = v;
    }
  }
  return input;
}

/**
 * Expand a single bead spec at approve time. Pure function — safe to call
 * in tests and in the bead-creation path without touching br CLI state.
 *
 * @param phase Caller's current `FlywheelPhase`, threaded onto any error
 *              envelope so the SKILL.md orchestrator branches correctly.
 */
export function expandBeadPlanSpec(spec: BeadPlanSpec, phase: FlywheelPhase): BeadExpansionOutcome {
  const parsed = parseTemplateHint(spec.template);
  if (!parsed) {
    // No hint, empty hint, or malformed hint → legacy free-form passthrough.
    // `parseTemplateHint` already logs a warn for malformed hints.
    return {
      status: 'passthrough',
      title: spec.title,
      description: spec.description ?? '',
    };
  }

  const result = expandTemplate(parsed.id, parsed.version, buildTemplateInput(spec));
  if (result.success) {
    return {
      status: 'expanded',
      title: spec.title,
      description: `Template: ${parsed.id}\n\n${result.description}`,
      usedTemplate: parsed,
    };
  }

  const hintText = `template hint "${parsed.id}@${parsed.version}"`;
  const remediation =
    result.error === 'template_not_found'
      ? 'Pick a template id@version that exists in the library, or omit the hint to create a free-form bead.'
      : result.error === 'template_placeholder_missing'
      ? 'Supply the missing placeholders in the bead spec (title/scope/acceptance/test_plan/extraPlaceholders).'
      : 'Inspect the template body for unresolved markers or invalid placeholder values.';

  const errorResult = makeFlywheelErrorResult('flywheel_approve_beads', phase, {
    code: result.error,
    message: `Failed to expand ${hintText}: ${result.detail}`,
    hint: remediation,
    details: {
      templateId: parsed.id,
      templateVersion: parsed.version,
      beadTitle: spec.title,
    },
  });

  return {
    status: 'error',
    title: spec.title,
    code: result.error,
    detail: result.detail,
    errorResult,
  };
}

/**
 * Expand every bead spec at approve time, returning ordered outcomes.
 *
 * Callers iterate results: `expanded` + `passthrough` beads proceed to
 * `br create`; the first `error` outcome's `errorResult` should be returned
 * from the tool handler to surface the FlywheelErrorCode envelope to the
 * SKILL.md orchestrator.
 */
export function expandBeadPlanSpecs(specs: BeadPlanSpec[], phase: FlywheelPhase): BeadExpansionOutcome[] {
  return specs.map((spec) => expandBeadPlanSpec(spec, phase));
}

/**
 * flywheel_approve_beads — Review and approve bead graph before implementation.
 *
 * action="start"    — Approve beads and launch implementation
 * action="polish"   — Request another refinement round
 * action="reject"   — Reject and stop the flywheel
 * action="advanced" — Advanced refinement (requires advancedAction param)
 */
export async function runApprove(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult> {
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

  // ── Plan approval mode (when phase is awaiting_plan_approval) ──
  if (
    (state.phase === 'awaiting_plan_approval' || (state.phase === 'planning' && state.planDocument)) &&
    state.planDocument
  ) {
    return handlePlanApproval(ctx, args);
  }

  // ── Bead approval mode ─────────────────────────────────────────
  // Read current beads from br CLI
  const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 10000, signal });
  if (brListResult.code !== 0) {
    return makeApproveError(
      `Error reading beads: ${brListResult.stderr}\n\nEnsure \`br\` CLI is installed and \`br init\` has been run in this directory.`,
      state.phase,
      'beads',
      'cli_failure',
      {
        command: 'br list --json',
        stderr: brListResult.stderr,
      },
      'Install the br CLI and run `br init` in the repo root, then retry flywheel_approve_beads.',
    );
  }

  let allBeads: Bead[] = [];
  const parsed = parseBrList(brListResult.stdout);
  if (parsed.ok) {
    allBeads = parsed.data;
  } else {
    log.warn('Failed to parse br list output', { error: parsed.error });
    return makeApproveError(
      `Error: Could not parse br list output: ${parsed.error}`,
      state.phase,
      'beads',
      'parse_failure',
      { command: 'br list --json', parseError: parsed.error },
      'Run `br list --json` manually to inspect output; upgrade br CLI if the JSON shape drifted.',
    );
  }

  const beads = allBeads.filter(b => b.status === 'open' || b.status === 'in_progress');

  if (beads.length === 0) {
    return makeApproveResult(
      `No open beads found. Create beads first using:\n\`\`\`bash\nbr create --title "..." --description "..."\n\`\`\`\n\nThen call \`flywheel_approve_beads\` again.`,
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

  // action === 'start' — launch implementation. stop_reason is "manual_start"
  // because the polish loop was terminated by an explicit operator decision.
  return handleStart(ctx, beads, roundHeader, beadList, convergenceScore, matrix);
}

async function handlePlanApproval(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult> {
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

    const refinementModel = pickRefinementModel(planRound);
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

  const beadPrompt = buildPlanToBeadsPrompt(plan, state.selectedGoal!, planPath);

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

function buildPlanToBeadsPrompt(plan: string, goal: string, planPath: string): string {
  // Show the first 2000 chars of the plan as context
  const preview = plan.slice(0, 2000);
  return `## Create Beads from Approved Plan

**Goal:** ${goal}
**Plan artifact:** \`${planPath}\`

Read the full plan from \`${planPath}\`, then create one bead per implementation phase or logical unit.

### Bead creation rules
1. Each bead = one focused unit of work (1-4 hours)
2. \`br create --title "Verb phrase" --description "WHAT/WHY/HOW" --priority 2 --type task\`
3. Add dependencies: \`br dep add <id> --depends-on <other-id>\`
4. Bead description must specify exact files to create/modify
5. No mega-beads — split anything >4 hours

### Plan preview (first 2000 chars)
\`\`\`
${preview}${plan.length > 2000 ? '\n...(read full plan from file)' : ''}
\`\`\`

After creating all beads, call \`flywheel_approve_beads\` with action="start" to review and launch.`;
}

async function handleStart(
  ctx: ToolContext,
  beads: Bead[],
  roundHeader: string,
  beadList: string,
  convergenceScore: number | undefined,
  matrix: HotspotMatrix,
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  // Reset and move to implementing
  _lastBeadSnapshot = undefined;
  state.beadResults = {};
  state.beadReviews = {};
  state.beadReviewPassCounts = {};
  state.beadHitMeTriggered = {};
  state.beadHitMeCompleted = {};
  state.iterationRound = 0;
  state.currentGateIndex = 0;
  state.phase = 'implementing';

  // Get ready beads (unblocked by dependencies)
  const brReadyResult = await exec('br', ['ready', '--json'], { cwd, timeout: 10000, signal });
  let ready: Bead[] = [];

  if (brReadyResult.code === 0) {
    const readyParsed = parseBrList(brReadyResult.stdout);
    if (readyParsed.ok) {
      ready = readyParsed.data;
    } else {
      log.warn('Failed to parse br ready output', { error: readyParsed.error });
    }
  }

  // Fallback: if br ready fails, find beads with no open dependencies
  if (ready.length === 0) {
    ready = beads.slice(0, 3); // take first few as fallback
  }

  if (ready.length === 0) {
    saveState(state);
    return makeApproveResult(
      `Beads approved! But no ready beads found (all may be blocked).\n\nRun \`br ready\` or \`br dep cycles\` to diagnose.\n\n${beadList}`,
      state.phase,
      'beads',
      {
        kind: 'beads_approved',
        launchMode: 'blocked',
        readyCount: 0,
        currentBeadId: undefined,
        readyBeads: [],
        ...getBeadApprovalData(state, beads, convergenceScore, matrix),
        readiness: {
          blocked: true,
          message: 'No ready beads found after approval.',
        },
      },
      makeNextToolStep('run_cli', 'Diagnose blocked beads with br ready or br dep cycles, then return to flywheel_approve_beads.')
    );
  }

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
        releaseBeadMutex(mutexKey);
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
    state.currentBeadId = ready[0].id;
    saveState(state);
  } finally {
    releaseBeadMutex(mutexKey);
  }

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
    // Sequential: single bead — contention can't matter here, but surface
    // matrix in structuredContent for observability.
    const bead = ready[0];
    return makeApproveResult(
      `**Beads approved!** ${beads.length} total.${convergenceNote}${qualityNote}${roundHeader}

**NEXT: Implement bead ${bead.id} (${bead.title}), then call \`flywheel_review\` when done.**

---

## Bead ${bead.id}: ${bead.title}

${bead.description}

After implementing:
1. Do a self-review of all changes
2. Run tests if applicable
3. Commit: \`git add <changed files> && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\`
4. Call \`flywheel_review\` with beadId="${bead.id}" and a summary of what you did

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
          agentName: undefined,
        }],
        ...getBeadApprovalData(state, beads, convergenceScore, matrix),
      },
      makeNextToolStep('call_tool', 'Implement the ready bead, then call flywheel_review with its summary.', {
        tool: 'flywheel_review',
        argsSchemaHint: { beadId: 'string', action: 'looks-good | hit-me | skip' },
      })
    );
  }

  // Parallel: multiple ready beads — return agent configs for CC to spawn
  const agentConfigs = ready.map((bead) => {
    const baseTask = `You are implementing bead ${bead.id} as part of the flywheel workflow.

## ${bead.title}

${bead.description}

## Instructions
1. Implement all changes described in the bead
2. Only modify files listed in the bead scope
3. Run tests if applicable
4. Do a fresh-eyes self-review
5. Commit: \`git add <files> && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\`

After completing, report your summary to the agent-flywheel.`;

    return {
      name: `bead-${bead.id}`,
      cwd,
      task: withCassContext(baseTask, cwd, `implementing: ${bead.title}`),
    };
  });

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
    `**Beads approved!** ${beads.length} total, ${ready.length} ready now.${convergenceNote}${qualityNote}${roundHeader}${hotspotNote}

**NEXT: Spawn ${ready.length} parallel agents (one per ready bead), then call \`flywheel_review\` for each when done.**

\`\`\`json
${JSON.stringify({ agents: agentConfigs }, null, 2)}
\`\`\`

After all agents complete, call \`flywheel_review\` for each bead with its agent's summary.

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
        agentName: `bead-${bead.id}`,
      })),
      ...getBeadApprovalData(state, beads, convergenceScore, matrix),
    },
    nextStep,
  );
}

function handlePolish(ctx: ToolContext, beads: Bead[], round: number, fresh: boolean, matrix?: HotspotMatrix): McpToolResult {
  const { cwd, state, saveState } = ctx;
  state.phase = 'refining_beads';
  saveState(state);

  const model = pickRefinementModel(round);
  const compactList = beads.map(b => `• ${b.id}: ${b.title}`).join('\n');
  const sharedData = {
    kind: 'bead_refinement_requested',
    action: 'polish',
    refinementMode: fresh ? 'fresh-agent' : 'same-agent',
    ...getBeadApprovalData(state, beads, state.polishConvergenceScore, matrix),
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

    const passes = [1, 2, 3, 4, 5].map(i =>
      `### Blunder Hunt Pass ${i}\nRead all beads via \`br list --json\`. Look for: incomplete descriptions, missing files, circular dependencies, wrong priorities, vague acceptance criteria. Fix anything suspicious.`
    ).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `**NEXT: Run 5 blunder hunt passes, then call \`flywheel_approve_beads\` again.**\n\n${passes}\n\ncd ${cwd}\n\nCurrent beads:\n${compactList}`,
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
4. Transfer dependencies: \`br dep add <survivor> --depends-on <deps-of-closed>\`

Report what was merged. Then call \`flywheel_approve_beads\`.

cd ${cwd}

Current beads:\n${compactList}`,
      }],
    };
  }

  if (advancedAction === 'cross-model') {
    state.phase = 'refining_beads';
    saveState(state);

    const altModel = pickRefinementModel(round + 1);
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
        ...getBeadApprovalData(state, beads, state.polishConvergenceScore, matrix),
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
