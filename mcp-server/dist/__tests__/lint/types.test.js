import { describe, it, expect } from "vitest";
describe("types", () => {
    it("Finding shape compiles with required fields only", () => {
        const f = {
            ruleId: "X",
            severity: "error",
            file: "a.md",
            line: 1,
            column: 1,
            message: "m",
        };
        expect(f.ruleId).toBe("X");
    });
    it("LintResult shape has findings + internalErrors arrays", () => {
        const r = { findings: [], internalErrors: [] };
        expect(Array.isArray(r.findings)).toBe(true);
        expect(Array.isArray(r.internalErrors)).toBe(true);
    });
});
//# sourceMappingURL=types.test.js.map