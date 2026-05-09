import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { makeExec } from './exec.js';
import { createLogger } from './logger.js';
import { clearState, loadState, saveState } from './state.js';
import { runApprove } from './tools/approve.js';
import { runDiscover } from './tools/discover.js';
import { runDoctor } from './tools/doctor-tool.js';
import { runEmitCodex } from './tools/emit-codex.js';
import { runGetSkill } from './tools/get-skill.js';
import { runMemory } from './tools/memory-tool.js';
import { runPlan } from './tools/plan.js';
import { runProfile } from './tools/profile.js';
import { runReview } from './tools/review.js';
import { runSelect } from './tools/select.js';
import { runVerifyBeads } from './tools/verify-beads.js';
import { runComplianceAudit } from './tools/compliance-audit.js';
import { runAdvanceWave } from './tools/advance-wave.js';
import { runObserve } from './tools/observe.js';
import { runRemediate, RemediateInputSchema } from './tools/remediate.js';
import { runCalibrate, CalibrateInputSchema } from './tools/calibrate.js';
import { runConvergence } from './tools/convergence-tool.js';
import { runSynthesizeRubric } from './tools/synthesize-rubric.js';
import { runGradeOutcome } from './tools/grade-outcome.js';
import { runCapabilitiesWith } from './tools/capabilities.js';
import { runRobotDocs, ROBOT_DOCS_SECTIONS } from './tools/robot-docs.js';
import { makeToolError } from './tools/shared.js';
import { FlywheelError, makeFlywheelErrorResult } from './errors.js';
import { resolveRealpath } from './utils/path-safety.js';
import type {
  McpToolResult,
  FlywheelToolName,
  ToolContext,
} from './types.js';
import { VERSION } from './version.js';

const log = createLogger('server');

type ToolRunner = (ctx: ToolContext, args: any) => Promise<McpToolResult>;

type ToolRunnerMap = Partial<Record<FlywheelToolName, ToolRunner>>;

interface ToolValidationError {
  message: string;
  field?: string;
  reason: 'missing_required_parameter' | 'invalid_cwd' | 'invalid_enum_value';
}

interface CallToolHandlerDependencies {
  makeExec: typeof makeExec;
  loadState: typeof loadState;
  saveState: typeof saveState;
  clearState: typeof clearState;
  runners?: ToolRunnerMap;
}

const PRIMARY_TOOLS = [
  {
    name: 'flywheel_profile',
    description: 'Scan the current repository to collect its tech stack, structure, commits, TODOs, and key files. Returns a structured profile and discovery instructions. Call this first before any other flywheel tool.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        goal: { type: 'string', description: 'Optional initial goal to target discovery' },
        force: { type: 'boolean', description: 'Force a fresh scan, bypassing the profile cache' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_discover',
    description: 'Accept LLM-generated project ideas based on the repo profile. Call flywheel_profile first. Pass 5-15 structured ideas; this tool stores them and instructs you to call flywheel_select next.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        ideas: {
          type: 'array',
          description: '3-15 project ideas based on the repo profile',
          minItems: 3,
          maxItems: 15,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique kebab-case identifier' },
              title: { type: 'string', description: 'Short title' },
              description: { type: 'string', description: '2-3 sentence description' },
              category: {
                type: 'string',
                enum: ['feature', 'refactor', 'docs', 'dx', 'performance', 'reliability', 'security', 'testing'],
              },
              effort: { type: 'string', enum: ['low', 'medium', 'high'] },
              impact: { type: 'string', enum: ['low', 'medium', 'high'] },
              rationale: { type: 'string', description: 'Why this idea — cite repo evidence' },
              tier: { type: 'string', enum: ['top', 'honorable'] },
              sourceEvidence: { type: 'array', items: { type: 'string' } },
              scores: {
                type: 'object',
                properties: {
                  useful: { type: 'number' },
                  pragmatic: { type: 'number' },
                  accretive: { type: 'number' },
                  robust: { type: 'number' },
                  ergonomic: { type: 'number' },
                },
              },
              risks: { type: 'array', items: { type: 'string' } },
              synergies: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'title', 'description', 'category', 'effort', 'impact', 'rationale', 'tier'],
          },
        },
      },
      required: ['cwd', 'ideas'],
    },
  },
  {
    name: 'flywheel_select',
    description: 'Set the selected goal and transition to planning phase. After presenting ideas to the user (via conversation), call this with their chosen goal. Returns workflow instructions for plan-first, deep-plan, or direct-to-beads.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        goal: { type: 'string', description: 'The selected goal to pursue (from ideas or custom)' },
      },
      required: ['cwd', 'goal'],
    },
  },
  {
    name: 'flywheel_plan',
    description: 'Generate a plan document for the selected goal. mode=standard returns a planning prompt for a single plan. mode=deep returns configs for 3 parallel planning agents. mode=duel triggers /dueling-idea-wizards for adversarial 2-agent cross-scoring. Provide planFile (preferred) or planContent to register a completed plan and transition to bead creation.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        mode: {
          type: 'string',
          enum: ['standard', 'deep', 'duel'],
          default: 'standard',
          description: 'standard=single-model plan prompt, deep=multi-model angle agents, duel=/dueling-idea-wizards adversarial cross-scoring',
        },
        planFile: {
          type: 'string',
          description: 'Path (relative to cwd) of an already-written plan file on disk. Preferred over planContent for large plans — avoids passing large payloads over stdio.',
        },
        planContent: {
          type: 'string',
          description: 'Pre-synthesized plan content (inline). For large plans, write to disk first and use planFile instead to prevent stdio stalling.',
        },
        source: {
          type: 'string',
          enum: ['picked-up-existing-plan'],
          description: 'Provenance signal. Set to "picked-up-existing-plan" when registering a plan via the Step 0d "Pick up existing plan" route; this gates Step 5.45 (the Validate / Approve / Refine / Scrap menu) before bead creation. Omit for fresh plans coming out of /brainstorming, mode=deep, or mode=duel — those flow straight to Step 5.5.',
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_approve_beads',
    description: 'Review and approve bead graph before implementation. Reads beads from br CLI, computes convergence, and acts based on action parameter. Call after creating beads with br create.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        action: {
          type: 'string',
          enum: ['start', 'polish', 'reject', 'advanced', 'git-diff-review', 'remediate'],
          description: 'start=approve and launch implementation, polish=refine beads/plan, reject=stop, advanced=use advancedAction, git-diff-review=run git-diff style plan review cycle, remediate=create one bead from a failing outcome-grading criterion (T20).',
        },
        advancedAction: {
          type: 'string',
          enum: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
          description: 'Required when action=advanced. Selects the advanced refinement strategy.',
        },
        remediation: {
          type: 'object',
          description: 'Required when action=remediate. Carries the failing-criterion payload used by the §"Remediation Bead Template" body. T11 (_wrapup.md Step 9.5 Iterate) renders this from the failing PerCriterionVerdict + rubric.md.',
          properties: {
            planSlug: { type: 'string', description: 'Plan slug used to fill the verdict-file path in the bead body.' },
            iteration: { type: 'number', description: 'Iteration index from the verdict.' },
            criterionId: { type: 'string', description: 'Criterion id (e.g. c2).' },
            criterionDescription: { type: 'string', description: 'Criterion description from rubric.md.' },
            status: { type: 'string', enum: ['unmet', 'partial'], description: 'Verdict status for this criterion.' },
            evidence: { type: 'string', description: "Grader's evidence trace; quoted into the bead body unchanged." },
            gaps: {
              type: 'array',
              items: { type: 'string' },
              description: 'Gaps the grader flagged; rendered as bullet list in bead body.',
            },
          },
          required: ['planSlug', 'iteration', 'criterionId', 'criterionDescription', 'status', 'evidence', 'gaps'],
        },
        until_convergence_score: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Optional polish-bound (default 0.85). When action=polish and the in-state convergence score has already crossed this threshold, the call returns stop_reason="convergence_reached" instead of scheduling another polish round (bead 2p5).',
        },
        max_rounds: {
          type: 'integer',
          minimum: 1,
          description: 'Optional polish-bound (default 5). When action=polish and state.polishRound >= max_rounds, the call returns stop_reason="max_rounds_hit" instead of scheduling another polish round (bead 2p5).',
        },
      },
      required: ['cwd', 'action'],
    },
  },
  {
    name: 'flywheel_review',
    description: "Submit bead implementation for review. action=hit-me spawns parallel review agents (returns agent task specs for Claude Code to spawn). action=looks-good marks bead done and advances. action=skip defers the bead. Use beadId=__gates__ for guided review gates after all beads are done. mode dispatches the same reviewers into four shapes (interactive/autofix/report-only/headless) per bead agent-flywheel-plugin-f0j.",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        beadId: {
          type: 'string',
          description: "The bead being reviewed (from br list), or '__gates__' for guided review gates, or '__regress_to_plan__'/'__regress_to_beads__'/'__regress_to_implement__' for phase regression",
        },
        action: {
          type: 'string',
          enum: ['hit-me', 'looks-good', 'skip'],
          description: 'hit-me=spawn parallel review agents, looks-good=mark done and advance, skip=defer bead',
        },
        mode: {
          type: 'string',
          enum: ['autofix', 'report-only', 'headless', 'interactive'],
          default: 'interactive',
          description: 'Review-mode matrix. autofix=reviewers apply diffs + commit (gated behind green doctor + clean tree); report-only=reviewers write docs/reviews/<date>.md and exit; headless=CI-friendly exit-code signal per error count; interactive=AskUserQuestion per finding (default).',
        },
        parallelSafe: {
          type: 'boolean',
          default: false,
          description: 'Caller asserts reviewers can run in parallel without racing on the same files. Advisory flag only — does not disable the autofix gate.',
        },
      },
      required: ['cwd', 'beadId', 'action'],
    },
  },
  {
    name: 'flywheel_verify_beads',
    description: "Verify a wave of beads is closed; auto-close stragglers that have matching commits. Call after impl agents report back, before moving to the next wave. Returns {verified, autoClosed, unclosedNoCommit, errors}.",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        beadIds: {
          type: 'array',
          description: 'Bead IDs completed in this wave to reconcile',
          minItems: 1,
          items: { type: 'string' },
        },
      },
      required: ['cwd', 'beadIds'],
    },
  },
  {
    name: 'flywheel_compliance_audit',
    description:
      'Audit a wave of closed beads for compliance with their acceptance criteria via the standalone /beads-compliance-and-completion-verification skill. ' +
      'Returns per-bead scores; reopens false-closed beads; bumps telemetry; persists scores to CASS. ' +
      'Default mode is single-bead parallel (~5-10 min for 5 beads). Honors FW_COMPLIANCE_OVERRIDE env for emergency skip.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        beadIds: {
          type: 'array',
          description: 'Bead IDs in this wave to audit',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['single-bead', 'standard'],
          description: 'Audit mode (default: single-bead)',
        },
        threshold: {
          type: 'number',
          description: 'Score threshold below which a bead is false-closed (default: 700)',
        },
        parallelism: {
          type: 'number',
          description: 'Max parallel skill spawns (default: 5, max: 5)',
        },
        skipEnv: {
          type: 'string',
          description: 'Comma-separated bead IDs to skip; if any provided, audit is short-circuited',
        },
      },
      required: ['cwd', 'beadIds'],
    },
  },
  {
    name: 'flywheel_advance_wave',
    description: 'Verify a completed wave of beads, then read the next frontier and return dispatch-ready per-lane prompts. Combines verify → readyBeads → prompt rendering in one atomic call. Returns {verification, nextWave, waveComplete}.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        closedBeadIds: {
          type: 'array',
          description: 'Bead IDs from the wave that just completed — will be verified first',
          minItems: 1,
          items: { type: 'string' },
        },
        maxNextWave: {
          type: 'number',
          description: 'Max beads in the next wave (defaults to composition tier from swarm.ts)',
        },
      },
      required: ['cwd', 'closedBeadIds'],
    },
  },
  {
    name: 'flywheel_memory',
    description: 'Search and interact with CASS memory (cm CLI). Use to recall past decisions, gotchas, and patterns from prior flywheel runs. Requires cm CLI to be installed.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        query: { type: 'string', description: 'Search query for CASS memory' },
        operation: {
          type: 'string',
          enum: ['search', 'store', 'draft_postmortem', 'draft_solution_doc', 'refresh_learnings'],
          default: 'search',
          description: 'search=find entries, store=add new entry, draft_postmortem=synthesize a read-only session post-mortem draft (never auto-commits), draft_solution_doc=synthesize a docs/solutions/ entry paired with a CASS entry_id (read-only; caller writes the file), refresh_learnings=sweep docs/solutions/ and classify entries Keep/Update/Consolidate/Replace/Delete (read-only; caller archives)',
        },
        content: {
          type: 'string',
          description: 'Content to store (required when operation=store)',
        },
        entryId: {
          type: 'string',
          description: 'CASS entry id from a prior store call (required when operation=draft_solution_doc)',
        },
        refreshRoot: {
          type: 'string',
          description: 'Optional override for the docs/solutions/ root scanned by operation=refresh_learnings. Defaults to <cwd>/docs/solutions.',
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_doctor',
    description: 'Run an 11-check health sweep of the flywheel environment: MCP connectivity, agent-mail liveness, required/optional CLIs (br/bv/ntm/cm), node version, git status, dist drift, orphaned worktrees, and checkpoint validity. Read-only — never mutates checkpoint or state. Returns a DoctorReport with per-check severity (green/yellow/red).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_get_skill',
    description: 'Return a skill\'s frontmatter + body in one round-trip. Backed by a deterministic build-time bundle with 4-layer drift defense (manifest integrity check, per-entry stale warn, FW_SKILL_BUNDLE=off bypass, transparent disk fallback). Pass name as `<plugin>:<skill-name>` (e.g. `agent-flywheel:start`, `agent-flywheel:start_planning`). Returns `{ name, frontmatter, body, source: "bundle"|"disk", staleWarn? }`.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        name: {
          type: 'string',
          description: 'Skill identifier in `<plugin>:<skill-name>` form, e.g. `agent-flywheel:start`.',
          pattern: '^[a-z0-9_-]+:[a-z0-9_-]+$',
        },
      },
      required: ['cwd', 'name'],
    },
  },
  {
    name: 'flywheel_calibrate',
    description: 'Aggregate closed-bead actual vs estimated durations per template. Prefers git first-commit ts as work-start proxy (capped at 200 git calls/run; falls back to created_ts when over cap or no commit). Drops samples with clock-skew. Writes report to .pi-flywheel/calibration.json and returns it.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        sinceDays: {
          type: 'number',
          description: 'Filter to beads created within this many days (1-365, default 90)',
          minimum: 1,
          maximum: 365,
          default: 90,
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_observe',
    description: 'Single-call read-only session-state snapshot. Aggregates checkpoint, beads, agent-mail, ntm, git, WIZARD artifacts, and a cached doctor verdict (60s TTL) into one structured envelope. Idempotent + non-mutating; designed for fast session recovery without staging multiple round-trips. Wall-clock budget < 1.5s; degraded probes mark their sub-section as `unavailable: true`.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_remediate',
    description: 'Apply the canonical fix for a failing doctor check. Default mode is dry_run; pass mode:\'execute\' + autoConfirm:true to actually mutate. Per-check mutex prevents concurrent calls.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        checkName: {
          type: 'string',
          enum: [
            'mcp_connectivity', 'agent_mail_liveness', 'br_binary', 'bv_binary',
            'ntm_binary', 'cm_binary', 'node_version', 'git_status', 'dist_drift',
            'orphaned_worktrees', 'checkpoint_validity', 'claude_cli', 'codex_cli',
            'gemini_cli', 'swarm_model_ratio', 'codex_config_compat', 'rescues_last_30d',
          ],
          description: 'The doctor check name to remediate',
        },
        autoConfirm: {
          type: 'boolean',
          default: false,
          description: 'Required to be true when mode=execute and the remediation is mutating',
        },
        mode: {
          type: 'string',
          enum: ['dry_run', 'execute'],
          default: 'dry_run',
          description: 'dry_run=return plan only, execute=apply the fix',
        },
      },
      required: ['cwd', 'checkName'],
    },
  },
  {
    name: 'flywheel_convergence',
    description:
      'Read the persisted convergence state for a plan slug from .pi-flywheel/plans/<slug>/convergence.json. Returns { tool, version: 1, status: "ok" | "not_found" | "error", data: ConvergenceState | null }. Pure read; never mutates. Status "error" with code "score_version_mismatch" signals the on-disk state was written by a different scoreVersion and must be recomputed before use.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        planSlug: {
          type: 'string',
          description:
            'Plan slug or original plan path. Slugified to a filesystem-safe directory name; same slug used by writers.',
        },
      },
      required: ['cwd', 'planSlug'],
    },
  },
  // ─── v3.13.0 outcome-grading tools (T9 / claude-orchestrator-zbe) ───
  {
    name: 'flywheel_synthesize_rubric',
    description:
      'Synthesize / validate / edit / regenerate the cycle-level outcome rubric at .pi-flywheel/plans/<slug>/rubric.md. Called from skills/start/_planning.md Step 5.6 after the plan-ready gate fires. Discriminator on success: kind ∈ { rubric_synthesized, rubric_preserved (cache hit on edited/user source), rubric_edited (action=edit), rubric_validated (action=validate) }. Errors surface FlywheelErrorCode envelopes (rubric_synth_invalid, rubric_missing, invalid_input).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        planSlug: {
          type: 'string',
          description:
            'Plan slug. Optional; falls back to slugifying state.outcomeRubricPath / planPath / state.planDocument.',
        },
        planPath: {
          type: 'string',
          description: 'Path to the plan markdown (relative to cwd or absolute). Required for synthesize/regenerate when state.planDocument is unset.',
        },
        action: {
          type: 'string',
          enum: ['synthesize', 'validate', 'edit', 'regenerate'],
          default: 'synthesize',
          description:
            'synthesize=spawn synthesizer (cache + edited-source guard); validate=parse current rubric.md; edit=apply editIntent; regenerate=force=true synth (overrides edited-source guard).',
        },
        editIntent: {
          type: 'object',
          description: 'Required when action=edit. Tighten/add/remove are deterministic transforms; custom routes through the LLM.',
          properties: {
            kind: { type: 'string', enum: ['tighten', 'add', 'remove', 'custom'] },
            text: { type: 'string', description: 'Free-form instruction or single criterion text.' },
          },
          required: ['kind', 'text'],
        },
        force: {
          type: 'boolean',
          description: 'Bypass the planContentSha cache and the edited-source guard. Equivalent to action=regenerate.',
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_grade_outcome',
    description:
      'Grade the cycle outcome with a model strictly decorrelated from the impl swarm — codex primary, fresh-CC fallback. Called from skills/start/_wrapup.md Step 9.5 before commit review. Reads state.outcomeRubricPath; short-circuits to kind=grading_skipped when state.outcomeGradingSkipped is true. Persists verdict to .pi-flywheel/plans/<slug>/grading/iteration-<N>.json. Discriminator on success: kind ∈ { grader_verdict, grading_skipped, grading_capped (max_iterations_reached server-side coerced), grading_persistence_failed (verdict in-memory; disk write failed) }.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (absolute path)' },
        planSlug: {
          type: 'string',
          description: 'Plan slug. Optional; defaults to slugifying state.outcomeRubricPath.',
        },
        force: {
          type: 'boolean',
          description: 'Bypass the iteration-N.json-exists guard and the in-memory mutex.',
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_capabilities',
    description:
      'Read-only contract surface for the flywheel MCP server. Returns the full mcp_tools list (with required/optional fields and enum values), the doctor_check_names enum, every error_code with its default hint and retryable flag, the env_var dictionary, and the exit_code_contract — all in a single call so agents can pin contract_version and discover valid actions without grepping source. Snapshot-pinned via R-001 regression test. cwd is accepted for dispatch consistency but the tool ignores it (output is a stateless server-snapshot).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (accepted for dispatch consistency; not used)' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'flywheel_robot_docs',
    description:
      'Paste-ready agent handbook returned in a single call. Sections: getting_started, common_workflows, error_codes_decoder, dangerous_ops_safe_alt, exit_code_contract, capabilities_pointer. Default section="all" returns every section as one markdown blob. Use this instead of reading AGENTS.md (42 KB) every session. For machine-readable enums (error codes, env vars, etc.) call flywheel_capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory (accepted for dispatch consistency; not used)' },
        section: {
          type: 'string',
          enum: [...ROBOT_DOCS_SECTIONS, 'all'],
          default: 'all',
          description: 'Which section to return; "all" returns every section concatenated as markdown',
        },
      },
      required: ['cwd'],
    },
  },
];

/**
 * Deprecated `orch_*` aliases for each primary `flywheel_*` tool.
 * Kept for back-compat with legacy client installs — will be removed in v4.0.
 */
const DEPRECATED_ALIAS_TOOLS = PRIMARY_TOOLS.map((tool) => {
  const aliasName = tool.name.replace(/^flywheel_/, 'orch_');
  return {
    ...tool,
    name: aliasName,
    description: `[DEPRECATED — use ${tool.name} instead; removed in v4.0] ${tool.description}`,
  };
});

export const TOOLS = [...PRIMARY_TOOLS, ...DEPRECATED_ALIAS_TOOLS];

const DEFAULT_RUNNERS: Record<FlywheelToolName, ToolRunner> = {
  flywheel_profile: runProfile as ToolRunner,
  flywheel_discover: runDiscover as ToolRunner,
  flywheel_select: runSelect as ToolRunner,
  flywheel_plan: runPlan as ToolRunner,
  flywheel_approve_beads: runApprove as ToolRunner,
  flywheel_review: runReview as ToolRunner,
  flywheel_verify_beads: runVerifyBeads as ToolRunner,
  flywheel_compliance_audit: runComplianceAudit as ToolRunner,
  flywheel_advance_wave: runAdvanceWave as ToolRunner,
  flywheel_memory: runMemory as ToolRunner,
  flywheel_doctor: runDoctor as ToolRunner,
  flywheel_get_skill: runGetSkill as ToolRunner,
  flywheel_observe: runObserve as ToolRunner,
  // Deprecated orch_* aliases — dispatch to the same runners. Removed in v4.0.
  orch_profile: runProfile as ToolRunner,
  orch_discover: runDiscover as ToolRunner,
  orch_select: runSelect as ToolRunner,
  orch_plan: runPlan as ToolRunner,
  orch_approve_beads: runApprove as ToolRunner,
  orch_review: runReview as ToolRunner,
  orch_verify_beads: runVerifyBeads as ToolRunner,
  orch_compliance_audit: runComplianceAudit as ToolRunner,
  orch_advance_wave: runAdvanceWave as ToolRunner,
  orch_memory: runMemory as ToolRunner,
  orch_get_skill: runGetSkill as ToolRunner,
  orch_observe: runObserve as ToolRunner,
};

/**
 * Extension runners — tools added by beads that don't (or can't) widen
 * `FlywheelToolName` in types.ts. Keyed by raw string so the registration
 * doesn't require touching the shared union.
 *
 * bead `agent-flywheel-plugin-zbx` — `flywheel_emit_codex`.
 * bead `claude-orchestrator-2tl` (T8) — `flywheel_remediate` + `orch_remediate` alias.
 */
const EXTENSION_RUNNERS: Record<string, ToolRunner> = {
  flywheel_emit_codex: runEmitCodex as ToolRunner,
  flywheel_remediate: async (ctx, args) => {
    const parsed = RemediateInputSchema.parse(args);
    return runRemediate(parsed, ctx.exec, ctx.signal ?? new AbortController().signal) as Promise<McpToolResult>;
  },
  orch_remediate: async (ctx, args) => {
    const parsed = RemediateInputSchema.parse(args);
    return runRemediate(parsed, ctx.exec, ctx.signal ?? new AbortController().signal) as Promise<McpToolResult>;
  },
  flywheel_calibrate: async (ctx, args) => {
    const parsed = CalibrateInputSchema.parse({ ...args, cwd: ctx.cwd });
    return runCalibrate(parsed, ctx.exec, ctx.signal ?? new AbortController().signal) as unknown as Promise<McpToolResult>;
  },
  orch_calibrate: async (ctx, args) => {
    const parsed = CalibrateInputSchema.parse({ ...args, cwd: ctx.cwd });
    return runCalibrate(parsed, ctx.exec, ctx.signal ?? new AbortController().signal) as unknown as Promise<McpToolResult>;
  },
  flywheel_convergence: async (ctx, args) => {
    return runConvergence(ctx, {
      cwd: ctx.cwd,
      planSlug: (args as { planSlug?: string }).planSlug ?? '',
    });
  },
  // v3.13.0 outcome-grading (T9).
  flywheel_synthesize_rubric: async (ctx, args) => runSynthesizeRubric(ctx, args) as Promise<McpToolResult>,
  flywheel_grade_outcome: async (ctx, args) => runGradeOutcome(ctx, args) as Promise<McpToolResult>,
  // R-001 (agent-ergonomics audit pass 2) — capabilities surface.
  flywheel_capabilities: runCapabilitiesWith(TOOLS),
  orch_capabilities: runCapabilitiesWith(TOOLS),
  // R-002 (agent-ergonomics audit pass 2) — paste-ready agent handbook.
  flywheel_robot_docs: runRobotDocs as ToolRunner,
  orch_robot_docs: runRobotDocs as ToolRunner,
};

function isKnownToolName(name: string): name is FlywheelToolName {
  return TOOLS.some((tool) => tool.name === name);
}

export function validateToolArgs(toolName: string, args: Record<string, unknown>): ToolValidationError | null {
  const tool = TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return null;
  }

  if ('cwd' in args && (typeof args.cwd !== 'string' || args.cwd.trim() === '')) {
    return {
      message: `Error: 'cwd' must be a non-empty string, got ${JSON.stringify(args.cwd)}.`,
      field: 'cwd',
      reason: 'invalid_cwd',
    };
  }

  const required: string[] = (tool.inputSchema as { required?: string[] }).required ?? [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      return {
        message: `Error: required parameter '${field}' is missing for tool '${toolName}'.`,
        field,
        reason: 'missing_required_parameter',
      };
    }

    if (field === 'cwd' && (typeof args[field] !== 'string' || args[field].trim() === '')) {
      return {
        message: `Error: 'cwd' must be a non-empty string, got ${JSON.stringify(args[field])}.`,
        field,
        reason: 'invalid_cwd',
      };
    }
  }

  // P-001 (pass-5 second-order finding) — enum check.
  //
  // Pre-P-001: enums declared in inputSchema were only enforced inside
  // each tool's runner, AFTER dispatch. A bad enum value (e.g.
  // flywheel_review action:"review" instead of "hit-me") would slip
  // through validation, hit the runner's required-field check, and
  // surface a message about the WRONG field ("beadId is required")
  // because the runner aborted on the first per-field check it ran
  // before reaching the enum branch. Discovered by the pass-5
  // simulation transcript.
  //
  // Post-P-001: any property declaring an `enum` array is checked here.
  // Failure surfaces the field name, the rejected value, and the valid
  // values — agents get the corrected invocation in one round-trip.
  const properties =
    ((tool.inputSchema as unknown as { properties?: Record<string, { enum?: unknown[] }> }).properties ?? {});
  for (const [field, rawSchema] of Object.entries(properties)) {
    const schema = rawSchema as { enum?: unknown[] };
    if (!Array.isArray(schema?.enum) || schema.enum.length === 0) continue;
    if (!(field in args)) continue;
    const value = args[field];
    if (value === undefined || value === null) continue;
    if (schema.enum.includes(value)) continue;
    const validList = schema.enum.map((v) => JSON.stringify(v)).join(', ');
    return {
      message: `Error: '${field}' must be one of [${validList}] for tool '${toolName}'; got ${JSON.stringify(value)}.`,
      field,
      reason: 'invalid_enum_value',
    };
  }

  return null;
}

function makeValidationErrorResult(toolName: string, validationError: ToolValidationError): McpToolResult {
  if (isKnownToolName(toolName)) {
    // P-001 — branch hint by validation reason. invalid_enum_value points
    // straight at flywheel_capabilities so agents can read the valid list
    // without source grep.
    let hint: string;
    switch (validationError.reason) {
      case 'invalid_cwd':
        hint = 'Pass `cwd` as a non-empty absolute path to the project working directory.';
        break;
      case 'invalid_enum_value':
        hint = `'${validationError.field ?? ''}' was not in the documented enum — call flywheel_capabilities and read mcp_tools[name='${toolName}'].enums for the valid set.`;
        break;
      default:
        hint = `Supply the required parameter '${validationError.field ?? ''}' and retry.`;
    }
    return makeToolError(toolName, 'idle', 'invalid_input', validationError.message, {
      retryable: false,
      hint,
      details: {
        field: validationError.field,
        reason: validationError.reason,
      },
    });
  }

  return {
    content: [{ type: 'text', text: validationError.message }],
    isError: true,
  };
}

function makeCwdResolutionErrorResult(
  toolName: FlywheelToolName,
  reason: 'invalid_input' | 'not_found',
  message: string,
  details: Record<string, unknown>,
): McpToolResult {
  return makeToolError(toolName, 'idle', reason, message, {
    retryable: false,
    hint:
      reason === 'not_found'
        ? 'Pass an existing project directory. Symlinks are resolved via realpath before tool execution.'
        : 'Pass a readable project directory. Symlinks are resolved via realpath before tool execution.',
    details,
  });
}

/**
 * One-shot orch_* deprecation warning emitter (bead 3ef).
 *
 * Fires the first time any given orch_* alias is invoked in a server's
 * lifetime. Subsequent calls are no-ops so a long-running server doesn't
 * spam its log with the same warning every minute.
 *
 * Exported for tests; internal callers should NOT depend on this directly.
 */
const _orchDeprecationWarned = new Set<string>();

export function emitOrchDeprecationWarning(toolName: string): boolean {
  if (!toolName.startsWith('orch_')) return false;
  if (_orchDeprecationWarned.has(toolName)) return false;
  _orchDeprecationWarned.add(toolName);
  const canonical = toolName.replace(/^orch_/, 'flywheel_');
  log.warn('orch_* MCP namespace deprecated', {
    code: 'orch_deprecation_warned',
    deprecated: toolName,
    use: canonical,
    removedIn: 'v4.0',
    migration:
      `Replace ${toolName}({...}) with ${canonical}({...}) — same input/output shape.`,
  });
  return true;
}

/** Test-only — reset the once-per-tool warning ledger. */
export function _resetOrchDeprecationLedger(): void {
  _orchDeprecationWarned.clear();
}

export function createCallToolHandler(dependencies: CallToolHandlerDependencies) {
  const runners: Record<FlywheelToolName, ToolRunner> = {
    ...DEFAULT_RUNNERS,
    ...dependencies.runners,
  };
  // Extension tools (bead `agent-flywheel-plugin-zbx`): merged via a wider
  // string-keyed map so we can dispatch tools whose names aren't part of the
  // `FlywheelToolName` union. Runtime safety is still enforced by
  // `isKnownToolName`, which checks the TOOLS array.
  const extensionRunners: Record<string, ToolRunner> = { ...EXTENSION_RUNNERS };

  return async (request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<McpToolResult> => {
    const { name, arguments: args } = request.params;
    const normalizedArgs = (args ?? {}) as Record<string, unknown>;
    const validationError = validateToolArgs(name, normalizedArgs);

    if (validationError) {
      return makeValidationErrorResult(name, validationError);
    }

    if (!isKnownToolName(name)) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const rawCwd = normalizedArgs.cwd as string;
    const resolvedCwd = resolveRealpath(rawCwd, { label: 'cwd' });
    if (!resolvedCwd.ok) {
      return makeCwdResolutionErrorResult(
        name,
        resolvedCwd.reason === 'not_found' ? 'not_found' : 'invalid_input',
        resolvedCwd.message,
        {
          cwd: rawCwd,
          absolutePath: resolvedCwd.absolutePath,
          reason: resolvedCwd.reason,
        },
      );
    }
    const cwd = resolvedCwd.realPath;
    const runnerArgs = { ...normalizedArgs, cwd };
    const exec = dependencies.makeExec(cwd);
    const state = dependencies.loadState(cwd);
    const ac = new AbortController();
    const ctx: ToolContext = {
      exec,
      cwd,
      state,
      saveState: (nextState) => dependencies.saveState(cwd, nextState),
      clearState: () => dependencies.clearState(cwd),
      signal: ac.signal,
    };

    try {
      const runner = runners[name] ?? extensionRunners[name as string];
      if (!runner) {
        return {
          content: [{ type: 'text', text: `No runner registered for tool: ${name}` }],
          isError: true,
        };
      }
      // Deprecation warning for orch_* aliases (bead 3ef). The aliases keep
      // working — this is the deprecation window, not removal — but each
      // call logs once per tool so operators see they should migrate to
      // flywheel_*. Removed in v4.0; tracked via `orch_deprecation_warned`
      // so the log stays one-shot per tool per server lifetime.
      if (name.startsWith('orch_')) {
        emitOrchDeprecationWarning(name);
      }
      return await runner(ctx, runnerArgs);
    } catch (err: unknown) {
      if (err instanceof FlywheelError) {
        return makeFlywheelErrorResult(name, state.phase, {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          hint: err.hint,
          cause: err.cause,
          details: err.details,
        });
      }
      log.error('Tool error', { tool: name, err: String(err) });
      return makeFlywheelErrorResult(name, state.phase, {
        code: 'internal_error',
        message: `Error in ${name}: ${(err as Error)?.message ?? String(err)}`,
        retryable: true,
        hint: 'Unexpected server error — retry once, then run flywheel_doctor or set FW_LOG_LEVEL=debug to capture root cause.',
        cause: String(err),
      });
    }
  };
}

export function createServer(): Server {
  const server = new Server(
    { name: 'agent-flywheel', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(
    CallToolRequestSchema,
    createCallToolHandler({
      makeExec,
      loadState,
      saveState,
      clearState,
    })
  );

  return server;
}

export const server = createServer();

if (
  process.argv[1] !== undefined &&
  process.argv[1] !== null &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started');
}
