/**
 * Run a single rule with isolation + timeout. Never throws.
 * - try/catch around rule.check(): caught errors become internalError.
 * - Promise.race with timeout: timeout becomes internalError.
 */
export async function runRule(rule, doc, ctx, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    let timer;
    try {
        const findings = await Promise.race([
            Promise.resolve().then(() => rule.check(doc, ctx)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`rule timeout after ${timeoutMs}ms`)), timeoutMs);
                if (opts.signal) {
                    opts.signal.addEventListener("abort", () => {
                        if (timer)
                            clearTimeout(timer);
                        reject(new Error("aborted"));
                    }, { once: true });
                }
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        return { findings: findings ?? [] };
    }
    catch (err) {
        if (timer)
            clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        return {
            findings: [],
            internalError: { ruleId: rule.id, message },
        };
    }
}
//# sourceMappingURL=runRule.js.map