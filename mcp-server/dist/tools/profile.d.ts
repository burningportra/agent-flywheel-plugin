import type { ToolContext, McpToolResult, ProfileArgs } from '../types.js';
/**
 * flywheel_profile — Scan the current repo and build a profile.
 *
 * Runs git log, finds key files, detects language/framework/CI/test tooling.
 * Detects the br CLI (beads) for coordination backend.
 * Returns a structured profile and discovery instructions.
 *
 * Uses a git-HEAD-keyed cache to skip redundant scans. Pass force=true to bypass.
 */
export declare function runProfile(ctx: ToolContext, args: ProfileArgs): Promise<McpToolResult>;
//# sourceMappingURL=profile.d.ts.map