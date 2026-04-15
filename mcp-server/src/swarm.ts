/**
 * Swarm Launcher & Configuration
 *
 * Agent composition, staggered launch, status formatting,
 * and SwarmTender monitoring integration.
 */

import { swarmMarchingOrders, SWARM_STAGGER_DELAY_MS, SWARM_MODELS, CODEX_SUBAGENT_TYPE } from "./prompts.js";
import type { Bead } from "./types.js";
import type { AgentStatus } from "./tender.js";

// ─── Types ──────────────────────────────────────────────────

export interface SwarmAgentConfig {
  /** Display name for the agent. */
  name: string;
  /** Marching orders prompt. */
  task: string;
  /** Optional model override (CC model shorthand, e.g. "opus", "sonnet"). */
  model?: string;
  /** Optional CC subagent_type override (takes precedence over model). */
  subagent_type?: string;
  /** Working directory. */
  cwd: string;
  /** Delay before spawning (ms) — for staggered starts. */
  delayMs: number;
}

export interface SwarmComposition {
  /** Total agent count. */
  total: number;
  /** Recommended model distribution. */
  models: Array<{ model: string; count: number }>;
  /** Reasoning for the recommendation. */
  rationale: string;
}

// ─── Agent Composition ──────────────────────────────────────

/** Recommend agent composition based on open bead count. */
export function recommendComposition(openBeadCount: number): SwarmComposition {
  if (openBeadCount >= 400) {
    return {
      total: 10,
      models: [
        { model: SWARM_MODELS.opus, count: 4 },
        { model: SWARM_MODELS.codex, count: 4 },
        { model: SWARM_MODELS.haiku, count: 2 },
      ],
      rationale: `${openBeadCount} open beads — large project, full swarm recommended`,
    };
  }
  if (openBeadCount >= 100) {
    return {
      total: 8,
      models: [
        { model: SWARM_MODELS.opus, count: 3 },
        { model: SWARM_MODELS.codex, count: 3 },
        { model: SWARM_MODELS.haiku, count: 2 },
      ],
      rationale: `${openBeadCount} open beads — medium project, moderate swarm`,
    };
  }
  return {
    total: 3,
    models: [
      { model: SWARM_MODELS.opus, count: 1 },
      { model: SWARM_MODELS.codex, count: 1 },
      { model: SWARM_MODELS.haiku, count: 1 },
    ],
    rationale: `${openBeadCount} open beads — small project, minimal swarm`,
  };
}

// ─── Agent Config Generation ────────────────────────────────

/**
 * Generate agent configurations for the swarm.
 * Each agent gets staggered delay and marching orders.
 */
export function generateAgentConfigs(
  count: number,
  cwd: string,
  composition: SwarmComposition
): SwarmAgentConfig[] {
  const configs: SwarmAgentConfig[] = [];

  // Distribute models across agents according to composition
  const modelQueue: string[] = [];
  for (const { model, count: modelCount } of composition.models) {
    for (let i = 0; i < modelCount; i++) {
      modelQueue.push(model);
    }
  }

  for (let i = 0; i < count; i++) {
    const model = modelQueue[i % modelQueue.length];
    const isCodex = model === SWARM_MODELS.codex;
    const modelShort = isCodex ? "codex" : (model.split("/").pop()?.slice(0, 12) ?? `agent-${i}`);

    const config: SwarmAgentConfig = {
      name: `swarm-${i + 1}-${modelShort}`,
      task: swarmMarchingOrders(cwd),
      cwd,
      delayMs: i * SWARM_STAGGER_DELAY_MS,
    };

    if (isCodex) {
      config.subagent_type = CODEX_SUBAGENT_TYPE;
    } else {
      config.model = model;
    }

    configs.push(config);
  }

  return configs;
}

// ─── Status Formatting ──────────────────────────────────────

/**
 * Format swarm status for display.
 */
export function formatSwarmStatus(
  agents: AgentStatus[],
  beads: Bead[]
): string {
  if (agents.length === 0) return "No swarm agents active.";

  const active = agents.filter((a) => a.health === "active").length;
  const idle = agents.filter((a) => a.health === "idle").length;
  const stuck = agents.filter((a) => a.health === "stuck").length;

  const openBeads = beads.filter((b) => b.status === "open").length;
  const inProgress = beads.filter((b) => b.status === "in_progress").length;
  const closed = beads.filter((b) => b.status === "closed").length;

  const healthEmoji = stuck > 0 ? "RED" : idle > agents.length / 2 ? "YELLOW" : "GREEN";

  const lines = [
    `[${healthEmoji}] Swarm Status (${agents.length} agents)`,
    `  Active: ${active} | Idle: ${idle} | Stuck: ${stuck}`,
    `  Beads: ${openBeads} open | ${inProgress} in progress | ${closed} closed`,
  ];

  if (stuck > 0) {
    const stuckAgents = agents.filter((a) => a.health === "stuck");
    lines.push(`  Stuck agents: ${stuckAgents.map((a) => `#${a.stepIndex}`).join(", ")}`);
  }

  // File conflict detection
  const fileMap = new Map<string, number[]>();
  for (const agent of agents) {
    for (const file of agent.changedFiles) {
      const existing = fileMap.get(file) ?? [];
      existing.push(agent.stepIndex);
      fileMap.set(file, existing);
    }
  }
  const conflicts = Array.from(fileMap.entries()).filter(([, indices]) => indices.length > 1);
  if (conflicts.length > 0) {
    lines.push(`  File conflicts (${conflicts.length}):`);
    for (const [file, indices] of conflicts.slice(0, 5)) {
      lines.push(`    ${file} — agents #${indices.join(", #")}`);
    }
    if (conflicts.length > 5) {
      lines.push(`    ... and ${conflicts.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Format the swarm launch configuration for the LLM to execute.
 * Returns a structured JSON that the LLM can use with subagent/spawn tools.
 */
export function formatLaunchInstructions(configs: SwarmAgentConfig[]): string {
  const lines = [
    `## Swarm Launch Configuration`,
    "",
    `**${configs.length} agents** with ${SWARM_STAGGER_DELAY_MS / 1000}s stagger between launches.`,
    "",
    "Spawn each agent using the `subagent` tool with these configurations:",
    "",
  ];

  for (const config of configs) {
    const typeLabel = config.subagent_type ?? config.model ?? "(default)";
    lines.push(`### ${config.name}`);
    lines.push(`- **Model/Type:** ${typeLabel}`);
    lines.push(`- **Delay:** ${config.delayMs / 1000}s after launch`);
    lines.push("```json");
    const agentSpec: Record<string, unknown> = {
      name: config.name,
      task: config.task,
      cwd: config.cwd,
    };
    if (config.subagent_type) {
      agentSpec.subagent_type = config.subagent_type;
    } else if (config.model) {
      agentSpec.model = config.model;
    }
    lines.push(JSON.stringify(agentSpec, null, 2));
    lines.push("```");
    lines.push("");
  }

  lines.push("**Important:**");
  lines.push("- Wait the specified delay between each spawn to prevent thundering herd");
  lines.push("- Each agent will independently use `bv --robot-next` to pick work");
  lines.push("- Agents coordinate via Agent Mail file reservations");
  lines.push("- Monitor with `/flywheel-swarm-status`");
  lines.push("- Stop with `/flywheel-swarm-stop`");

  return lines.join("\n");
}
