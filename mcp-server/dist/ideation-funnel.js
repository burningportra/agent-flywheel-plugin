/**
 * Externalized Ideation Funnel (30 → 5 → 15)
 *
 * The Flywheel guide: "Having agents brainstorm 30 then winnow to 5
 * produces much better results than asking for 5 directly because
 * the winnowing forces critical evaluation."
 *
 * When we tell a model "think of 30, output 5," the winnowing is
 * performative. When we have 30 real ideas and a DIFFERENT model
 * ranks them, the critical evaluation is real.
 *
 * Three phases:
 * 1. Generate 30 ideas (sub-agent, structured JSON output)
 * 2. Winnow to 5 (different model, explicit keep/cut for each)
 * 3. Expand to 15 (10 more, checked against existing beads)
 */
// ─── Repo Profile Formatting ─────────────────────────────────
/**
 * Format a RepoProfile (and optional ScanResult) into a prompt-injectable string.
 * Inlined here since prompts.ts is not ported to this project.
 */
function formatRepoProfile(profile, scanResult) {
    const lines = [
        `### Project: ${profile.name}`,
        `Languages: ${profile.languages.join(", ") || "unknown"}`,
        `Frameworks: ${profile.frameworks.join(", ") || "none detected"}`,
        `Package manager: ${profile.packageManager ?? "unknown"}`,
        `Has tests: ${profile.hasTests}${profile.testFramework ? ` (${profile.testFramework})` : ""}`,
        `Has docs: ${profile.hasDocs}`,
        `Has CI: ${profile.hasCI}${profile.ciPlatform ? ` (${profile.ciPlatform})` : ""}`,
    ];
    if (profile.readme) {
        lines.push("", "### README (excerpt)", profile.readme.slice(0, 500));
    }
    if (profile.todos.length > 0) {
        lines.push("", "### TODOs/FIXMEs (sample)", ...profile.todos.slice(0, 10).map(t => `- [${t.type}] ${t.file}:${t.line} — ${t.text}`));
    }
    if (profile.recentCommits.length > 0) {
        lines.push("", "### Recent Commits", ...profile.recentCommits.slice(0, 5).map(c => `- ${c.hash.slice(0, 7)} ${c.message}`));
    }
    if (scanResult?.codebaseAnalysis?.summary) {
        lines.push("", "### Codebase Analysis", scanResult.codebaseAnalysis.summary);
    }
    return lines.join("\n");
}
// ─── Phase 2: Winnowing model note ──────────────────────────
/**
 * Prepended to winnowingPrompt() to enforce model divergence.
 * Using the same model for ideation and winnowing defeats the purpose:
 * winnowing becomes performative self-evaluation instead of real critique.
 */
export const WINNOWING_MODEL_NOTE = "IMPORTANT: This winnowing step MUST run on a different model than the ideation step. " +
    "Using the same model defeats the purpose — winnowing becomes performative self-evaluation.";
// ─── Phase 1: Broad Ideation ────────────────────────────────
/**
 * Prompt for generating 30 raw ideas. The model is told NOT to winnow —
 * output everything. Quantity enables quality in the next phase.
 *
 * @param existingBeadTitles - titles of existing beads to avoid duplicating.
 *   When provided and non-empty, a dedup section is injected before Instructions.
 */
export function broadIdeationPrompt(profile, scanResult, existingBeadTitles) {
    const repoContext = formatRepoProfile(profile, scanResult);
    const beadDedupeSection = existingBeadTitles && existingBeadTitles.length > 0
        ? `### Existing Beads (do NOT duplicate these)\nThe following work items already exist. Do NOT propose duplicates:\n${existingBeadTitles.map((t) => `- ${t}`).join("\n")}\n\n`
        : "";
    return `## Broad Ideation — Generate 30 Ideas

You are brainstorming improvement ideas for this project. Your job is to generate QUANTITY, not quality. Output ALL ideas — do NOT winnow, filter, or self-censor.

${repoContext}

${beadDedupeSection}### Instructions
1. Study the repo profile, scan findings, TODOs, commits, and README carefully
2. Generate exactly 30 improvement ideas across diverse categories
3. For each idea, provide a brief 1-2 sentence description
4. Score each on 5 axes (1-5): useful, pragmatic, accretive, robust, ergonomic
5. DO NOT filter or rank — output all 30

### Categories to cover (aim for variety)
feature, refactor, docs, dx, performance, reliability, security, testing

### Output Format
Return a JSON array of 30 objects:
\`\`\`json
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "description": "1-2 sentence description",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high",
    "scores": { "useful": 4, "pragmatic": 3, "accretive": 5, "robust": 3, "ergonomic": 4 },
    "sourceEvidence": ["signal from repo"]
  }
]
\`\`\`

Output ONLY the JSON array. No markdown fences, no surrounding text. All 30 ideas.`;
}
// ─── Phase 2: Winnowing ─────────────────────────────────────
/**
 * Prompt for a DIFFERENT model to critically evaluate and winnow 30→5.
 * The winnowing must be externalized — each idea gets explicit keep/cut.
 */
export function winnowingPrompt(ideas, profile) {
    // WINNOWING_MODEL_NOTE is prepended to remind the caller (and any reviewing agent)
    // that this step must run on a different model than the ideation step.
    const ideaList = ideas
        .map((idea, i) => `${i + 1}. **${idea.title}** [${idea.category}] (effort: ${idea.effort}, impact: ${idea.impact})\n   ${idea.description}${idea.scores ? `\n   Scores: useful=${idea.scores.useful} pragmatic=${idea.scores.pragmatic} accretive=${idea.scores.accretive} robust=${idea.scores.robust} ergonomic=${idea.scores.ergonomic}` : ""}`)
        .join("\n\n");
    return `${WINNOWING_MODEL_NOTE}

## Critical Winnowing — Cut 30 Ideas to 5

You are reviewing ${ideas.length} improvement ideas for **${profile.name}**. Your job is to be RUTHLESSLY critical and select only the 5 most impactful.

### All ${ideas.length} Ideas
${ideaList}

### Instructions
1. For EACH of the ${ideas.length} ideas, state: **KEEP** or **CUT** with a one-sentence justification
2. You must keep exactly 5 ideas
3. Rank your 5 KEEPs from most to least impactful
4. For each KEEP, write a detailed rationale (2-3 sentences) explaining:
   - Why this beat the other 25 ideas
   - What specific repo evidence supports it
   - What makes it uniquely valuable

### Evaluation Criteria (weighted)
- **Useful** (2× weight) — solves a real, frequent pain
- **Pragmatic** (2× weight) — realistic to build in hours/days
- **Accretive** (1.5× weight) — clearly adds value beyond what exists
- **Robust** (1× weight) — handles edge cases
- **Ergonomic** (1× weight) — reduces friction

### Output Format
Return a JSON object:
\`\`\`json
{
  "cuts": [
    { "id": "idea-id", "reason": "why cut" }
  ],
  "keeps": [
    {
      "id": "idea-id",
      "rank": 1,
      "rationale": "detailed rationale for keeping"
    }
  ]
}
\`\`\`

Output ONLY the JSON. Be ruthless — if you can't articulate why an idea is in the top 5, cut it.`;
}
// ─── Phase 3: Expansion ─────────────────────────────────────
/**
 * Prompt to generate 10 MORE ideas that complement the top 5.
 * Each must be checked against existing beads for novelty.
 */
export function expandIdeasPrompt(top5, existingBeadTitles, profile) {
    const topList = top5
        .map((idea, i) => `${i + 1}. **${idea.title}**: ${idea.description}`)
        .join("\n");
    const beadList = existingBeadTitles.length > 0
        ? `\n### Existing Beads (DO NOT duplicate)\n${existingBeadTitles.map((t) => `- ${t}`).join("\n")}`
        : "";
    return `## Expand — Generate 10 Complementary Ideas

The top 5 ideas have been selected through competitive winnowing:
${topList}
${beadList}

### Instructions
1. Generate 10 MORE improvement ideas for **${profile.name}**
2. Each must COMPLEMENT the top 5 (not duplicate or conflict)
3. Each must be explicitly checked against existing beads for novelty
4. Aim for variety in categories and effort levels
5. Score each on the same 5-axis rubric (useful, pragmatic, accretive, robust, ergonomic)

### Output Format
Return a JSON array of 10 objects (same format as the broad ideation):
\`\`\`json
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "description": "1-2 sentence description",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high",
    "scores": { "useful": 4, "pragmatic": 3, "accretive": 5, "robust": 3, "ergonomic": 4 },
    "sourceEvidence": ["signal from repo"],
    "rationale": "why this complements the top 5 and is novel"
  }
]
\`\`\`

Output ONLY the JSON array. No duplicates of the top 5 or existing beads.`;
}
// ─── Parsing Helpers ────────────────────────────────────────
/**
 * Parse a JSON array of ideas from LLM output.
 * Handles markdown fences, surrounding text, and partial outputs.
 */
export function parseIdeasJSON(output) {
    // Try to extract a JSON array
    const match = output.match(/\[[\s\S]*\]/);
    if (!match)
        return [];
    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .filter((item) => {
            if (typeof item !== "object" || item === null)
                return false;
            const obj = item;
            return typeof obj.id === "string" && typeof obj.title === "string";
        })
            .map((item) => ({
            id: String(item.id),
            title: String(item.title),
            description: String(item.description ?? ""),
            category: validateCategory(String(item.category ?? "feature")),
            effort: validateEffort(String(item.effort ?? "medium")),
            impact: validateImpact(String(item.impact ?? "medium")),
            rationale: typeof item.rationale === "string" ? item.rationale : "",
            tier: "honorable",
            sourceEvidence: Array.isArray(item.sourceEvidence)
                ? item.sourceEvidence.filter((s) => typeof s === "string")
                : undefined,
            scores: parseScores(item.scores),
        }));
    }
    catch {
        return [];
    }
}
/**
 * Parse winnowing results from LLM output.
 * Returns the IDs of the kept ideas in rank order.
 */
export function parseWinnowingResult(output) {
    const match = output.match(/\{[\s\S]*"keeps"[\s\S]*\}/);
    if (!match)
        return { keptIds: [], cutCount: 0 };
    try {
        const parsed = JSON.parse(match[0]);
        const keeps = Array.isArray(parsed.keeps)
            ? parsed.keeps
                .filter((k) => typeof k === "object" && k !== null && typeof k.id === "string")
                .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99))
                .map((k) => String(k.id))
            : [];
        const cuts = Array.isArray(parsed.cuts) ? parsed.cuts.length : 0;
        return { keptIds: keeps, cutCount: cuts };
    }
    catch {
        return { keptIds: [], cutCount: 0 };
    }
}
const VALID_CATEGORIES = [
    "feature", "refactor", "docs", "dx", "performance", "reliability", "security", "testing",
];
function validateCategory(value) {
    const lower = value.toLowerCase();
    return VALID_CATEGORIES.includes(lower) ? lower : "feature";
}
function validateEffort(value) {
    const lower = value.toLowerCase();
    if (lower === "low" || lower === "medium" || lower === "high")
        return lower;
    return "medium";
}
function validateImpact(value) {
    const lower = value.toLowerCase();
    if (lower === "low" || lower === "medium" || lower === "high")
        return lower;
    return "medium";
}
function parseScores(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const obj = raw;
    const scores = {
        useful: clamp(Number(obj.useful), 1, 5),
        pragmatic: clamp(Number(obj.pragmatic), 1, 5),
        accretive: clamp(Number(obj.accretive), 1, 5),
        robust: clamp(Number(obj.robust), 1, 5),
        ergonomic: clamp(Number(obj.ergonomic), 1, 5),
    };
    // Return undefined if all NaN
    if (Object.values(scores).every(isNaN))
        return undefined;
    return scores;
}
function clamp(value, min, max) {
    if (isNaN(value))
        return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}
//# sourceMappingURL=ideation-funnel.js.map