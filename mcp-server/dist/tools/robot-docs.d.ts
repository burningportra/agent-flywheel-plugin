/**
 * `flywheel_robot_docs` — paste-ready agent handbook returned in a single
 * MCP call. Lets agents skip reading the 42 KB AGENTS.md every session
 * just to learn how to start a flywheel cycle.
 *
 * R-002 from the agent-ergonomics audit (priority 920). Designed as a
 * pure pull-from-data function so a regression test can pin every
 * section's presence and minimum length.
 *
 * Section selection: the `section` argument picks one of the keys below,
 * or 'all' (default) for the full handbook. Sections are deliberately
 * short — every example is paste-ready.
 */
import type { McpToolResult, ToolContext } from '../types.js';
export declare const ROBOT_DOCS_VERSION: 1;
export declare const ROBOT_DOCS_SECTIONS: readonly ["getting_started", "common_workflows", "error_codes_decoder", "dangerous_ops_safe_alt", "exit_code_contract", "capabilities_pointer"];
export type RobotDocsSection = (typeof ROBOT_DOCS_SECTIONS)[number];
interface DocSection {
    key: RobotDocsSection;
    title: string;
    body: string;
}
interface RobotDocsEnvelope {
    tool: 'flywheel_robot_docs';
    version: 1;
    status: 'ok';
    phase: 'idle';
    data: {
        kind: 'robot_docs';
        docs_version: typeof ROBOT_DOCS_VERSION;
        section: RobotDocsSection | 'all';
        sections: DocSection[];
        markdown: string;
        pointers: {
            capabilities_tool: 'flywheel_capabilities';
            handbook_full_path: 'AGENTS.md (in repo root)';
        };
    };
}
interface RobotDocsArgs {
    cwd?: unknown;
    section?: unknown;
}
export declare function buildRobotDocs(section: RobotDocsSection | 'all'): RobotDocsEnvelope;
export declare function runRobotDocs(_ctx: ToolContext, args: RobotDocsArgs): Promise<McpToolResult>;
export {};
//# sourceMappingURL=robot-docs.d.ts.map