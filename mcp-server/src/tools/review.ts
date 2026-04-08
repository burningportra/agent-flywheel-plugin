import type { ToolContext, McpToolResult, Bead, BeadResult } from '../types.js';

interface ReviewArgs {
  cwd: string;
  beadId: string;
  action: 'hit-me' | 'looks-good' | 'skip';
}

/**
 * orch_review — Submit implementation work for review.
 *
 * action="hit-me"    — Return parallel review agent task specs for CC to spawn
 * action="looks-good"— Mark bead done, advance to next or enter gates
 * action="skip"      — Skip this bead (mark deferred), move to next
 */
export async function runReview(ctx: ToolContext, args: ReviewArgs): Promise<McpToolResult> {
  const { exec, cwd, state, saveState } = ctx;

  if (!args.beadId) {
    return {
      content: [{ type: 'text', text: 'Error: beadId is required.' }],
      isError: true,
    };
  }

  const beadId = args.beadId;

  // ── Special sentinels ─────────────────────────────────────────
  if (beadId === '__gates__') {
    return runGates(ctx);
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
  const brShowResult = await exec('br', ['show', beadId, '--json'], { cwd, timeout: 8000 });
  if (brShowResult.code !== 0) {
    return {
      content: [{
        type: 'text',
        text: `Bead ${beadId} not found. Run \`br list\` to see available beads.\n\nError: ${brShowResult.stderr}`,
      }],
      isError: true,
    };
  }

  let bead: Bead;
  try {
    bead = JSON.parse(brShowResult.stdout);
  } catch {
    return {
      content: [{ type: 'text', text: `Error parsing bead ${beadId} from br show output.` }],
      isError: true,
    };
  }

  const alreadyCompleted = state.beadResults?.[beadId]?.status === 'success';
  if (alreadyCompleted) {
    return {
      content: [{
        type: 'text',
        text: `Bead ${beadId} is already complete. Move to the next bead or call \`orch_review\` with beadId="__gates__" for guided review gates.`,
      }],
    };
  }

  // ── action: skip ──────────────────────────────────────────────
  if (args.action === 'skip') {
    await exec('br', ['update', beadId, '--status', 'deferred'], { cwd, timeout: 5000 });

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
    await exec('br', ['update', beadId, '--status', 'closed'], { cwd, timeout: 5000 });

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
      const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 8000 });
      if (brListResult.code === 0) {
        try {
          const allBeads: Bead[] = JSON.parse(brListResult.stdout);
          const siblings = allBeads.filter(b => b.parent === bead.parent);
          const allDone = siblings.every(b => b.status === 'closed' || b.id === beadId);
          if (allDone && bead.parent) {
            await exec('br', ['update', bead.parent, '--status', 'closed'], { cwd, timeout: 5000 });
            if (!state.beadResults) state.beadResults = {};
            state.beadResults[bead.parent] = { beadId: bead.parent, status: 'success', summary: 'All subtasks complete' };
          }
        } catch { /* parse failure ok */ }
      }
    }

    saveState(state);
    return nextBeadOrGates(ctx, beadId, bead.title, 'Passed');
  }

  // ── action: hit-me — return parallel review agent specs ───────
  if (args.action === 'hit-me') {
    const hitMeWasTriggered = state.beadHitMeTriggered?.[beadId] ?? false;
    const hitMeWasCompleted = state.beadHitMeCompleted?.[beadId] ?? false;
    const round = state.beadReviewPassCounts?.[beadId] ?? 0;

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
        task: `Fresh-eyes code reviewer. You have NEVER seen this code before.

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
        task: `Adversarial code reviewer. Your job is to break this implementation.

**Bead:** ${beadId} — ${bead.title}
**Files to review:** ${fileList}
**cwd:** ${cwd}

Try to: trigger edge cases, find security holes, construct inputs that cause failures.
Fix any real vulnerabilities or bugs directly.

Report your attack attempts and findings.`,
      },
      {
        name: `Ergonomics-${beadId}-r${round}`,
        perspective: 'ergonomics',
        task: `Ergonomics reviewer. Focus on usability and developer experience.

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
        task: `Reality checker. Verify the implementation actually achieves the goal.

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
        task: `Code explorer. Randomly explore the codebase to find related issues.

**Bead:** ${beadId} — ${bead.title}
**cwd:** ${cwd}

Pick 3 random files related to the bead's area and read them. Look for:
- Inconsistencies with the new implementation
- Patterns broken by the changes
- Tests that should exist but don't

Report what you found. Fix obvious issues directly.`,
      },
    ];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          action: 'spawn-agents',
          beadId,
          round,
          agentTasks,
          instructions: `Spawn these 5 review agents in parallel. After all complete, synthesize their findings and apply fixes. Then call \`orch_review\` with beadId="${beadId}" and action="looks-good" or action="hit-me" for another round.`,
        }, null, 2),
      }],
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown action: ${args.action}. Valid: hit-me, looks-good, skip` }],
    isError: true,
  };
}

async function nextBeadOrGates(
  ctx: ToolContext,
  completedBeadId: string,
  completedTitle: string,
  status: string
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState } = ctx;

  // Get next ready beads
  const brReadyResult = await exec('br', ['ready', '--json'], { cwd, timeout: 8000 });
  let ready: Bead[] = [];

  if (brReadyResult.code === 0) {
    try {
      ready = JSON.parse(brReadyResult.stdout);
    } catch { ready = []; }
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

    return {
      content: [{
        type: 'text',
        text: `**${status}: Bead ${completedBeadId} (${completedTitle}).**

All beads complete! Entering review gates.

**NEXT: Call \`orch_review\` with beadId="__gates__" to run guided review gates.**`,
      }],
    };
  }

  if (ready.length === 1) {
    const nextBead = ready[0];
    await exec('br', ['update', nextBead.id, '--status', 'in_progress'], { cwd, timeout: 5000 });
    state.currentBeadId = nextBead.id;
    state.retryCount = 0;
    state.phase = 'implementing';
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**${status}: Bead ${completedBeadId}.** Moving to bead ${nextBead.id}.

**NEXT: Implement bead ${nextBead.id} (${nextBead.title}), then call \`orch_review\` when done.**

---

## Bead ${nextBead.id}: ${nextBead.title}

${nextBead.description}

After implementing, commit and call \`orch_review\` with beadId="${nextBead.id}".`,
      }],
    };
  }

  // Multiple ready — spawn parallel agents
  for (const bead of ready) {
    await exec('br', ['update', bead.id, '--status', 'in_progress'], { cwd, timeout: 5000 });
  }
  state.phase = 'implementing';
  saveState(state);

  const agentConfigs = ready.map(bead => ({
    name: `bead-${bead.id}`,
    cwd,
    task: `Implement bead ${bead.id}: ${bead.title}\n\n${bead.description}\n\nAfter implementing, commit and report your summary.`,
  }));

  return {
    content: [{
      type: 'text',
      text: `**${status}: Bead ${completedBeadId}.** ${ready.length} beads now ready.

**NEXT: Spawn ${ready.length} parallel agents, then call \`orch_review\` for each when done.**

\`\`\`json
${JSON.stringify({ agents: agentConfigs }, null, 2)}
\`\`\``,
    }],
  };
}

async function runGates(ctx: ToolContext): Promise<McpToolResult> {
  const { state, saveState, cwd } = ctx;

  state.iterationRound = (state.iterationRound ?? 0) + 1;
  const round = state.iterationRound;

  // Check for two consecutive clean rounds
  const consecutiveClean = state.consecutiveCleanRounds ?? 0;

  const gateChecks = [
    `### Gate 1: Tests passing\nRun \`npm test\` or equivalent. Report results.`,
    `### Gate 2: No regressions\nRun \`git diff HEAD~${Math.min(round, 5)} -- "*.test.*"\` to check test changes. Are all tests intentional?`,
    `### Gate 3: Code quality\nCheck for: TODO/FIXME left over, console.log not cleaned up, dead code. Report findings.`,
    `### Gate 4: Documentation\nAre new features/APIs documented? Do AGENTS.md, README need updates?`,
    `### Gate 5: Integration sanity\nDo a quick end-to-end smoke test if possible. Does the feature work as described in the goal?`,
  ];

  const currentGate = gateChecks[state.currentGateIndex ?? 0] ?? gateChecks[0];
  const gateIndex = (state.currentGateIndex ?? 0) % gateChecks.length;
  state.currentGateIndex = (gateIndex + 1) % gateChecks.length;
  saveState(state);

  const completionHint = consecutiveClean >= 1
    ? `\n\nAfter completing this gate: if everything passes clean, call \`orch_review\` with beadId="__gates__" again. After 2 consecutive clean gate rounds, the orchestration is complete.`
    : '';

  return {
    content: [{
      type: 'text',
      text: `## Review Gate (Round ${round})

${currentGate}

After completing this gate check:
- If it **passes**: call \`orch_review\` with beadId="__gates__" and action="looks-good" to advance
- If it **fails**: fix the issue and call \`orch_review\` with beadId="__gates__" and action="hit-me" to spawn fixers${completionHint}

**cwd:** ${cwd}`,
    }],
  };
}

function regressToPhase(
  ctx: ToolContext,
  targetPhase: import('../types.js').OrchestratorPhase,
  phaseName: string
): McpToolResult {
  const { state, saveState } = ctx;
  state.phase = targetPhase;
  state.currentGateIndex = 0;
  state.iterationRound = 0;
  saveState(state);

  const instructions: Record<string, string> = {
    planning: `Revise the plan${state.planDocument ? ` at \`${state.planDocument}\`` : ''}, then call \`orch_approve_beads\` to re-enter the approval flow.`,
    creating_beads: `Create/revise beads using \`br create\` and \`br update\`, then call \`orch_approve_beads\` to return to the approval menu.`,
    implementing: `Use \`br ready\` to find the next unblocked bead and implement it, then call \`orch_review\` when done.`,
  };

  return {
    content: [{
      type: 'text',
      text: `Regressed to **${phaseName} phase**.\n\n${instructions[targetPhase] || 'Continue from the appropriate phase.'}`,
    }],
  };
}

function extractFilesFromBead(bead: Bead): string[] {
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
