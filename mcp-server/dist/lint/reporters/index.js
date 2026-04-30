import * as pretty from "./pretty.js";
import * as compact from "./compact.js";
import * as gha from "./gha.js";
import * as json from "./json.js";
const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };
export function selectReporter() {
    if (process.env.GITHUB_ACTIONS === "true")
        return "gha";
    if (process.stdout.isTTY)
        return "pretty";
    return "compact";
}
export function format(name, result, opts = {}) {
    switch (name) {
        case "pretty": return pretty.format(result, opts);
        case "compact": return compact.format(result, opts);
        case "gha": return gha.format(result, opts);
        case "json": return json.format(result, opts);
    }
}
export function sortFindings(findings) {
    return findings.slice().sort((a, b) => a.file.localeCompare(b.file)
        || a.line - b.line
        || a.column - b.column
        || a.ruleId.localeCompare(b.ruleId));
}
export function filterBySeverity(findings, minSeverity) {
    if (!minSeverity)
        return findings;
    const max = SEVERITY_RANK[minSeverity];
    return findings.filter((f) => SEVERITY_RANK[f.severity] <= max);
}
export function visibleFindings(result, opts = {}) {
    return filterBySeverity(sortFindings(result.findings), opts.minSeverity);
}
export function severityLabel(severity, warnLabel = "warn") {
    return severity === "warn" ? warnLabel : severity;
}
export function countBySeverity(findings) {
    return {
        errors: findings.filter((f) => f.severity === "error").length,
        warnings: findings.filter((f) => f.severity === "warn").length,
        infos: findings.filter((f) => f.severity === "info").length,
    };
}
//# sourceMappingURL=index.js.map