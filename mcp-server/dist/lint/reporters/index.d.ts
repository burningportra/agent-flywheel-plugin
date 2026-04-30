import type { LintResult, Finding, ReporterOptions, Severity } from "../types.js";
export type ReporterName = "pretty" | "compact" | "gha" | "json";
export declare function selectReporter(): ReporterName;
export declare function format(name: ReporterName, result: LintResult, opts?: ReporterOptions): string;
export declare function sortFindings(findings: Finding[]): Finding[];
export declare function filterBySeverity(findings: Finding[], minSeverity?: Severity): Finding[];
export declare function visibleFindings(result: LintResult, opts?: ReporterOptions): Finding[];
export declare function severityLabel(severity: Severity, warnLabel?: "warn" | "warning"): string;
export declare function countBySeverity(findings: Finding[]): {
    errors: number;
    warnings: number;
    infos: number;
};
//# sourceMappingURL=index.d.ts.map