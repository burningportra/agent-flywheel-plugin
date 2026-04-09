import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeExec } from './exec.js';
import { loadState, saveState, clearState } from './state.js';
import { runProfile } from './tools/profile.js';
import { runDiscover } from './tools/discover.js';
import { runSelect } from './tools/select.js';
import { runPlan } from './tools/plan.js';
import { runApprove } from './tools/approve.js';
import { runReview } from './tools/review.js';
import { runMemory } from './tools/memory-tool.js';

const server = new Server(
  { name: "claude-orchestrator", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────

const TOOLS = [
  {
    name: "orch_profile",
    description: "Scan the current repository to collect its tech stack, structure, commits, TODOs, and key files. Returns a structured profile and discovery instructions. Call this first before any other orchestration tool.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory (absolute path)" },
        goal: { type: "string", description: "Optional initial goal to target discovery" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "orch_discover",
    description: "Accept LLM-generated project ideas based on the repo profile. Call orch_profile first. Pass 5-15 structured ideas; this tool stores them and instructs you to call orch_select next.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        ideas: {
          type: "array",
          description: "3-15 project ideas based on the repo profile",
          minItems: 3,
          maxItems: 15,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique kebab-case identifier" },
              title: { type: "string", description: "Short title" },
              description: { type: "string", description: "2-3 sentence description" },
              category: {
                type: "string",
                enum: ["feature", "refactor", "docs", "dx", "performance", "reliability", "security", "testing"],
              },
              effort: { type: "string", enum: ["low", "medium", "high"] },
              impact: { type: "string", enum: ["low", "medium", "high"] },
              rationale: { type: "string", description: "Why this idea — cite repo evidence" },
              tier: { type: "string", enum: ["top", "honorable"] },
              sourceEvidence: { type: "array", items: { type: "string" } },
              scores: {
                type: "object",
                properties: {
                  useful: { type: "number" },
                  pragmatic: { type: "number" },
                  accretive: { type: "number" },
                  robust: { type: "number" },
                  ergonomic: { type: "number" },
                },
              },
              risks: { type: "array", items: { type: "string" } },
              synergies: { type: "array", items: { type: "string" } },
            },
            required: ["id", "title", "description", "category", "effort", "impact", "rationale", "tier"],
          },
        },
      },
      required: ["cwd", "ideas"],
    },
  },
  {
    name: "orch_select",
    description: "Set the selected goal and transition to planning phase. After presenting ideas to the user (via conversation), call this with their chosen goal. Returns workflow instructions for plan-first, deep-plan, or direct-to-beads.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        goal: { type: "string", description: "The selected goal to pursue (from ideas or custom)" },
      },
      required: ["cwd", "goal"],
    },
  },
  {
    name: "orch_plan",
    description: "Generate a plan document for the selected goal. mode=standard returns a planning prompt for a single plan. mode=deep returns configs for 3 parallel planning agents. Provide planFile (preferred) or planContent to register a completed plan and transition to bead creation.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        mode: {
          type: "string",
          enum: ["standard", "deep"],
          default: "standard",
          description: "standard=single-model plan prompt, deep=multi-model agent configs",
        },
        planFile: {
          type: "string",
          description: "Path (relative to cwd) of an already-written plan file on disk. Preferred over planContent for large plans — avoids passing large payloads over stdio.",
        },
        planContent: {
          type: "string",
          description: "Pre-synthesized plan content (inline). For large plans, write to disk first and use planFile instead to prevent stdio stalling.",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "orch_approve_beads",
    description: "Review and approve bead graph before implementation. Reads beads from br CLI, computes convergence, and acts based on action parameter. Call after creating beads with br create.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        action: {
          type: "string",
          enum: ["start", "polish", "reject", "advanced", "git-diff-review"],
          description: "start=approve and launch implementation, polish=refine beads/plan, reject=stop, advanced=use advancedAction, git-diff-review=run git-diff style plan review cycle",
        },
        advancedAction: {
          type: "string",
          enum: ["fresh-agent", "same-agent", "blunder-hunt", "dedup", "cross-model", "graph-fix"],
          description: "Required when action=advanced. Selects the advanced refinement strategy.",
        },
      },
      required: ["cwd", "action"],
    },
  },
  {
    name: "orch_review",
    description: "Submit bead implementation for review. action=hit-me spawns parallel review agents (returns agent task specs for Claude Code to spawn). action=looks-good marks bead done and advances. action=skip defers the bead. Use beadId=__gates__ for guided review gates after all beads are done.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        beadId: {
          type: "string",
          description: "The bead being reviewed (from br list), or '__gates__' for guided review gates, or '__regress_to_plan__'/'__regress_to_beads__'/'__regress_to_implement__' for phase regression",
        },
        action: {
          type: "string",
          enum: ["hit-me", "looks-good", "skip"],
          description: "hit-me=spawn parallel review agents, looks-good=mark done and advance, skip=defer bead",
        },
      },
      required: ["cwd", "beadId", "action"],
    },
  },
  {
    name: "orch_memory",
    description: "Search and interact with CASS memory (cm CLI). Use to recall past decisions, gotchas, and patterns from prior orchestration runs. Requires cm CLI to be installed.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        query: { type: "string", description: "Search query for CASS memory" },
        operation: {
          type: "string",
          enum: ["search", "store"],
          default: "search",
          description: "search=find entries, store=add new entry",
        },
        content: {
          type: "string",
          description: "Content to store (required when operation=store)",
        },
      },
      required: ["cwd"],
    },
  },
];

// ─── Request handlers ─────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const cwd = (args as any)?.cwd as string;

  if (!cwd) {
    return {
      content: [{ type: "text", text: "Error: cwd parameter is required for all tools." }],
      isError: true,
    };
  }

  const exec = makeExec(cwd);
  const state = loadState(cwd);
  const ctx = {
    exec,
    cwd,
    state,
    saveState: (s: typeof state) => saveState(cwd, s),
    clearState: () => clearState(cwd),
  };

  try {
    switch (name) {
      case "orch_profile":
        return await runProfile(ctx, args as any);
      case "orch_discover":
        return await runDiscover(ctx, args as any);
      case "orch_select":
        return await runSelect(ctx, args as any);
      case "orch_plan":
        return await runPlan(ctx, args as any);
      case "orch_approve_beads":
        return await runApprove(ctx, args as any);
      case "orch_review":
        return await runReview(ctx, args as any);
      case "orch_memory":
        return await runMemory(ctx, args as any);
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    console.error(`[claude-orchestrator] Tool ${name} error:`, err);
    return {
      content: [{ type: "text", text: `Error in ${name}: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  }
});

// ─── Start server ─────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[claude-orchestrator] MCP server started");
