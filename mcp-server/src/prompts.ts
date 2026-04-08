import type { RepoProfile, Bead, BeadResult, ScanResult, OrchestratorPhase } from "./types.js";
import type { PlanToBeadAudit } from "./beads.js";
import { formatTemplatesForPrompt } from "./bead-templates.js";

// ─── Workflow Roadmap ───────────────────────────────────────
const WORKFLOW_PHASES: { key: OrchestratorPhase; label: string }[] = [
  { key: "profiling", label: "Scan" },
  { key: "discovering", label: "Discover" },
  { key: "awaiting_selection", label: "Select" },
  { key: "creating_beads", label: "Plan" },
  { key: "implementing", label: "Build" },
  { key: "reviewing", label: "Review" },
  { key: "complete", label: "Done" },
];

export function workflowRoadmap(currentPhase: OrchestratorPhase): string {
  const phaseIdx = WORKFLOW_PHASES.findIndex(p => p.key === currentPhase);
  return WORKFLOW_PHASES.map((p, i) => {
    const marker = i < phaseIdx ? "v" : i === phaseIdx ? ">" : "o";
    return `${marker} ${p.label}`;
  }).join("  ");
}

// ─── Repo Profile Formatting ────────────────────────────────
export function formatRepoProfile(profile: RepoProfile, scanResult?: ScanResult): string {
  const sections = [
    `## Repository: ${profile.name}`,
    `**Languages:** ${profile.languages.join(", ") || "unknown"}`,
    `**Frameworks:** ${profile.frameworks.join(", ") || "none detected"}`,
    `**Package Manager:** ${profile.packageManager ?? "unknown"}`,
    `**Entrypoints:** ${profile.entrypoints.join(", ") || "none detected"}`,
    `**Tests:** ${profile.hasTests ? `Yes (${profile.testFramework ?? "unknown framework"})` : "No"}`,
    `**Docs:** ${profile.hasDocs ? "Yes" : "No"}`,
    `**CI:** ${profile.hasCI ? `Yes (${profile.ciPlatform ?? "unknown"})` : "No"}`,
    `**TODOs/FIXMEs:** ${profile.todos.length} found`,
  ];

  if (scanResult?.codebaseAnalysis && (scanResult.codebaseAnalysis.summary || scanResult.codebaseAnalysis.recommendations.length > 0 || scanResult.codebaseAnalysis.structuralInsights.length > 0)) {
    sections.push(`\n### Codebase Analysis (${scanResult.source})`);
    if (scanResult.codebaseAnalysis.summary) {
      sections.push(scanResult.codebaseAnalysis.summary);
    }
    if (scanResult.codebaseAnalysis.recommendations.length > 0) {
      sections.push(
        "\n#### Recommended focus areas",
        ...scanResult.codebaseAnalysis.recommendations.slice(0, 5).map(
          (item) => `- **${item.title}**${item.priority ? ` (${item.priority})` : ""}: ${item.detail}`
        )
      );
    }
    if (scanResult.codebaseAnalysis.structuralInsights.length > 0) {
      sections.push(
        "\n#### Structural insights",
        ...scanResult.codebaseAnalysis.structuralInsights.slice(0, 5).map(
          (item) => `- **${item.title}**: ${item.detail}`
        )
      );
    }
  }

  if (profile.todos.length > 0) {
    sections.push(
      "\n### Notable TODOs",
      ...profile.todos.slice(0, 10).map(
        (t) => `- \`${t.file}:${t.line}\` [${t.type}] ${t.text}`
      )
    );
  }

  if (profile.recentCommits.length > 0) {
    sections.push(
      "\n### Recent Commits",
      ...profile.recentCommits.slice(0, 10).map(
        (c) => `- \`${c.hash}\` ${c.message} (${c.author})`
      )
    );
  }

  if (profile.readme) {
    const truncated =
      profile.readme.length > 2000
        ? profile.readme.slice(0, 2000) + "\n...(truncated)"
        : profile.readme;
    sections.push("\n### README (excerpt)", truncated);
  }

  return sections.join("\n");
}

// ─── System Prompt for Orchestrator Mode ────────────────────
export function orchestratorSystemPrompt(
  hasSophia: boolean,
  coordBackend?: import("./coordination.js").CoordinationBackend
): string {
  // Build coordination section based on detected backends
  let coordinationSection = "";

  const useBeadsAgentMail = coordBackend?.beads && coordBackend?.agentMail;

  if (useBeadsAgentMail) {
    coordinationSection = `
## Coordination: Beads + Agent Mail
The orchestrator uses **beads** for task lifecycle and **agent-mail** for inter-agent messaging and file reservations.

### Beads (task tracking)
- Create beads via \`br create "Title" -t task -p <priority> -d "..."\` in bash
- Set dependencies via \`br dep add <child-id> <parent-id>\`
- Bead status tracks implementation: open -> in_progress -> closed
- \`br sync --flush-only\` persists state to .beads/ (git-visible JSONL)
- Use \`br ready\` to see actionable (unblocked) tasks

### Agent Mail (coordination)
- Each parallel agent bootstraps with \`macro_start_session\` using this repo's absolute path as \`project_key\`
- File reservations prevent conflicts: \`file_reservation_paths(project_key, agent_name, paths, ttl_seconds=3600, exclusive=true)\`
- Thread ID = bead ID - all progress updates, review findings, and handoffs are scoped to the task
- Check inbox with \`fetch_inbox\` before advancing; urgent messages may require attention
- Release reservations when done: \`release_file_reservations(project_key, agent_name)\`

### Parallel Execution
When beads have disjoint files and agent-mail is available, agents work in the **same directory** with file reservations (no worktrees needed).
When files overlap, fall back to git worktree isolation.
${hasSophia ? "\nSophia is also available as a secondary backend for CR/task management." : ""}`;
  } else if (hasSophia) {
    coordinationSection = `
## Sophia Integration
The orchestrator uses Sophia for change request and task management. When beads are created:
- A Sophia CR is created automatically with tasks matching beads
- Use \`sophia cr task done <crId> <taskId> --commit-type feat --from-contract\` to checkpoint completed tasks
- After all beads, \`sophia cr validate\` and \`sophia cr review\` run automatically

## Parallel Execution with Worktree Isolation
When beads are independent (no shared files), use \`parallel_subagents\` with git worktree isolation:

1. The orchestrator creates a **WorktreePool** - each parallel bead gets its own git worktree checkout
2. For each parallel group, spawn sub-agents via \`parallel_subagents\`, passing the worktree path as the working directory
3. Each sub-agent works in isolation - no file conflicts between parallel beads
4. After all agents in a group complete, worktree changes are merged back to the main branch sequentially
5. Worktrees are cleaned up after merge

Use \`br ready\` to determine which beads can run in parallel.
If worktree creation fails, the orchestrator falls back to sequential execution in the shared directory.`;
  }

  return `You are operating as a repo-aware multi-agent orchestrator. You have access to specialized orchestrator tools that drive a structured workflow.

## Your Workflow
1. Call \`orch_profile\` to scan the repository
2. Call \`orch_discover\` to generate project ideas from the profile
3. Call \`orch_select\` to present ideas to the user and get their choice
4. If the workflow produces a plan, return to \`orch_approve_beads\` to review/approve the plan in-menu before creating beads
5. Create beads for the selected goal via \`br create\` in bash, setting dependencies with \`br dep add\`, then call \`orch_approve_beads\` to enter the bead approval menu
6. For each bead, implement using code tools (read, write, edit, bash), then call \`orch_review\`
7. After all beads pass review, the orchestrator runs post-completion checks and offers follow-up actions
${coordinationSection}

## Multi-Pass Review
Each bead goes through multiple review passes:
1. **Self-review**: You assess your own work against acceptance criteria via \`orch_review\`
2. **Adversarial review**: A second pass with fresh eyes checks for bugs, oversights, ergonomics issues
3. **Cross-agent review**: After ALL beads complete, an independent reviewer sub-agent audits the full diff

Each pass uses a different perspective to catch what the previous one missed.

## Post-Completion
After all beads and reviews pass, the orchestrator offers:
- **Polish pass**: Improve clarity, remove generic AI patterns, tighten ergonomics
- **Commit strategy**: Group changes into logical commits with detailed messages
- **Skill extraction**: Check if the work product should become a reusable skill

## CASS Memory
- Use \`orch_memory\` tool with action \`context\` to get task-relevant rules and anti-patterns
- Use \`orch_memory\` tool with action \`mark\` to give feedback on rules (\`helpful\` or \`harmful\`)
- Use \`/memory\` command to view, search, add rules, or mark rules as harmful
- When a CASS rule helps you, mark it: \`orch_memory\` action=mark query=<bulletId> helpful=true
- When a rule leads you astray, mark it: \`orch_memory\` action=mark query=<bulletId> helpful=false reason="explanation"

## Epistemic Discipline
- Report outcomes faithfully: if tests fail, say so with the relevant output.
- If you did not run a verification step, say that rather than implying it succeeded.
- Never claim "all tests pass" when output shows failures.
- Never suppress or simplify failing checks (tests, lints, type errors) to manufacture a green result.
- Never characterize incomplete or broken work as done.
- When a check did pass or a task is complete, state it plainly.
- Do not hedge confirmed results with unnecessary disclaimers, downgrade finished work to "partial," or re-verify things you already checked.
- The goal is an accurate report, not a defensive one.

## Rules
- Follow the workflow in order. Do not skip steps.
- Keep every handoff inside the orchestrate workflow/menus. If a plan exists, route back through \`orch_approve_beads\` before bead creation; if beads exist, route through \`orch_approve_beads\` before implementation; if implementation is in progress, route through \`orch_review\`.
- **CRITICAL: When a tool result says "NEXT: Call \`tool_name\`", you MUST call that tool IMMEDIATELY in your next response. Do NOT stop to summarize, ask questions, or chat. Just call the tool.**
- After each tool call, read the result carefully before proceeding.
- When implementing beads, use the standard code tools (read, write, edit, bash) to make actual changes.
- If a review fails, re-implement based on the revision instructions, then review again (max 3 retries per bead).
- Do NOT add commentary between orchestrator tool calls. The user sees the tool results directly.
- If orch_select returns no selection, stop gracefully.
- If you experience context compaction during this session, immediately re-read AGENTS.md and the current orchestration state via \`/orchestrate-status\` before continuing.`;
}

// ─── Discovery Prompt ────────────────────────────────────────
export function discoveryInstructions(profile: RepoProfile, scanResult?: ScanResult): string {
  const repoContext = formatRepoProfile(profile, scanResult);

  return `Analyze this repository and generate your best improvement ideas using structured ideation.

${repoContext}

## Process (do this internally before outputting)
1. **Ground yourself** - study the repo profile, scan findings, TODOs, commits, and any memory context carefully
2. **Generate broadly** - come up with at least 25-30 candidate ideas (do NOT output these)
3. **Score each candidate** against these 5 axes (1-5 scale):
   - **Useful** (2x weight) - does it solve a real, frequent pain?
   - **Pragmatic** (2x weight) - is it realistic to build in hours/days?
   - **Accretive** (1.5x weight) - does it clearly add value beyond what exists?
   - **Robust** (1x weight) - will it handle edge cases and work reliably?
   - **Ergonomic** (1x weight) - does it reduce friction or cognitive load?
4. **Cut** - remove anything scoring <3 average, anything duplicative, anything already addressed
5. **Rank** - sort by weighted score
6. **Merge overlaps** - if two ideas are variants of the same thing, combine into one stronger idea
7. **Balance** - ensure at least 2 different categories in the top 5
8. **Tier** - label your best 5 as tier "top", next 5-10 as tier "honorable"

## Output requirements
For each surviving idea, provide:
- **id**: unique kebab-case identifier
- **title**: short descriptive title
- **description**: 2-3 sentences explaining what to do and why
- **category**: feature | refactor | docs | dx | performance | reliability | security | testing
- **effort**: low | medium | high
- **impact**: low | medium | high
- **rationale**: 2-3 sentences explaining why this beat other candidates. Cite specific repo evidence. Do NOT write generic rationale like "this would improve the project" - explain what specific signals support this and what alternatives you considered.
- **tier**: "top" or "honorable"
- **sourceEvidence**: array of strings - what repo signals prompted this (e.g. "TODO in src/scan.ts:45", "ccc finding: no error recovery", "recent commits all touch prompts.ts")
- **scores**: { useful, pragmatic, accretive, robust, ergonomic } - your 1-5 ratings
- **risks**: (optional) known downsides
- **synergies**: (optional) ids of complementary ideas

Return 10-15 ideas total (5 top + 5-10 honorable).`;
}

// ─── Bead Creation Prompt ────────────────────────────────────
export function beadCreationPrompt(
  goal: string,
  repoContext: string,
  constraints: string[]
): string {
  return `## Create Beads for Goal

Take the selected goal and create beads (tasks) using the br CLI. Cover all required work.

### Goal
${goal}

### Repository Context
${repoContext}

### Constraints
${constraints.length > 0 ? constraints.map((c) => `- ${c}`).join("\n") : "None specified."}

### Instructions
For each bead, run in bash:
\`\`\`
br create "Title" -t task -p <priority 1-5> -d "Detailed description including:
- What to implement
- Why it matters
- Acceptance criteria (as checklist):
  - [ ] Criterion 1
  - [ ] Criterion 2
- ### Files: src/foo.ts, src/bar.ts"
\`\`\`

Set dependencies between beads:
\`\`\`
br dep add <child-id> <parent-id>
\`\`\`

For complex beads that would take more than a few hours, break them into subtasks:
\`\`\`
br create "Subtask title" -t task -p <priority> -d "..."
br dep add <subtask-id> <parent-id> --type parent-child
\`\`\`

Each subtask should be a single coherent unit of work that one agent can complete independently.

**\`br create\` flag reference**: \`-d\` = description (long: \`--description\`), \`-t\` = type, \`-p\` = priority. Do NOT abbreviate to \`--desc\` - it does not exist and will error.

### Requirements
- Make beads self-documenting - include background, reasoning, and anything a future agent needs
- The beads should be so detailed that a fresh agent never needs to consult back to the original goal. Include relevant background, reasoning/justification, considerations - anything a future agent needs about goals, intentions, and thought process.
- Each bead MUST include a \`### Files:\` section listing files to create/modify
- Order by priority: foundations first, integration last
- Set dependency edges so \`br ready\` returns the correct parallel groups
- Acceptance criteria should be specific and testable
- Include test beads where appropriate

## Template Library
${formatTemplatesForPrompt()}

Templates are optional shortcuts for common bead shapes, not requirements. If a template fits, use its ID as a drafting aid, substitute concrete placeholder values, and expand it into a fully self-contained bead description before running \`br create\`.

Example - starting from template \`add-api-endpoint\` with all placeholders substituted (\`{{endpointPath}} -> /api/users\`, \`{{moduleName}} -> user-management\`, \`{{endpointPurpose}} -> return a filtered user list\`, \`{{httpMethod}} -> GET\`, \`{{implementationFile}} -> src/api/users.ts\`, \`{{testFile}} -> src/api/users.test.ts\`):

> Implement a new API endpoint for /api/users in the user-management area.
> Add request validation, success/error responses, and any supporting wiring
> needed so the endpoint behaves consistently with the existing API surface.
>
> Why this bead exists:
> - The feature needs a concrete endpoint for return a filtered user list.
> - The work should land with validation, error handling, and test coverage instead of a stub.
>
> Acceptance criteria:
> - [ ] Add the GET /api/users endpoint with validation for the expected inputs.
> - [ ] Return clear success and failure responses for the main path and obvious edge cases.
> - [ ] Add tests covering the happy path and at least one error path.
>
> ### Files:
> - src/api/users.ts
> - src/api/users.test.ts

Notice: every placeholder is resolved and the final text is fully expanded - no template IDs, no placeholders.

If no template fits, write a custom bead normally. Final beads must not say \`[Use template: ...]\`, \`see template\`, or leave unresolved \`{{placeholderName}}\` markers behind.

Verify with \`br list\` and \`br dep cycles\` (must show no cycles).

Use ultrathink.`;
}

export function formatPlanToBeadAuditWarnings(audit: PlanToBeadAudit): string {
  if (audit.uncoveredSections.length === 0 && audit.weakMappings.length === 0) {
    return "";
  }

  const lines = ["** Plan-to-bead audit warnings**"];

  if (audit.uncoveredSections.length > 0) {
    lines.push(
      "Uncovered plan sections:",
      ...audit.uncoveredSections.slice(0, 5).map((section) =>
        `- **${section.heading}**${section.summary ? ` - ${section.summary}` : ""}`
      )
    );
  }

  if (audit.weakMappings.length > 0) {
    lines.push(
      "Weak section-to-bead mapping:",
      ...audit.weakMappings.slice(0, 5).map((section) => {
        const top = section.matches[0];
        return `- **${section.heading}** -> ${top?.beadId ?? "no bead"}${top ? ` (${Math.round(top.score * 100)}% keyword overlap)` : ""}`;
      })
    );
  }

  lines.push("Review these gaps before implementation if they reflect missing scope or underspecified beads.");
  return lines.join("\n");
}

export function planToBeadsPrompt(
  planPath: string,
  goal: string,
  profile: RepoProfile
): string {
  return `## Convert Approved Plan into Beads

Take the approved implementation plan and translate it into beads (tasks) using the br CLI.

### Goal
${goal}

### Repository Context
${formatRepoProfile(profile)}

### Plan Artifact
The approved plan lives at: \`${planPath}\`

### Instructions
1. Read the plan artifact at \`${planPath}\` before creating any beads.
2. Treat that artifact as the source of truth for scope, sequencing, architecture, edge cases, and testing.
3. Convert the plan into executable beads with \`br create\` and dependency edges with \`br dep add\`.
4. Embed the relevant context from the plan directly into each bead description:
   - summarize the implementation intent
   - capture the rationale and important constraints
   - include acceptance criteria and verification expectations
   - list the files to create or modify
5. DO NOT write beads that say things like "see the plan", "refer to plan", or "per approved plan" without restating the needed context. Each bead must stand on its own for a fresh agent.
6. If the plan describes a large effort, split it into multiple beads so each bead is a coherent, independently executable unit.

### Bead Format
For each bead, run in bash:
\`\`\`
br create "Title" -t task -p <priority 1-5> -d "Detailed description including:
- What to implement
- Why it matters
- Key context pulled forward from the approved plan
- Acceptance criteria (as checklist):
  - [ ] Criterion 1
  - [ ] Criterion 2
- ### Files: src/foo.ts, src/bar.ts"
\`\`\`

Set dependencies between beads:
\`\`\`
br dep add <child-id> <parent-id>
\`\`\`

### Requirements
- Every bead must be self-contained and self-documenting
- Preserve the plan's intended sequencing and parallelism
- Carry forward edge cases, migration notes, and testing expectations from the plan into the relevant beads
- Each bead MUST include a \`### Files:\` section listing files to create/modify
- Acceptance criteria should be specific and testable
- Include test beads where appropriate

## Template Library
${formatTemplatesForPrompt()}

The plan is your primary source. Use templates only to accelerate structure, not replace plan details.
Templates are optional: if one fits, expand it with plan-specific details; if none fit, write a custom bead normally.
Do not emit final beads that say \`[Use template: ...]\`, raw template IDs, \`see template\`, or unresolved \`{{placeholderName}}\` markers.

Verify with \`br list\` and \`br dep cycles\` (must show no cycles).

Use ultrathink.`;
}

// ─── Bead Refinement Prompt ──────────────────────────────────
export function beadRefinementPrompt(roundNumber?: number, priorChanges?: number[]): string {
  const hasRoundNumber = roundNumber !== undefined && roundNumber !== null;
  const roundInfo = hasRoundNumber ? `This is polish round ${roundNumber + 1}.\n\n` : "";
  const changesInfo = priorChanges && priorChanges.length > 0
    ? `Prior rounds: ${priorChanges.map((n, i) => `Round ${i + 1}: ${n} change${n !== 1 ? "s" : ""}`).join(", ")}.\n\n`
    : "";

  return `## Bead Refinement Pass

${roundInfo}${changesInfo}Review each bead via \`br list\` and \`br show <id>\`.

### For each bead, check:
1. Does this make sense? Is there a better approach?
2. Could the description be clearer or more actionable?
3. Does a fresh agent have enough context to execute without guessing?
4. Are acceptance criteria specific and testable?
5. Is the \`### Files:\` section accurate and complete?
6. Are dependencies correct? Would \`br ready\` return the right parallel groups?
7. Are any beads too large? Could they split into 2-3 subtasks for better parallelism?
8. Could a fresh agent implement this without ANY external context? What background is missing?

### Actions
- Revise with \`br update <id> -d "..."\` for any improvements
- Validate: \`br dep cycles\` (must show no cycles)

### Rules
- DO NOT OVERSIMPLIFY. DO NOT LOSE FEATURES.
- Include test beads that cover the new functionality.
- Every bead must be self-contained and self-documenting.
- If you find missing beads, create them with \`br create\`.
- If you find redundant beads, remove them with \`br rm <id>\`.

Use ultrathink.`;
}

/** Fresh-context refinement prompt for sub-agent bead review. */
export function freshContextRefinementPrompt(cwd: string, goal: string, roundNumber: number, simulationReport?: string): string {
  const simSection = simulationReport
    ? `\n\n### Simulation Issues\nThe plan simulation found structural problems that must be fixed:\n\n${simulationReport}\n`
    : "";

  return `## Fresh-Context Bead Refinement (Round ${roundNumber + 1})

You are reviewing beads for a project with NO prior context. This is deliberate - fresh eyes catch what anchored reviewers miss.

**Goal:** ${goal}${simSection}

### Instructions
1. Run \`br list --json\` to read all open beads
2. For each bead, evaluate:
   - Does it make sense as a self-contained work unit?
   - Is the description detailed enough for a fresh agent to implement without guessing?
   - Are acceptance criteria specific and testable?
   - Are dependencies correct?
   - Could the architecture be improved?
3. Make improvements directly via \`br update <id> -d "..."\`
4. Check for missing beads and create them with \`br create\`
5. Run \`br dep cycles\` to verify no cycles

### Rules
- DO NOT OVERSIMPLIFY. DO NOT LOSE FEATURES OR FUNCTIONALITY.
- Every bead must be self-contained and self-documenting.
- Include specific test expectations in each bead.

Use ultrathink.

cd ${cwd}`;
}

/**
 * Generate a refinement prompt that includes specific simulation failures.
 * Used when simulateExecutionPaths finds structural problems in the bead graph.
 */
export function simulationRefinementPrompt(report: string, beadIds: string[]): string {
  return `## Simulation-Driven Bead Refinement

The plan simulation found structural issues that must be fixed before beads can be approved.

### Simulation Report
${report}

### Beads to review
${beadIds.map((id) => `- ${id}`).join("\n")}

### Fix guidance by issue type
- **File conflicts between parallel beads**: Add a dependency edge (\`br dep add\`) between conflicting beads so they execute sequentially, or split beads so their file sets don't overlap.
- **Missing file references**: Update file paths in bead descriptions to match actual repo paths, or mark new files explicitly (files that the bead will create are expected to be missing).
- **Execution order issues**: Adjust dependencies so the topological sort produces a valid execution sequence.
- **Cycle detected**: Break the cycle by removing or reversing one dependency edge.

Make fixes directly via \`br update <id> --description "..."\` and \`br dep add/remove\`.
Verify with \`br dep cycles\` (must show no cycles).`;
}

/**
 * Convergence score (0-1) from polish round history.
 * Weights: velocity 35%, size 25%, similarity 25%, zero-streak 15%.
 * >= 0.75 = ready to implement, >= 0.90 = diminishing returns.
 *
 * @param descriptionSnapshots - Optional per-round arrays of bead description strings.
 *   When provided, Jaccard similarity between the last two snapshots is used as signal 3.
 */
export function computeConvergenceScore(
  changes: number[],
  outputSizes?: number[],
  descriptionSnapshots?: string[][]
): number {
  if (changes.length < 3) return 0;

  // Change velocity: ratio of recent changes to peak changes
  const peak = Math.max(...changes, 1);
  const recent = changes[changes.length - 1];
  const velocityScore = 1 - (recent / peak);

  // Output size delta: are outputs shrinking? (convergence signal)
  let sizeScore = 0.5; // neutral if no data
  if (outputSizes && outputSizes.length >= 2) {
    const lastTwo = outputSizes.slice(-2);
    const delta = Math.abs(lastTwo[1] - lastTwo[0]);
    const maxSize = Math.max(...outputSizes, 1);
    sizeScore = 1 - Math.min(delta / maxSize, 1);
  }

  // Jaccard similarity between the last two description snapshots
  let similarityScore = 0.5; // neutral if no data
  if (descriptionSnapshots && descriptionSnapshots.length >= 2) {
    const prev = descriptionSnapshots[descriptionSnapshots.length - 2];
    const curr = descriptionSnapshots[descriptionSnapshots.length - 1];
    const wordsOf = (strs: string[]): Set<string> => {
      const words = new Set<string>();
      for (const s of strs) {
        for (const w of s.toLowerCase().split(/\W+/)) {
          if (w.length > 0) words.add(w);
        }
      }
      return words;
    };
    const setA = wordsOf(prev);
    const setB = wordsOf(curr);
    const intersection = new Set([...setA].filter((w) => setB.has(w)));
    const union = new Set([...setA, ...setB]);
    similarityScore = union.size === 0 ? 1 : intersection.size / union.size;
  }

  // Consecutive zero-change rounds
  let zeroStreak = 0;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i] === 0) zeroStreak++;
    else break;
  }
  const zeroScore = Math.min(zeroStreak / 2, 1); // 2 consecutive zeros = 1.0

  // If descriptionSnapshots not provided, fall back to original weights for backward compatibility
  if (!descriptionSnapshots || descriptionSnapshots.length < 2) {
    return velocityScore * 0.4 + sizeScore * 0.3 + zeroScore * 0.3;
  }

  return velocityScore * 0.35 + sizeScore * 0.25 + similarityScore * 0.25 + zeroScore * 0.15;
}

// ─── Deep Planning Synthesis Prompt ──────────────────────────
export function synthesisInstructions(plans: { name: string; model: string; plan: string }[]): string {
  return `## Synthesis Instructions

${plans.length} independent planners produced the plans above. Synthesize them into one plan:

1. Identify the strongest ideas from each plan
2. Where plans contradict, pick the approach with better justification
3. Cover architecture, constraints, testing, and error handling
4. Make the result detailed enough for a fresh agent to execute without guessing

Then create beads via \`br create\` in bash with the synthesized plan.`;
}

// ─── Reality Check Prompt ────────────────────────────────────
export function realityCheckInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[]
): string {
  const done = results.filter((r) => r.status === "success").length;
  const total = beads.length;

  return `## Reality Check

Where are we on this project? Do we actually have the thing we are trying to build?

### Goal
${goal}

### Progress
${done}/${total} beads completed.

${beads.map((b) => {
  const r = results.find((r) => r.beadId === b.id);
  return `- Bead ${b.id}: ${r?.status ?? "not started"} - ${b.title}: ${b.description}${r?.summary ? `\n  Summary: ${r.summary}` : ""}`;
}).join("\n")}

### Answer honestly
1. If all remaining open beads are implemented correctly, does that close the gap? If not, what is missing?
2. What is blocking progress right now?
3. Are there missing beads or untracked dependencies?
4. Is any completed work broken or incomplete despite being marked done?

If remaining beads don't close the gap, the fix is to revise beads or add missing work, not to push harder on implementation.`;
}

function normalizePromptSection(content: string | undefined, heading: string): string {
  const trimmed = content?.trim();
  if (!trimmed) return "";
  return trimmed.startsWith(heading)
    ? `\n${trimmed}\n`
    : `\n${heading}\n${trimmed}\n`;
}

// ─── Implementer Instructions ────────────────────────────────
export function implementerInstructions(
  bead: Bead,
  profile: RepoProfile,
  previousResults: BeadResult[],
  cassMemory?: string,
  episodicContext?: string
): string {
  const prevContext =
    previousResults.length > 0
      ? `\n## Previous Beads Completed\n${previousResults
          .map((r) => `- Bead ${r.beadId}: ${r.status} - ${r.summary}`)
          .join("\n")}`
      : "";

  // Extract acceptance criteria from description (lines starting with - [ ])
  const criteriaLines = bead.description
    .split("\n")
    .filter((line) => line.trim().startsWith("- [ ]"))
    .map((line) => line.trim());

  // Extract files section from description
  const filesMatch = bead.description.match(/### Files:\s*(.+?)(?:\n###|\n\n|$)/s);
  const files = filesMatch ? filesMatch[1].trim() : "See bead description";

  const memorySection = normalizePromptSection(cassMemory, "## Memory from Prior Orchestrations");
  const episodicSection = normalizePromptSection(episodicContext, "## Past Session Examples");

  return `## Implement Bead ${bead.id}: ${bead.title}${memorySection}${episodicSection}

### Description
${bead.description}

### Acceptance Criteria
${criteriaLines.length > 0 ? criteriaLines.join("\n") : "See bead description for criteria."}

### Expected Files
${files}

### Repo Context
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
${prevContext}

### Marching Orders
- Read the relevant files first.
- Use \`orch_memory\` if prior learnings would help.
- Implement with focused changes only.
- Do a fresh-eyes review of modified code before finishing.
- When done, call \`orch_review\` with what you changed and what you checked.

**Next bead routing:** \`bv --robot-next\` for solo work, \`bv --robot-triage\` for swarms, fallback \`br ready --json\`. Use \`bv --robot-insights\` if the graph looks stuck.`;
}

// ─── Reviewer Instructions ───────────────────────────────────
export function reviewerInstructions(
  bead: Bead,
  implementationSummary: string,
  profile: RepoProfile,
  episodicContext?: string
): string {
  const criteriaLines = bead.description
    .split("\n")
    .filter((line) => line.trim().startsWith("- [ ]") || line.trim().startsWith("- [x]"))
    .map((line) => line.trim().replace(/^- \[.\] /, ""));

  const episodicSection = normalizePromptSection(episodicContext, "## Past Session Examples");

  return `## Review Bead ${bead.id}: ${bead.title}${episodicSection}

### Acceptance Criteria
${criteriaLines.length > 0 ? criteriaLines.map((c) => `- ${c}`).join("\n") : "See bead description."}

### Implementation Summary
${implementationSummary}

### Project Conventions
- **Languages:** ${profile.languages.join(", ")}
- **Frameworks:** ${profile.frameworks.join(", ")}
- **Test Framework:** ${profile.testFramework ?? "unknown"}

### Review Checklist
1. Does the implementation satisfy each acceptance criterion?
2. Do changes align with project conventions?
3. Are there any regressions or issues introduced?
4. Is the code clean and well-structured?

Determine: **PASS** or **FAIL**
If FAIL, provide specific revision instructions.`;
}

// ─── Adversarial Review Instructions ─────────────────────────
export function adversarialReviewInstructions(
  bead: Bead,
  implementationSummary: string,
  domainExtras?: string
): string {
  const criteriaLines = bead.description
    .split("\n")
    .filter((line) => line.trim().startsWith("- [ ]") || line.trim().startsWith("- [x]"))
    .map((line) => line.trim().replace(/^- \[.\] /, ""));

  return `## Adversarial "Fresh Eyes" Review - Bead ${bead.id}

You are reviewing this bead as if you've never seen it before. The first review already passed - your job is to catch what it missed.

### What was implemented
${implementationSummary}

### Acceptance Criteria
${criteriaLines.length > 0 ? criteriaLines.map((c) => `- ${c}`).join("\n") : "See bead description."}

### Check specifically for:
1. **Blunders & bugs** - off-by-one errors, null derefs, race conditions, missing error handling
2. **Ergonomics** - would a fresh agent find this intuitive? Would you want to read this code cold?
3. **Oversights** - edge cases not covered, missing validation, assumptions that don't hold
4. **Security** - injection, path traversal, secrets in output, unsafe defaults
5. **Style** - generic AI patterns, unnecessary verbosity, unclear naming${domainExtras ?? ""}

Provide specific file:line references and fixes for every issue.
If everything is clean, say so briefly - don't invent problems.`;
}

// ─── Cross-Agent Review Instructions ─────────────────────────
export function crossAgentReviewInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[]
): string {
  return `## Independent Cross-Agent Code Review

You are an independent reviewer auditing the FULL diff of this orchestration.
You did NOT write this code. Review it with zero assumptions.

### Goal
${goal}

### Beads Completed
${beads
  .map((b) => {
    const r = results.find((r) => r.beadId === b.id);
    return `- Bead ${b.id}: ${b.title} (${r?.status ?? "unknown"})`;
  })
  .join("\n")}

### Your Review Checklist
1. **Correctness** - Does the implementation actually achieve the stated goal?
2. **Consistency** - Do all the pieces fit together? Any contradictions between beads?
3. **Completeness** - Anything missing that the beads promised?
4. **Code quality** - Clean, well-structured, follows project conventions?
5. **Agent ergonomics** - Would another coding agent find this easy to understand and modify?
6. **Regressions** - Could any change break existing functionality?

### Output
Provide:
- A severity-ranked list of findings (critical -> minor)
- Specific fix suggestions for anything critical
- An overall verdict: APPROVE or REQUEST_CHANGES`;
}

// ─── Post-Completion Phase Instructions ──────────────────────
export function polishInstructions(goal: string, artifacts: string[]): string {
  return `## Polish Pass (De-Slopify)

Review all files changed during this orchestration and improve them:

### Goal context
${goal}

### Files to review
${artifacts.map((a) => `- ${a}`).join("\n")}

### What to fix:
1. **Remove AI slop** - generic filler ("leverage", "utilize", "comprehensive"), unnecessary caveats, hollow qualifiers
2. **Improve clarity** - rename vague variables, simplify convoluted logic, add comments only where non-obvious
3. **Tighten ergonomics** - would you want to read this code cold with no context?
4. **Consistent style** - match the project's existing conventions
5. **Trim fat** - remove dead code, unused imports, unnecessary abstractions

Make targeted edits. Don't rewrite things that are already good.`;
}

export function commitStrategyInstructions(
  beads: Bead[],
  results: BeadResult[]
): string {
  // Extract files from bead descriptions
  const beadDetails = beads.map((b) => {
    const r = results.find((r) => r.beadId === b.id);
    const filesMatch = b.description.match(/### Files:\s*(.+?)(?:\n###|\n\n|$)/s);
    const files = filesMatch ? filesMatch[1].trim() : "See bead description";
    return `- Bead ${b.id}: ${b.title}\n  Files: ${files}\n  Summary: ${r?.summary ?? "N/A"}`;
  });

  return `## Commit Strategy

Group the changes from this orchestration into logical commits with detailed messages.

### Beads completed
${beadDetails.join("\n\n")}

### Rules
- Group by logical change, NOT by bead number (beads may touch the same files)
- Each commit should be independently understandable
- Use conventional commit format: type(scope): description
- First line <= 72 chars, then blank line, then detailed body
- Body explains WHY, not just WHAT
- Reference bead IDs in the body for traceability

Create the commits now using bash (git add -p / git add <files> then git commit).`;
}

export function skillExtractionInstructions(
  goal: string,
  artifacts: string[]
): string {
  return `## Skill Extraction Check

Evaluate whether the work from this orchestration should become a reusable agent skill.

### What was built
Goal: ${goal}
Artifacts: ${artifacts.join(", ")}

### Criteria for extraction
A skill is worth creating if:
1. The workflow/pattern will be reused across projects
2. It encapsulates non-obvious domain knowledge
3. It would save significant time on future similar tasks
4. It's self-contained enough to work without heavy context

### If yes:
- Create a SKILL.md following the standard format
- Include: name, description (trigger phrases), concrete instructions, examples
- Place it in a skills/ subdirectory

### If no:
- Briefly explain why not (too project-specific, too simple, etc.)
- Suggest if any PART of it could be a skill`;
}

// ─── Strategic Drift Detection ───────────────────────────────
/** Proactive drift check that runs every N completed beads. */
export function strategicDriftCheckInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[],
  completedCount: number,
  totalCount: number
): string {
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  return `## Strategic Drift Check (${completedCount}/${totalCount} beads, ${progressPct}%)

A swarm can look productive while heading in the wrong direction. This check verifies we are still converging on the actual goal.

### Goal
${goal}

### Current State
${beads.map((b) => {
  const r = results.find((r) => r.beadId === b.id);
  return `- ${b.id}: ${r?.status === "success" ? "[done]" : r ? "[in-progress]" : "[open]"} ${b.title}`;
}).join("\n")}

### Answer These Questions
1. **Gap analysis**: If we implement all remaining open beads perfectly, do we fully achieve the goal? If not, what is missing?
2. **Direction check**: Is any completed work actually moving us AWAY from the goal or creating unnecessary complexity?
3. **Bead sufficiency**: Are there capabilities the goal requires that no current bead addresses?
4. **Priority alignment**: Are the highest-impact beads being worked on, or is the swarm doing leaf work while blockers sit idle?

### Output
- **Drift detected**: YES or NO
- **Confidence**: HIGH / MEDIUM / LOW
- **Missing beads**: List any beads that should be created
- **Beads to deprioritize**: List any that are not actually needed
- **Recommendation**: CONTINUE, PAUSE_AND_REVISE, or STOP`;
}

// ─── Blunder Hunt (Overshoot Mismatch Technique) ────────────
/**
 * Overshoot mismatch prompt. Claiming 80+ errors forces exhaustive search
 * past the ~20-25 issue plateau.
 */
export function blunderHuntInstructions(cwd: string, passNumber: number, domainExtras?: string): string {
  return `## Blunder Hunt - Pass ${passNumber}/5

Reread the beads. Assume you missed at least 80 issues. Check for:

1. **Logical flaws** in bead descriptions or acceptance criteria
2. **Missing dependencies** between beads
3. **Incomplete context** that would leave a fresh agent guessing
4. **Contradictions** between beads
5. **Missing test expectations**
6. **Overly vague acceptance criteria**
7. **Wrong file paths** in ### Files sections
8. **Duplicative or overlapping beads**
9. **Missing error handling expectations**
10. **Architectural inconsistencies**${domainExtras ?? ""}

For each issue found:
- State the bead ID and the specific problem
- Fix it directly via \`br update <id> -d "..."\`
- Or create missing beads via \`br create\`

Do not stop at a few issues. Keep looking.

cd ${cwd}`;
}

// ─── Random Code Exploration Review ──────────────────────────
/** Force the reviewer to pick files outside the changed artifacts list. */
export function randomExplorationInstructions(
  goal: string,
  changedFiles: string[],
  cwd: string
): string {
  const excludeList = changedFiles.length > 0
    ? `\n\n**EXCLUDE these files** (already reviewed by other agents):\n${changedFiles.map(f => `- ${f}`).join("\n")}`
    : "";

  return `## Random Code Exploration Review

Randomly explore code files in this project. Trace execution flows through imports and dependents.${excludeList}

### Goal Context
${goal}

### Instructions
1. Pick 3-5 files at random (NOT from the changed files list above)
2. For each file, trace execution flows through imports and callers
3. Once you understand the purpose in the larger workflow context, check for:
   - Bugs, logic errors, off-by-one mistakes
   - Broken execution flows across module boundaries
   - Missing error handling
   - Assumptions that don't hold
4. Fix any issues you find directly using the edit tool

Focus on utility modules, error handling paths, and edge-case branches - the places that get the least attention.

cd ${cwd}`;
}

// ─── De-Slopification ───────────────────────────────────────
/** Extensible catalogue of AI slop patterns to detect and fix. */
export const AI_SLOP_PATTERNS = [
  { pattern: "emdash overuse (-)", fix: "Replace with semicolons, commas, or sentence splits" },
  { pattern: '"It\'s not X, it\'s Y"', fix: "Recast the contrast without the formulaic structure" },
  { pattern: '"Here\'s why" / "Here\'s why it matters:"', fix: "Remove the clickbait lead-in" },
  { pattern: '"Let\'s dive in" / "Let us dive in"', fix: "Remove forced enthusiasm" },
  { pattern: '"At its core..."', fix: "Remove pseudo-profound opener" },
  { pattern: '"It\'s worth noting..."', fix: "Remove unnecessary hedge" },
  { pattern: '"leverage" / "utilize"', fix: 'Use "use"' },
  { pattern: '"comprehensive" / "robust"', fix: "Be specific about what makes it comprehensive" },
  { pattern: '"seamless" / "seamlessly"', fix: "Describe the actual behavior" },
  { pattern: '"In conclusion" / "To summarize"', fix: "Just state the conclusion" },
];

export function deSlopifyInstructions(files: string[]): string {
  const patternList = AI_SLOP_PATTERNS
    .map((p, i) => `${i + 1}. **${p.pattern}** -> ${p.fix}`)
    .join("\n");

  return `## De-Slopification Pass

Read through the following files and remove telltale AI writing patterns. Revise each line manually - no regex or script-based replacement.

### Files to review
${files.map(f => `- ${f}`).join("\n")}

### AI Slop Patterns to Fix
${patternList}

### Rules
- Read each line of text and revise manually
- Preserve the meaning while removing the AI-ish phrasing
- If a sentence works fine with the pattern, leave it (not every emdash is bad)
- Focus on user-facing documentation, README, and doc comments
- Code comments are fine to clean up but don't over-polish them`;
}

// ─── Landing the Plane ──────────────────────────────────────
export function landingChecklistInstructions(cwd: string): string {
  return `## Landing the Plane - Session Completion Checklist

Work is NOT complete until every item below passes. A session is only "landable" when a future swarm can pick it back up from artifacts alone.

### Checklist
1. **Remaining work filed**: Create beads for any unfinished work or follow-up items
2. **Quality gates**: Run tests (\`npm test\`), type check (\`npm run build\`), lints
3. **Bead status**: Close all finished beads, update in-progress items
4. **Sync beads**: \`br sync --flush-only\` to export to JSONL
5. **Commit and push**: \`git pull --rebase && git add . && git commit && git push\`
6. **Verify**: \`git status\` must show clean working tree and up-to-date with remote
7. **Session resumability**: AGENTS.md + beads + agent-mail threads are sufficient for a new agent to continue

### For Each Item
Report: PASS or FAIL with reason

cd ${cwd}`;
}

// ─── Swarm Marching Orders ──────────────────────────────────
export function swarmMarchingOrders(cwd: string, beadId?: string): string {
  return `## Swarm Marching Orders

Read AGENTS.md and README.md thoroughly. Then investigate the codebase to understand the technical architecture and project purpose.${beadId ? `\n\nYour assigned bead: ${beadId}` : ""}

Be sure to check your agent mail and promptly respond to any messages. Then proceed meticulously with your assigned bead, working systematically and tracking progress via beads and agent mail messages.

Don't stall on coordination. Start work promptly, but inform fellow agents via messages and mark beads appropriately.

When idle, use \`bv --robot-triage\` to find the highest-impact bead, claim it, and start coding. Acknowledge all communication from other agents. Use ultrathink.

cd ${cwd}`;
}

/** Stagger delay configuration for thundering herd prevention. */
export const SWARM_STAGGER_DELAY_MS = 30_000; // 30 seconds between agent starts

// ─── Centralized Model IDs ──────────────────────────────────
// All model references go through these constants so typos and
// provider mismatches are caught in one place.
//
// Format: "provider/modelId" as accepted by `claude --model`.
// Update these when new model versions ship or providers change.

/** Default models used by the multi-model deep planning agents (fallbacks). */
export const DEEP_PLAN_MODELS = {
  correctness: "openai-codex/gpt-5.4",
  robustness: "anthropic/claude-opus-4-6",
  ergonomics: "anthropic/claude-sonnet-4-6",
  synthesis: "openai-codex/gpt-5.4",
} as const;

/** Models used by the swarm launcher. */
export const SWARM_MODELS = {
  opus: "anthropic/claude-opus-4-6",
  gpt: "openai-codex/gpt-5.4",
  haiku: "anthropic/claude-haiku-4-5",
} as const;

/** Models used by cost-aware model routing tiers. */
export const MODEL_ROUTING_TIERS = {
  simple: {
    implementation: "anthropic/claude-haiku-4-5",
    review: "anthropic/claude-opus-4-6",
  },
  medium: {
    implementation: "anthropic/claude-opus-4-6",
    review: "openai-codex/gpt-5.4",
  },
  complex: {
    implementation: "anthropic/claude-opus-4-6",
    review: "openai-codex/gpt-5.4",
  },
} as const;

/**
 * Model rotation for refinement rounds.
 * Different models have different blind spots; rotating prevents anchoring.
 */
export const REFINEMENT_MODELS = [
  "anthropic/claude-opus-4-6",
  "openai-codex/gpt-5.4",
  "anthropic/claude-sonnet-4-6",
] as const;

/** Pick a refinement model based on round number (rotates through available models). */
export function pickRefinementModel(round: number): string {
  return REFINEMENT_MODELS[round % REFINEMENT_MODELS.length];
}

// ─── Bead Quality Scoring ───────────────────────────────────
/**
 * Prompt for LLM-based quality scoring of a bead on WHAT/WHY/HOW axes.
 */
export function beadQualityScoringPrompt(beadId: string, title: string, description: string): string {
  return `## Bead Quality Assessment: ${beadId}

### Title
${title}

### Description
${description}

### Score this bead on three axes (1-5 each):

**WHAT (Implementation Details)**: Does the description specify concrete implementation steps?
- 5: Exact functions, data structures, algorithms, file changes
- 3: General approach but missing specifics
- 1: Vague or missing implementation guidance

**WHY (Rationale & Context)**: Does it explain the reasoning, intent, and background?
- 5: Full rationale, design decisions, tradeoffs documented
- 3: Some context but gaps in reasoning
- 1: No rationale - just a bare task description

**HOW (Verification)**: Does it include acceptance criteria, test expectations, verification steps?
- 5: Specific, testable criteria with edge cases covered
- 3: Basic criteria but missing edge cases
- 1: No criteria - "just make it work"

### Output Format (JSON)
\`\`\`json
{
  "what": <1-5>,
  "why": <1-5>,
  "how": <1-5>,
  "weaknesses": ["specific weakness 1", "specific weakness 2"],
  "suggestions": ["specific improvement 1", "specific improvement 2"]
}
\`\`\``;
}

// ─── Research & Reimagine Workflow ───────────────────────────
/** Step 1: Investigate an external project and propose reimagined ideas. */
export function researchInvestigatePrompt(externalUrl: string, projectName: string, cwd: string): string {
  const repoSlug = externalUrl.replace(/\.git$/, "").split("/").slice(-2).join("-");
  const cloneDir = `/tmp/research-${repoSlug}`;
  return `## Research & Reimagine - Step 1: Investigate

Study ${externalUrl} and find ideas worth reimagining on top of ${projectName}'s existing capabilities.

### Step 1 - Clone the repo
\`\`\`bash
git clone --depth 1 ${externalUrl} ${cloneDir} 2>&1 || echo "Clone failed - repo may not exist or require auth"
\`\`\`

If clone fails, output the error and stop - do NOT invent a proposal.

### Step 2 - Explore the codebase
\`\`\`bash
ls ${cloneDir}
cat ${cloneDir}/README.md 2>/dev/null || cat ${cloneDir}/readme.md 2>/dev/null || echo "No README found"
\`\`\`

Then read 3-5 key source files to understand architecture and implementation patterns.

### Step 3 - Study this project
\`\`\`bash
ls ${cwd}
cat ${cwd}/README.md 2>/dev/null | head -100
\`\`\`

### Step 4 - Write the proposal

Write a proposal document that:
1. Summarizes the external project's architecture and key ideas (cite specific files/patterns you read)
2. Identifies the strongest design decisions worth adapting
3. Proposes how to reimagine each through ${projectName}'s unique strengths
4. Creates something neither project could achieve alone

Make the proposal genuinely novel, not a shallow port. Start with a one-line summary of what the external project does, so the reader knows it was actually studied.

cd ${cwd}`;
}

/** Step 2: Push past conservative initial suggestions. */
export function researchDeepenPrompt(): string {
  return `## Research & Reimagine - Step 2: Deepen

Decent start, but surface-level. Push further: more ambition, bolder ideas. Find genuinely surprising, high-impact possibilities.

Go deeper.`;
}

/**
 * Post-research handoff prompt - sent as a followUp after all research phases
 * complete. Uses the same "NEXT: ... NOW" directive style as tool results so
 * the agent immediately drives the full pipeline rather than just acknowledging.
 */
export function researchHandoffPrompt(
  externalName: string,
  selectedGoal: string,
  artifactName: string,
  phasesCompleted: number,
  totalPhases: number,
  hasRepoProfile: boolean
): string {
  const profileNote = hasRepoProfile
    ? ""
    : "\n\n> No repo profile found. `orch_approve_beads` will profile the repo automatically.";

  return `## Research complete - execute the full pipeline now

**Research for \`${externalName}\` finished** (${phasesCompleted}/${totalPhases} phases).${profileNote}

The reimagined proposal is saved at \`${artifactName}\`.
Goal: _"${selectedGoal}"_

---

## NEXT: Execute these steps in order, WITHOUT pausing or asking for confirmation.

### Step 1 - Call \`orch_approve_beads\` NOW
This reads the proposal, scores its quality, and optionally runs up to 4 refinement rounds.
When it completes, it will return explicit \`br create\` commands - follow them exactly.

### Step 2 - Create beads from the plan (as directed by Step 1)
Use \`br create\` and \`br dep add\` as specified.
Each bead must include:
- A clear title and description
- \`### Files:\` section listing every file it will touch
- \`- [ ]\` acceptance criteria

### Step 3 - Call \`orch_approve_beads\` again
Quality-checks the created beads. Fixes shallow descriptions automatically.
Approves the beads and transitions to the implementing phase.

### Step 4 - Call \`orch_review\` to start implementing
Picks the first ready bead and returns implementation instructions.
Keep calling \`orch_review\` after each bead until all pass.

---

**Call \`orch_approve_beads\` now to begin.**`;
}

/** Step 3: Inversion analysis - what can WE do that THEY cannot? */
export function researchInversionPrompt(projectName: string, externalName: string): string {
  return `## Research & Reimagine - Step 3: Inversion Analysis

Now "invert" the analysis: what are things that ${projectName} can do because of its unique primitives/capabilities that ${externalName} simply could never do even if they wanted to, because they are working from less rich primitives?

This surfaces the highest-value integration points: capabilities that are genuinely novel rather than reimplementations.`;
}

// ─── Goal Refinement Prompt ──────────────────────────────────
export function goalRefinementPrompt(goal: string, profile: RepoProfile): string {
  return `## Goal Refinement

The user wants to work on this goal:
> ${goal}

${formatRepoProfile(profile)}

## Your Task
Analyze the goal against the repository context above. Generate clarifying questions that will sharpen the goal into an unambiguous, actionable plan. Each question should reference specific aspects of the repo (languages, frameworks, file structure, recent commits) - do NOT ask generic questions.

**Adaptive depth:** If the goal is already specific and detailed, generate fewer questions (as few as 1-2). If it's vague or broad, generate up to 5. Assess specificity before generating.

**Required:** One question MUST ask about constraints and non-goals - things the user explicitly does NOT want changed or wants to avoid.

## Output Format
Return a JSON array of question objects. Each question has:
- \`id\`: kebab-case identifier (e.g. "target-framework")
- \`label\`: short display label (e.g. "Target Framework")
- \`prompt\`: the full question text, referencing repo context where relevant
- \`options\`: array of 3-5 options, each with \`value\` (kebab-case), \`label\` (display text), and optional \`description\`
- \`allowOther\`: boolean - whether the user can type a custom answer

## Example Output
\`\`\`json
[
  {
    "id": "scope",
    "label": "Scope",
    "prompt": "The repo has both src/api/ and src/cli/ entrypoints. Should this change target the API layer, the CLI, or both?",
    "options": [
      { "value": "api-only", "label": "API only", "description": "Changes limited to src/api/" },
      { "value": "cli-only", "label": "CLI only", "description": "Changes limited to src/cli/" },
      { "value": "both", "label": "Both", "description": "Coordinate changes across API and CLI" }
    ],
    "allowOther": false
  },
  {
    "id": "constraints",
    "label": "Constraints & Non-Goals",
    "prompt": "Are there parts of the codebase or behaviors you want to explicitly preserve or avoid changing?",
    "options": [
      { "value": "no-breaking", "label": "No breaking changes", "description": "Public API must remain backward-compatible" },
      { "value": "no-new-deps", "label": "No new dependencies", "description": "Solve with existing packages only" },
      { "value": "no-constraints", "label": "No specific constraints", "description": "Open to any approach" }
    ],
    "allowOther": true
  }
]
\`\`\`

Return ONLY the JSON array, no surrounding text or markdown fences.`;
}

// ─── Summary Instructions ────────────────────────────────────
export function summaryInstructions(
  goal: string,
  beads: Bead[],
  results: BeadResult[]
): string {
  return `## Generate Final Summary

### Goal
${goal}

### Beads and Results
${beads
  .map((b) => {
    const result = results.find((r) => r.beadId === b.id);
    return `**Bead ${b.id}: ${b.title}**
- Status: ${result?.status ?? "not started"}
- Summary: ${result?.summary ?? "N/A"}`;
  })
  .join("\n\n")}

### Instructions
Write a clear, user-facing summary including:
1. What goal was implemented
2. What files changed or were created
3. How to use the new functionality (commands, configuration, etc.)
4. Any follow-up recommendations

Also ask the user if they'd like you to:
- Create a GUIDE.md documenting the changes
- Run tests
- Create a git commit with a descriptive message`;
}

// ─── Plan Document Generation ───────────────────────────────
export function competingPlanAgentPrompt(
  focus: "correctness" | "robustness" | "ergonomics",
  goal: string,
  profile: RepoProfile,
  scanResult?: ScanResult,
  cassContext?: string
): string {
  const repoContext = formatRepoProfile(profile, scanResult);
  const memorySection =
    cassContext && cassContext.trim().length > 0
      ? `\n## Memory from Prior Orchestrations\n${cassContext.trim()}\n`
      : "";
  const lensInstructions = {
    correctness: [
      "Prioritize architectural correctness and internal consistency.",
      "Interrogate assumptions about existing interfaces, types, and control flow.",
      "Call out any places where the implementation could accidentally violate current behavior or contracts.",
    ],
    robustness: [
      "Prioritize failure modes, degraded paths, rollout safety, and testability.",
      "Stress edge cases, missing validation, sequencing hazards, and migration risks.",
      "Bias toward plans that remain reliable under partial failure and future extension.",
    ],
    ergonomics: [
      "Prioritize clarity, maintainability, and agent ergonomics for future contributors.",
      "Prefer simpler seams, better naming, and flows that reduce context-switching and ambiguity.",
      "Push for plans that are easy to execute, review, and modify without surprising coupling.",
    ],
  } satisfies Record<string, string[]>;

  return `You are an expert software architect participating in a competing-plans exercise. Use ultrathink and produce ONE detailed markdown plan document.

## Goal
${goal}

## Focus Lens: ${focus}
${lensInstructions[focus].map((line) => `- ${line}`).join("\n")}${memorySection}

## Repository Context
${repoContext}

## Requirements
Produce a concrete markdown plan with these sections:
1. Architecture Overview
2. User Workflows
3. Data Model / Types
4. API Surface
5. Testing Strategy
6. Edge Cases & Failure Modes
7. File Structure
8. Sequencing

## Rules
- Ground every recommendation in the repository context above.
- Do not create beads.
- Do not mention your focus lens in the final headings; express it through the substance of the plan.
- Be opinionated about trade-offs and note key risks.
- Make the plan detailed enough that a fresh agent could implement it without guessing.`;
}

export function planSynthesisPrompt(
  plans: { name: string; model: string; plan: string }[],
  format: "markdown" | "git-diff" = "markdown"
): string {
  const plansText = plans
    .map((plan, index) => `### Plan ${index + 1}: ${plan.name} (${plan.model})\n\n${plan.plan}`)
    .join("\n\n");

  if (format === "git-diff") {
    return `## Plan Synthesis Instructions (git-diff format)

${plans.length} independent plan documents were generated for the same goal. Plan 1 (${plans[0]?.name ?? "correctness"}) is the baseline.

${plansText}

## What to do
Output your improvements as a unified diff against Plan 1, suitable for application via \`patch -p0\` or \`git apply\`.
1. Use standard unified diff format (--- a/plan.md / +++ b/plan.md headers, @@ hunks)
2. Incorporate the strongest ideas from Plans 2 and 3 as additions/replacements
3. Resolve contradictions in favour of the approach with the best justification
4. Preserve correctness, robustness, and ergonomics insights

Return ONLY the unified diff - no prose before or after.`;
  }

  return `## Plan Synthesis Instructions

${plans.length} independent plan documents were generated for the same goal. Synthesize them into a single best-of-all-worlds implementation plan.

${plansText}

## What to do
1. Identify the strongest ideas from each plan
2. Resolve contradictions explicitly; pick the approach with the best justification
3. Preserve the best correctness, robustness, and ergonomics insights
4. Produce one unified markdown plan document with these sections:
   - Architecture Overview
   - User Workflows
   - Data Model / Types
   - API Surface
   - Testing Strategy
   - Edge Cases & Failure Modes
   - File Structure
   - Sequencing
5. Make it concrete enough that a fresh agent could execute it without guessing

Return ONLY the synthesized markdown plan.`;
}

export function planDocumentPrompt(goal: string, profile: RepoProfile, scanResult?: ScanResult): string {
  const repoContext = formatRepoProfile(profile, scanResult);

  return `You are an expert software architect. Use ultrathink to produce a detailed implementation plan.

## Goal
${goal}

## Repository Context
${repoContext}

## Instructions
Produce a detailed markdown plan document covering ALL of the following sections:

### 1. Architecture Overview
- High-level system design and component relationships
- Key architectural decisions and trade-offs

### 2. User Workflows
- Step-by-step user-facing flows the implementation enables
- How existing workflows are affected

### 3. Data Model / Types
- New types, interfaces, or schemas needed
- Changes to existing data structures

### 4. API Surface
- New functions, methods, endpoints, or CLI commands
- Signatures, parameters, return types

### 5. Testing Strategy
- Unit, integration, and e2e test plan
- Edge cases to cover, mocking strategy

### 6. Edge Cases & Failure Modes
- What can go wrong and how to handle it
- Graceful degradation, error messages

### 7. File Structure
- Which files to create or modify
- Logical grouping and module boundaries

### 8. Sequencing
- Implementation order with dependencies
- What can be parallelized vs. must be sequential

## Output
Save the plan as a session artifact using write_artifact with a descriptive name like 'plans/<goal-slug>.md'.
Ground every recommendation in the repository context above - do not hallucinate capabilities or files that don't exist.`;
}

export function planRefinementPrompt(planPath: string, roundNumber: number): string {
  return `You are a fresh reviewer with NO prior context on this plan. Use ultrathink to critically evaluate it.

## Round ${roundNumber} Refinement

This is refinement round ${roundNumber}. Each round uses a fresh conversation to prevent anchoring bias - you should evaluate the plan with completely fresh eyes.

## Instructions
1. Read the plan artifact at: ${planPath}
2. Evaluate it critically - look for:
   - Missing edge cases or failure modes
   - Overly complex designs that could be simplified
   - Incorrect assumptions about the codebase
   - Gaps in testing strategy
   - Sequencing issues or missing dependencies
   - Vague sections that need concrete detail
3. If the plan needs improvement, rewrite the FULL refined plan and save it back to the SAME artifact with \`write_artifact\` using the exact same artifact name: ${planPath}
4. Preserve the strongest parts of the current plan while fixing weaknesses - do not regress coverage or specificity
5. If the plan is already solid, make no artifact changes and say \`NO_CHANGES\` with a brief explanation

Focus on substance over style. Each round should find fewer issues as the plan converges.`;
}

/**
 * Fresh-context plan refinement prompt for sub-agent use.
 * Embeds the full plan text so the sub-agent (zero session context)
 * can evaluate without reading artifacts.
 */
export function freshPlanRefinementPrompt(
  planText: string,
  planArtifactPath: string,
  roundNumber: number,
  cwd: string,
  cassContext?: string
): string {
  const memorySection =
    cassContext && cassContext.trim().length > 0
      ? `\n## Memory from Prior Orchestrations\n${cassContext.trim()}\n`
      : "";
  return `You are a fresh reviewer with ZERO prior context. You have never seen this plan before. Use ultrathink.${memorySection}

## Round ${roundNumber} Refinement

Critically evaluate this implementation plan. Each refinement round uses a completely fresh session to prevent anchoring bias.

## The Plan

${planText}

## Instructions
1. Evaluate the plan critically - look for:
   - Missing edge cases or failure modes
   - Overly complex designs that could be simplified
   - Incorrect assumptions about the codebase
   - Gaps in testing strategy
   - Sequencing issues or missing dependencies
   - Vague sections that need concrete detail
   - User workflows that lack step-by-step detail
   - Architectural decisions without rationale
2. If improvements are needed, output the FULL refined plan (not just diffs)
3. Preserve the strongest parts while fixing weaknesses - do not regress coverage or specificity
4. If the plan is already solid with only marginal improvements possible, output \`NO_CHANGES\` and briefly explain why

Focus on substance over style. Be specific about what is weak and why.

cd ${cwd}`;
}

export function learningsExtractionPrompt(goal: string, beadIds: string[]): string {
  return `## Structured Learnings Extraction

Goal: ${goal}
Beads completed: ${beadIds.join(", ")}

Reflect on this orchestration and extract actionable learnings by answering these 5 questions:

### 1. What architectural decisions were made and why?
Identify key design choices, trade-offs, and the reasoning behind them.

### 2. What gotchas or surprises were encountered?
What was unexpected? What broke in non-obvious ways? What assumptions were wrong?

### 3. What patterns worked well?
Which approaches, abstractions, or workflows proved effective and should be repeated?

### 4. What would you do differently next time?
With hindsight, what would you change about the approach, sequencing, or scope?

### 5. Were there any tool issues or workflow friction?
Did any tools misbehave? Were there workflow bottlenecks or ergonomic problems?

---

For each learning, save it to CASS memory:

\`\`\`bash
cm add '<learning>' --category orchestration --json
\`\`\`

Use appropriate categories: \`orchestration\`, \`architecture\`, \`gotcha\`, \`pattern\`, \`tooling\`

Add 3-7 rules. Each should be specific, actionable, and traceable to beads: ${beadIds.join(", ")}`;
}

// ─── Bead Quality Score Parser ───────────────────────────────

export interface BeadQualityScore {
  what: number;       // 1-5: implementation detail clarity
  why: number;        // 1-5: rationale and context
  how: number;        // 1-5: verification / acceptance criteria
  weaknesses: string[];
  suggestions: string[];
}

export interface BeadQualityAuditResult {
  beadId: string;
  title: string;
  score: BeadQualityScore | null;
  /** Average of what/why/how, or null if parse failed */
  avgScore: number | null;
  weakAxis: "what" | "why" | "how" | null;
}

/**
 * Parse the JSON block produced by beadQualityScoringPrompt().
 */
export function parseBeadQualityScore(output: string): BeadQualityScore | null {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1] : output;
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      typeof parsed.what === "number" &&
      typeof parsed.why === "number" &&
      typeof parsed.how === "number"
    ) {
      return {
        what: Math.min(5, Math.max(1, Math.round(parsed.what))),
        why: Math.min(5, Math.max(1, Math.round(parsed.why))),
        how: Math.min(5, Math.max(1, Math.round(parsed.how))),
        weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Score bar for display: e.g. "|||.. 3/5" */
function scoreBar(n: number): string {
  const filled = Math.round(n);
  return "|".repeat(filled) + ".".repeat(5 - filled) + ` ${n}/5`;
}

/**
 * Format a WHAT/WHY/HOW audit result for display in the approval UI.
 */
export function formatBeadQualityAudit(results: BeadQualityAuditResult[]): string {
  if (results.length === 0) return "No beads scored.";

  const scored = results.filter((r) => r.score !== null);
  if (scored.length === 0) return "WHAT/WHY/HOW scoring failed for all beads.";

  // Axis summary across all beads
  const avgWhat = scored.reduce((s, r) => s + r.score!.what, 0) / scored.length;
  const avgWhy = scored.reduce((s, r) => s + r.score!.why, 0) / scored.length;
  const avgHow = scored.reduce((s, r) => s + r.score!.how, 0) / scored.length;

  const weakestAxis = (() => {
    const min = Math.min(avgWhat, avgWhy, avgHow);
    if (min === avgWhat) return "WHAT (implementation detail)";
    if (min === avgWhy) return "WHY (rationale/context)";
    return "HOW (verification criteria)";
  })();

  const lines: string[] = [
    `## WHAT/WHY/HOW Quality Audit (${scored.length}/${results.length} beads scored)`,
    ``,
    `**Overall averages:**`,
    `  WHAT ${scoreBar(avgWhat)}`,
    `  WHY  ${scoreBar(avgWhy)}`,
    `  HOW  ${scoreBar(avgHow)}`,
    ``,
    avgWhat < 3 || avgWhy < 3 || avgHow < 3
      ? `**Weakest axis: ${weakestAxis}** - focus next refinement round here.`
      : `All axes above threshold.`,
    ``,
  ];

  // List weak beads (any axis < 3)
  const weak = scored.filter(
    (r) => r.score!.what < 3 || r.score!.why < 3 || r.score!.how < 3
  );
  if (weak.length > 0) {
    lines.push(`**Beads needing improvement (${weak.length}):**`);
    for (const r of weak) {
      const axes = [
        r.score!.what < 3 ? `WHAT(${r.score!.what})` : "",
        r.score!.why < 3 ? `WHY(${r.score!.why})` : "",
        r.score!.how < 3 ? `HOW(${r.score!.how})` : "",
      ].filter(Boolean).join(", ");
      lines.push(`  - **${r.beadId}** (${r.title}): weak on ${axes}`);
      if (r.score!.suggestions.length > 0) {
        lines.push(`    -> ${r.score!.suggestions[0]}`);
      }
    }
  }

  return lines.join("\n");
}

// ─── Existing-Codebase Maintenance Prompts ────────────────────────────────

/**
 * Full codebase audit prompt - used by /orchestrate-audit.
 * Spawned as parallel agents: bugs, security, tests, dead-code.
 */
export function auditAgentPrompt(
  focus: "bugs" | "security" | "tests" | "dead-code",
  profile: RepoProfile,
  files: string[],
  cwd: string,
  domainExtras?: string
): string {
  const fileList = files.length > 0
    ? `### Files in scope\n${files.map(f => `- ${f}`).join("\n")}`
    : `### Scope\nEntire codebase (all source files)`;

  const focusInstructions: Record<string, string> = {
    bugs: `You are a **bug hunter**. Find runtime bugs, logic errors, off-by-one errors, null dereferences, unhandled promise rejections, race conditions, and incorrect error handling.

For every issue:
- State the file and line range
- Explain the bug precisely
- Provide the minimal fix

Be exhaustive. If you find one bug, look for the same pattern in other files.`,

    security: `You are a **security auditor**. Find:
- Injection vulnerabilities (SQL, shell, path traversal)
- Missing input validation / sanitisation
- Hardcoded secrets or credentials
- Insecure defaults or missing auth checks
- Supply chain risks (unpinned deps, suspicious packages)
- Data exposure (logging PII, overly broad CORS, etc.)

For every finding: severity (critical/high/medium/low), file/line, description, fix.`,

    tests: `You are a **test coverage auditor**. Find:
- Public functions / exported symbols with no test
- Unhappy paths and edge cases missing from existing tests
- Integration points tested only via mocks (fragile)
- E2E workflows with no end-to-end test

For every gap: file, what's untested, suggested test description.`,

    "dead-code": `You are a **dead code detector**. Find:
- Exported symbols never imported anywhere
- Functions defined but never called
- Variables assigned but never read
- Commented-out code blocks left in place
- Feature flags / config options that can never be true
- TODO/FIXME comments that have been there a long time

For every item: file/line, what it is, safe-to-delete verdict.`,
  };

  return `${focusInstructions[focus]}

## Repository Context
Languages: ${profile.languages.join(", ") || "unknown"}
Frameworks: ${profile.frameworks.join(", ") || "none detected"}
${domainExtras ? `\n## Domain-Specific Checklist\n${domainExtras}` : ""}

${fileList}

## Output format
Return a JSON array of findings, then a markdown summary.

\`\`\`json
[
  {
    "severity": "critical|high|medium|low|info",
    "file": "src/foo.ts",
    "line": "42-55",
    "title": "Short title",
    "description": "What is wrong and why",
    "fix": "Minimal fix or suggestion"
  }
]
\`\`\`

After the JSON, write a brief prose summary (3-5 sentences) of the most important findings.

Use ultrathink. Be specific and exhaustive - vague findings are useless.

cd ${cwd}`;
}

/**
 * Targeted scan prompt - used by /orchestrate-scan.
 * Scoped to specific files/paths and one focus area.
 */
export function scanAgentPrompt(
  focus: string,
  files: string[],
  cwd: string,
  domainExtras?: string
): string {
  const fileList = files.map(f => `- ${f}`).join("\n");
  return `You are performing a **targeted code scan** focused on: **${focus}**

## Files to scan
${fileList}

${domainExtras ? `## Domain-specific checks\n${domainExtras}\n` : ""}## Instructions
1. Read every file in the list above carefully
2. Find all issues related to your focus area: ${focus}
3. For each issue: severity, file:line, title, description, suggested fix
4. After reviewing, search for the same patterns in neighbouring files not in the list
5. Be exhaustive - if you miss something, you break the safety net

## Output format
\`\`\`json
[
  {
    "severity": "critical|high|medium|low|info",
    "file": "src/foo.ts",
    "line": "42-55",
    "title": "Short title",
    "description": "What is wrong and why",
    "fix": "Minimal fix"
  }
]
\`\`\`

Follow the JSON with a 2-3 sentence summary of the most critical finding.

Use ultrathink.

cd ${cwd}`;
}

/**
 * Convert audit/scan findings into bead creation instructions.
 */
export function findingsToBeadsPrompt(
  findings: Array<{ severity: string; file: string; line: string; title: string; description: string; fix: string }>,
  cwd: string
): string {
  const priority = (sev: string) =>
    sev === "critical" ? "P0" : sev === "high" ? "P1" : sev === "medium" ? "P2" : "P3";

  const cmds = findings.map(f => {
    const safeTitle = f.title.replace(/"/g, "'").slice(0, 80);
    const safeDesc = `**File:** ${f.file}:${f.line}\n\n**Problem:** ${f.description}\n\n**Fix:** ${f.fix}\n\n### Files:\n${f.file}`;
    const escapedDesc = safeDesc.replace(/"/g, "'").replace(/\n/g, "\\n");
    return `br create --title "Fix: ${safeTitle}" --description "${escapedDesc}" --priority ${priority(f.severity)}`;
  }).join("\n\n");

  return `## Create Fix Beads

Run these commands to track each finding as a bead:

\`\`\`bash
cd ${cwd}

${cmds}

br sync --flush-only
git add .beads/ && git commit -m "chore: add fix beads from audit"
\`\`\`

After creating beads, call \`orch_approve_beads\` to review before implementing.`;
}
