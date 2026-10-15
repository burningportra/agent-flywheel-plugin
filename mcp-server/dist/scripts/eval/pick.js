/**
 * Pick an answer for one AskUserQuestion sub-question.
 *
 * Matching rule (fixed under M3 reopen, 2026-10-15):
 *   1. A scripted rule matches when its `headerContains` substring is in the
 *      question's `header`. Question *text* is intentionally NOT scanned, so a
 *      rule like `headerContains: "pre-flight"` cannot be fired by a scope
 *      question whose body mentions "Pre-flight".
 *   2. If a rule matches, its target string must substring-match one of the
 *      offered option labels. On miss, return a `kind: "unmatched"` outcome
 *      so the caller can record a harness violation instead of injecting
 *      free-text to Sonnet.
 *   3. If no rule matches by header, fall back to the first offered option
 *      and record it as a `kind: "default"` outcome so the caller can log
 *      which scenario relied on the fallback.
 */
export function pickAnswer(header, options, scripted) {
    const hdr = String(header ?? "").toLowerCase();
    const labels = options.map((o) => String(o["label"] ?? ""));
    const rule = scripted.find((s) => hdr.includes(s.headerContains.toLowerCase()));
    if (rule) {
        const match = labels.find((label) => label.toLowerCase().includes(rule.option.toLowerCase()));
        if (match) {
            return {
                kind: "matched",
                label: match,
                ruleTarget: rule.option,
                optionMatched: match,
            };
        }
        return {
            kind: "unmatched",
            ruleTarget: rule.option,
            header,
            labels,
        };
    }
    const first = labels[0] ?? "";
    return { kind: "default", label: first, header, labels };
}
//# sourceMappingURL=pick.js.map