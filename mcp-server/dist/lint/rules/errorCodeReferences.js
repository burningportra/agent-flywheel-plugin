import { FLYWHEEL_ERROR_CODES } from "../../errors.js";
const STRUCTURED_CODE_RE = /\b(?:structuredContent\??\.[\w?.]*data\??\.error\??\.code|data\??\.error\??\.code|error\??\.code)\b/;
const ERROR_TEXT_RE = /\b(?:error|errors|message|messages|text|stderr|exception)\b/i;
const LEGACY_MATCH_RE = /\b(?:contains?|includes?|indexof|startswith|endswith|match|search|regex|regexp)\b|(?:===|==|!==|!=)/i;
// One alternation with a capture group per code, built once. A regex returns
// its leftmost match and, at that position, the first alternative that
// matches, which is the same earliest-index, first-listed-code answer as
// testing each code's pattern separately.
const CODE_RE = new RegExp(FLYWHEEL_ERROR_CODES.map((code) => `\\b(${code.replace(/_/g, "[ _-]?")})\\b`).join("|"), "i");
function findCodeReference(line) {
    const match = CODE_RE.exec(line);
    if (!match)
        return null;
    const group = match.findIndex((value, i) => i > 0 && value !== undefined);
    return { code: FLYWHEEL_ERROR_CODES[group - 1], index: match.index };
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