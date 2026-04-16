import type { ToolContext, McpToolResult, DiscoverArgs } from '../types.js';
/**
 * flywheel_discover — Accept LLM-generated ideas and store them in state.
 *
 * The calling Claude agent generates 5-15 ideas based on the repo profile
 * from flywheel_profile, then calls this tool with the structured list.
 * After storing, it instructs the agent to call flywheel_select.
 */
export declare function runDiscover(ctx: ToolContext, args: DiscoverArgs): Promise<McpToolResult>;
//# sourceMappingURL=discover.d.ts.map