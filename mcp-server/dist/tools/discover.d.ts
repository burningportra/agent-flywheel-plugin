import type { ToolContext, McpToolResult, DiscoverArgs } from '../types.js';
/**
 * R-010 (agent-ergonomics audit pass 3) — resolve the discovery-artifact
 * directory using XDG conventions instead of /tmp.
 *
 * Precedence:
 *   1. $XDG_STATE_HOME/agent-flywheel/discovery
 *   2. ~/.local/state/agent-flywheel/discovery (XDG default)
 *
 * Why: /tmp/agent-flywheel-discovery collided across cycles and
 * disappeared on reboot. The XDG state path survives reboots and
 * gives agents a stable place to look across sessions.
 */
export declare function resolveDiscoveryArtifactDir(): string;
/**
 * flywheel_discover — Accept LLM-generated ideas and store them in state.
 *
 * The calling Claude agent generates 5-15 ideas based on the repo profile
 * from flywheel_profile, then calls this tool with the structured list.
 * After storing, it instructs the agent to call flywheel_select.
 */
export declare function runDiscover(ctx: ToolContext, args: DiscoverArgs): Promise<McpToolResult>;
//# sourceMappingURL=discover.d.ts.map