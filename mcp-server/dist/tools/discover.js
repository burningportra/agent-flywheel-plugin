import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeNextToolStep, makeToolError, makeToolResult } from './shared.js';
/**
 * flywheel_discover — Accept LLM-generated ideas and store them in state.
 *
 * The calling Claude agent generates 5-15 ideas based on the repo profile
 * from flywheel_profile, then calls this tool with the structured list.
 * After storing, it instructs the agent to call flywheel_select.
 */
export async function runDiscover(ctx, args) {
    const { state, saveState } = ctx;
    if (!state.repoProfile) {
        return makeToolError('flywheel_discover', state.phase, 'missing_prerequisite', 'Error: No repo profile found. Call flywheel_profile first.', {
            hint: 'Call flywheel_profile to generate a repo profile before calling flywheel_discover.',
        });
    }
    const ideas = (args.ideas || []);
    if (ideas.length === 0) {
        return makeToolError('flywheel_discover', state.phase, 'invalid_input', 'Error: No ideas provided. Pass at least 3 ideas in the ideas array.', {
            hint: 'Generate 5-15 ideas from the repo profile and pass them in the ideas array.',
        });
    }
    state.candidateIdeas = ideas;
    state.phase = 'awaiting_selection';
    saveState(state);
    // Write artifact for reference
    const topIdeas = ideas.filter(i => i.tier === 'top');
    const honorableIdeas = ideas.filter(i => i.tier === 'honorable' || !i.tier);
    const duelIdeas = ideas.filter(i => i.provenance?.source === 'duel' || i.provenance?.source === 'reality-check-duel');
    const contestedIdeas = duelIdeas.filter(i => i.provenance?.contested === true);
    const artifactLines = [
        `# Discovery Ideas — ${new Date().toISOString().slice(0, 10)}`,
        '',
    ];
    if (topIdeas.length > 0) {
        artifactLines.push('## Top Picks', '');
        for (const idea of topIdeas) {
            artifactLines.push(`### ${idea.title}`, `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`, '', idea.description);
            if (idea.rationale)
                artifactLines.push('', `**Rationale:** ${idea.rationale}`);
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
            artifactLines.push(`### ${idea.title}`, `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`, '', idea.description, '');
        }
    }
    try {
        const artifactDir = join(tmpdir(), 'agent-flywheel-discovery');
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(artifactDir, `ideas-${Date.now()}.md`), artifactLines.join('\n'), 'utf8');
    }
    catch { /* best-effort */ }
    // Format idea list for the agent
    const ideaList = ideas.map((idea, i) => {
        let line = `${i + 1}. **[${idea.category}] ${idea.title}** (effort: ${idea.effort}, impact: ${idea.impact})`;
        if (idea.tier === 'honorable')
            line += ' _(honorable mention)_';
        if (idea.provenance?.contested)
            line += ' ⚔️ _contested_';
        line += `\n   ${idea.description}`;
        if (idea.scores) {
            const s = idea.scores;
            const weighted = s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
            line += `\n   Score: ${weighted.toFixed(1)}/37.5`;
        }
        if (idea.provenance?.agentScores) {
            const parts = Object.entries(idea.provenance.agentScores).map(([k, v]) => `${k}=${v}`);
            line += `\n   Cross-scores (0-1000): ${parts.join(', ')}`;
        }
        if (idea.provenance?.survivingCritique) {
            line += `\n   ⚠ Surviving critique: ${idea.provenance.survivingCritique}`;
        }
        if (idea.rationale)
            line += `\n   _${idea.rationale}_`;
        return line;
    }).join('\n\n');
    const provenanceHint = duelIdeas.length > 0
        ? `\n\nThis discovery batch came out of a /dueling-idea-wizards run (${duelIdeas.length} adversarially cross-scored idea${duelIdeas.length === 1 ? '' : 's'}, ${contestedIdeas.length} contested). When you present these to the user, group them as **Consensus winners** (provenance.contested=false) and **Contested** (provenance.contested=true) so the user sees where the agents disagreed. Carry the surviving critique into the bead body's Provenance block at bead-creation time.`
        : '';
    const text = `**NEXT: Call \`flywheel_select\` with the user's chosen goal.**

Present these ${ideas.length} ideas to the user (${topIdeas.length} top, ${honorableIdeas.length} honorable) and ask them to choose one. Then call \`flywheel_select\` with their chosen goal.${provenanceHint}

---

${ideaList}`;
    return makeToolResult(text, {
        tool: 'flywheel_discover',
        version: 1,
        status: 'ok',
        phase: state.phase,
        nextStep: makeNextToolStep('call_tool', 'Present the ideas to the user, then call flywheel_select with the chosen goal.', {
            tool: 'flywheel_select',
            argsSchemaHint: { goal: 'string' },
        }),
        data: {
            kind: 'ideas_registered',
            totalIdeas: ideas.length,
            topIdeas: topIdeas.length,
            honorableIdeas: honorableIdeas.length,
            ideaIds: ideas.map(idea => idea.id),
            ideas: ideas.map(idea => ({
                id: idea.id,
                title: idea.title,
                category: idea.category,
                effort: idea.effort,
                impact: idea.impact,
                tier: idea.tier,
                rationale: idea.rationale,
                provenance: idea.provenance,
            })),
            duelIdeas: duelIdeas.length,
            contestedIdeas: contestedIdeas.length,
        },
    });
}
//# sourceMappingURL=discover.js.map