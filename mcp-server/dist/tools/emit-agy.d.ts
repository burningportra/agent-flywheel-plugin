/**
 * flywheel_emit_agy — check, write, or prune the Antigravity port of this
 * plugin by running `scripts/sync-agy.sh --json --target <targetDir>`.
 *
 * The port normally lives outside the project, under
 * `~/.gemini/antigravity/plugins/`, so `targetDir` may sit strictly inside
 * either `cwd` or the directory holding the manifest's port target. Both
 * checks compare realpaths, so a symlink can't carry the target elsewhere.
 */
import type { McpToolResult, ToolContext } from '../types.js';
import { type SyncAgyMode } from '../adapters/antigravity.js';
export interface EmitAgyArgs {
    cwd: string;
    targetDir: string;
    mode?: SyncAgyMode;
    /** Plugin checkout holding `scripts/sync-agy.sh`. Must be inside cwd or match CLAUDE_PLUGIN_ROOT. */
    pluginRoot?: string;
}
export declare function runEmitAgy(ctx: ToolContext, args: EmitAgyArgs): Promise<McpToolResult>;
//# sourceMappingURL=emit-agy.d.ts.map