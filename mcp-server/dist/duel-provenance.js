import { markdownFenceFor } from './utils/markdown-fence.js';
const CANONICAL_AGENTS = ['cc', 'cod', 'gmi'];
const CANONICAL_AGENT_SET = new Set(CANONICAL_AGENTS);
const DUEL_MODES = new Set([
    'ideas',
    'architecture',
    'security',
    'reliability',
    'ux',
    'performance',
    'innovation',
]);
function cleanInline(value) {
    const trimmed = value.trim().replace(/^\*\*|\*\*$/g, '').trim();
    if (trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
            || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function cleanTitle(value) {
    return value
        .replace(/^\s*\d+[.)]\s*/, '')
        .replace(/[*`]/g, '')
        .trim();
}
function normalizedTitle(value) {
    return cleanTitle(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function normalizeAgent(label) {
    const compact = label.toLowerCase().replace(/cross[- ]?score|score/g, '').replace(/[^a-z0-9]+/g, '');
    if (compact === 'cc' || compact.includes('claude'))
        return 'cc';
    if (compact === 'cod' || compact.includes('codex'))
        return 'cod';
    if (compact === 'gmi' || compact === 'agy' || compact.includes('gemini'))
        return 'gmi';
    return compact;
}
function parseScoreValue(value) {
    const cleaned = value.replace(/\*\*/g, '').trim().toLowerCase();
    if (/[<>]/.test(cleaned) || /\b0\s*-\s*1000\b/.test(cleaned))
        return undefined;
    const scores = (cleaned.match(/\b(?:1000|[0-9]{1,3})\b/g) ?? [])
        .map(Number)
        .filter(score => score >= 0 && score <= 1000);
    if (scores.length === 1)
        return scores[0];
    if (scores.length > 1)
        return scores;
    if (/^self(?:\b|$)/.test(cleaned))
        return 'self';
    if (/^(?:n\/?a|not available|none)$/.test(cleaned))
        return 'n/a';
    return undefined;
}
function parseExplicitScores(text) {
    let payload;
    for (const line of text.split('\n')) {
        const match = /^\s*(?:[-*]\s*)?\*{0,2}Agent scores\*{0,2}\s*:\s*(.+)$/i.exec(line);
        if (!match)
            continue;
        payload = match[1].replace(/^\*{1,2}\s*/, '');
        break;
    }
    if (payload === undefined)
        return undefined;
    const result = {};
    for (const part of payload.split(/[,;]/)) {
        const match = /^\s*([a-z][a-z0-9 _-]*)\s*[:=]\s*(.+?)\s*$/i.exec(part);
        if (!match)
            continue;
        const agent = normalizeAgent(match[1]);
        const score = parseScoreValue(match[2]);
        if (agent && score !== undefined)
            result[agent] = score;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
function parseLabeledText(text, labels) {
    for (const line of text.split('\n')) {
        for (const label of labels) {
            const expression = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}${label}\\*{0,2}\\s*:\\s*(.+?)\\s*$`, 'i');
            const match = expression.exec(line);
            if (match) {
                const value = cleanInline(match[1]);
                return /<[^>]+>/.test(value) ? undefined : value;
            }
        }
    }
    return undefined;
}
function parseExplicitContested(text) {
    const value = parseLabeledText(text, ['Contested']);
    if (!value)
        return undefined;
    if (/^true\b/i.test(value))
        return true;
    if (/^false\b/i.test(value))
        return false;
    return undefined;
}
function parseMode(text) {
    const match = /(?:--mode=|\bmode\s*=\s*)([a-z][a-z-]*)/i.exec(text);
    const mode = match?.[1]?.toLowerCase();
    return mode && DUEL_MODES.has(mode) ? mode : undefined;
}
function validRunAt(value) {
    const cleaned = cleanInline(value.replace(/`/g, ''));
    return Number.isNaN(Date.parse(cleaned)) ? undefined : cleaned;
}
function parseRunAt(text) {
    const sourceMatch = /\brun\s*=\s*([^,)\s]+(?:T[^,)\s]+)?)/i.exec(text);
    if (sourceMatch)
        return validRunAt(sourceMatch[1]);
    const labeled = parseLabeledText(text, ['Run at', 'Date']);
    return labeled ? validRunAt(labeled) : undefined;
}
function tableCells(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|'))
        return [];
    const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    return withoutEdges.split('|').map(cell => cell.trim());
}
function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}
function scoreMatrixRows(text) {
    const heading = /^##\s+Score Matrix[^\n]*$/im.exec(text);
    const headingIndex = heading?.index;
    const headingLength = heading?.[0].length;
    if (headingIndex === undefined || headingLength === undefined)
        return [];
    const start = headingIndex + headingLength;
    const nextHeadingExpression = /^##\s+/gm;
    nextHeadingExpression.lastIndex = start;
    const nextHeading = nextHeadingExpression.exec(text);
    const section = text.slice(start, nextHeading?.index ?? text.length);
    const tableLines = section.split('\n').filter(line => line.trim().startsWith('|'));
    if (tableLines.length < 3)
        return [];
    const headers = tableCells(tableLines[0]);
    const ideaIndex = headers.findIndex(header => /^(?:idea|decision|proposal)$/i.test(cleanTitle(header)));
    if (ideaIndex < 0)
        return [];
    const scoreColumns = headers
        .map((header, index) => ({ header, index }))
        .filter(({ header }) => /(?:cross[- ]?)?score/i.test(header) && !/^avg/i.test(header));
    const rows = [];
    for (const line of tableLines.slice(1)) {
        const cells = tableCells(line);
        if (isSeparatorRow(cells) || cells.length !== headers.length)
            continue;
        const title = cleanTitle(cells[ideaIndex] ?? '');
        if (!title)
            continue;
        const agentScores = {};
        for (const { header, index } of scoreColumns) {
            const agent = normalizeAgent(header);
            const score = parseScoreValue(cells[index] ?? '');
            if (agent && score !== undefined)
                agentScores[agent] = score;
        }
        rows.push({ title, agentScores });
    }
    return rows;
}
function findMatrixScores(title, rows) {
    const wanted = normalizedTitle(title);
    const exact = rows.find(row => normalizedTitle(row.title) === wanted);
    if (exact)
        return exact.agentScores;
    const compatible = rows.filter(row => {
        const candidate = normalizedTitle(row.title);
        return candidate.includes(wanted) || wanted.includes(candidate);
    });
    return compatible.length === 1 ? compatible[0].agentScores : undefined;
}
function decisionSections(text) {
    const headings = [...text.matchAll(/^##\s+(.+)$/gm)];
    const sections = [];
    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index];
        const label = heading[1];
        const isConsensus = /^Consensus Winners\b/i.test(label);
        const isContested = /^Contested (?:Ideas|Decisions)\b/i.test(label);
        if (!isConsensus && !isContested)
            continue;
        const start = (heading.index ?? 0) + heading[0].length;
        const end = headings[index + 1]?.index ?? text.length;
        sections.push({ content: text.slice(start, end), contested: isContested });
    }
    return sections;
}
function decisionsFromSection(section, rows, steelmanSkipped) {
    const headings = [...section.content.matchAll(/^###\s+(.+)$/gm)];
    const decisions = [];
    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index];
        const title = cleanTitle(heading[1]);
        const start = (heading.index ?? 0) + heading[0].length;
        const end = headings[index + 1]?.index ?? section.content.length;
        const body = section.content.slice(start, end);
        const agentScores = parseExplicitScores(body) ?? findMatrixScores(title, rows);
        const survivingCritique = parseLabeledText(body, ['Strongest surviving critique', 'Surviving critique']);
        const steelman = parseLabeledText(body, ['Steelman summary', 'Steelman']) ?? (steelmanSkipped ? null : undefined);
        const contested = parseExplicitContested(body) ?? section.contested;
        decisions.push({
            title,
            ...(agentScores ? { agentScores } : {}),
            ...(survivingCritique ? { survivingCritique } : {}),
            ...(steelman === undefined ? {} : { steelman }),
            ...(contested === undefined ? {} : { contested }),
        });
    }
    return decisions;
}
export function parseDuelReport(markdown) {
    const text = markdown.replace(/\r\n/g, '\n');
    const rows = scoreMatrixRows(text);
    const steelmanSkipped = /(?:Phases skipped[^\n]*6\.75|steelman[^\n]*(?:not run|skipped|none))/i.test(text);
    const decisions = decisionSections(text)
        .flatMap(section => decisionsFromSection(section, rows, steelmanSkipped));
    if (decisions.length === 0) {
        const agentScores = parseExplicitScores(text);
        const survivingCritique = parseLabeledText(text, ['Strongest surviving critique', 'Surviving critique']);
        const steelman = parseLabeledText(text, ['Steelman summary', 'Steelman']);
        const contested = parseExplicitContested(text);
        if (agentScores || survivingCritique || steelman || contested !== undefined) {
            let normalizedSteelman = steelman;
            if (normalizedSteelman === undefined && steelmanSkipped)
                normalizedSteelman = null;
            decisions.push({
                title: 'Duel decision',
                ...(agentScores ? { agentScores } : {}),
                ...(survivingCritique ? { survivingCritique } : {}),
                ...(normalizedSteelman === undefined ? {} : { steelman: normalizedSteelman }),
                ...(contested === undefined ? {} : { contested }),
            });
        }
    }
    const mode = parseMode(text);
    const runAt = parseRunAt(text);
    return {
        ...(mode ? { mode } : {}),
        ...(runAt ? { runAt } : {}),
        decisions,
    };
}
function formatScore(score) {
    return Array.isArray(score) ? score.join('/') : String(score);
}
function formatAgentScores(scores) {
    const extraAgents = Object.keys(scores ?? {})
        .filter(agent => !CANONICAL_AGENT_SET.has(agent))
        .sort();
    const agents = [...CANONICAL_AGENTS, ...extraAgents];
    return agents.map(agent => {
        const score = scores?.[agent];
        return `${agent}=${score === undefined ? '<0-1000 or n/a>' : formatScore(score)}`;
    }).join(', ');
}
function quoted(value, placeholder) {
    return value === undefined ? `"${placeholder}"` : JSON.stringify(value);
}
function provenanceBlock(report, decision) {
    const mode = report.mode ?? '<ideas|architecture|security|reliability>';
    const runAt = report.runAt ?? '<ISO timestamp>';
    const lines = [
        '## Provenance',
        `- **Source:** dueling-wizards (mode=${mode}, run=${runAt})`,
        `- **Agent scores:** ${formatAgentScores(decision.agentScores)}`,
        `- **Strongest surviving critique:** ${quoted(decision.survivingCritique, '<one-line critique from the opponent reveal phase>')}`,
    ];
    if (decision.steelman !== null) {
        lines.push(`- **Steelman summary:** ${quoted(decision.steelman, '<one-line steelman, or omit this line if Phase 6.75 did not run>')}`);
    }
    lines.push(`- **Contested:** ${decision.contested === undefined ? '<true|false>' : String(decision.contested)}`);
    return lines.join('\n');
}
function formatInstructions(report, sourceDescription) {
    const decisions = report.decisions.length > 0
        ? report.decisions
        : [{ title: 'Values to complete' }];
    const lines = [
        'Append one copy of the block below to every duel-sourced bead description. When the report contains several decisions, use the decision that matches the bead\'s plan section.',
        '',
    ];
    for (const decision of decisions) {
        const block = provenanceBlock(report, decision);
        const fence = markdownFenceFor(block);
        lines.push(`### ${decision.title}`, `${fence}markdown`, block, fence, '');
    }
    lines.push(`Read missing provenance values from ${sourceDescription} before running \`br create\`. Never invent scores.`);
    return lines.join('\n');
}
function selectedDuelIdea(state) {
    const selected = state.selectedGoal?.trim().toLowerCase();
    if (!selected)
        return undefined;
    return state.candidateIdeas?.find(idea => {
        const source = idea.provenance?.source;
        if (source !== 'duel' && source !== 'reality-check-duel')
            return false;
        return [idea.id, idea.title, idea.description]
            .some(value => value.trim().toLowerCase() === selected);
    });
}
function decisionFromIdea(idea, provenance) {
    const agentScores = provenance.agentScores
        ? Object.fromEntries(Object.entries(provenance.agentScores).filter(([, score]) => (Number.isInteger(score) && score >= 0 && score <= 1000)))
        : undefined;
    const runAt = provenance.runAt ? validRunAt(provenance.runAt) : undefined;
    return {
        mode: provenance.source === 'reality-check-duel' ? 'reliability' : 'ideas',
        ...(runAt ? { runAt } : {}),
        decisions: [{
                title: idea.title,
                ...(agentScores && Object.keys(agentScores).length > 0 ? { agentScores } : {}),
                ...(provenance.survivingCritique ? { survivingCritique: provenance.survivingCritique } : {}),
                ...(provenance.steelman ? { steelman: provenance.steelman } : {}),
                ...(provenance.contested === undefined ? {} : { contested: provenance.contested }),
            }],
    };
}
export function resolveDuelProvenanceInstructions(state, reportArtifact) {
    if (state.planSource === 'duel') {
        const report = reportArtifact ? parseDuelReport(reportArtifact.content) : { decisions: [] };
        const source = reportArtifact ? `\`${reportArtifact.path}\`` : 'the active duel report';
        return formatInstructions(report, source);
    }
    const idea = selectedDuelIdea(state);
    if (!idea?.provenance)
        return undefined;
    return formatInstructions(decisionFromIdea(idea, idea.provenance), 'the selected idea provenance');
}
//# sourceMappingURL=duel-provenance.js.map