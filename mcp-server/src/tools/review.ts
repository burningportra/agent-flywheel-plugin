import type { ToolContext, McpToolResult, Bead, ReviewArgs, FlywheelPhase, ReviewMode } from '../types.js';
import type { FlywheelErrorCode } from '../errors.js';
import { errMsg, makeFlywheelErrorResult } from '../errors.js';
import { createLogger } from '../logger.js';
import { makeOkToolResult } from './shared.js';

const log = createLogger('review');

// ─── Review-mode matrix (bead agent-flywheel-plugin-f0j) ──────────────
//
// Mode routing is skill-level — we do NOT introduce new MCP tools. The
// reviewer personas are reused verbatim; `mode` only changes the agent
// prompt preamble and the post-synthesis action (apply-diffs-and-commit
// vs write-docs vs emit-exit-code vs ask-per-finding).

export const AUTOFIX_GATE_HINT =
  'Autofix refuses when the tree is dirty or the doctor is not green. Stash/commit local changes, run `flywheel_doctor`, then retry — or fall back to mode="interactive".';

export const HEADLESS_EXIT_HINT =
  'Headless mode returns error code "review_headless_findings" with details.findingCount when reviewers surface non-zero issues. CI wrappers should branch on structuredContent?.data?.error?.code and use details.exitCode (1 = findings, 2 = reviewer crash).';

function modePreamble(mode: ReviewMode, beadId: string): string {
  switch (mode) {
    case 'autofix':
      return `**Review mode: autofix.** After completing your review, APPLY your fixes directly via code-edit tools AND stage them for a single fixup commit per reviewer. When done, run \`git commit -m "fix(review/${beadId}): <reviewer-perspective>"\`. Do NOT ask the user per finding — your job is to ship the patch.\n\n`;
    case 'report-only':
      return `**Review mode: report-only.** Do NOT edit code. Write your full findings to \`docs/reviews/${beadId}-<perspective>-<YYYY-MM-DD>.md\` and exit. The coordinator aggregates reports — no interactive prompts.\n\n`;
    case 'headless':
      return `**Review mode: headless (CI).** Do NOT edit code and do NOT write markdown reports. Emit a compact machine-readable JSON summary on stdout: \`{ "beadId": "${beadId}", "perspective": "<your-perspective>", "findings": [{ "severity": "error|warn|info", "file": "...", "line": 0, "message": "..." }] }\`. The coordinator aggregates exit codes (0 = clean, 1 = findings, 2 = reviewer crash).\n\n`;
    case 'interactive':
    default:
      return '';
  }
}

/**
 * Decide whether autofix mode is safe right now. Runs two cheap checks:
 *   1. `git status --porcelain` — tree must be clean.
 *   2. `flywheel_doctor` recent report (if checkpoint has one) — must be green.
 * If either fails we fall back to interactive mode and surface a warning.
 */
async function autofixGateOk(ctx: ToolContext): Promise<{ ok: boolean; reason?: string }> {
  const { exec, cwd, signal } = ctx;
  try {
    const statusResult = await exec('git', ['status', '--porcelain'], { cwd, timeout: 5000, signal });
    if (statusResult.code !== 0) {
      return { ok: false, reason: `git status failed (exit ${statusResult.code})` };
    }
    if (statusResult.stdout.trim().length > 0) {
      return { ok: false, reason: 'working tree is dirty (uncommitted changes present)' };
    }
  } catch (err: unknown) {
    return { ok: false, reason: `git status threw: ${errMsg(err)}` };
  }
  // Doctor signal: if the session has a recent DoctorReport cached and any
  // check is "red", refuse. Absence of a cached report is tolerated — the
  // git-clean check alone is still a meaningful guard.
  const report = (ctx.state as { lastDoctorReport?: { checks?: Array<{ severity: string }> } }).lastDoctorReport;
  if (report?.checks?.some((c) => c.severity === 'red')) {
    return { ok: false, reason: 'flywheel_doctor reports at least one red check' };
  }
  return { ok: true };
}

function okResult(phase: string, text: string, data: Record<string, unknown>): McpToolResult {
  return makeOkToolResult('flywheel_review', phase, text, data);
}

function errorResult(
  phase: FlywheelPhase,
  code: FlywheelErrorCode,
  message: string,
  details?: Record<string, unknown>,
  hint?: string,
): McpToolResult {
  return makeFlywheelErrorResult('flywheel_review', phase, {
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(details ? { details } : {}),
  });
}

function parseBrShowBead(raw: string): Bead | null {
  try {
    const parsed = JSON.parse(raw);
    if (looksLikeBead(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const candidateKeys = ['bead', 'issue', 'data', 'result'];
      for (const key of candidateKeys) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (looksLikeBead(candidate)) return candidate as Bead;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikeBead(value: unknown): value is Bead {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as Record<string, unknown>).id === 'string'
      && typeof (value as Record<string, unknown>).title === 'string'
      && typeof (value as Record<string, unknown>).description === 'string'
      && typeof (value as Record<string, unknown>).status === 'string'
  );
}

/**
 * flywheel_review — Submit implementation work for review.
 *
 * action="hit-me"    — Return parallel review agent task specs for CC to spawn
 * action="looks-good"— Mark bead done, advance to next or enter gates
 * action="skip"      — Skip this bead (mark deferred), move to next
 */
export async function runReview(ctx: ToolContext, args: ReviewArgs): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  if (!args.beadId) {
    return errorResult(
      'reviewing',
      'invalid_input',
      'Error: beadId is required.',
      undefined,
      'Pass beadId from `br list`, or use `__gates__` / `__regress_to_plan__` / `__regress_to_beads__` / `__regress_to_implement__` sentinels.',
    );
  }

  const beadId = args.beadId;

  // ── Resolve review mode + autofix gating (bead agent-flywheel-plugin-f0j) ─
  // `mode` is advisory on `looks-good`/`skip` (those paths don't spawn
  // reviewers) but drives the hit-me dispatch. Autofix is gated behind a
  // clean git tree + non-red doctor report; failing the gate downgrades to
  // interactive with a warning attached to the payload.
  const requestedMode: ReviewMode = args.mode ?? 'interactive';
  let effectiveMode: ReviewMode = requestedMode;
  let modeGateWarning: string | undefined;
  if (requestedMode === 'autofix' && args.action === 'hit-me') {
    const gate = await autofixGateOk(ctx);
    if (!gate.ok) {
      effectiveMode = 'interactive';
      modeGateWarning = `Autofix refused: ${gate.reason}. Falling back to interactive mode. ${AUTOFIX_GATE_HINT}`;
      log.warn('autofix gate refused — downgrading to interactive', {
        beadId,
        reason: gate.reason,
      });
    }
  }
  const parallelSafe = args.parallelSafe ?? false;

  // ── Special sentinels ─────────────────────────────────────────
  if (beadId === '__gates__') {
    return runGates(ctx, args.action);
  }
  if (beadId === '__regress_to_plan__') {
    return regressToPhase(ctx, 'planning', 'plan revision');
  }
  if (beadId === '__regress_to_beads__') {
    return regressToPhase(ctx, 'creating_beads', 'bead creation');
  }
  if (beadId === '__regress_to_implement__') {
    return regressToPhase(ctx, 'implementing', 'implementation');
  }

  // ── Look up bead ──────────────────────────────────────────────
  const brShowResult = await exec('br', ['show', beadId, '--json'], { cwd, timeout: 8000, signal });
  if (brShowResult.code !== 0) {
    return errorResult(
      state.phase,
      'not_found',
      `Bead ${beadId} not found. Run \`br list\` to see available beads.\n\nError: ${brShowResult.stderr}`,
      { beadId, stderr: brShowResult.stderr },
      'Run `br list` to confirm the bead id, or `br init` if beads have not been initialized in this repo.',
    );
  }

  const bead = parseBrShowBead(brShowResult.stdout);
  if (!bead) {
    return errorResult(
      state.phase,
      'parse_failure',
      `Error parsing bead ${beadId} from br show output.`,
      { beadId },
      'Run `br show <id> --json` manually to inspect raw output; this usually indicates a br CLI version mismatch.',
    );
  }

  // ── Preflight: actual bead status (handles auto-close from impl agent) ─
  // If `br show` says the bead is already closed, the impl agent (or someone
  // else) ran `br update --status closed` without informing the agent-flywheel.
  // Reconcile state and route based on the requested action.
  //
  // Note: state.beadResults is only synced on the looks-good path. Setting
  // it for hit-me would trip the `alreadyCompleted` short-circuit below and
  // suppress the post-close audit the caller asked for.
  if (bead.status === 'closed') {
    if (args.action === 'looks-good') {
      if (!state.beadResults) state.beadResults = {};
      if (!state.beadResults[beadId]) {
        state.beadResults[beadId] = {
          beadId,
          status: 'success',
          summary: 'Auto-closed by impl agent',
        };
        saveState(state);
      }
      return nextBeadOrGates(ctx, beadId, bead.title, 'Already closed by impl agent');
    }
    if (args.action === 'skip') {
      return errorResult(
        state.phase,
        'already_closed',
        `Bead ${beadId} is already closed; skip is not applicable. Move to the next bead or call flywheel_review with action=looks-good to acknowledge.`,
        { beadId, status: 'closed' },
        'Call flywheel_review with action=looks-good to acknowledge the already-closed bead, then continue.',
      );
    }
    // hit-me on a closed bead falls through; payload is tagged postClose below.
  }

  const alreadyCompleted = state.beadResults?.[beadId]?.status === 'success';
  if (alreadyCompleted) {
    return okResult(
      state.phase,
      `Bead ${beadId} is already complete. Move to the next bead or call \`flywheel_review\` with beadId="__gates__" for guided review gates.`,
      {
        kind: 'review_gate',
        scope: 'already_complete',
        beadId,
      }
    );
  }

  // ── action: skip ──────────────────────────────────────────────
  if (args.action === 'skip') {
    await exec('br', ['update', beadId, '--status', 'deferred'], { cwd, timeout: 5000, signal });

    if (!state.beadResults) state.beadResults = {};
    state.beadResults[beadId] = {
      beadId,
      status: 'blocked',
      summary: 'Skipped by user',
    };
    saveState(state);

    return nextBeadOrGates(ctx, beadId, bead.title, 'Skipped');
  }

  // ── action: looks-good ────────────────────────────────────────
  if (args.action === 'looks-good') {
    // Mark bead closed
    await exec('br', ['update', beadId, '--status', 'closed'], { cwd, timeout: 5000, signal });

    if (!state.beadResults) state.beadResults = {};
    state.beadResults[beadId] = {
      beadId,
      status: 'success',
      summary: 'Passed review',
    };

    // Track review pass count
    if (!state.beadReviewPassCounts) state.beadReviewPassCounts = {};
    state.beadReviewPassCounts[beadId] = (state.beadReviewPassCounts[beadId] ?? 0) + 1;

    // Auto-close parent if all siblings are done
    if (bead.parent) {
      const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 8000, signal });
      if (brListResult.code === 0) {
        try {
          const allBeads: Bead[] = JSON.parse(brListResult.stdout);
          const siblings = allBeads.filter(b => b.parent === bead.parent);
          const allDone = siblings.every(b => b.status === 'closed' || b.id === beadId);
          if (allDone && bead.parent) {
            await exec('br', ['update', bead.parent, '--status', 'closed'], { cwd, timeout: 5000, signal });
            if (!state.beadResults) state.beadResults = {};
            state.beadResults[bead.parent] = { beadId: bead.parent, status: 'success', summary: 'All subtasks complete' };
          }
        } catch (err: unknown) {
          log.warn('Failed to parse sibling beads for parent auto-close', {
            code: 'parse_failure', tool: 'flywheel_review', phase: state.phase,
            cause: errMsg(err),
            parentId: bead.parent,
          });
        }
      }
    }

    saveState(state);
    return nextBeadOrGates(ctx, beadId, bead.title, 'Passed');
  }

  // ── action: hit-me — return parallel review agent specs ───────
  if (args.action === 'hit-me') {
    const round = state.beadReviewPassCounts?.[beadId] ?? 0;
    const postClose = bead.status === 'closed';
    const postCloseNote = postClose
      ? `**Note:** this bead is already closed by the impl agent. This is a post-close audit — focus on what shipped, surface bugs in landed code, and propose follow-up fixes rather than blocking the close.\n\n`
      : '';
    const modeNote = modePreamble(effectiveMode, beadId);

    if (!state.beadHitMeTriggered) state.beadHitMeTriggered = {};
    if (!state.beadHitMeCompleted) state.beadHitMeCompleted = {};
    state.beadHitMeTriggered[beadId] = true;
    state.beadHitMeCompleted[beadId] = false;
    saveState(state);

    // Extract file list from bead description (heuristic: lines containing paths)
    const files = extractFilesFromBead(bead);
    const fileList = files.length > 0 ? files.join(', ') : '(check bead description for files)';

    const goal = state.selectedGoal ?? 'unknown goal';
    const prevResults = Object.values(state.beadResults ?? {});
    const prevSummary = prevResults.length > 0
      ? prevResults.slice(-3).map(r => `- ${r.beadId}: ${r.status}`).join('\n')
      : '(none yet)';

    const agentTasks = [
      {
        name: `FreshEyes-${beadId}-r${round}`,
        perspective: 'fresh-eyes',
        task: `${modeNote}${postCloseNote}Fresh-eyes code reviewer. You have NEVER seen this code before.

**Bead:** ${beadId} — ${bead.title}
**Files to review:** ${fileList}
**Description:** ${bead.description.slice(0, 500)}
**cwd:** ${cwd}

Find blunders, bugs, errors, oversights. Be harsh but constructive. Fix issues directly using code tools.

Report what you found and what you fixed.`,
      },
      {
        name: `Adversary-${beadId}-r${round}`,
        perspective: 'adversarial',
        task: `${modeNote}${postCloseNote}Adversarial code reviewer. Your job is to break this implementation.

**Bead:** ${beadId} — ${bead.title}
**Files to review:** ${fileList}
**cwd:** ${cwd}

**Mandatory first step**: invoke \`/ubs-workflow\` on the changed files to run the Ultimate Bug Scanner comprehensive review. Its findings are your baseline before manual attack.

Then go further: trigger edge cases, find security holes, construct inputs that cause failures.
Fix any real vulnerabilities or bugs directly.

If your review surfaces a crash, hang, or memory issue in compiled code, invoke \`/gdb-for-debugging\` to reproduce it under a debugger and capture a stack trace in the report.

Report your attack attempts and findings.`,
      },
      {
        name: `Ergonomics-${beadId}-r${round}`,
        perspective: 'ergonomics',
        task: `${modeNote}${postCloseNote}Ergonomics reviewer. Focus on usability and developer experience.

**Bead:** ${beadId} — ${bead.title}
**Files to review:** ${fileList}
**cwd:** ${cwd}

If you came in fresh with zero context, would you understand this code?
Check: naming, comments, API design, error messages, type annotations.
Fix anything confusing or unclear directly.

Report improvements made.`,
      },
      {
        name: `RealityCheck-${beadId}-r${round}`,
        perspective: 'reality-check',
        task: `${modeNote}${postCloseNote}Reality checker. Verify the implementation actually achieves the goal.

**Goal:** ${goal}
**Bead:** ${beadId} — ${bead.title}
**Prior results:** ${prevSummary}
**Files:** ${fileList}
**cwd:** ${cwd}

Check: Does this actually solve the bead's stated goal? Are there gaps between intent and implementation?
Do NOT edit code — just report your findings.`,
      },
      {
        name: `Explorer-${beadId}-r${round}`,
        perspective: 'exploration',
        task: `${modeNote}${postCloseNote}Code explorer. Randomly explore the codebase to find related issues.

**Bead:** ${beadId} — ${bead.title}
**cwd:** ${cwd}

Pick 3 random files related to the bead's area and read them. Look for:
- Inconsistencies with the new implementation
- Patterns broken by the changes
- Tests that should exist but don't

Report what you found. Fix obvious issues directly.`,
      },
    ];

    const baseInstructions = `Spawn these 5 review agents in parallel. After all complete, synthesize their findings and apply fixes. Then call \`flywheel_review\` with beadId="${beadId}" and action="looks-good" or action="hit-me" for another round.`;
    const modeInstructions: Record<ReviewMode, string> = {
      autofix: `Review mode=autofix: each reviewer applies and commits its fixes directly. After all 5 finish, verify the tree is green and call \`flywheel_review\` with action="looks-good" — do NOT AskUserQuestion per finding.`,
      'report-only': `Review mode=report-only: reviewers write findings to docs/reviews/<perspective>-<date>.md and DO NOT edit code. After synthesizing, call \`flywheel_review\` with action="looks-good" to close the bead or action="hit-me" again if reports surfaced blockers.`,
      headless: `Review mode=headless (CI): reviewers emit JSON-on-stdout only. The coordinator MUST aggregate finding counts and treat a non-zero count as review_headless_findings (CI exit code 1). Do NOT AskUserQuestion — this mode is for non-interactive shells.`,
      interactive: baseInstructions,
    };
    const instructions = postClose
      ? `Bead ${beadId} is already closed; this is a post-close audit. ${modeInstructions[effectiveMode]} For looks-good, the bead stays closed (idempotent).`
      : modeInstructions[effectiveMode];

    const payload = {
      kind: 'review_tasks',
      strategy: 'hit_me',
      beadId,
      round,
      postClose,
      mode: effectiveMode,
      requestedMode,
      parallelSafe,
      ...(modeGateWarning ? { modeGateWarning } : {}),
      agentTasks,
      files,
      instructions,
    };

    return okResult(
      state.phase,
      JSON.stringify({
        action: 'spawn-agents',
        beadId,
        round,
        postClose,
        mode: effectiveMode,
        requestedMode,
        parallelSafe,
        ...(modeGateWarning ? { modeGateWarning } : {}),
        agentTasks,
        instructions,
      }, null, 2),
      payload
    );
  }

  return errorResult(
    state.phase,
    'unsupported_action',
    `Unknown action: ${args.action}. Valid: hit-me, looks-good, skip`,
    { beadId, action: args.action },
    'Pass action as one of: "hit-me" (spawn reviewers), "looks-good" (accept), "skip" (defer).',
  );
}

async function nextBeadOrGates(
  ctx: ToolContext,
  completedBeadId: string,
  completedTitle: string,
  status: string
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState, signal } = ctx;

  // Get next ready beads
  const brReadyResult = await exec('br', ['ready', '--json'], { cwd, timeout: 8000, signal });
  let ready: Bead[] = [];

  if (brReadyResult.code === 0) {
    try {
      ready = JSON.parse(brReadyResult.stdout);
    } catch {
      return errorResult(
        state.phase,
        'parse_failure',
        'br ready produced malformed JSON — fall back to manual bead selection.',
        { command: 'br ready --json', stdout: brReadyResult.stdout.slice(0, 200) },
        'Run `br ready --json` manually to inspect the output; upgrade br CLI if the JSON shape drifted.',
      );
    }
  }

  // Filter out already-completed beads
  const completed = new Set(
    Object.entries(state.beadResults ?? {})
      .filter(([, r]) => r.status === 'success')
      .map(([id]) => id)
  );
  ready = ready.filter(b => !completed.has(b.id));

  if (ready.length === 0) {
    // All done — enter review gates
    state.phase = 'iterating';
    state.iterationRound = 0;
    state.currentGateIndex = 0;
    saveState(state);

    return okResult(
      'iterating',
      `**${status}: Bead ${completedBeadId} (${completedTitle}).**

All beads complete! Entering review gates.

**NEXT: Call \`flywheel_review\` with beadId="__gates__" to run guided review gates.**`,
      {
        kind: 'review_gate',
        scope: 'bead_completion',
        completedBeadId,
        completedTitle,
        status,
      }
    );
  }

  if (ready.length === 1) {
    const nextBead = ready[0];
    await exec('br', ['update', nextBead.id, '--status', 'in_progress'], { cwd, timeout: 5000, signal });
    state.currentBeadId = nextBead.id;
    state.retryCount = 0;
    state.phase = 'implementing';
    saveState(state);

    return okResult(
      'implementing',
      `**${status}: Bead ${completedBeadId}.** Moving to bead ${nextBead.id}.

**NEXT: Implement bead ${nextBead.id} (${nextBead.title}), then call \`flywheel_review\` when done.**

---

## Bead ${nextBead.id}: ${nextBead.title}

${nextBead.description}

After implementing, commit and call \`flywheel_review\` with beadId="${nextBead.id}".`,
      {
        kind: 'review_tasks',
        strategy: 'single_bead',
        completedBeadId,
        nextBeadIds: [nextBead.id],
        beads: [nextBead],
      }
    );
  }

  // Multiple ready — spawn parallel agents
  for (const bead of ready) {
    await exec('br', ['update', bead.id, '--status', 'in_progress'], { cwd, timeout: 5000, signal });
  }
  state.phase = 'implementing';
  saveState(state);

  const agentConfigs = ready.map(bead => ({
    name: `bead-${bead.id}`,
    cwd,
    task: `Implement bead ${bead.id}: ${bead.title}\n\n${bead.description}\n\nAfter implementing, commit and report your summary.`,
  }));

  return okResult(
    'implementing',
    `**${status}: Bead ${completedBeadId}.** ${ready.length} beads now ready.

**NEXT: Spawn ${ready.length} parallel agents, then call \`flywheel_review\` for each when done.**

\`\`\`json
${JSON.stringify({ agents: agentConfigs }, null, 2)}
\`\`\``,
    {
      kind: 'review_tasks',
      strategy: 'parallel_beads',
      completedBeadId,
      nextBeadIds: ready.map(bead => bead.id),
      beads: ready,
      agentConfigs,
    }
  );
}

async function runGates(ctx: ToolContext, action: 'hit-me' | 'looks-good' | 'skip'): Promise<McpToolResult> {
  const { state, saveState, cwd } = ctx;

  const gateChecks = [
    `### Gate 1: Tests passing\nRun \`npm test\` or equivalent. Report results.`,
    `### Gate 2: No regressions\nCheck test changes are all intentional.`,
    `### Gate 3: Code quality\nCheck for: TODO/FIXME left over, console.log not cleaned up, dead code. Report findings.`,
    `### Gate 4: Documentation\nAre new features/APIs documented? Do AGENTS.md, README need updates?`,
    `### Gate 5: Integration sanity\nDo a quick end-to-end smoke test if possible. Does the feature work as described in the goal?`,
  ];

  // action="looks-good": gate passed — advance gate index and increment clean counter
  if (action === 'looks-good') {
    const gateIndex = (state.currentGateIndex ?? 0) % gateChecks.length;
    const nextGateIndex = (gateIndex + 1) % gateChecks.length;
    state.currentGateIndex = nextGateIndex;
    state.consecutiveCleanRounds = (state.consecutiveCleanRounds ?? 0) + 1;
    const consecutiveClean = state.consecutiveCleanRounds;

    if (consecutiveClean >= 2) {
      state.phase = 'complete';
      saveState(state);
      return okResult(
        'complete',
        `## Flywheel Complete

All gates passed for ${consecutiveClean} consecutive rounds. The implementation is done.

**Summary:** All beads closed, all review gates clean.

Run \`/agent-flywheel:flywheel-status\` for a final report.`,
        {
          kind: 'flywheel_complete',
          scope: 'gates',
          consecutiveCleanRounds: consecutiveClean,
        }
      );
    }

    saveState(state);
    const nextGate = gateChecks[nextGateIndex];
    return okResult(
      state.phase,
      `Gate passed. Moving to next gate (${consecutiveClean}/2 clean rounds needed to finish).

## Next Review Gate

${nextGate}

After checking:
- If it **passes**: call \`flywheel_review\` with beadId="__gates__" and action="looks-good"
- If it **fails**: fix it, then call \`flywheel_review\` with beadId="__gates__" and action="hit-me"

**cwd:** ${cwd}`,
      {
        kind: 'review_gate',
        scope: 'gates',
        gateIndex: nextGateIndex,
        consecutiveCleanRounds: consecutiveClean,
        gatePrompt: nextGate,
      }
    );
  }

  // action="hit-me" or first entry: show current gate and reset clean streak
  state.iterationRound = (state.iterationRound ?? 0) + 1;
  const round = state.iterationRound;
  state.consecutiveCleanRounds = 0; // issue found — reset streak
  const gateIndex = (state.currentGateIndex ?? 0) % gateChecks.length;
  const currentGate = gateChecks[gateIndex];
  saveState(state);

  return okResult(
    state.phase,
    `## Review Gate (Round ${round})

${currentGate}

After completing this gate check:
- If it **passes**: call \`flywheel_review\` with beadId="__gates__" and action="looks-good" to advance
- If it **fails**: fix the issue and call \`flywheel_review\` with beadId="__gates__" and action="hit-me" to spawn fixers

**cwd:** ${cwd}`,
    {
      kind: 'review_gate',
      scope: 'gates',
      gateIndex,
      round,
      consecutiveCleanRounds: state.consecutiveCleanRounds,
      gatePrompt: currentGate,
    }
  );
}

function regressToPhase(
  ctx: ToolContext,
  targetPhase: import('../types.js').FlywheelPhase,
  phaseName: string
): McpToolResult {
  const { state, saveState } = ctx;
  state.phase = targetPhase;
  state.currentGateIndex = 0;
  state.iterationRound = 0;
  saveState(state);

  const instructions: Record<string, string> = {
    planning: `Revise the plan${state.planDocument ? ` at \`${state.planDocument}\`` : ''}, then call \`flywheel_approve_beads\` to re-enter the approval flow.`,
    creating_beads: `Create/revise beads using \`br create\` and \`br update\`, then call \`flywheel_approve_beads\` to return to the approval menu.`,
    implementing: `Use \`br ready\` to find the next unblocked bead and implement it, then call \`flywheel_review\` when done.`,
  };

  return {
    content: [{
      type: 'text',
      text: `Regressed to **${phaseName} phase**.\n\n${instructions[targetPhase] || 'Continue from the appropriate phase.'}`,
    }],
  };
}

function extractFilesFromBead(bead: Bead): string[] {
  if (!bead || typeof bead.description !== 'string' || bead.description.length === 0) {
    return [];
  }
  const files: string[] = [];
  // Heuristic: lines that look like file paths
  const lines = bead.description.split('\n');
  for (const line of lines) {
    const match = line.match(/[`\s]((?:src|lib|tests?|dist|app|packages?)\/[^\s`"']+\.[a-z]+)/);
    if (match) files.push(match[1]);
    // Also match bare paths like "- src/foo.ts"
    const bare = line.match(/^[-*]\s+([\w./]+\.[a-z]+)/);
    if (bare) files.push(bare[1]);
  }
  return [...new Set(files)].slice(0, 10);
}
