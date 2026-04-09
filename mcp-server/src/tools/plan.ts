import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolContext, McpToolResult } from '../types.js';
import { slugifyGoal, pickRefinementModel, DEEP_PLAN_MODELS } from './shared.js';
import { CODEX_SUBAGENT_TYPE } from '../prompts.js';
import { getDeepPlanModels } from '../model-detection.js';

interface PlanArgs {
  cwd: string;
  mode?: 'standard' | 'deep';
  planContent?: string;
  planFile?: string; // Path to already-written plan file (avoids passing large content over stdio)
}

/**
 * orch_plan — Generate a plan document for the selected goal.
 *
 * mode="standard": Returns a prompt for the agent to generate a single plan
 * mode="deep": Returns spawn configs for 3 parallel planning agents (correctness, robustness, ergonomics)
 *              If planContent is provided, uses it directly to create beads.
 */
export async function runPlan(ctx: ToolContext, args: PlanArgs): Promise<McpToolResult> {
  const { state, saveState, cwd } = ctx;

  if (!state.selectedGoal) {
    return {
      content: [{ type: 'text', text: 'Error: No goal selected. Call orch_select first.' }],
      isError: true,
    };
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
    const absPath = resolve(cwd, args.planFile);
    if (!existsSync(absPath)) {
      return {
        content: [{ type: 'text', text: `Error: planFile not found: ${absPath}` }],
        isError: true,
      };
    }
    const content = readFileSync(absPath, 'utf8');
    const relativePath = args.planFile.startsWith('docs/') ? args.planFile : `docs/plans/${args.planFile}`;
    state.planDocument = args.planFile;
    state.planRefinementRound = 0;
    state.phase = 'awaiting_plan_approval';
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**Plan loaded from \`${args.planFile}\`.**

**NEXT: Call \`orch_approve_beads\` to review the plan and proceed to bead creation.**

Goal: "${goal}"${constraintsSummary}

Plan loaded (${content.length} chars, ${content.split('\n').length} lines).`,
      }],
    };
  }

  // ── If planContent is provided inline, write it to disk then register ──
  if (args.planContent && args.planContent.trim()) {
    const planDir = join(cwd, 'docs', 'plans');
    mkdirSync(planDir, { recursive: true });
    const planFilePath = join(planDir, `${new Date().toISOString().slice(0, 10)}-${planSlug}-synthesized.md`);
    writeFileSync(planFilePath, args.planContent, 'utf8');

    const relativePath = `docs/plans/${new Date().toISOString().slice(0, 10)}-${planSlug}-synthesized.md`;
    state.planDocument = relativePath;
    state.planRefinementRound = 0;
    state.phase = 'awaiting_plan_approval';
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**Plan received and saved to \`${relativePath}\`.**

**NEXT: Call \`orch_approve_beads\` to review the plan and proceed to bead creation.**

Goal: "${goal}"${constraintsSummary}

Plan saved (${args.planContent.length} chars, ${args.planContent.split('\n').length} lines).`,
      }],
    };
  }

  state.phase = 'planning';
  state.planRefinementRound = 0;
  saveState(state);

  // ── Standard (single-model) plan ──────────────────────────────
  if (mode === 'standard') {
    const profileContext = profile
      ? `\n\n### Repository Context\n- **Name:** ${profile.name}\n- **Languages:** ${profile.languages.join(', ')}\n- **Frameworks:** ${profile.frameworks.join(', ')}\n- **Has tests:** ${profile.hasTests}`
      : '';

    const planPath = `docs/plans/${new Date().toISOString().slice(0, 10)}-${planSlug}.md`;
    state.planDocument = planPath;
    saveState(state);

    return {
      content: [{
        type: 'text',
        text: `**NEXT: Generate a detailed plan document and save it to \`${planPath}\`.**

Goal: "${goal}"${constraintsSummary}${profileContext}

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
2. Call \`orch_approve_beads\` to review the plan and create beads from it`,
      }],
    };
  }

  // ── Deep plan (multi-model) ───────────────────────────────────
  // If no planContent provided, return agent spawn configs
  const profileSummary = profile
    ? `Repository: ${profile.name} | Languages: ${profile.languages.join(', ')} | Frameworks: ${profile.frameworks.join(', ')}`
    : 'Repository: (profile not loaded — call orch_profile first for best results)';

  const basePrompt = `You are a planning agent for an agentic coding workflow.

**Goal:** ${goal}${constraintsSummary}
**${profileSummary}**

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

Focus deeply on your assigned perspective lens.`;

  const dynamicModels = getDeepPlanModels();

  const planAgents: Array<{ model?: string; subagent_type?: string; perspective: string; task: string }> = [
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

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        action: 'spawn-plan-agents',
        goal,
        constraints: state.constraints,
        planAgents,
        instructions: `Spawn these ${planAgents.length} planning agents in parallel using TeamCreate + Agent with run_in_background: true. Each agent must bootstrap Agent Mail (macro_start_session) and write their plan to docs/plans/<date>-<perspective>.md, then send the file path via send_message. After all complete, spawn a synthesis agent to read the ${planAgents.length} files and write the synthesized plan to docs/plans/<date>-<slug>-synthesized.md. Then call orch_plan with planFile: "docs/plans/<date>-<slug>-synthesized.md" (NOT planContent — passing large text through stdio stalls the MCP server).`,
      }, null, 2),
    }],
  };
}
