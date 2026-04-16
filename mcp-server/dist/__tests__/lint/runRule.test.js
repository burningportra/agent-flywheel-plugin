import { describe, it, expect } from "vitest";
import { runRule } from "../../lint/runRule.js";
const doc = { source: "", filePath: "x.md" };
const ctx = { filePath: "x.md", source: "" };
function makeFinding(ruleId, message) {
    return { ruleId, severity: "error", file: "x.md", line: 1, column: 1, message };
}
describe("runRule", () => {
    it("returns findings from a sync rule", async () => {
        const rule = {
            id: "R1",
            description: "",
            severity: "error",
            check: () => [makeFinding("R1", "found")],
        };
        const r = await runRule(rule, doc, ctx);
        expect(r.findings.length).toBe(1);
        expect(r.findings[0].message).toBe("found");
        expect(r.internalError).toBeUndefined();
    });
    it("returns findings from an async rule (Promise<Finding[]>)", async () => {
        const rule = {
            id: "R2",
            description: "",
            severity: "error",
            check: async () => [makeFinding("R2", "async-found"), makeFinding("R2", "async-found-2")],
        };
        const r = await runRule(rule, doc, ctx);
        expect(r.findings.length).toBe(2);
        expect(r.internalError).toBeUndefined();
    });
    it("captures thrown errors as internalError, no findings", async () => {
        const rule = {
            id: "R3",
            description: "",
            severity: "error",
            check: () => {
                throw new Error("boom");
            },
        };
        const r = await runRule(rule, doc, ctx);
        expect(r.findings).toEqual([]);
        expect(r.internalError).toBeDefined();
        expect(r.internalError.ruleId).toBe("R3");
        expect(r.internalError.message).toBe("boom");
    });
    it("captures async rejections as internalError", async () => {
        const rule = {
            id: "R4",
            description: "",
            severity: "error",
            check: async () => {
                throw new Error("async-boom");
            },
        };
        const r = await runRule(rule, doc, ctx);
        expect(r.findings).toEqual([]);
        expect(r.internalError).toBeDefined();
        expect(r.internalError.ruleId).toBe("R4");
        expect(r.internalError.message).toBe("async-boom");
    });
    it("times out a hanging rule and reports internalError with 'timeout'", async () => {
        const rule = {
            id: "R5",
            description: "",
            severity: "error",
            check: () => new Promise(() => { }),
        };
        const r = await runRule(rule, doc, ctx, { timeoutMs: 50 });
        expect(r.findings).toEqual([]);
        expect(r.internalError).toBeDefined();
        expect(r.internalError.ruleId).toBe("R5");
        expect(r.internalError.message).toMatch(/timeout/i);
    });
    it("normalizes a null/undefined return to empty findings", async () => {
        const rule = {
            id: "R6",
            description: "",
            severity: "error",
            check: () => undefined,
        };
        const r = await runRule(rule, doc, ctx);
        expect(r.findings).toEqual([]);
        expect(r.internalError).toBeUndefined();
    });
    it("respects an AbortSignal — aborted rule becomes internalError", async () => {
        const ac = new AbortController();
        const rule = {
            id: "R7",
            description: "",
            severity: "error",
            check: () => new Promise(() => { }),
        };
        setTimeout(() => ac.abort(), 20);
        const r = await runRule(rule, doc, ctx, { timeoutMs: 5000, signal: ac.signal });
        expect(r.findings).toEqual([]);
        expect(r.internalError).toBeDefined();
        expect(r.internalError.message).toMatch(/abort/i);
    });
});
//# sourceMappingURL=runRule.test.js.map