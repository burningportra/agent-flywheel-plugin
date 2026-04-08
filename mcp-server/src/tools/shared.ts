import type { OrchestratorState } from '../types.js';

export function formatModelRef(model: { provider?: string; id: string }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * Pick execution mode: single-branch (shared checkout) or worktree (isolated checkouts).
 */
export function resolveExecutionMode(
  coordinationMode: OrchestratorState['coordinationMode'],
  hasAgentMail: boolean
): 'worktree' | 'single-branch' {
  if (coordinationMode === 'single-branch') return 'single-branch';
  if (coordinationMode === 'worktree') return 'worktree';
  return hasAgentMail ? 'single-branch' : 'worktree';
}

/**
 * Convergence score computation from polish change history.
 * Returns a 0-1 score where 1 = fully converged (no more changes).
 */
export function computeConvergenceScore(
  polishChanges: number[],
  outputSizes?: number[]
): number {
  if (polishChanges.length < 3) return 0;

  const recent = polishChanges.slice(-3);
  const total = recent.reduce((s, n) => s + n, 0);

  // Zero changes in last 3 rounds = fully converged
  if (total === 0) return 1;

  // Compute trend: are changes decreasing?
  const trend = recent[2] <= recent[0] ? 0.2 : 0;

  // Size stability bonus
  let sizeBonus = 0;
  if (outputSizes && outputSizes.length >= 2) {
    const last = outputSizes[outputSizes.length - 1];
    const prev = outputSizes[outputSizes.length - 2];
    const delta = Math.abs(last - prev) / Math.max(prev, 1);
    sizeBonus = delta < 0.02 ? 0.2 : delta < 0.05 ? 0.1 : 0;
  }

  // Monotonically decreasing = good signal
  const isDecreasing = recent.every((v, i) => i === 0 || v <= recent[i - 1]);
  const decreasingBonus = isDecreasing ? 0.15 : 0;

  // Base score inversely proportional to total changes (capped at 5 per round)
  const normalized = Math.min(total / (3 * 5), 1);
  const base = 1 - normalized;

  return Math.min(1, base * 0.65 + trend + sizeBonus + decreasingBonus);
}

/** Model rotation list for refinement rounds (prevents taste convergence). */
const REFINEMENT_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];

export function pickRefinementModel(round: number): string {
  return REFINEMENT_MODELS[round % REFINEMENT_MODELS.length];
}

/** Default deep plan model assignments. */
export const DEEP_PLAN_MODELS = {
  correctness: 'claude-opus-4-6',
  robustness: 'claude-sonnet-4-6',
  ergonomics: 'claude-sonnet-4-6',
  synthesis: 'claude-opus-4-6',
} as const;

export const SWARM_STAGGER_DELAY_MS = 30_000;

/**
 * Slugify a goal string to a filesystem-safe identifier.
 */
export function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plan';
}

/**
 * Format a repo profile into a readable summary string for prompts.
 */
export function formatRepoProfile(profile: import('../types.js').RepoProfile): string {
  const lines: string[] = [];
  lines.push(`## Repository: ${profile.name || '(unnamed)'}`);
  lines.push(`**Languages:** ${profile.languages.join(', ') || 'unknown'}`);
  lines.push(`**Frameworks:** ${profile.frameworks.join(', ') || 'none'}`);
  if (profile.packageManager) lines.push(`**Package manager:** ${profile.packageManager}`);
  if (profile.testFramework) lines.push(`**Test framework:** ${profile.testFramework}`);
  lines.push(`**Has tests:** ${profile.hasTests ? 'yes' : 'no'}`);
  lines.push(`**Has CI:** ${profile.hasCI ? `yes (${profile.ciPlatform || 'unknown'})` : 'no'}`);
  if (profile.entrypoints.length > 0) {
    lines.push(`**Entrypoints:** ${profile.entrypoints.slice(0, 5).join(', ')}`);
  }
  if (profile.recentCommits.length > 0) {
    lines.push(`\n**Recent commits:**`);
    for (const c of profile.recentCommits.slice(0, 5)) {
      lines.push(`- ${c.hash.slice(0, 7)} ${c.message.slice(0, 60)}`);
    }
  }
  if (profile.todos.length > 0) {
    lines.push(`\n**TODOs (${profile.todos.length}):**`);
    for (const t of profile.todos.slice(0, 5)) {
      lines.push(`- ${t.file}:${t.line} — ${t.text.slice(0, 80)}`);
    }
  }
  if (profile.keyFiles && Object.keys(profile.keyFiles).length > 0) {
    lines.push(`\n**Key files:**`);
    for (const [name, content] of Object.entries(profile.keyFiles).slice(0, 5)) {
      lines.push(`- \`${name}\`: ${content.slice(0, 100)}`);
    }
  }
  if (profile.structure) {
    lines.push(`\n**Directory structure:**\n\`\`\`\n${profile.structure.slice(0, 2000)}\n\`\`\``);
  }
  return lines.join('\n');
}

/**
 * Build the bead creation prompt given a goal and repo context.
 */
export function beadCreationPrompt(
  goal: string,
  repoContext: string,
  constraints: string[]
): string {
  const constraintSection = constraints.length > 0
    ? `\n\n## Constraints\n${constraints.map(c => `- ${c}`).join('\n')}`
    : '';

  return `## Goal\n${goal}${constraintSection}\n\n## Repository Context\n${repoContext}

## Bead Creation Instructions

Create a set of implementation beads using the \`br\` CLI. Each bead represents one focused unit of work.

### Rules
1. Use \`br create --title "..." --description "..." --priority <0-4> --type task\`
2. Add dependencies with \`br dep add <bead-id> --depends-on <other-id>\`
3. Each bead must have:
   - **WHAT**: Concrete implementation steps
   - **WHY**: Business or technical rationale
   - **HOW**: Specific files to create/modify
4. Scope beads to single concerns — no mega-beads
5. Order by dependency: foundation beads before feature beads
6. Use descriptive titles (verb phrases work well: "Add rate limiting to /api/submit")

### After creating beads
Call \`orch_approve_beads\` to review and approve the bead graph before implementation begins.`;
}

/**
 * Build implementer instructions for a single bead.
 */
export function implementerInstructions(
  bead: import('../types.js').Bead,
  profile: import('../types.js').RepoProfile,
  prevResults: import('../types.js').BeadResult[],
  cassMemory?: string,
  episodic?: string
): string {
  const prevSummary = prevResults.length > 0
    ? `\n\n## Prior bead results\n${prevResults.slice(-3).map(r => `- ${r.beadId}: ${r.status} — ${r.summary.slice(0, 100)}`).join('\n')}`
    : '';

  const memSection = cassMemory
    ? `\n\n## CASS memory (relevant rules)\n${cassMemory.slice(0, 500)}`
    : '';

  const episodicSection = episodic
    ? `\n\n## Prior session context\n${episodic.slice(0, 500)}`
    : '';

  return `## Implement Bead: ${bead.id}

### ${bead.title}

${bead.description}

---

**Repo:** ${profile.name || cwd_from_profile(profile)} | **Languages:** ${profile.languages.join(', ')}
${prevSummary}${memSection}${episodicSection}

## Instructions
1. Read the bead description carefully — it specifies WHAT, WHY, and HOW
2. Implement all changes described
3. Run tests if applicable
4. Do a fresh-eyes review of your changes
5. Commit: \`git add <files> && git commit -m "bead ${bead.id}: ${bead.title.slice(0, 60)}"\`
6. Call \`orch_review\` with beadId="${bead.id}" and your summary`;
}

function cwd_from_profile(profile: import('../types.js').RepoProfile): string {
  return profile.name || 'project';
}
