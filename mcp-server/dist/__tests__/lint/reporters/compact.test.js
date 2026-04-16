import { describe, it, expect } from "vitest";
import { format } from "../../../lint/reporters/compact.js";
const empty = { findings: [], internalErrors: [] };
const sample = {
    findings: [
        { ruleId: "AUQ002", severity: "warn", file: "skills/b.md", line: 10, column: 1, message: "warn b10" },
        { ruleId: "AUQ001", severity: "error", file: "skills/a.md", line: 47, column: 7, message: "err a47" },
    ],
    internalErrors: [],
};
const ESLINT_LINE = /^[^:]+:\d+:\d+: (error|warning|info) [A-Z0-9_]+: .+$/;
describe("compact reporter", () => {
    it("empty findings → empty output", () => {
        expect(format(empty)).toBe("");
    });
    it("sorts and emits ESLint-style one-liners (no ANSI)", () => {
        const out = format(sample);
        const lines = out.split("\n");
        expect(lines.length).toBe(2);
        expect(out).not.toMatch(/\x1b\[/);
        for (const l of lines) {
            expect(l).toMatch(ESLINT_LINE);
        }
        expect(lines[0]).toContain("skills/a.md:47:7: error AUQ001");
        expect(lines[1]).toContain("skills/b.md:10:1: warning AUQ002");
    });
});
//# sourceMappingURL=compact.test.js.map