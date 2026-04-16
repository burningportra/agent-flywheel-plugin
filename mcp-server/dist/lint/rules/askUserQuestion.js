const MAX_HEADER_GRAPHEMES = 12;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
function questionLabel(q) {
    if (q.header && q.header.length > 0)
        return q.header;
    if (q.question)
        return q.question.slice(0, 40);
    return "(unnamed)";
}
function optionLabel(opt) {
    return opt.label ?? "(unlabeled)";
}
function asParsed(doc) {
    return doc;
}
export const auq001 = {
    id: "AUQ001",
    description: "AskUserQuestion question must have 2-4 options.",
    severity: "error",
    check(doc, ctx) {
        const findings = [];
        const parsed = asParsed(doc);
        for (const call of parsed.askUserQuestionCalls) {
            if (call.parseError)
                continue;
            for (const q of call.questions) {
                const n = q.options.length;
                if (n < MIN_OPTIONS || n > MAX_OPTIONS) {
                    findings.push({
                        ruleId: "AUQ001",
                        severity: "error",
                        file: ctx.filePath,
                        line: q.span.start.line,
                        column: q.span.start.column,
                        endLine: q.span.end.line,
                        endColumn: q.span.end.column,
                        message: `Question "${questionLabel(q)}" has ${n} options; AskUserQuestion accepts 2–4. Drop or merge one option, or split into two questions.`,
                    });
                }
            }
        }
        return findings;
    },
};
export const auq002 = {
    id: "AUQ002",
    description: "AskUserQuestion options must be { label, description } objects.",
    severity: "error",
    check(doc, ctx) {
        const findings = [];
        const parsed = asParsed(doc);
        for (const call of parsed.askUserQuestionCalls) {
            if (call.parseError)
                continue;
            for (const q of call.questions) {
                for (const opt of q.options) {
                    if (opt.isBareString) {
                        const literal = opt.label !== undefined ? `"${opt.label}"` : "(string)";
                        findings.push({
                            ruleId: "AUQ002",
                            severity: "error",
                            file: ctx.filePath,
                            line: opt.span.start.line,
                            column: opt.span.start.column,
                            endLine: opt.span.end.line,
                            endColumn: opt.span.end.column,
                            message: `Option ${literal} is a bare string; AskUserQuestion expects { label, description } objects.`,
                        });
                        continue;
                    }
                    if (opt.description === undefined) {
                        findings.push({
                            ruleId: "AUQ002",
                            severity: "error",
                            file: ctx.filePath,
                            line: opt.span.start.line,
                            column: opt.span.start.column,
                            endLine: opt.span.end.line,
                            endColumn: opt.span.end.column,
                            message: `Option "${optionLabel(opt)}" has no description field. Add: description: "<one-line explanation>"`,
                        });
                    }
                }
            }
        }
        return findings;
    },
};
export const auq003 = {
    id: "AUQ003",
    description: "AskUserQuestion question header must be present and ≤12 graphemes.",
    severity: "error",
    check(doc, ctx) {
        const findings = [];
        const parsed = asParsed(doc);
        for (const call of parsed.askUserQuestionCalls) {
            if (call.parseError)
                continue;
            for (const q of call.questions) {
                if (q.header === undefined) {
                    findings.push({
                        ruleId: "AUQ003",
                        severity: "error",
                        file: ctx.filePath,
                        line: q.span.start.line,
                        column: q.span.start.column,
                        endLine: q.span.end.line,
                        endColumn: q.span.end.column,
                        message: `Question header is missing; add header: "<short label, ≤12 chars>"`,
                    });
                    continue;
                }
                const graphemes = Array.from(q.header).length;
                if (graphemes > MAX_HEADER_GRAPHEMES) {
                    findings.push({
                        ruleId: "AUQ003",
                        severity: "error",
                        file: ctx.filePath,
                        line: q.span.start.line,
                        column: q.span.start.column,
                        endLine: q.span.end.line,
                        endColumn: q.span.end.column,
                        message: `Question header "${q.header}" is ${graphemes} chars; AskUserQuestion truncates >12 in the UI.`,
                    });
                }
            }
        }
        return findings;
    },
};
export const auq004 = {
    id: "AUQ004",
    description: "AskUserQuestion question should set multiSelect explicitly.",
    severity: "warn",
    check(doc, ctx) {
        const findings = [];
        const parsed = asParsed(doc);
        for (const call of parsed.askUserQuestionCalls) {
            if (call.parseError)
                continue;
            for (const q of call.questions) {
                if (!q.multiSelectExplicit) {
                    findings.push({
                        ruleId: "AUQ004",
                        severity: "warn",
                        file: ctx.filePath,
                        line: q.span.start.line,
                        column: q.span.start.column,
                        endLine: q.span.end.line,
                        endColumn: q.span.end.column,
                        message: `Question "${questionLabel(q)}" omits multiSelect; add multiSelect: false explicitly.`,
                    });
                }
            }
        }
        return findings;
    },
};
export const auqRules = [auq001, auq002, auq003, auq004];
//# sourceMappingURL=askUserQuestion.js.map