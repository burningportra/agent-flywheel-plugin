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
import { makeToolResult } from './shared.js';
export const ROBOT_DOCS_VERSION = 1;
export const ROBOT_DOCS_SECTIONS = [
    'getting_started',
    'common_workflows',
    'error_codes_decoder',
    'dangerous_ops_safe_alt',
    'exit_code_contract',
    'capabilities_pointer',
];
const SECTIONS = {
    getting_started: {
        key: 'getting_started',
        title: 'Getting started',
        body: `
The flywheel is a state machine: profile → discover → select → plan →
approve_beads → impl swarm → verify_beads → review → advance_wave.
Every transition is exposed as a flywheel_* MCP tool. Calling them in
order from a clean repo state will work. To resume a partial cycle,
call flywheel_observe(cwd) first — it returns the current phase plus
which tool the state machine expects next.

Minimal first call: flywheel_profile(cwd: <repo-root>)
Resume call:        flywheel_observe(cwd: <repo-root>)
`.trim(),
    },
    common_workflows: {
        key: 'common_workflows',
        title: 'Common workflows (paste-ready)',
        body: `
1. Start a new cycle from a clean repo:
   flywheel_profile(cwd)
   flywheel_discover(cwd, ideas: [...])     # ideas come from your model
   flywheel_select(cwd, goal: "<chosen>")
   flywheel_plan(cwd, mode: "standard")     # or "deep" / "duel"
   flywheel_approve_beads(cwd, action: "start")
   # impl swarm runs (each agent commits + writes attestation)
   flywheel_verify_beads(cwd, beadIds: [...])
   flywheel_advance_wave(cwd, closedBeadIds: [...])

2. Daily health check:
   flywheel_doctor(cwd)
   # severity: green = ok, yellow = degraded, red = blocked.
   # On non-green: flywheel_remediate(cwd, checkName, mode: "dry_run")
   # then again with mode: "execute" once you have read the plan.

3. Single-bead review loop:
   flywheel_review(cwd, beadId, action: "hit-me", mode: "interactive")
   # ... discuss findings ...
   flywheel_review(cwd, beadId, action: "looks-good")

4. Memory:
   flywheel_memory(cwd, operation: "search", query: "<term>")
   flywheel_memory(cwd, operation: "store", content: "<note>")
`.trim(),
    },
    error_codes_decoder: {
        key: 'error_codes_decoder',
        title: 'Error codes — what to do (decoder)',
        body: `
Every flywheel error includes a 'code' field. Common codes:

  invalid_input           re-read the tool description; check enum values
                          via flywheel_capabilities; correct the args
  missing_prerequisite    a required CLI/file/state is missing — typically
                          run flywheel_profile or flywheel_setup first
  not_found               the bead/plan/memory id does not exist — list
                          via 'br list' or flywheel_memory operation=search
  cli_failure             the underlying CLI exited non-zero — re-run it
                          manually to inspect stderr, then retry
  cli_not_available       install the missing CLI; verify with --version
  blocked_state           the flywheel is in a phase where this tool isn't
                          valid — call flywheel_observe to see current phase
  attestation_missing     the closed bead lacks .pi-flywheel/completion/<id>.json;
                          ask the impl agent to emit one before re-verifying
  attestation_invalid     the file exists but failed schema validation;
                          'br show <id>' to see what the agent committed,
                          then update or recreate
  exec_timeout            the underlying CLI took too long — retry once;
                          if it persists, set FW_LOG_LEVEL=debug for trace
  concurrent_write        another flywheel call holds the mutex; wait or
                          identify the holder via the inbox

For the full machine-readable error_codes list (every code + default
hint + retryable flag), call flywheel_capabilities and read
data.error_codes.
`.trim(),
    },
    dangerous_ops_safe_alt: {
        key: 'dangerous_ops_safe_alt',
        title: 'Dangerous operations — safe alternatives',
        body: `
These commands cannot be undone; bare invocation is gated.

  /flywheel-rollback <bead-id>      → confirm before applying;
                                      use --dry-run to preview
  /flywheel-cleanup                  → confirm; use without --force first
  /flywheel-stop                     → confirm; preserves state by default
  /flywheel-swarm-stop --yes         → REQUIRED — kills agents + releases
                                      reservations. Preview with --dry-run.
  /flywheel-refine-skills --yes      → REQUIRED — rewrites SKILL.md files
                                      across the project. Use --skill <name>
                                      for single-skill refinement instead.

For MCP tools that mutate state, every one accepts a discriminator that
forces an explicit decision: flywheel_remediate(mode='dry_run'|'execute'),
flywheel_review(mode='interactive'|'autofix'|'report-only'|'headless'),
flywheel_synthesize_rubric(action='synthesize'|'validate'|'edit'|'regenerate').
Default to dry_run / interactive / validate; only escalate after reading
the proposed change.
`.trim(),
    },
    exit_code_contract: {
        key: 'exit_code_contract',
        title: 'Exit code contract (CLI shim + hooks)',
        body: `
  0   success
  1   user-input-error  — invalid args, missing required field, enum violation
  2   safety-block      — refused destructive op without --yes; blocked_state
  3   tool-environment-error — required CLI missing, network unreachable
  4   concurrent-write  — another process holds the mutex; retry with backoff
  5   parse-failure     — input file or upstream output failed validation

MCP tools always return 0 from the JSON-RPC perspective; failure is
encoded in the structured envelope's status:'error'. The exit codes
above apply to the CLI shim (when one is invoked) and to hooks/scripts
that wrap flywheel calls. Surface this contract in any wrapper script
you write so callers can branch deterministically.
`.trim(),
    },
    capabilities_pointer: {
        key: 'capabilities_pointer',
        title: 'Where to look next (machine-readable)',
        body: `
For everything that's enumerable rather than narrative, call
flywheel_capabilities. It returns:

  data.contract_version          pin this; bumps require code review
  data.mcp_tools[]               every tool with required/optional/enums/schema_url
  data.error_codes[]             every code with default hint + retryable flag
  data.doctor_check_names[]      remediable check names for flywheel_remediate
  data.env_vars{}                FW_* environment variable dictionary
  data.exit_code_contract{}      same table as the section above
  data.references.schemas_url    path to dist/schemas/index.json
                                 (per-tool draft-07 JSON Schema documents)

Validate your invocations locally against the schemas before calling
the tool — much cheaper than letting the server reject them.
`.trim(),
    },
};
function pickSection(raw) {
    if (typeof raw !== 'string')
        return 'all';
    if (raw === 'all')
        return 'all';
    if (ROBOT_DOCS_SECTIONS.includes(raw)) {
        return raw;
    }
    return 'all';
}
export function buildRobotDocs(section) {
    const selected = section === 'all'
        ? ROBOT_DOCS_SECTIONS.map((k) => SECTIONS[k])
        : [SECTIONS[section]];
    const markdown = selected
        .map((s) => `## ${s.title}\n\n${s.body}\n`)
        .join('\n');
    return {
        tool: 'flywheel_robot_docs',
        version: 1,
        status: 'ok',
        phase: 'idle',
        data: {
            kind: 'robot_docs',
            docs_version: ROBOT_DOCS_VERSION,
            section,
            sections: selected,
            markdown,
            pointers: {
                capabilities_tool: 'flywheel_capabilities',
                handbook_full_path: 'AGENTS.md (in repo root)',
            },
        },
    };
}
export async function runRobotDocs(_ctx, args) {
    const section = pickSection(args.section);
    const payload = buildRobotDocs(section);
    const text = `flywheel_robot_docs: section=${payload.data.section} sections_count=${payload.data.sections.length} markdown_chars=${payload.data.markdown.length}`;
    return makeToolResult(text, payload);
}
//# sourceMappingURL=robot-docs.js.map