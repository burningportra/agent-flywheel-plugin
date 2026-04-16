import type { LintResult } from "./types.js";
export declare const EXIT_CLEAN = 0;
export declare const EXIT_FINDINGS = 1;
export declare const EXIT_INTERNAL = 2;
export declare const EXIT_INVALID_ARGS = 3;
export declare const EXIT_FILE_ERROR = 4;
/**
 * Compute exit code from a LintResult per §9 of the v1.0 plan.
 * Internal errors take precedence over findings.
 */
export declare function computeExitCode(result: LintResult): number;
//# sourceMappingURL=exitCodes.d.ts.map