import type {
  McpToolResult,
  FlywheelStructuredError,
  FlywheelToolError,
  FlywheelToolName,
  FlywheelPhase,
  ToolChoiceOption,
  ToolNextStep,
  FlywheelErrorCode,
} from '../types.js';
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { makeFlywheelErrorResult } from '../errors.js';
import { buildBeadCreationPrompt } from './bead-prompt.js';

export function makeChoiceOption(
  id: string,
  label: string,
  options: Omit<ToolChoiceOption, 'id' | 'label'> = {}
): ToolChoiceOption {
  return {
    id,
    label,
    ...options,
  };
}

export function makeNextToolStep(
  type: ToolNextStep['type'],
  message: string,
  options: Omit<ToolNextStep, 'type' | 'message'> = {}
): ToolNextStep {
  return {
    type,
    message,
    ...options,
  };
}

export function makeToolResult<TStructured>(text: string, structuredContent: TStructured): McpToolResult<TStructured> {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export function makeOkToolResult<TData>(
  tool: FlywheelToolName,
  phase: FlywheelPhase | string,
  text: string,
  data: TData,
): McpToolResult {
  return makeToolResult(text, {
    tool,
    version: 1 as const,
    status: 'ok' as const,
    phase,
    data,
  });
}

export function makeToolError(
  tool: FlywheelToolName,
  phase: FlywheelPhase,
  code: FlywheelErrorCode,
  message: string,
  options: Omit<FlywheelToolError, 'code' | 'message' | 'tool' | 'phase' | 'timestamp'> = {}
): McpToolResult<FlywheelStructuredError> {
  return makeFlywheelErrorResult(tool, phase, { code, message, ...options });
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

/**
 * Walk a directory and return the newest mtime (ms) across matching files.
 * Skips node_modules and dot-directories. Returns null if nothing matched.
 */
export function newestMtime(root: string, filter: (name: string) => boolean = () => true): number | null {
  let max: number | null = null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile() && filter(e.name)) {
        try {
          const m = statSync(full).mtimeMs;
          if (max === null || m > max) max = m;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return max;
}

export { slugifyGoal } from './bead-program.js';

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
  constraints: string[],
  provenance?: string,
): string {
  return buildBeadCreationPrompt({
    goal,
    repoContext,
    constraints,
    provenance,
  });
}

// ─── Bead Quality Score ──────────────────────────────────────

export interface BeadQualityScore {
  /** 0-1 composite score. */
  score: number;
  /** Human-readable label. */
  label: string;
  /** Per-bead issues found. */
  weakBeads: string[];
}

const VERB_PREFIXES = [
  'add', 'create', 'fix', 'update', 'remove', 'implement', 'refactor',
  'migrate', 'extract', 'replace', 'guard', 'wrap', 'build', 'write',
  'enable', 'disable', 'configure', 'integrate', 'expose', 'clean', 'port',
  'set', 'register', 'drop', 'rename', 'move', 'split', 'merge', 'wire',
];
const FILE_PATTERN = /\.(ts|js|tsx|jsx|py|go|rs|json|md|yaml|yml|toml|sh|sql|css|scss|html)\b|\/src\/|\/lib\/|\/api\//i;
const CRITERIA_PATTERN = /accept(ance)?[\s_-]crite|criteria:|acceptance:|✓|- \[|\*\*acceptance/i;
const WHAT_WHY_HOW = /\b(what|why|how)\b/i;

/**
 * Heuristic bead quality score based on description richness, title quality,
 * file specificity, and acceptance criteria presence.
 * Returns a 0-1 score and a summary label — no LLM call required.
 */
export function computeBeadQualityScore(beads: import('../types.js').Bead[]): BeadQualityScore {
  if (beads.length === 0) return { score: 0, label: '⛔ no beads', weakBeads: [] };

  let totalScore = 0;
  const weakBeads: string[] = [];

  for (const bead of beads) {
    let beadScore = 0;
    const issues: string[] = [];

    // Title quality (0-25 pts): should be a verb phrase
    const firstWord = bead.title.toLowerCase().trim().split(/\s+/)[0] ?? '';
    const titleScore = VERB_PREFIXES.some(v => firstWord.startsWith(v)) ? 25 : 10;
    beadScore += titleScore;
    if (titleScore < 20) issues.push('title not a verb phrase');

    // Description completeness (0-35 pts): length + WHAT/WHY/HOW presence
    const descLen = bead.description.trim().length;
    let descScore = descLen >= 300 ? 35 : descLen >= 150 ? 25 : descLen >= 50 ? 15 : 5;
    if (WHAT_WHY_HOW.test(bead.description)) descScore = Math.min(35, descScore + 5);
    beadScore += descScore;
    if (descLen < 50) issues.push('description too short');

    // File specificity (0-25 pts): mentions file paths or extensions
    const fileScore = FILE_PATTERN.test(bead.description) ? 25 : 8;
    beadScore += fileScore;
    if (fileScore < 20) issues.push('no file paths specified');

    // Acceptance criteria (0-15 pts)
    const criteriaScore = CRITERIA_PATTERN.test(bead.description) ? 15 : 5;
    beadScore += criteriaScore;
    if (criteriaScore < 10) issues.push('no acceptance criteria');

    totalScore += beadScore;
    if (issues.length > 0) weakBeads.push(`${bead.id} (${issues.join(', ')})`);
  }

  const score = Math.round((totalScore / (beads.length * 100)) * 100) / 100;
  const label = score >= 0.85 ? '✅ high quality'
    : score >= 0.70 ? '⚠️  acceptable'
    : '⛔ needs polish';

  return { score, label, weakBeads };
}

/**
 * Format a BeadQualityScore for display.
 */
export function formatBeadQualityScore(q: BeadQualityScore): string {
  const bar = Math.round(q.score * 10);
  const filled = '█'.repeat(bar) + '░'.repeat(10 - bar);
  const lines = [`📊 **Bead quality: ${(q.score * 100).toFixed(0)}/100** ${filled} ${q.label}`];
  if (q.weakBeads.length > 0) {
    lines.push(`   Weak beads: ${q.weakBeads.slice(0, 3).join(' | ')}`);
  }
  return lines.join('\n');
}
