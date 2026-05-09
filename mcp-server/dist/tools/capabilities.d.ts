/**
 * `flywheel_capabilities` — read-only handler that returns the entire MCP
 * contract surface in a single call. Agents use this to pin contract
 * versions, discover valid action enums, list error codes, and read the
 * env-var dictionary without grepping source.
 *
 * R-001 from the agent-ergonomics audit (priority 985). The output is
 * snapshot-tested so the contract cannot drift silently.
 *
 * Design constraint: this tool MUST NOT import from server.ts (circular).
 * The TOOLS list is passed in from server.ts at registration time via the
 * `runCapabilitiesWith` closure factory.
 */
import type { McpToolResult, ToolContext } from '../types.js';
/**
 * Bumped any time the capabilities envelope shape (NOT the tool list)
 * changes in a way clients must observe. Tool additions/removals do NOT
 * bump this — they are surfaced in `mcp_tools[]` and pinned by the
 * snapshot test.
 */
export declare const CAPABILITIES_CONTRACT_VERSION: 1;
/**
 * Tool descriptor shape — structurally matches the entries in server.ts
 * PRIMARY_TOOLS. The `type` field is widened to `string` because the
 * literal in server.ts is not declared `as const` and the array contains
 * heterogeneous shapes; we only read `name`, `description`, and the inner
 * required/properties anyway.
 */
interface ToolDescriptor {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}
interface ToolSummary {
    name: string;
    description: string;
    required: string[];
    optional: string[];
    enums: Record<string, readonly string[]>;
    deprecated: boolean;
    deprecation_replacement?: string;
    /** R-003: relative path inside the MCP server install root pointing at the JSON Schema for this tool's input. */
    schema_url: string;
}
interface CapabilitiesData {
    kind: 'capabilities';
    contract_version: typeof CAPABILITIES_CONTRACT_VERSION;
    generated_at: string;
    /**
     * Pass-6 finding-1 — top-level alias for `mcp_tools`. The simulator hit
     * the universal first-call confusion: `Object.keys(envelope.data)` shows
     * `mcp_tools` and an agent has to recognize the `mcp_` prefix is
     * implementer-leaking. `tools` is the plain name. Both are kept for
     * backward compatibility (additive change; same array reference).
     */
    tools: ToolSummary[];
    mcp_tools: ToolSummary[];
    doctor_check_names: readonly string[];
    error_codes: Array<{
        code: string;
        default_hint: string;
        /** R-007 (pass 3) — paste-ready next-step. Parallel to default_hint. */
        default_try_this: string;
        retryable: boolean;
    }>;
    env_vars: Record<string, string>;
    exit_code_contract: Record<string, string>;
    references: {
        schemas_url: string | null;
        robot_docs_tool: string | null;
        /** Prose pointer (legacy field — kept for narrative readers). */
        handbook: string;
        /**
         * Pass-6 finding-2 — structured `{tool, args}` form so smaller models
         * can pattern-match the next call instead of text-extracting it from
         * a sentence. Mirrors the same intent as `handbook`.
         */
        handbook_call: {
            tool: string;
            args: Record<string, unknown>;
            description: string;
        } | null;
    };
}
interface CapabilitiesEnvelope {
    tool: 'flywheel_capabilities';
    version: 1;
    status: 'ok';
    phase: 'idle';
    data: CapabilitiesData;
}
/**
 * Hand-curated env-var dictionary. Agents look here before grepping source.
 * Update this when a new FW_* env var is read by any tool runner.
 */
export declare const FLYWHEEL_ENV_VARS: Record<string, string>;
/**
 * Documented exit-code contract. The MCP layer uses 0 for success and the
 * structured-error envelope for failure (no shell exit codes). This dict is
 * what the CLI shim should emit if/when one is added.
 */
export declare const EXIT_CODE_CONTRACT: Record<string, string>;
/**
 * Build a single tool summary with required/optional/enum extraction.
 * Pure function so the snapshot test can call it directly.
 */
export declare function summarizeTool(tool: ToolDescriptor): ToolSummary;
/**
 * Assemble the full capabilities payload. Pure function (no I/O) so tests
 * can pin its output deterministically.
 */
export declare function buildCapabilitiesPayload(tools: readonly ToolDescriptor[], options?: {
    now?: () => string;
}): CapabilitiesEnvelope;
/**
 * Closure factory: server.ts calls this once with its TOOLS array; the
 * returned runner satisfies the ToolRunner shape and can be wired into
 * EXTENSION_RUNNERS. Avoids the capabilities.ts → server.ts circular import.
 */
export declare function runCapabilitiesWith(tools: readonly ToolDescriptor[]): (ctx: ToolContext, args: Record<string, unknown>) => Promise<McpToolResult>;
export {};
//# sourceMappingURL=capabilities.d.ts.map