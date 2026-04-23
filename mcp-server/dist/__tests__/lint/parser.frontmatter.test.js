// Unit tests for the SKILL.md frontmatter fence pre-check in lint/parser.ts.
//
// Context: CE phase4 blunder #4 — a permissive frontmatter parser that sees
// `---` on line 1 with no closing `---` returns `{data: {}, body: raw}`. The
// whole file (including the YAML lines) becomes the skill body and installs
// with no name/tools. parse() must refuse such files loudly.
//
// Scope:
//   - unclosed fence throws FlywheelError(parse_failure) with the hint from
//     bead agent-flywheel-plugin-o7b
//   - properly-closed frontmatter passes through unchanged
//   - line-1 `---` is required; a `---` in the middle of the document (a
//     thematic break) must not trigger the check
//   - files with no frontmatter at all are untouched
import { describe, it, expect } from "vitest";
import { parse } from "../../lint/parser.js";
import { FlywheelError } from "../../errors.js";
describe("parser frontmatter fence pre-check", () => {
    it("throws FlywheelError with helpful hint on unclosed fence", async () => {
        const src = [
            "---",
            "name: broken",
            "description: missing closing fence",
            "",
            "# Body starts here but parser sees everything as YAML",
            "",
            "Some prose.",
        ].join("\n");
        await expect(parse(src, "skills/broken/SKILL.md")).rejects.toThrowError(FlywheelError);
        try {
            await parse(src, "skills/broken/SKILL.md");
            throw new Error("expected parse to throw");
        }
        catch (err) {
            expect(err).toBeInstanceOf(FlywheelError);
            const fe = err;
            expect(fe.code).toBe("parse_failure");
            expect(fe.hint).toBe("frontmatter started at line 1 but never closed — add ---");
            expect(fe.message).toContain("skills/broken/SKILL.md");
            expect(fe.details?.filePath).toBe("skills/broken/SKILL.md");
        }
    });
    it("throws on unclosed fence with CRLF line endings (post-preprocess)", async () => {
        const src = "---\r\nname: broken\r\nBody\r\n";
        await expect(parse(src, "crlf.md")).rejects.toThrowError(FlywheelError);
    });
    it("accepts properly-closed frontmatter", async () => {
        const src = [
            "---",
            "name: good",
            "description: a skill",
            "---",
            "",
            "# Body",
            "",
            "Some prose.",
        ].join("\n");
        const doc = await parse(src, "skills/good/SKILL.md");
        expect(doc.filePath).toBe("skills/good/SKILL.md");
        expect(doc.headers.length).toBeGreaterThanOrEqual(1);
    });
    it("does not trigger on thematic break mid-document (no line-1 opener)", async () => {
        const src = [
            "# Title",
            "",
            "First section.",
            "",
            "---",
            "",
            "Second section (the `---` above is a thematic break).",
        ].join("\n");
        // Should not throw: line 1 is "# Title", not "---".
        await expect(parse(src, "no-fm.md")).resolves.toBeDefined();
    });
    it("does not trigger on files with no frontmatter at all", async () => {
        const src = "# Plain skill\n\nNo YAML anywhere.\n";
        await expect(parse(src, "plain.md")).resolves.toBeDefined();
    });
    it("accepts empty string (no line-1 opener)", async () => {
        await expect(parse("", "empty.md")).resolves.toBeDefined();
    });
});
//# sourceMappingURL=parser.frontmatter.test.js.map