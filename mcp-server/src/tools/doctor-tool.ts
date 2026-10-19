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
import { classifyExecError, errMsg, makeFlywheelErrorResult } from '../errors.js';
import { isFirstRun } from '../first-run.js';
import { renderPreflightBanner } from '../preflight.js';
import { parseBrList } from '../br-parser.js';
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
 * Tip appended to doctor output on any non-green overall result. Points
 * contributors at the `FW_LOG_LEVEL` env var — `createLogger` filters
 * stderr JSON lines by this level (default `warn`).
 */
const FW_LOG_LEVEL_TIP =
  'Tip: set FW_LOG_LEVEL=debug for full trace. See README "Debugging" section.';

/**
 * Render a DoctorReport as a compact plain-text summary — 1 line per check
 * with a severity glyph. This is the human-facing view that appears in MCP
 * `content[]`. Structured data lives in `structuredContent.data.report`.
 *
 * On any non-green overall result (yellow or red), a trailing line surfaces
 * the `FW_LOG_LEVEL=debug` tip so contributors can discover the verbose-log
 * escape hatch without grepping the README.
 */
export function renderDoctorReportText(report: DoctorReport): string {
  const header = `flywheel doctor — overall: ${glyphFor(report.overall)} (${report.elapsedMs}ms${report.partial ? ', partial' : ''})`;
  const lines = report.checks.map((c) => {
    const base = `${glyphFor(c.severity)} ${c.name}: ${c.message}`;
    return c.hint ? `${base} [hint: ${c.hint}]` : base;
  });
  const out = [header, ...lines];
  if (report.overall !== 'green') {
    out.push('', FW_LOG_LEVEL_TIP);
  }
  return out.join('\n');
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
    preflightBanner: string | null;
    firstRun: boolean;
  };
};

const FIRST_RUN_PROBE_TIMEOUT_MS = 5000;

async function listBeadsForFirstRun(ctx: ToolContext): Promise<unknown[]> {
  const result = await ctx.exec(
    'br',
    ['list', '--all', '--limit', '1', '--json'],
    {
      cwd: ctx.cwd,
      timeout: FIRST_RUN_PROBE_TIMEOUT_MS,
      signal: ctx.signal,
    },
  );
  if (result.code !== 0) {
    throw new Error(`br list failed: ${result.stderr}`);
  }
  return parseBrList(result.stdout).rows;
}

async function searchCassForFirstRun(ctx: ToolContext): Promise<unknown[]> {
  const result = await ctx.exec(
    'cass',
    [
      'search',
      '',
      '--workspace',
      ctx.cwd,
      '--limit',
      '1',
      '--fields',
      'minimal',
      '--json',
    ],
    {
      cwd: ctx.cwd,
      timeout: FIRST_RUN_PROBE_TIMEOUT_MS,
      signal: ctx.signal,
    },
  );
  if (result.code !== 0) {
    throw new Error(`cass search failed: ${result.stderr}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err: unknown) {
    throw new Error(`cass search returned invalid JSON: ${errMsg(err)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { hits?: unknown }).hits)
  ) {
    throw new Error('cass search output is missing hits[]');
  }
  return (parsed as { hits: unknown[] }).hits;
}

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
    void args;
    const [firstRun, report] = await Promise.all([
      isFirstRun({
        cwd: ctx.cwd,
        brList: () => listBeadsForFirstRun(ctx),
        cassSearch: () => searchCassForFirstRun(ctx),
      }),
      runDoctorChecks(ctx.cwd, ctx.signal),
    ]);
    const preflightBanner = renderPreflightBanner(report);
    const structured: DoctorStructuredContent = {
      tool: 'flywheel_doctor',
      version: 1,
      status: 'ok',
      phase: 'doctor',
      data: {
        kind: 'doctor_report',
        report,
        preflightBanner,
        firstRun,
      },
    };
    const reportText = renderDoctorReportText(report);
    const text = preflightBanner === null
      ? reportText
      : `${reportText}\n\n${preflightBanner}`;
    return makeToolResult(text, structured);
  } catch (err: unknown) {
    // runDoctorChecks itself is designed not to throw, but defensively handle
    // unexpected failures (e.g. bad cwd argument) at the tool boundary.
    const classified = classifyExecError(err);
    return makeFlywheelErrorResult('flywheel_doctor', 'doctor', {
      code: classified.code,
      message: errMsg(err),
      retryable: classified.retryable,
      hint:
        classified.code === 'exec_timeout'
          ? 'A doctor probe timed out — rerun flywheel_doctor; if persistent, set FW_LOG_LEVEL=debug and inspect the slow check.'
          : classified.code === 'exec_aborted'
          ? 'The doctor run was aborted before completion — rerun flywheel_doctor when the environment is stable.'
          : 'Verify cwd is a valid absolute path and required CLIs (git, br) are on PATH, then retry flywheel_doctor.',
      cause: classified.cause,
    });
  }
}
