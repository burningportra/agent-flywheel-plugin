import type { ToolContext, McpToolResult, OrchestratorState } from '../types.js';
import { formatRepoProfile } from './shared.js';
import { profileRepo } from '../profiler.js';

interface ProfileArgs {
  cwd: string;
  goal?: string;
}

/**
 * orch_profile — Scan the current repo and build a profile.
 *
 * Runs git log, finds key files, detects language/framework/CI/test tooling.
 * Detects the br CLI (beads) for coordination backend.
 * Returns a structured profile and discovery instructions.
 */
export async function runProfile(ctx: ToolContext, args: ProfileArgs): Promise<McpToolResult> {
  const { exec, cwd, state, saveState } = ctx;

  state.phase = 'profiling';

  // ── Collect repo signals ──────────────────────────────────────
  const profile = await profileRepo(exec, cwd);

  // ── Detect coordination backends ──────────────────────────────
  const brResult = await exec('br', ['--version'], { cwd, timeout: 5000 });
  const hasBeads = brResult.code === 0;

  const coordinationBackend = {
    beads: hasBeads,
    agentMail: false, // agent-mail detection out of scope for MCP
    sophia: false,
  };
  const coordinationStrategy = hasBeads ? 'beads' : 'bare';

  state.repoProfile = profile;
  state.coordinationBackend = coordinationBackend;
  state.coordinationStrategy = coordinationStrategy as OrchestratorState['coordinationStrategy'];
  state.coordinationMode ??= 'worktree';
  if (args.goal) state.selectedGoal = args.goal;
  state.phase = 'discovering';
  saveState(state);

  // ── Foundation gaps ───────────────────────────────────────────
  const foundationGaps: string[] = [];
  const hasAgentsMd = profile.keyFiles && Object.keys(profile.keyFiles).some(f => f.toLowerCase().includes('agents.md'));
  if (!hasAgentsMd) foundationGaps.push('- No AGENTS.md found. Consider creating one for agent guidance.');
  if (!profile.hasTests) foundationGaps.push('- No test framework detected.');
  if (!profile.hasCI) foundationGaps.push('- No CI tooling detected.');
  if (profile.recentCommits.length === 0) foundationGaps.push('- No git history detected.');
  const foundationWarning = foundationGaps.length > 0
    ? `\n\n### Foundation Gaps\n${foundationGaps.join('\n')}`
    : '';

  // ── Beads status ──────────────────────────────────────────────
  let beadStatus = '';
  if (hasBeads) {
    const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 10000 });
    if (brListResult.code === 0) {
      try {
        const beads: any[] = JSON.parse(brListResult.stdout);
        const open = beads.filter((b: any) => b.status === 'open' || b.status === 'in_progress');
        const deferred = beads.filter((b: any) => b.status === 'deferred');
        if (open.length > 0 || deferred.length > 0) {
          beadStatus = `\n\n### Existing Beads\n- ${open.length} open/in-progress\n- ${deferred.length} deferred`;
          if (open.length > 0) {
            beadStatus += `\n\nTo work on existing beads, call \`orch_approve_beads\` with action="start".`;
          }
        }
      } catch { /* parse failure ok */ }
    }
  }

  const coordLine = hasBeads
    ? `Coordination: beads (br CLI detected)`
    : `Coordination: bare (no beads CLI detected — run \`br init\` to enable task tracking)`;

  const roadmap = `**Workflow:** profile → discover → select → plan → approve_beads → implement → review`;

  const goalSection = args.goal
    ? `\n\n### Goal\n${args.goal}\n\nSince a goal was provided, you can skip discovery and call \`orch_select\` directly with this goal, or call \`orch_discover\` to generate alternatives.`
    : `\n\n### Next Step\nCall \`orch_discover\` with 5-15 project ideas based on this profile.`;

  const formatted = formatRepoProfile(profile);

  const text = `${roadmap}\n\n${coordLine}${foundationWarning}${beadStatus}${goalSection}\n\n---\n\n${formatted}`;

  return { content: [{ type: 'text', text }] };
}
