export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_INTERNAL = 2;
export const EXIT_INVALID_ARGS = 3;
export const EXIT_FILE_ERROR = 4;
/**
 * Compute exit code from a LintResult per §9 of the v1.0 plan.
 * Internal errors take precedence over findings.
 */
export function computeExitCode(result) {
    if (result.internalErrors.length > 0)
        return EXIT_INTERNAL;
    if (result.findings.some((f) => f.severity === "error"))
        return EXIT_FINDINGS;
    return EXIT_CLEAN;
}
//# sourceMappingURL=exitCodes.js.map