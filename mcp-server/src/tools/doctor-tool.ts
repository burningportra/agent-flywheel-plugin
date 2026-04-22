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

import type { DoctorArgs, DoctorReport, McpToolResult, ToolContext } from '../types.js';
import { classifyExecError, makeFlywheelErrorResult } from '../errors.js';
import { makeToolResult } from './shared.js';
import { runDoctorChecks } from './doctor.js';

// ─── Rendering ────────────────────────────────────────────────────────────

/** Severity glyph rendered into the MCP `content[]` text block. */
function glyphFor(severity: 'green' | 'yellow' | 'red'): string {
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
export function renderDoctorReportText(report: DoctorReport): string {
  const header = `flywheel doctor — overall: ${glyphFor(report.overall)} (${report.elapsedMs}ms${report.partial ? ', partial' : ''})`;
  const lines = report.checks.map((c) => {
    const base = `${glyphFor(c.severity)} ${c.name}: ${c.message}`;
    return c.hint ? `${base} [hint: ${c.hint}]` : base;
  });
  return [header, ...lines].join('\n');
}

// ─── Handler ──────────────────────────────────────────────────────────────

type DoctorStructuredContent = {
  tool: 'flywheel_doctor';
  version: 1;
  status: 'ok';
  phase: 'doctor';
  data: {
    kind: 'doctor_report';
    report: DoctorReport;
  };
};

/**
 * flywheel_doctor tool handler.
 *
 * Never mutates checkpoint or state — purely observational.
 */
export async function runDoctor(
  ctx: ToolContext,
  args: DoctorArgs,
): Promise<McpToolResult> {
  try {
    const report = await runDoctorChecks(args.cwd, ctx.signal);
    const structured: DoctorStructuredContent = {
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
  } catch (err: unknown) {
    // runDoctorChecks itself is designed not to throw, but defensively handle
    // unexpected failures (e.g. bad cwd argument) at the tool boundary.
    const classified = classifyExecError(err);
    return makeFlywheelErrorResult('flywheel_doctor', 'doctor', {
      code: classified.code,
      message: err instanceof Error ? err.message : String(err),
      retryable: classified.retryable,
      cause: classified.cause,
    });
  }
}
