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
import { FLYWHEEL_ERROR_CODES, DEFAULT_HINTS, DEFAULT_RETRYABLE, DEFAULT_TRY_THIS } from '../errors.js';
import { DOCTOR_CHECK_NAMES } from './doctor.js';
import { makeToolResult } from './shared.js';
/**
 * Bumped any time the capabilities envelope shape (NOT the tool list)
 * changes in a way clients must observe. Tool additions/removals do NOT
 * bump this — they are surfaced in `mcp_tools[]` and pinned by the
 * snapshot test.
 */
export const CAPABILITIES_CONTRACT_VERSION = 1;
/**
 * Hand-curated env-var dictionary. Agents look here before grepping source.
 * Update this when a new FW_* env var is read by any tool runner.
 */
export const FLYWHEEL_ENV_VARS = {
    FW_ATTESTATION_REQUIRED: '"1" | "true" — when set, flywheel_advance_wave hard-blocks instead of warning when a closed bead lacks an attestation file.',
    FW_COMPLIANCE_OVERRIDE: '"1" | "true" — bypass the compliance audit gate in flywheel_compliance_audit. Only used during emergencies; logged to telemetry.',
    FW_GRADER_FORCE_CLAUDE: '"1" | "true" — force flywheel_grade_outcome to use the Claude Code fallback grader instead of probing for codex first.',
    FW_GRADER_MODEL: 'Codex-primary grader model passed to codex exec --model (e.g. "gpt-5.5"). Does NOT configure the fresh-CC fallback; that path is selected by FW_GRADER_FORCE_CLAUDE=1 or Codex unavailability.',
    FW_GRADER_MODEL_DEFAULT: 'Default grader model id used when FW_GRADER_MODEL is not set.',
    FW_GRADER_TIMEOUT_MS: 'Per-grader-invocation timeout in milliseconds. Default: 180000.',
    FW_LOG_LEVEL: '"debug" | "info" | "warn" | "error" — server log verbosity. Set to "debug" when triaging tool failures.',
    FW_MAX_OUTCOME_ITERATIONS: 'Server-side cap on outcome-grading iterations per cycle. Default: 5.',
    FW_RUBRIC_SYNTH_TIMEOUT_MS: 'Per-call timeout for flywheel_synthesize_rubric. Default: 180000.',
    FW_SESSION_ID: 'Session id used for telemetry correlation; auto-generated if unset.',
    FW_SKILL_BUNDLE: 'Override path to the skills bundle used by flywheel_get_skill. When unset the server reads from the plugin install root.',
    FW_VIEWER_BIND: 'Bind address for the bead-viewer HTTP server. Default: 127.0.0.1.',
};
/**
 * Documented exit-code contract. The MCP layer uses 0 for success and the
 * structured-error envelope for failure (no shell exit codes). This dict is
 * what the CLI shim should emit if/when one is added.
 */
export const EXIT_CODE_CONTRACT = {
    '0': 'success',
    '1': 'user-input-error — invalid args, missing required field, enum violation',
    '2': 'safety-block — refused destructive op without --yes; refused mutation under blocked_state',
    '3': 'tool-environment-error — required CLI missing, network unreachable, fs not writable',
    '4': 'concurrent-write — another process holds the mutex; retry with backoff',
    '5': 'parse-failure — input file or upstream output failed schema validation',
};
/**
 * Build a single tool summary with required/optional/enum extraction.
 * Pure function so the snapshot test can call it directly.
 */
export function summarizeTool(tool) {
    const props = (tool.inputSchema.properties ?? {});
    const required = tool.inputSchema.required ?? [];
    const allFields = Object.keys(props);
    const optional = allFields.filter((f) => !required.includes(f));
    const enums = {};
    for (const [field, schema] of Object.entries(props)) {
        if (schema && Array.isArray(schema.enum) && schema.enum.length > 0) {
            enums[field] = schema.enum;
        }
    }
    const deprecated = tool.name.startsWith('orch_');
    return {
        name: tool.name,
        description: tool.description,
        required: [...required].sort(),
        optional: optional.sort(),
        enums,
        deprecated,
        deprecation_replacement: deprecated
            ? tool.name.replace(/^orch_/, 'flywheel_')
            : undefined,
        schema_url: `schemas/inputs/${tool.name}.json`,
    };
}
/**
 * Assemble the full capabilities payload. Pure function (no I/O) so tests
 * can pin its output deterministically.
 */
export function buildCapabilitiesPayload(tools, options = {}) {
    const now = options.now ?? (() => new Date().toISOString());
    const summaries = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(summarizeTool);
    const errorCodes = [...FLYWHEEL_ERROR_CODES].sort().map((code) => ({
        code,
        default_hint: DEFAULT_HINTS[code],
        default_try_this: DEFAULT_TRY_THIS[code],
        retryable: DEFAULT_RETRYABLE[code],
    }));
    return {
        tool: 'flywheel_capabilities',
        version: 1,
        status: 'ok',
        phase: 'idle',
        data: {
            kind: 'capabilities',
            contract_version: CAPABILITIES_CONTRACT_VERSION,
            generated_at: now(),
            // Pass-6 finding-1 — both keys point at the SAME summaries array
            // so future writes don't drift. `tools` is the plain name; `mcp_tools`
            // stays as a deprecated alias for one minor cycle (drop in v4.0).
            tools: summaries,
            mcp_tools: summaries,
            doctor_check_names: [...DOCTOR_CHECK_NAMES].sort(),
            error_codes: errorCodes,
            env_vars: FLYWHEEL_ENV_VARS,
            exit_code_contract: EXIT_CODE_CONTRACT,
            references: {
                schemas_url: 'schemas/index.json',
                robot_docs_tool: 'flywheel_robot_docs',
                handbook: 'Call flywheel_robot_docs (default section="all") for the paste-ready handbook. AGENTS.md in the repo root is the verbose long-form.',
                // Pass-6 finding-2 — structured form parallel to `handbook`.
                // Smaller models pattern-match this; larger ones can use either.
                handbook_call: {
                    tool: 'flywheel_robot_docs',
                    args: { cwd: '<repo-root>', section: 'all' },
                    description: 'Returns the 6-section paste-ready handbook in one call.',
                },
            },
        },
    };
}
/**
 * Closure factory: server.ts calls this once with its TOOLS array; the
 * returned runner satisfies the ToolRunner shape and can be wired into
 * EXTENSION_RUNNERS. Avoids the capabilities.ts → server.ts circular import.
 */
export function runCapabilitiesWith(tools) {
    return async (_ctx, _args) => {
        const payload = buildCapabilitiesPayload(tools);
        const text = `flywheel_capabilities: contract_version=${payload.data.contract_version} tools=${payload.data.mcp_tools.length} error_codes=${payload.data.error_codes.length} doctor_checks=${payload.data.doctor_check_names.length}`;
        return makeToolResult(text, payload);
    };
}
//# sourceMappingURL=capabilities.js.map