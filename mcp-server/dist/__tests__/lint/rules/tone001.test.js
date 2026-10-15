import { describe, expect, it } from "vitest";
import { parse } from "../../../lint/parser.js";
import { tone001, countToneTokens } from "../../../lint/rules/tone001.js";
async function runRule(source, opts = {}) {
    const filePath = opts.filePath ?? "inline.md";
    const doc = await parse(source, filePath);
    const ctx = {
        filePath,
        source,
        toneBaseline: opts.baseline ?? {},
    };
    return (await tone001.check(doc, ctx));
}
describe("TONE001", () => {
    it("counts the listed all-caps directive tokens in plain prose", () => {
        const prose = "You MUST stop. Do NOT skip. CRITICAL step. This is MANDATORY. Hard rule applies.";
        // MUST, NEVER (0), MANDATORY, STOP (0 — matches STOP as word; "stop" lowercase doesn't),
        // CRITICAL, IMPORTANT (0), Do NOT (1), Hard rule (1)
        expect(countToneTokens(prose)).toBe(5);
    });
    it("counts quota phrases AT LEAST and NN+", () => {
        const prose = "find AT LEAST 80 issues, surface 100+ findings, no more than 5 total.";
        // AT LEAST (1), 100+ (1); "80" alone is not caught because the pattern is \d{2,}\+
        expect(countToneTokens(prose)).toBe(2);
    });
    it("ignores lowercase occurrences — only shouting is flagged", () => {
        const prose = "The function must not stop; it is important that we never pad.";
        expect(countToneTokens(prose)).toBe(0);
    });
    it("fails when count rises above baseline", async () => {
        const src = ["# Doc", "", "MUST do this.", "NEVER skip.", "CRITICAL step.", ""].join("\n");
        const findings = await runRule(src, { baseline: { "inline.md": 2 } });
        expect(findings).toHaveLength(1);
        const f = findings[0];
        expect(f.ruleId).toBe("TONE001");
        expect(f.severity).toBe("error");
        expect(f.message).toContain("3 discouraged tokens");
        expect(f.message).toContain("ceiling 2");
    });
    it("passes when count equals baseline (ratchet lower-bound respected)", async () => {
        const src = ["# Doc", "", "MUST", "NEVER", "CRITICAL"].join("\n");
        const findings = await runRule(src, { baseline: { "inline.md": 3 } });
        expect(findings).toEqual([]);
    });
    it("passes when count is lower than baseline", async () => {
        const src = ["# Doc", "", "MUST"].join("\n");
        const findings = await runRule(src, { baseline: { "inline.md": 5 } });
        expect(findings).toEqual([]);
    });
    it("ignores tokens inside fenced code blocks", async () => {
        const src = [
            "# Doc",
            "",
            "Normal prose.",
            "",
            "```",
            "MUST do this",
            "NEVER skip",
            "CRITICAL action",
            "```",
            "",
            "More prose.",
        ].join("\n");
        const findings = await runRule(src, { baseline: { "inline.md": 0 } });
        expect(findings).toEqual([]);
    });
    it("ignores tokens inside a Universal Rule block", async () => {
        const src = [
            "# Doc",
            "",
            "## Universal Rule 1",
            "",
            "You MUST route decisions through AskUserQuestion. This is MANDATORY. Do NOT skip.",
            "",
            "## Step 2",
            "",
            "Plain prose.",
        ].join("\n");
        const findings = await runRule(src, { baseline: { "inline.md": 0 } });
        expect(findings).toEqual([]);
    });
    it("still counts tokens in a non-UR section after the UR carve-out ends", async () => {
        const src = [
            "# Doc",
            "",
            "## Universal Rule 1",
            "",
            "MUST route decisions.",
            "",
            "## Step 2",
            "",
            "MUST do another thing.",
        ].join("\n");
        const findings = await runRule(src, { baseline: { "inline.md": 0 } });
        expect(findings).toHaveLength(1);
        expect(findings[0].message).toContain("1 discouraged tokens");
    });
    it("uses baseline=0 for a file not in the baseline map (new file budget is zero)", async () => {
        const src = "# New file\n\nMUST do something.\n";
        const findings = await runRule(src, { baseline: {}, filePath: "skills/new.md" });
        expect(findings).toHaveLength(1);
        expect(findings[0].message).toContain("ceiling 0");
    });
});
//# sourceMappingURL=tone001.test.js.map