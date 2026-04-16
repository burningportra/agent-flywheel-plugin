/** Exported for extensibility; future rules can push() to extend the seed set. */
export const IMPLICIT_DECISION_PHRASES = [
    "wait for confirmation",
    "wait for the user",
    "ask the user",
    "surface this to the user",
    "propose this to the user",
    "check with the user",
    "only do .+ if the user confirms",
    "confirm with the user",
    "prompt the user",
    "get user approval",
    "seek user input",
    "let the user decide",
    "pause for user feedback",
];
function findUR1Regions(source) {
    const lines = source.split("\n");
    const regions = [];
    let inRegion = false;
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^>\s*##\s*⚠️.*UNIVERSAL RULE/i.test(line)) {
            if (inRegion)
                regions.push({ startLine, endLine: i });
            inRegion = true;
            startLine = i + 1;
            continue;
        }
        if (inRegion && !/^>/.test(line) && line.trim() !== "") {
            regions.push({ startLine, endLine: i });
            inRegion = false;
            startLine = -1;
        }
    }
    if (inRegion)
        regions.push({ startLine, endLine: lines.length });
    return regions;
}
function inUR1Region(line, regions) {
    return regions.some((r) => line >= r.startLine && line <= r.endLine);
}
function followedByAUQ(line, doc, windowLines = 20) {
    return (doc.askUserQuestionCalls ?? []).some((call) => call.span.start.line > line && call.span.start.line - line <= windowLines);
}
function insideBacktickQuote(lineText, col) {
    let backticks = 0;
    for (let i = 0; i < col && i < lineText.length; i++) {
        if (lineText[i] === "`" && (i === 0 || lineText[i - 1] !== "\\"))
            backticks++;
    }
    return backticks % 2 === 1;
}
const REGEX_META_RE = /[.+*?(){}|\\^$[\]]/;
function compilePhrases() {
    return IMPLICIT_DECISION_PHRASES.map((p) => {
        const isRegex = REGEX_META_RE.test(p);
        const pattern = isRegex ? p : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(pattern, "gi");
    });
}
export const impl001 = {
    id: "IMPL001",
    description: "Implicit-decision phrasing must be replaced with explicit AskUserQuestion calls.",
    severity: "error",
    check(doc, ctx) {
        const findings = [];
        const parsed = doc;
        const source = parsed.source ?? ctx.source;
        const lines = source.split("\n");
        const ur1Regions = findUR1Regions(source);
        const compiled = compilePhrases();
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line1 = lineIdx + 1;
            const lineText = lines[lineIdx];
            if (inUR1Region(line1, ur1Regions))
                continue;
            for (const re of compiled) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(lineText)) !== null) {
                    const col = m.index + 1;
                    if (insideBacktickQuote(lineText, m.index)) {
                        if (m.index === re.lastIndex)
                            re.lastIndex++;
                        continue;
                    }
                    if (followedByAUQ(line1, parsed)) {
                        if (m.index === re.lastIndex)
                            re.lastIndex++;
                        continue;
                    }
                    findings.push({
                        ruleId: "IMPL001",
                        severity: "error",
                        file: ctx.filePath,
                        line: line1,
                        column: col,
                        message: `Implicit-decision phrase "${m[0]}" found. Replace with an explicit AskUserQuestion call (Universal Rule 1).`,
                        hint: `AskUserQuestion(questions: [{ question: "...", header: "...", options: [...], multiSelect: false }])`,
                    });
                    if (m.index === re.lastIndex)
                        re.lastIndex++;
                }
            }
        }
        return findings;
    },
};
export default impl001;
//# sourceMappingURL=implicitDecisions.js.map