import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext, McpToolResult, CandidateIdea, DiscoverArgs } from '../types.js';

/**
 * orch_discover — Accept LLM-generated ideas and store them in state.
 *
 * The calling Claude agent generates 5-15 ideas based on the repo profile
 * from orch_profile, then calls this tool with the structured list.
 * After storing, it instructs the agent to call orch_select.
 */
export async function runDiscover(ctx: ToolContext, args: DiscoverArgs): Promise<McpToolResult> {
  const { state, saveState } = ctx;

  if (!state.repoProfile) {
    return {
      content: [{ type: 'text', text: 'Error: No repo profile found. Call orch_profile first.' }],
      isError: true,
    };
  }

  const ideas = (args.ideas || []) as CandidateIdea[];
  if (ideas.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: No ideas provided. Pass at least 3 ideas in the ideas array.' }],
      isError: true,
    };
  }

  state.candidateIdeas = ideas;
  state.phase = 'awaiting_selection';
  saveState(state);

  // Write artifact for reference
  const topIdeas = ideas.filter(i => i.tier === 'top');
  const honorableIdeas = ideas.filter(i => i.tier === 'honorable' || !i.tier);
  const artifactLines: string[] = [
    `# Discovery Ideas — ${new Date().toISOString().slice(0, 10)}`,
    '',
  ];
  if (topIdeas.length > 0) {
    artifactLines.push('## Top Picks', '');
    for (const idea of topIdeas) {
      artifactLines.push(
        `### ${idea.title}`,
        `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`,
        '',
        idea.description,
      );
      if (idea.rationale) artifactLines.push('', `**Rationale:** ${idea.rationale}`);
      if (idea.scores) {
        const s = idea.scores;
        const weighted = s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
        artifactLines.push(`**Score:** ${weighted.toFixed(1)}/37.5`);
      }
      artifactLines.push('');
    }
  }
  if (honorableIdeas.length > 0) {
    artifactLines.push('## Honorable Mentions', '');
    for (const idea of honorableIdeas) {
      artifactLines.push(
        `### ${idea.title}`,
        `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`,
        '',
        idea.description,
        '',
      );
    }
  }
  try {
    const artifactDir = join(tmpdir(), 'claude-orchestrator-discovery');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, `ideas-${Date.now()}.md`), artifactLines.join('\n'), 'utf8');
  } catch { /* best-effort */ }

  // Format idea list for the agent
  const ideaList = ideas.map((idea, i) => {
    let line = `${i + 1}. **[${idea.category}] ${idea.title}** (effort: ${idea.effort}, impact: ${idea.impact})`;
    if (idea.tier === 'honorable') line += ' _(honorable mention)_';
    line += `\n   ${idea.description}`;
    if (idea.scores) {
      const s = idea.scores;
      const weighted = s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
      line += `\n   Score: ${weighted.toFixed(1)}/37.5`;
    }
    if (idea.rationale) line += `\n   _${idea.rationale}_`;
    return line;
  }).join('\n\n');

  const text = `**NEXT: Call \`orch_select\` with the user's chosen goal.**

Present these ${ideas.length} ideas to the user (${topIdeas.length} top, ${honorableIdeas.length} honorable) and ask them to choose one. Then call \`orch_select\` with their chosen goal.

---

${ideaList}`;

  return { content: [{ type: 'text', text }] };
}
