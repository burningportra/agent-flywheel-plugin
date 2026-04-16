import { parse } from "./parser.js";
import { runRule } from "./runRule.js";
export { createLintLogger } from "./logger.js";
export { LintConfigSchema } from "./config.js";
export { computeExitCode, EXIT_CLEAN, EXIT_FINDINGS, EXIT_INTERNAL, EXIT_INVALID_ARGS, EXIT_FILE_ERROR, } from "./exitCodes.js";
export { runRule } from "./runRule.js";
export async function lint(opts) {
    const parsed = await parse(opts.source, opts.filePath);
    const result = {
        findings: parsed.parserFindings.slice(),
        internalErrors: [],
    };
    const ctx = {
        filePath: opts.filePath,
        source: opts.source,
        ...(opts.ruleContextExtras ?? {}),
    };
    for (const rule of opts.rules ?? []) {
        const rr = await runRule(rule, parsed, ctx, { timeoutMs: opts.ruleTimeoutMs });
        result.findings.push(...rr.findings);
        if (rr.internalError)
            result.internalErrors.push(rr.internalError);
    }
    return result;
}
//# sourceMappingURL=index.js.map