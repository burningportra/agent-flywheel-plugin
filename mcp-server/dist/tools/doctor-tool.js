/**
 * flywheel_doctor — MCP tool registration (I4).
 *
 * Thin wrapper around `runDoctorChecks` from `./doctor.js` (I2 engine).
 * Builds the standard `structuredContent` envelope, threads `ctx.signal`,
 * classifies thrown errors via `classifyExecError` at the tool boundary.
 *
 * READ-ONLY: this tool MUST NOT mutate `.pi-flywheel/checkpoint.json` or
 * write any file. It does not call `saveState` / `clearState`.
 */
import { classifyExecError, makeFlywheelErrorResult } from '../errors.js';
import { makeToolResult } from './shared.js';
import { runDoctorChecks } from './doctor.js';
// ─── Rendering ────────────────────────────────────────────────────────────
/** Severity glyph rendered into the MCP `content[]` text block. */
function glyphFor(severity) {
    switch (severity) {
        case 'green':
            return '[OK]';
        case 'yellow':
            return '[WARN]';
        case 'red':
            return '[FAIL]';
    }
}
/**
 * Render a DoctorReport as a compact plain-text summary — 1 line per check
 * with a severity glyph. This is the human-facing view that appears in MCP
 * `content[]`. Structured data lives in `structuredContent.data.report`.
 */
export function renderDoctorReportText(report) {
    const header = `flywheel doctor — overall: ${glyphFor(report.overall)} (${report.elapsedMs}ms${report.partial ? ', partial' : ''})`;
    const lines = report.checks.map((c) => {
        const base = `${glyphFor(c.severity)} ${c.name}: ${c.message}`;
        return c.hint ? `${base} [hint: ${c.hint}]` : base;
    });
    return [header, ...lines].join('\n');
}
/**
 * flywheel_doctor tool handler.
 *
 * Never mutates checkpoint or state — purely observational.
 */
export async function runDoctor(ctx, args) {
    try {
        const report = await runDoctorChecks(args.cwd, ctx.signal);
        const structured = {
            tool: 'flywheel_doctor',
            version: 1,
            status: 'ok',
            phase: 'doctor',
            data: {
                kind: 'doctor_report',
                report,
            },
        };
        return makeToolResult(renderDoctorReportText(report), structured);
    }
    catch (err) {
        // runDoctorChecks itself is designed not to throw, but defensively handle
        // unexpected failures (e.g. bad cwd argument) at the tool boundary.
        const classified = classifyExecError(err);
        return makeFlywheelErrorResult('flywheel_doctor', 'doctor', {
            code: classified.code,
            message: err instanceof Error ? err.message : String(err),
            retryable: classified.retryable,
            hint: classified.code === 'exec_timeout'
                ? 'A doctor probe timed out — rerun flywheel_doctor; if persistent, set FW_LOG_LEVEL=debug and inspect the slow check.'
                : classified.code === 'exec_aborted'
                    ? 'The doctor run was aborted before completion — rerun flywheel_doctor when the environment is stable.'
                    : 'Verify cwd is a valid absolute path and required CLIs (git, br) are on PATH, then retry flywheel_doctor.',
            cause: classified.cause,
        });
    }
}
//# sourceMappingURL=doctor-tool.js.map