import { describe, it, expect } from "vitest";
import { pickAnswer } from "./pick.js";
const opts = (...labels) => labels.map((l) => ({ label: l, description: l }));
describe("pickAnswer (M3 reopen fix — header-first matching)", () => {
    it("matches a rule by header and returns the matched option", () => {
        const scripted = [{ headerContains: "plan mode", option: "Standard plan" }];
        const r = pickAnswer("Plan mode", opts("Standard plan", "Deep plan"), scripted);
        expect(r.kind).toBe("matched");
        if (r.kind === "matched") {
            expect(r.label).toBe("Standard plan");
            expect(r.ruleTarget).toBe("Standard plan");
        }
    });
    it("does NOT fire a header rule from question text (regression for s4 reopen)", () => {
        // Before the fix, pickAnswer scanned header + question text so a rule
        // for "pre-flight" fired on an ad-hoc Scope question whose text mentioned
        // "Pre-flight: resolve NTM readiness". The fix: match on header only.
        const scripted = [{ headerContains: "pre-flight", option: "Continue" }];
        const r = pickAnswer("Scope", opts("Finish the gates", "Full scope as written", "Docs and tests only"), scripted);
        // No rule matched by header → default fallback is options[0].
        expect(r.kind).toBe("default");
        if (r.kind === "default")
            expect(r.label).toBe("Finish the gates");
    });
    it("fails with kind=unmatched when the rule target matches no offered label", () => {
        const scripted = [{ headerContains: "plan mode", option: "Lightning plan" }];
        const r = pickAnswer("Plan mode", opts("Standard plan", "Deep plan", "Duel plan", "planning-workflow"), scripted);
        expect(r.kind).toBe("unmatched");
        if (r.kind === "unmatched") {
            expect(r.ruleTarget).toBe("Lightning plan");
            expect(r.labels).toContain("Standard plan");
        }
    });
    it("returns default (kind) when no scripted rule matches the header", () => {
        const scripted = [{ headerContains: "plan mode", option: "Standard plan" }];
        const r = pickAnswer("Metric", opts("ms", "ops/sec", "cost"), scripted);
        expect(r.kind).toBe("default");
        if (r.kind === "default") {
            expect(r.label).toBe("ms");
            expect(r.labels).toEqual(["ms", "ops/sec", "cost"]);
        }
    });
    it("is case-insensitive on both header and target", () => {
        const scripted = [{ headerContains: "PLAN MODE", option: "STANDARD PLAN" }];
        const r = pickAnswer("Plan mode", opts("Standard plan", "Deep plan"), scripted);
        expect(r.kind).toBe("matched");
        if (r.kind === "matched")
            expect(r.label).toBe("Standard plan");
    });
    it("picks the FIRST matching rule when more than one rule matches a header", () => {
        const scripted = [
            { headerContains: "plan", option: "Refine plan" },
            { headerContains: "plan review", option: "Create beads" },
        ];
        const r = pickAnswer("Plan review", opts("Create beads", "Refine plan", "Stop here"), scripted);
        expect(r.kind).toBe("matched");
        if (r.kind === "matched")
            expect(r.ruleTarget).toBe("Refine plan");
    });
    it("empty options list with no rule yields default with empty label", () => {
        const r = pickAnswer("Anything", [], []);
        expect(r.kind).toBe("default");
        if (r.kind === "default")
            expect(r.label).toBe("");
    });
});
//# sourceMappingURL=pick.test.js.map