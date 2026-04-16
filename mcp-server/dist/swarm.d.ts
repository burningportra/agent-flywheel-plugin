/**
 * Swarm Launcher & Configuration
 *
 * Agent composition, staggered launch, status formatting,
 * and SwarmTender monitoring integration.
 */
import type { Bead } from "./types.js";
import type { AgentStatus } from "./tender.js";
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
    models: Array<{
        model: string;
        count: number;
    }>;
    /** Reasoning for the recommendation. */
    rationale: string;
}
/** Recommend agent composition based on open bead count. */
export declare function recommendComposition(openBeadCount: number): SwarmComposition;
/**
 * Generate agent configurations for the swarm.
 * Each agent gets staggered delay and marching orders.
 */
export declare function generateAgentConfigs(count: number, cwd: string, composition: SwarmComposition): SwarmAgentConfig[];
/**
 * Format swarm status for display.
 */
export declare function formatSwarmStatus(agents: AgentStatus[], beads: Bead[]): string;
/**
 * Format the swarm launch configuration for the LLM to execute.
 * Returns a structured JSON that the LLM can use with subagent/spawn tools.
 */
export declare function formatLaunchInstructions(configs: SwarmAgentConfig[]): string;
//# sourceMappingURL=swarm.d.ts.map