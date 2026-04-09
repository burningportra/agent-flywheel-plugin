import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, McpToolResult, Bead, ApproveArgs } from '../types.js';
import { computeConvergenceScore, computeBeadQualityScore, formatBeadQualityScore, pickRefinementModel, slugifyGoal } from './shared.js';
import { planGitDiffReviewPrompt, planIntegrationPrompt } from '../prompts.js';

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

/**
 * orch_approve_beads — Review and approve bead graph before implementation.
 *
 * action="start"    — Approve beads and launch implementation
 * action="polish"   — Request another refinement round
 * action="reject"   — Reject and stop orchestration
 * action="advanced" — Advanced refinement (requires advancedAction param)
 */
export async function runApprove(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult> {
  const { exec, cwd, state, saveState } = ctx;

  if (!state.selectedGoal) {
    return {
      content: [{ type: 'text', text: 'Error: No goal selected. Call orch_select first.' }],
      isError: true,
    };
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
  const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 10000 });
  if (brListResult.code !== 0) {
    return {
      content: [{
        type: 'text',
        text: `Error reading beads: ${brListResult.stderr}\n\nEnsure \`br\` CLI is installed and \`br init\` has been run in this directory.`,
      }],
      isError: true,
    };
  }

  let allBeads: Bead[] = [];
  try {
    allBeads = JSON.parse(brListResult.stdout);
  } catch {
    return {
      content: [{ type: 'text', text: 'Error: Could not parse br list output as JSON.' }],
      isError: true,
    };
  }

  const beads = allBeads.filter(b => b.status === 'open' || b.status === 'in_progress');

  if (beads.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No open beads found. Create beads first using:\n\`\`\`bash\nbr create --title "..." --description "..."\n\`\`\`\n\nThen call \`orch_approve_beads\` again.`,
      }],
    };
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
  const convergenceInfo = convergenceScore !== undefined
    ? `\n📈 Convergence: ${(convergenceScore * 100).toFixed(0)}%${
        convergenceScore >= 0.75
          ? ' ✅ — diminishing returns, ready to implement'
          : convergenceScore >= 0.50
          ? ' — still converging, another round recommended'
          : ' — low convergence, more polishing needed'
      }`
    : '';
  const roundHeader = round > 0
    ? `\nPolish round ${round}${changesInfo}${convergenceInfo}${state.polishConverged ? '\nSteady-state reached.' : ''}`
    : '';

  // ── Handle action ─────────────────────────────────────────────
  if (args.action === 'reject') {
    _lastBeadSnapshot = undefined;
    state.phase = 'idle';
    saveState(state);
    return {
      content: [{ type: 'text', text: 'Beads rejected. Orchestration stopped. Call `orch_profile` to start over.' }],
    };
  }

  if (args.action === 'polish') {
    return handlePolish(ctx, beads, round, false);
  }

  if (args.action === 'advanced') {
    return handleAdvanced(ctx, beads, round, args.advancedAction);
  }

  // action === 'start' — launch implementation
  return handleStart(ctx, beads, roundHeader, beadList, convergenceScore, state.selectedGoal);
}

async function handlePlanApproval(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult> {
  const { cwd, state, saveState } = ctx;
  const planPath = state.planDocument!;

  // Try to read the plan from docs/plans/ first, then cwd-relative
  let plan = '';
  const absPath = planPath.startsWith('/') ? planPath : join(cwd, planPath);
  if (existsSync(absPath)) {
    plan = readFileSync(absPath, 'utf8');
  } else {
    return {
      content: [{
        type: 'text',
        text: `Error: Plan document not found at \`${planPath}\`.\n\nGenerate the plan first using \`orch_plan\`, then call \`orch_approve_beads\` again.`,
      }],
      isError: true,
    };
  }

  const lineCount = plan.split('\n').length;
  const planRound = state.planRefinementRound ?? 0;

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
    return {
      content: [{ type: 'text', text: 'Plan rejected. Orchestration stopped.' }],
    };
  }

  if (args.action === 'git-diff-review') {
    state.phase = 'planning';
    state.planRefinementRound = planRound + 1;
    saveState(state);

    const reviewPrompt = planGitDiffReviewPrompt(plan);
    const integrationHint = `After collecting the reviewer's proposed revisions, call \`orch_approve_beads\` again — the tool will then prompt you to integrate them using \`planIntegrationPrompt\`.`;
    return {
      content: [{
        type: 'text',
        text: `**📝 Git-diff review pass (round ${planRound + 1})**\n\nSpawn a fresh reviewer agent with this prompt:\n\n---\n${reviewPrompt}\n---\n\nCollect the reviewer's proposed changes. Then spawn an integration agent with:\n\`\`\`\n${planIntegrationPrompt('<original plan from ' + planPath + '>', '<reviewer proposed revisions>')}\n\`\`\`\n\nHave the integration agent save the merged plan back to \`${planPath}\`, then call \`orch_approve_beads\` again.\n\n${sizeGate}\n\n${integrationHint}`,
      }],
    };
  }

  if (args.action === 'polish') {
    state.phase = 'planning';
    state.planRefinementRound = planRound + 1;
    saveState(state);

    const refinementModel = pickRefinementModel(planRound);
    return {
      content: [{
        type: 'text',
        text: `**NEXT: Refine the plan (round ${planRound + 1}) using model \`${refinementModel}\`.**\n\nRead the plan at \`${planPath}\`, critique it, and improve it. Focus on:\n- Missing implementation details\n- Underspecified acceptance criteria\n- Gaps in testing strategy\n- Edge cases not covered\n\nAfter improving, save the updated plan back to \`${planPath}\`, then call \`orch_approve_beads\` again.\n\nAlternatively, use \`action: "git-diff-review"\` for a git-diff style review cycle that proposes targeted changes with rationale.\n\n${sizeGate}`,
      }],
    };
  }

  // action === 'start' — approve plan and transition to bead creation
  state.phase = 'creating_beads';
  state.planRefinementRound = 0;
  saveState(state);

  const slug = slugifyGoal(state.selectedGoal!);
  const beadPrompt = buildPlanToBeadsPrompt(plan, state.selectedGoal!, planPath);

  return {
    content: [{
      type: 'text',
      text: `**Plan approved!** (${lineCount} lines)${sizeGate}\n\n**NEXT: Create beads from the plan using \`br create\` and \`br dep add\`, then call \`orch_approve_beads\` with action="start" to launch implementation.**\n\n---\n\n${beadPrompt}`,
    }],
  };
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

After creating all beads, call \`orch_approve_beads\` with action="start" to review and launch.`;
}

async function handleStart(
  ctx: ToolContext,
  beads: Bead[],
  roundHeader: string,
  beadList: string,
  convergenceScore: number | undefined,
  goal: string
): Promise<McpToolResult> {
  const { exec, cwd, state, saveState } = ctx;

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
  const brReadyResult = await exec('br', ['ready', '--json'], { cwd, timeout: 10000 });
  let ready: Bead[] = [];

  if (brReadyResult.code === 0) {
    try {
      ready = JSON.parse(brReadyResult.stdout);
    } catch { ready = []; }
  }

  // Fallback: if br ready fails, find beads with no open dependencies
  if (ready.length === 0) {
    ready = beads.slice(0, 3); // take first few as fallback
  }

  if (ready.length === 0) {
    saveState(state);
    return {
      content: [{
        type: 'text',
        text: `Beads approved! But no ready beads found (all may be blocked).\n\nRun \`br ready\` or \`br dep cycles\` to diagnose.\n\n${beadList}`,
      }],
    };
  }

  // Mark ready beads as in_progress
  for (const bead of ready) {
    await exec('br', ['update', bead.id, '--status', 'in_progress'], { cwd, timeout: 5000 });
  }
  state.currentBeadId = ready[0].id;
  saveState(state);

  const convergenceNote = convergenceScore !== undefined
    ? `\n📈 Convergence: ${(convergenceScore * 100).toFixed(0)}%${
        convergenceScore >= 0.75 ? ' ✅' : convergenceScore >= 0.50 ? ' (converging)' : ' (low)'
      }`
    : '';

  // Always compute and display bead quality score
  const beadQuality = computeBeadQualityScore(beads);
  const qualityNote = `\n${formatBeadQualityScore(beadQuality)}`;

  if (ready.length === 1) {
    // Sequential: single bead
    const bead = ready[0];
    return {
      content: [{
        type: 'text',
        text: `**Beads approved!** ${beads.length} total.${convergenceNote}${qualityNote}${roundHeader}

**NEXT: Implement bead ${bead.id} (${bead.title}), then call \`orch_review\` when done.**

---

## Bead ${bead.id}: ${bead.title}

${bead.description}

After implementing:
1. Do a self-review of all changes
2. Run tests if applicable
3. Commit: \`git add <changed files> && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\`
4. Call \`orch_review\` with beadId="${bead.id}" and a summary of what you did

${beadList}`,
      }],
    };
  }

  // Parallel: multiple ready beads — return agent configs for CC to spawn
  const agentConfigs = ready.map((bead) => ({
    name: `bead-${bead.id}`,
    cwd,
    task: `You are implementing bead ${bead.id} as part of the orchestration workflow.

## ${bead.title}

${bead.description}

## Instructions
1. Implement all changes described in the bead
2. Only modify files listed in the bead scope
3. Run tests if applicable
4. Do a fresh-eyes self-review
5. Commit: \`git add <files> && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\`

After completing, report your summary to the orchestrator.`,
  }));

  return {
    content: [{
      type: 'text',
      text: `**Beads approved!** ${beads.length} total, ${ready.length} ready now.${convergenceNote}${qualityNote}${roundHeader}

**NEXT: Spawn ${ready.length} parallel agents (one per ready bead), then call \`orch_review\` for each when done.**

\`\`\`json
${JSON.stringify({ agents: agentConfigs }, null, 2)}
\`\`\`

After all agents complete, call \`orch_review\` for each bead with its agent's summary.

${beadList}`,
    }],
  };
}

function handlePolish(ctx: ToolContext, beads: Bead[], round: number, fresh: boolean): McpToolResult {
  const { cwd, state, saveState } = ctx;
  state.phase = 'refining_beads';
  saveState(state);

  const model = pickRefinementModel(round);
  const compactList = beads.map(b => `• ${b.id}: ${b.title}`).join('\n');

  if (fresh) {
    return {
      content: [{
        type: 'text',
        text: `**NEXT: Spawn a fresh refinement agent (round ${round + 1}), then call \`orch_approve_beads\` with action="start" or action="polish" again.**

Use model \`${model}\` for diverse perspective (prevents taste convergence).

The agent should:
1. Run \`br list --json\` to read all beads
2. Review each bead for WHAT/WHY/HOW completeness
3. Use \`br update <id> --description "..."\` to improve weak beads
4. Check for missing dependencies with \`br dep list <id>\`

Current beads (${beads.length} total):\n${compactList}\n\ncd ${cwd}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `**NEXT: Review and refine the beads (round ${round + 1}), then call \`orch_approve_beads\` again.**

For each bead, check:
- WHAT: Are implementation steps concrete and specific?
- WHY: Is the business/technical rationale clear?
- HOW: Are the exact files listed?
- Dependencies: Are dep relationships correct?

Use \`br update <id> --description "..."\` to improve, \`br show <id>\` for details.
Use \`br dep add/remove\` to fix dependency graph.

After refining, call \`orch_approve_beads\` with action="start" or action="polish".

Current beads (${beads.length} total):\n${compactList}\n\ncd ${cwd}`,
    }],
  };
}

function handleAdvanced(
  ctx: ToolContext,
  beads: Bead[],
  round: number,
  advancedAction?: string
): McpToolResult {
  const { cwd, state, saveState } = ctx;

  if (!advancedAction) {
    return {
      content: [{
        type: 'text',
        text: `Error: advancedAction is required when action="advanced". Options: fresh-agent, same-agent, blunder-hunt, dedup, cross-model, graph-fix`,
      }],
      isError: true,
    };
  }

  const compactList = beads.map(b => `• ${b.id}: ${b.title}`).join('\n');

  if (advancedAction === 'fresh-agent') {
    return handlePolish(ctx, beads, round, true);
  }

  if (advancedAction === 'same-agent') {
    return handlePolish(ctx, beads, round, false);
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
        text: `**NEXT: Run 5 blunder hunt passes, then call \`orch_approve_beads\` again.**\n\n${passes}\n\ncd ${cwd}\n\nCurrent beads:\n${compactList}`,
      }],
    };
  }

  if (advancedAction === 'dedup') {
    state.phase = 'refining_beads';
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**NEXT: Run a deduplication pass on all beads, then call \`orch_approve_beads\` again.**

Check all open beads for overlap or redundancy:
1. \`br list --json\` — read all beads
2. For each pair of similar beads: merge the weaker one into the stronger
3. Close duplicates: \`br update <id> --status closed\`
4. Transfer dependencies: \`br dep add <survivor> --depends-on <deps-of-closed>\`

Report what was merged. Then call \`orch_approve_beads\`.

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
        text: `**NEXT: Spawn a cross-model review agent using \`${altModel}\`, then call \`orch_approve_beads\` again.**

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

    return {
      content: [{
        type: 'text',
        text: `**NEXT: Diagnose and fix the bead dependency graph, then call \`orch_approve_beads\` again.**

Check for:
1. **Cycles:** \`br dep cycles\` — if any, remove the cycle-causing dep
2. **Orphans:** Beads with no dependencies that should be grouped
3. **Bottlenecks:** Beads that block many others — consider splitting
4. **Missing deps:** Beads that should depend on others but don't

Fix issues with \`br dep add/remove\`, then call \`orch_approve_beads\`.

cd ${cwd}

Current beads:\n${compactList}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Unknown advancedAction: ${advancedAction}. Valid options: fresh-agent, same-agent, blunder-hunt, dedup, cross-model, graph-fix`,
    }],
    isError: true,
  };
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
