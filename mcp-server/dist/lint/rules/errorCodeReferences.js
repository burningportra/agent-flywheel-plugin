import { FLYWHEEL_ERROR_CODES } from "../../errors.js";
const STRUCTURED_CODE_RE = /\b(?:structuredContent\??\.[\w?.]*data\??\.error\??\.code|data\??\.error\??\.code|error\??\.code)\b/;
const ERROR_TEXT_RE = /\b(?:error|errors|message|messages|text|stderr|exception)\b/i;
const LEGACY_MATCH_RE = /\b(?:contains?|includes?|indexof|startswith|endswith|match|search|regex|regexp)\b|(?:===|==|!==|!=)/i;
const CODE_PATTERNS = FLYWHEEL_ERROR_CODES.map((code) => ({
    code,
    pattern: new RegExp(`\\b${code.replace(/_/g, "[ _-]?")}\\b`, "i"),
}));
function findCodeReference(line) {
    let best = null;
    for (const { code, pattern } of CODE_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (!match)
            continue;
        const index = match.index;
        if (best === null || index < best.index) {
            best = { code, index };
        }
    }
    return best;
}
export const err001 = {
    id: "ERR001",
    description: "Skill docs should branch on structured error codes, not string-match error text.",
    severity: "warn",
    check(doc, ctx) {
        const findings = [];
        const lines = doc.source.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (STRUCTURED_CODE_RE.test(line))
                continue;
            if (!ERROR_TEXT_RE.test(line))
                continue;
            if (!LEGACY_MATCH_RE.test(line))
                continue;
            const ref = findCodeReference(line);
            if (!ref)
                continue;
            findings.push({
                ruleId: "ERR001",
                severity: "warn",
                file: ctx.filePath,
                line: i + 1,
                column: ref.index + 1,
                message: `String-matching error text for "${ref.code}" found. Branch on structured error codes instead.`,
                hint: `Use result.structuredContent?.data?.error?.code === "${ref.code}" (FlywheelErrorCode).`,
            });
        }
        return findings;
    },
};
export default err001;
//# sourceMappingURL=errorCodeReferences.js.map