import type { LintResult, Finding, ReporterOptions, Severity } from "../types.js";
export type ReporterName = "pretty" | "compact" | "gha" | "json";
export declare function selectReporter(): ReporterName;
export declare function format(name: ReporterName, result: LintResult, opts?: ReporterOptions): string;
export declare function sortFindings(findings: Finding[]): Finding[];
export declare function filterBySeverity(findings: Finding[], minSeverity?: Severity): Finding[];
//# sourceMappingURL=index.d.ts.map