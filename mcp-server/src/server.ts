import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { makeExec } from './exec.js';
import { createLogger } from './logger.js';
import { clearState, loadState, saveState } from './state.js';
import { runApprove } from './tools/approve.js';
import { runDiscover } from './tools/discover.js';
import { runMemory } from './tools/memory-tool.js';
import { runPing } from './tools/ping.js';
import { runPlan } from './tools/plan.js';
import { runProfile } from './tools/profile.js';
import { runReview } from './tools/review.js';
import { runSelect } from './tools/select.js';
import { runVerifyBeads } from './tools/verify-beads.js';
import { makeToolError } from './tools/shared.js';
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
  reason: 'missing_required_parameter' | 'invalid_cwd';
}

interface CallToolHandlerDependencies {
  makeExec: typeof makeExec;
  loadState: typeof loadState;
  saveState: typeof saveState;
  clearState: typeof clearState;
  runners?: ToolRunnerMap;
}

export const TOOLS = [
  {
    name: 'flywheel_ping',
    description: 'Health check for the agent-flywheel MCP server. Returns a pong response with the server name, version, and current timestamp. Requires no arguments. Call this to verify the server is alive before running other flywheel tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
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
    description: 'Generate a plan document for the selected goal. mode=standard returns a planning prompt for a single plan. mode=deep returns configs for 3 parallel planning agents. Provide planFile (preferred) or planContent to register a completed plan and transition to bead creation.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        mode: {
          type: 'string',
          enum: ['standard', 'deep'],
          default: 'standard',
          description: 'standard=single-model plan prompt, deep=multi-model agent configs',
        },
        planFile: {
          type: 'string',
          description: 'Path (relative to cwd) of an already-written plan file on disk. Preferred over planContent for large plans — avoids passing large payloads over stdio.',
        },
        planContent: {
          type: 'string',
          description: 'Pre-synthesized plan content (inline). For large plans, write to disk first and use planFile instead to prevent stdio stalling.',
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
          enum: ['start', 'polish', 'reject', 'advanced', 'git-diff-review'],
          description: 'start=approve and launch implementation, polish=refine beads/plan, reject=stop, advanced=use advancedAction, git-diff-review=run git-diff style plan review cycle',
        },
        advancedAction: {
          type: 'string',
          enum: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
          description: 'Required when action=advanced. Selects the advanced refinement strategy.',
        },
      },
      required: ['cwd', 'action'],
    },
  },
  {
    name: 'flywheel_review',
    description: "Submit bead implementation for review. action=hit-me spawns parallel review agents (returns agent task specs for Claude Code to spawn). action=looks-good marks bead done and advances. action=skip defers the bead. Use beadId=__gates__ for guided review gates after all beads are done.",
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
    name: 'flywheel_memory',
    description: 'Search and interact with CASS memory (cm CLI). Use to recall past decisions, gotchas, and patterns from prior flywheel runs. Requires cm CLI to be installed.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project working directory' },
        query: { type: 'string', description: 'Search query for CASS memory' },
        operation: {
          type: 'string',
          enum: ['search', 'store'],
          default: 'search',
          description: 'search=find entries, store=add new entry',
        },
        content: {
          type: 'string',
          description: 'Content to store (required when operation=store)',
        },
      },
      required: ['cwd'],
    },
  },
];

const DEFAULT_RUNNERS: Record<FlywheelToolName, ToolRunner> = {
  flywheel_ping: () => runPing(),
  flywheel_profile: runProfile as ToolRunner,
  flywheel_discover: runDiscover as ToolRunner,
  flywheel_select: runSelect as ToolRunner,
  flywheel_plan: runPlan as ToolRunner,
  flywheel_approve_beads: runApprove as ToolRunner,
  flywheel_review: runReview as ToolRunner,
  flywheel_verify_beads: runVerifyBeads as ToolRunner,
  flywheel_memory: runMemory as ToolRunner,
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

  return null;
}

function makeValidationErrorResult(toolName: string, validationError: ToolValidationError): McpToolResult {
  if (isKnownToolName(toolName)) {
    return makeToolError(toolName, 'idle', 'invalid_input', validationError.message, {
      retryable: false,
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

export function createCallToolHandler(dependencies: CallToolHandlerDependencies) {
  const runners: Record<FlywheelToolName, ToolRunner> = {
    ...DEFAULT_RUNNERS,
    ...dependencies.runners,
  };

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

    // flywheel_ping is cwd-free — bypass the state/exec setup entirely
    if (name === 'flywheel_ping') {
      return runPing();
    }

    const cwd = normalizedArgs.cwd as string;
    const exec = dependencies.makeExec(cwd);
    const state = dependencies.loadState(cwd);
    const ctx: ToolContext = {
      exec,
      cwd,
      state,
      saveState: (nextState) => dependencies.saveState(cwd, nextState),
      clearState: () => dependencies.clearState(cwd),
    };

    try {
      return await runners[name](ctx, normalizedArgs);
    } catch (err: unknown) {
      log.error('Tool error', { tool: name, err: String(err) });
      return makeToolError(
        name,
        state.phase,
        'internal_error',
        `Error in ${name}: ${(err as Error)?.message ?? String(err)}`,
        { retryable: true }
      );
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

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started');
}
