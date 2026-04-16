import { describe, it, expect } from "vitest";
import { format } from "../../../lint/reporters/pretty.js";
const empty = { findings: [], internalErrors: [] };
const sample = {
    findings: [
        { ruleId: "AUQ002", severity: "warn", file: "skills/b.md", line: 10, column: 1, message: "warn b10" },
        { ruleId: "AUQ001", severity: "error", file: "skills/a.md", line: 47, column: 7, message: "err a47" },
        { ruleId: "AUQ003", severity: "info", file: "skills/a.md", line: 1, column: 1, message: "info a1" },
    ],
    internalErrors: [],
};
describe("pretty reporter", () => {
    it("returns empty string for empty findings + no internal errors", () => {
        expect(format(empty)).toBe("");
    });
    it("groups by file, sorts by (file, line, col, ruleId)", () => {
        const out = format(sample, { noColor: true });
        const aIdx = out.indexOf("skills/a.md");
        const bIdx = out.indexOf("skills/b.md");
        const a1 = out.indexOf("info a1");
        const a47 = out.indexOf("err a47");
        expect(aIdx).toBeGreaterThanOrEqual(0);
        expect(bIdx).toBeGreaterThan(aIdx);
        expect(a1).toBeGreaterThan(aIdx);
        expect(a47).toBeGreaterThan(a1);
    });
    it("noColor=true strips all ANSI codes", () => {
        const out = format(sample, { noColor: true });
        expect(out).not.toMatch(/\x1b\[/);
    });
    it("includes ANSI codes when noColor not set", () => {
        const out = format(sample);
        expect(out).toMatch(/\x1b\[/);
    });
    it("footer summarizes counts", () => {
        const out = format(sample, { noColor: true });
        expect(out).toContain("1 error");
        expect(out).toContain("1 warning");
        expect(out).toContain("1 info");
    });
});
//# sourceMappingURL=pretty.test.js.map