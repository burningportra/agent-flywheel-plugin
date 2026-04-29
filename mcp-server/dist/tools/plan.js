import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { slugifyGoal } from './shared.js';
import { CODEX_SUBAGENT_TYPE } from '../prompts.js';
import { getDeepPlanModels } from '../model-detection.js';
import { readMemory } from '../memory.js';
import { makeFlywheelErrorResult } from '../errors.js';
import { assertSafeRelativePath, resolveRealpathWithinRoot, } from '../utils/path-safety.js';
import { normalizeText } from '../utils/text-normalize.js';
/**
 * Locate the most-recent brainstorm artifact for this goal.
 *
 * Phase 0.5 of `skills/start/_planning.md` writes pressure-test outcomes to
 * `docs/brainstorms/<goal-slug>-<YYYY-MM-DD>.md`. We pick the lexically-greatest
 * match (dates in the filename make lexical order equal chronological order),
 * falling back to `null` when the directory is missing or no slug match exists.
 *
 * Returns the raw file contents so the caller can splice them directly into
 * the planner prompt — callers should NOT parse the file structure, because
 * the orchestrator writes arbitrary synthesis prose.
 */
function readLatestBrainstorm(cwd, goalSlug) {
    try {
        const dir = join(cwd, 'docs', 'brainstorms');
        if (!existsSync(dir))
            return null;
        const entries = readdirSync(dir)
            .filter(f => f.endsWith('.md') && f.startsWith(`${goalSlug}-`));
        if (entries.length === 0)
            return null;
        // Sort lexically descending — filenames embed ISO dates, so this == latest.
        entries.sort().reverse();
        const pick = entries[0];
        const abs = join(dir, pick);
        // lstatSync (NOT statSync): refuse symlinks outright so a planted
        // `<slug>-2026-01-01.md -> /etc/passwd` cannot leak content into the
        // planner prompt. Regular files only.
        const st = lstatSync(abs);
        if (!st.isFile() || st.isSymbolicLink())
            return null;
        const content = normalizeText(readFileSync(abs, 'utf8'));
        return { path: `docs/brainstorms/${pick}`, content };
    }
    catch {
        return null;
    }
}
/** Format a brainstorm artifact as a prompt section; empty string if null. */
function formatBrainstormSection(brainstorm) {
    if (!brainstorm)
        return '';
    return `\n## Phase 0.5 Brainstorm (read FIRST)\n\nSource: \`${brainstorm.path}\` — pressure-test outcome from Phase 0.5 of the planning skill. Anchor scope to the smallest version; reserve the 10x version as a "future direction" appendix, not a v1 requirement.\n\n\`\`\`markdown\n${brainstorm.content.trim()}\n\`\`\`\n`;
}
function okResult(text, phase, data) {
    return {
        content: [{ type: 'text', text }],
        structuredContent: {
            tool: 'flywheel_plan',
            version: 1,
            status: 'ok',
            phase,
            data,
        },
    };
}
function errorResult(phase, code, message, details, hint) {
    return makeFlywheelErrorResult('flywheel_plan', phase, {
        code,
        message,
        ...(hint ? { hint } : {}),
        ...(details ? { details } : {}),
    });
}
/**
 * flywheel_plan — Generate a plan document for the selected goal.
 *
 * mode="standard": Returns a prompt for the agent to generate a single plan
 * mode="deep": Returns spawn configs for 3 parallel planning agents (correctness, robustness, ergonomics)
 *              If planContent is provided, uses it directly to create beads.
 * mode="duel":  Returns instructions to invoke /dueling-idea-wizards --mode=architecture for 2-agent
 *               adversarial planning (CC + COD/GMI cross-scoring). Synthesis lands at
 *               docs/plans/<date>-<slug>-duel.md and is registered via planFile on the next call.
 */
export async function runPlan(ctx, args) {
    const { state, saveState, cwd } = ctx;
    if (!state.selectedGoal) {
        return errorResult('planning', 'missing_prerequisite', 'Error: No goal selected. Call flywheel_select first.', undefined, 'Call flywheel_select with the chosen goal before flywheel_plan.');
    }
    const goal = state.selectedGoal;
    const profile = state.repoProfile;
    const mode = args.mode || 'standard';
    const planSlug = slugifyGoal(goal);
    const constraintsSummary = state.constraints.length > 0
        ? `\nConstraints: ${state.constraints.join(', ')}`
        : '';
    // ── If planFile path provided, read it from disk (avoids large stdio payloads) ──
    if (args.planFile) {
        // Path-traversal guard (bead mq3): the user-supplied planFile must stay inside cwd.
        // allowAbsoluteInsideRoot=true preserves flows where callers already resolved
        // to an absolute path inside the project.
        const safe = assertSafeRelativePath(args.planFile, {
            root: cwd,
            allowAbsoluteInsideRoot: true,
        });
        if (!safe.ok) {
            return errorResult('planning', 'invalid_input', `Error: planFile rejected by path-safety (${safe.reason}): ${safe.message}`, { planFile: args.planFile, reason: safe.reason }, 'Provide a path relative to cwd without ".." segments, control chars, or absolute escape.');
        }
        const resolvedPlanFile = resolveRealpathWithinRoot(safe.value, {
            root: cwd,
            label: 'planFile',
            rootLabel: 'cwd',
        });
        if (!resolvedPlanFile.ok) {
            const code = resolvedPlanFile.reason === 'not_found' || resolvedPlanFile.reason === 'root_not_found'
                ? 'not_found'
                : 'invalid_input';
            return errorResult('planning', code, code === 'not_found'
                ? `Error: planFile not found: ${resolvedPlanFile.absolutePath}`
                : `Error: planFile rejected by realpath guard (${resolvedPlanFile.reason}): ${resolvedPlanFile.message}`, {
                planFile: args.planFile,
                absolutePath: resolvedPlanFile.absolutePath,
                reason: resolvedPlanFile.reason,
            }, code === 'not_found'
                ? 'Check the path is relative to cwd and that the plan file was saved before calling flywheel_plan.'
                : 'Pass an existing plan file inside cwd. Symlinks that resolve outside the project root are rejected.');
        }
        const content = normalizeText(readFileSync(resolvedPlanFile.realPath, 'utf8'));
        const planDocument = resolvedPlanFile.relativePath;
        state.planDocument = planDocument;
        state.planRefinementRound = 0;
        state.phase = 'awaiting_plan_approval';
        saveState(state);
        return okResult(`**Plan loaded from \`${planDocument}\`.**

**NEXT: Call \`flywheel_approve_beads\` to review the plan and proceed to bead creation.**

Goal: "${goal}"${constraintsSummary}

Plan loaded (${content.length} chars, ${content.split('\n').length} lines).`, 'awaiting_plan_approval', {
            kind: 'plan_registered',
            source: 'plan_file',
            goal,
            mode,
            planDocument,
            planStats: {
                chars: content.length,
                lines: content.split('\n').length,
            },
        });
    }
    // ── If planContent is provided inline, write it to disk then register ──
    if (args.planContent) {
        const trimmed = args.planContent.trim();
        if (trimmed.length === 0) {
            return errorResult('planning', 'empty_plan', 'planContent is empty or whitespace.', undefined, 'Generate plan content first, then pass it via planContent or write to disk and pass planFile.');
        }
        if (trimmed.includes('(No planner outputs provided.)')) {
            return makeFlywheelErrorResult('flywheel_plan', 'planning', {
                code: 'deep_plan_all_failed',
                message: 'Deep plan failed: all perspective planners timed out or produced no output.',
                hint: 'Retry with mode=standard as fallback.',
            });
        }
        if (trimmed.startsWith('(AGENT')) {
            return errorResult('planning', 'empty_plan', `planContent is an agent failure sentinel: ${trimmed.slice(0, 80)}`, { sentinelPrefix: '(AGENT' }, 'The upstream planner agent failed — retry flywheel_plan with mode=standard or spawn a fresh planning agent.');
        }
        const planDir = join(cwd, 'docs', 'plans');
        const relativePath = `docs/plans/${new Date().toISOString().slice(0, 10)}-${planSlug}-synthesized.md`;
        const planFilePath = join(planDir, relativePath.split('/').pop());
        const prevPlanDocument = state.planDocument;
        const prevPhase = state.phase;
        const prevRound = state.planRefinementRound;
        try {
            mkdirSync(planDir, { recursive: true });
            writeFileSync(planFilePath, args.planContent, 'utf8');
        }
        catch (err) {
            return errorResult('planning', 'cli_failure', `Failed to write plan file: ${err instanceof Error ? err.message : String(err)}`, { planFilePath }, 'Check filesystem permissions on docs/plans/ and free disk space, then retry.');
        }
        state.planDocument = relativePath;
        state.planRefinementRound = 0;
        state.phase = 'awaiting_plan_approval';
        const saved = await saveState(state);
        if (saved === false) {
            state.planDocument = prevPlanDocument;
            state.phase = prevPhase;
            state.planRefinementRound = prevRound ?? 0;
        }
        return okResult(`**Plan received and saved to \`${relativePath}\`.**

**NEXT: Call \`flywheel_approve_beads\` to review the plan and proceed to bead creation.**

Goal: "${goal}"${constraintsSummary}

Plan saved (${args.planContent.length} chars, ${args.planContent.split('\n').length} lines).`, 'awaiting_plan_approval', {
            kind: 'plan_registered',
            source: 'inline_plan_content',
            goal,
            mode,
            planDocument: relativePath,
            planStats: {
                chars: args.planContent.length,
                lines: args.planContent.split('\n').length,
            },
        });
    }
    state.phase = 'planning';
    state.planRefinementRound = 0;
    saveState(state);
    // ── Standard (single-model) plan ──────────────────────────────
    if (mode === 'standard') {
        const profileContext = profile
            ? `\n\n### Repository Context\n- **Name:** ${profile.name}\n- **Languages:** ${profile.languages.join(', ')}\n- **Frameworks:** ${profile.frameworks.join(', ')}\n- **Has tests:** ${profile.hasTests}`
            : '';
        // Phase 0.5 handoff: if the brainstorm artifact exists for this goal, surface it.
        const brainstorm = readLatestBrainstorm(cwd, planSlug);
        const brainstormSection = formatBrainstormSection(brainstorm);
        const planPath = `docs/plans/${new Date().toISOString().slice(0, 10)}-${planSlug}.md`;
        state.planDocument = planPath;
        saveState(state);
        return okResult(`**NEXT: Generate a detailed plan document and save it to \`${planPath}\`.**

Goal: "${goal}"${constraintsSummary}${profileContext}${brainstormSection}

## Plan Document Requirements

Write a comprehensive implementation plan that covers:

1. **Executive Summary** — What will be built and why
2. **Architecture** — High-level design decisions and component breakdown
3. **Implementation Phases** — Ordered list of phases with dependencies
4. **File-Level Changes** — For each component: files to create/modify, interfaces, data shapes
5. **Testing Strategy** — What tests to write, edge cases to cover
6. **Acceptance Criteria** — Clear definition of done per phase
7. **Risk & Mitigation** — Known unknowns and fallback strategies

Target: 500-3000 lines. Be specific — vague plans produce vague beads.

### After generating the plan
1. Save it to \`${planPath}\` using the Write tool or bash
2. Call \`flywheel_approve_beads\` to review the plan and create beads from it`, 'planning', {
            kind: 'plan_prompt',
            mode: 'standard',
            goal,
            planDocument: planPath,
            constraints: state.constraints,
            brainstormDocument: brainstorm?.path,
        });
    }
    // ── Duel plan (adversarial cross-scoring via /dueling-idea-wizards) ──────
    if (mode === 'duel') {
        const brainstorm = readLatestBrainstorm(cwd, planSlug);
        const planPath = `docs/plans/${new Date().toISOString().slice(0, 10)}-${planSlug}-duel.md`;
        state.planDocument = planPath;
        saveState(state);
        const brainstormHint = brainstorm
            ? `\n  - Pre-seed each agent with the brainstorm artifact at \`${brainstorm.path}\` (read FIRST in their study phase) so both planners share scope-floor / 10x-ceiling / adjacent-ask framing.`
            : '\n  - No Phase 0.5 brainstorm artifact found — both agents will study the repo profile only.';
        const text = `**NEXT: Invoke \`/dueling-idea-wizards --mode=architecture --top=3 --rounds=1\` for adversarial planning.**

Goal: "${goal}"${constraintsSummary}

## Duel-plan orchestration

This mode runs two independent planning agents (Claude Code + Codex, plus Gemini if available) through the full duel pipeline: study → independent plans → cross-scoring (0-1000) → reveal → synthesis. Surviving design choices land in a single synthesized plan with an "Adversarial review" section capturing consensus design choices, contested design choices (with both arguments), and any steelman reframings.

### Steps for the orchestrator

1. **Pre-flight** — verify ntm is installed and at least 2 of {cc, cod, gmi} are healthy. If only one agent is available, fall back to \`mode=deep\` (single-model angle agents) and emit a one-line warning.${brainstormHint}
2. **Invoke** the skill via \`Skill\` with:
   \`\`\`
   /dueling-idea-wizards --mode=architecture --top=3 --rounds=1 --focus="${goal.replace(/"/g, '\\"')}" --output=${planPath}
   \`\`\`
3. **Synthesis pickup** — when the duel completes, the skill writes its final report to the \`--output\` path. The orchestrator should then call \`flywheel_plan({ cwd, mode: "duel", planFile: "${planPath}" })\` to register the synthesized plan and advance phase to \`awaiting_plan_approval\`.
4. **Provenance carry-through** — when beads are created from this plan in Step 5.5, every bead's body MUST include a \`## Provenance\` block with: \`Source: dueling-wizards (mode=architecture)\`, agent cross-scores, the strongest surviving critique, and (if Phase 6.75 ran) the steelman one-liner. The flywheel_approve_beads tool autoinjects this when state.planSource = "duel".

### When to use this vs. deep plan

- **Duel plan** decorrelates generation from evaluation — best for high-stakes architectural decisions where reasonable people disagree. Cost: ~30 min per run.
- **Deep plan** spawns 3 same-team angle-agents (correctness/robustness/ergonomics). Faster (~15 min) but no adversarial cross-score. Best for refinement when the architectural shape is already clear.

After the duel completes and you call \`flywheel_plan\` again with \`planFile\`, jump directly to Step 5.55 (Plan alignment check). Do NOT skip 5.55 — the duel surfaces tensions the alignment check exists to surface.`;
        state.planSource = 'duel';
        saveState(state);
        return okResult(text, 'planning', {
            kind: 'duel_plan_spawn',
            mode: 'duel',
            goal,
            constraints: state.constraints,
            brainstormDocument: brainstorm?.path,
            planDocument: planPath,
            duelCommand: `/dueling-idea-wizards --mode=architecture --top=3 --rounds=1 --focus="${goal}" --output=${planPath}`,
        });
    }
    // ── Deep plan (multi-model) ───────────────────────────────────
    // If no planContent provided, return agent spawn configs
    const profileSummary = profile
        ? `Repository: ${profile.name} | Languages: ${profile.languages.join(', ')} | Frameworks: ${profile.frameworks.join(', ')}`
        : 'Repository: (profile not loaded — call flywheel_profile first for best results)';
    // Load CASS memory for planning context (best-effort)
    let memorySection = "";
    try {
        const mem = readMemory(cwd, `planning architecture ${goal}`);
        if (mem)
            memorySection = `\n## Prior Session Context\n${mem}\n`;
    }
    catch { /* CASS unavailable — proceed without */ }
    // Phase 0.5 handoff: inject brainstorm artifact if present.
    const brainstorm = readLatestBrainstorm(cwd, planSlug);
    const brainstormSection = formatBrainstormSection(brainstorm);
    const basePrompt = `You are a planning agent for an agentic coding workflow. Use ultrathink.

**Goal:** ${goal}${constraintsSummary}
**${profileSummary}**
${memorySection}${brainstormSection}
Write a comprehensive implementation plan from your designated perspective. The plan will be synthesized with plans from other agents with different perspectives.

## Plan requirements
- Executive summary
- Architecture overview
- Ordered implementation phases with dependencies
- File-level changes (specific files to create/modify per phase)
- Testing strategy
- Acceptance criteria
- Risk & mitigation
- Target: 500-2000 lines of detailed content

Focus deeply on your assigned perspective lens.

Use ultrathink.`;
    const dynamicModels = getDeepPlanModels();
    const planAgents = [
        {
            model: dynamicModels.correctness,
            perspective: 'correctness',
            task: `${basePrompt}

## Your perspective: CORRECTNESS
Focus on: type safety, edge cases, error handling, validation, data integrity, invariants.
Ask: What can go wrong? What are the failure modes? Are the interfaces correct?`,
        },
        {
            subagent_type: CODEX_SUBAGENT_TYPE,
            perspective: 'robustness',
            task: `${basePrompt}

## Your perspective: ROBUSTNESS
Focus on: performance, scalability, retry logic, timeouts, graceful degradation, observability.
Ask: What happens under load? What are the operational concerns? How does it fail gracefully?`,
        },
        {
            model: dynamicModels.ergonomics,
            perspective: 'ergonomics',
            task: `${basePrompt}

## Your perspective: ERGONOMICS
Focus on: API design, developer experience, naming, documentation, discoverability, simplicity.
Ask: Is it easy to use correctly? Hard to misuse? Does it follow existing patterns in the codebase?`,
        },
    ];
    // Add optional 4th Gemini planner when Google model is available
    if (dynamicModels.freshPerspective) {
        planAgents.push({
            model: dynamicModels.freshPerspective,
            perspective: 'fresh-perspective',
            task: `${basePrompt}

## Your perspective: FRESH PERSPECTIVE
You are a fresh pair of eyes who has not seen the other plans.
Challenge shared assumptions. Propose the simplest alternative that satisfies the goal.
Flag anything under-specified, contradictory, or likely to cause confusion during implementation.
Question every architectural choice: is there a simpler way? A more standard approach? A hidden dependency?`,
        });
    }
    const payload = {
        kind: 'deep_plan_spawn',
        mode: 'deep',
        goal,
        constraints: state.constraints,
        brainstormDocument: brainstorm?.path,
        planAgents,
        instructions: `Spawn these ${planAgents.length} planning agents in parallel using TeamCreate + Agent with run_in_background: true. Each agent must bootstrap Agent Mail (macro_start_session) and write their plan to docs/plans/<date>-<perspective>.md, then send the file path via send_message. After all complete, spawn a synthesis agent to read the ${planAgents.length} files and write the synthesized plan to docs/plans/<date>-<slug>-synthesized.md. Then call flywheel_plan with planFile: "docs/plans/<date>-<slug>-synthesized.md" (NOT planContent — passing large text through stdio stalls the MCP server).`,
        synthesisPrompt: `Use ultrathink.

## Best-of-All-Worlds Synthesis

Use ultrathink.

Read all ${planAgents.length} competing plans. For EACH plan, BEFORE proposing any changes:

1. **Honestly acknowledge** what that plan does better than the others — name the specific strengths, not generic praise.
2. **Identify the unique insight** each plan contributes that the others miss.

Then synthesize:

3. **Blend the strongest ideas** from all plans into a single superior document.
4. **For each major decision**, state which plan's approach you adopted and why.
5. **Provide git-diff style changes** showing what was merged vs what was cut.
6. **Flag unresolved tensions** — where plans fundamentally disagree and a judgment call was made.

The synthesis must be BETTER than any individual plan, not a lowest-common-denominator average. Preserve bold ideas; don't sand them down.`,
    };
    return okResult(JSON.stringify({
        action: 'spawn-plan-agents',
        goal,
        constraints: state.constraints,
        planAgents,
        instructions: payload.instructions,
        synthesisPrompt: payload.synthesisPrompt,
    }, null, 2), 'planning', payload);
}
//# sourceMappingURL=plan.js.map