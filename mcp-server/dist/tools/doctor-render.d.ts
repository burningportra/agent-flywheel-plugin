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
import type { DoctorReport } from '../types.js';
/**
 * Render the report as a clack-prompts intro/note block to stdout.
 *
 * @param report — the report from `runDoctorChecks`
 * @returns the criticalFails counter (so the CLI caller can use it as exit
 *          code; mirrors context-mode's `process.exit(criticalFails > 0 ? 1 : 0)`)
 */
export declare function renderDoctorReport(report: DoctorReport): number;
//# sourceMappingURL=doctor-render.d.ts.map