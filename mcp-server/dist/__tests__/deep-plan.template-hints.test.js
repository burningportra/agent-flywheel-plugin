import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEMPLATE_HINT_REGEX, parseTemplateHint, synthesizerTemplateHintGuidance, } from "../deep-plan.js";
describe("TEMPLATE_HINT_REGEX", () => {
    it("matches canonical hints", () => {
        expect(TEMPLATE_HINT_REGEX.test("foundation-with-fresh-eyes-gate@1")).toBe(true);
        expect(TEMPLATE_HINT_REGEX.test("add-feature@2")).toBe(true);
    });
    it("rejects hints with uppercase or spaces", () => {
        expect(TEMPLATE_HINT_REGEX.test("Foundation@1")).toBe(false);
        expect(TEMPLATE_HINT_REGEX.test("foundation @ 1")).toBe(false);
    });
    it("rejects hints without version", () => {
        expect(TEMPLATE_HINT_REGEX.test("foundation-with-fresh-eyes-gate")).toBe(false);
        expect(TEMPLATE_HINT_REGEX.test("foundation@")).toBe(false);
    });
    it("rejects hints starting with a digit or hyphen", () => {
        expect(TEMPLATE_HINT_REGEX.test("1foundation@1")).toBe(false);
        expect(TEMPLATE_HINT_REGEX.test("-foundation@1")).toBe(false);
    });
});
describe("parseTemplateHint — happy path", () => {
    it("parses a well-formed hint", () => {
        const parsed = parseTemplateHint("foundation-with-fresh-eyes-gate@1");
        expect(parsed).toEqual({ id: "foundation-with-fresh-eyes-gate", version: 1 });
    });
    it("tolerates surrounding whitespace", () => {
        expect(parseTemplateHint("  add-feature@1  ")).toEqual({ id: "add-feature", version: 1 });
    });
    it("parses multi-digit versions", () => {
        expect(parseTemplateHint("new-mcp-tool@42")).toEqual({ id: "new-mcp-tool", version: 42 });
    });
});
describe("parseTemplateHint — backward-compat / passthrough", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stderr;
    beforeEach(() => {
        stderr = vi
            .spyOn(process.stderr, "write")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mockImplementation((() => true));
    });
    afterEach(() => stderr.mockRestore());
    it("returns undefined when hint is undefined", () => {
        expect(parseTemplateHint(undefined)).toBeUndefined();
        expect(stderr).not.toHaveBeenCalled();
    });
    it("returns undefined when hint is null", () => {
        expect(parseTemplateHint(null)).toBeUndefined();
        expect(stderr).not.toHaveBeenCalled();
    });
    it("returns undefined for non-string input without warning", () => {
        expect(parseTemplateHint(42)).toBeUndefined();
        expect(parseTemplateHint({ id: "foo", version: 1 })).toBeUndefined();
        expect(stderr).not.toHaveBeenCalled();
    });
    it("returns undefined for empty / whitespace-only strings", () => {
        expect(parseTemplateHint("")).toBeUndefined();
        expect(parseTemplateHint("   ")).toBeUndefined();
        expect(stderr).not.toHaveBeenCalled();
    });
    it("warns and returns undefined for malformed hints", () => {
        const parsed = parseTemplateHint("bad");
        expect(parsed).toBeUndefined();
        expect(stderr).toHaveBeenCalledTimes(1);
        const firstArg = stderr.mock.calls[0][0];
        expect(firstArg).toContain("malformed template hint");
        expect(firstArg).toContain('"bad"');
    });
    it("warns on hints with no version separator", () => {
        const parsed = parseTemplateHint("foundation-no-version");
        expect(parsed).toBeUndefined();
        expect(stderr).toHaveBeenCalledTimes(1);
    });
    it("warns on hints with zero version", () => {
        // Regex rejects `@0`? The regex matches \d+ which accepts 0, so the parseInt
        // branch is the guard — version must be >= 1.
        const parsed = parseTemplateHint("add-feature@0");
        expect(parsed).toBeUndefined();
        expect(stderr).toHaveBeenCalledTimes(1);
        const firstArg = stderr.mock.calls[0][0];
        expect(firstArg).toContain("non-positive version");
    });
});
describe("synthesizerTemplateHintGuidance", () => {
    it("documents the hint syntax and final calibration metadata", () => {
        const text = synthesizerTemplateHintGuidance();
        expect(text).toContain("template: <id>@<version>");
        expect(text).toContain("expandTemplate");
        expect(text).toContain("Template: <id>");
        expect(text).toContain("flywheel_calibrate");
    });
    it("shows the regex for agent reference", () => {
        const text = synthesizerTemplateHintGuidance();
        expect(text).toContain("[a-z]");
        expect(text).toContain("\\d+");
    });
});
//# sourceMappingURL=deep-plan.template-hints.test.js.map