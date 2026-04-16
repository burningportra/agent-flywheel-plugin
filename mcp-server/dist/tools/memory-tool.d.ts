import type { ToolContext, McpToolResult, MemoryArgs } from '../types.js';
/**
 * flywheel_memory — Search and interact with CASS memory (cm CLI).
 *
 * operation="search" (default) — search CASS memory for relevant entries
 * operation="store"            — store a new memory entry
 */
export declare function runMemory(ctx: ToolContext, args: MemoryArgs): Promise<McpToolResult>;
//# sourceMappingURL=memory-tool.d.ts.map