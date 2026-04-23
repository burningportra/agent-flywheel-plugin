/**
 * flywheel_emit_codex — MCP tool handler (bead `agent-flywheel-plugin-zbx`).
 *
 * Sanitises `targetDir` via `utils/path-safety`, then delegates to
 * `emit/codex.ts`. Reports the AGENTS.md path and per-skill files written.
 *
 * Single-target by design: do NOT generalise into a registry. If a future
 * target is requested, that requires a separate design doc + bead.
 *
 * Note: this tool intentionally does NOT extend `FlywheelToolName` in
 * `types.ts` (forbidden by bead scope — types.ts is owned by another bead).
 * The MCP error envelope is therefore constructed directly rather than via
 * `makeToolError`, which narrows on `FlywheelToolName`.
 */
import type { McpToolResult, ToolContext } from "../types.js";
export interface EmitCodexArgs {
    cwd: string;
    targetDir: string;
    /**
     * Optional: explicit plugin root (where `skills/` lives). Defaults to
     * `cwd` — useful when the MCP server is invoked from the plugin checkout.
     */
    pluginRoot?: string;
}
export declare function runEmitCodex(ctx: ToolContext, args: EmitCodexArgs): Promise<McpToolResult>;
//# sourceMappingURL=emit-codex.d.ts.map