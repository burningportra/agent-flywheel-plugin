/**
 * Human-readable rendering of a {@link DoctorReport} for the
 * `/flywheel-doctor` slash-command CLI path. Uses `@clack/prompts` +
 * `picocolors` for a checklist look (`[x] / [!] / [-]` rows colored by
 * severity), modeled on context-mode/src/cli.ts (~L350-L495).
 *
 * The MCP tool path keeps emitting JSON via `runDoctor` in
 * `./doctor-tool.ts` — this renderer is opt-in and is the ONLY place that
 * imports `@clack/prompts` so the MCP server cold-start cost stays flat.
 */

import * as p from '@clack/prompts';
import color from 'picocolors';
import type { DoctorCheck, DoctorCheckSeverity, DoctorReport } from '../types.js';

const SEVERITY_GLYPH: Record<DoctorCheckSeverity, string> = {
  green: '[x]',
  yellow: '[!]',
  red: '[!]',
};

function paint(severity: DoctorCheckSeverity, text: string): string {
  switch (severity) {
    case 'green':
      return color.green(text);
    case 'yellow':
      return color.yellow(text);
    case 'red':
      return color.red(text);
  }
}

function rowFor(check: DoctorCheck): string {
  const glyph = paint(check.severity, SEVERITY_GLYPH[check.severity]);
  const name = color.bold(check.name);
  const dur =
    typeof check.durationMs === 'number'
      ? color.dim(` (${check.durationMs}ms)`)
      : '';
  const head = `${glyph} ${name}${dur} — ${check.message}`;
  return check.hint
    ? `${head}\n      ${color.dim('hint:')} ${color.dim(check.hint)}`
    : head;
}

function summaryLine(report: DoctorReport): string {
  const reds = report.criticalFails;
  const yellows = report.checks.filter((c) => c.severity === 'yellow').length;
  const greens = report.checks.filter((c) => c.severity === 'green').length;
  const parts = [
    color.green(`${greens} ok`),
    yellows > 0 ? color.yellow(`${yellows} warn`) : color.dim(`${yellows} warn`),
    reds > 0 ? color.red(`${reds} critical`) : color.dim(`${reds} critical`),
  ];
  const elapsed = color.dim(`(${report.elapsedMs}ms${report.partial ? ', partial' : ''})`);
  return `${parts.join(' · ')} ${elapsed}`;
}

/**
 * Render the report as a clack-prompts intro/note block to stdout.
 *
 * @param report — the report from `runDoctorChecks`
 * @returns the criticalFails counter (so the CLI caller can use it as exit
 *          code; mirrors context-mode's `process.exit(criticalFails > 0 ? 1 : 0)`)
 */
export function renderDoctorReport(report: DoctorReport): number {
  p.intro(color.bold('flywheel doctor'));

  const overallTag =
    report.overall === 'green'
      ? color.green('OK')
      : report.overall === 'yellow'
      ? color.yellow('WARN')
      : color.red('FAIL');
  p.note(
    [
      `overall: ${overallTag}`,
      `cwd: ${color.dim(report.cwd)}`,
      `summary: ${summaryLine(report)}`,
    ].join('\n'),
    'status',
  );

  const body = report.checks.map(rowFor).join('\n');
  p.note(body, 'checks');

  if (report.criticalFails > 0) {
    p.outro(
      color.red(
        `${report.criticalFails} critical check(s) failed — see hints above.`,
      ),
    );
  } else if (report.overall === 'yellow') {
    p.outro(color.yellow('all critical checks passed; warnings present.'));
  } else {
    p.outro(color.green('all checks passed.'));
  }

  return report.criticalFails;
}
