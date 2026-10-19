import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFreshEyesPrompt } from "../gates.js";
const baseOptions = {
    round: 3,
    memoryContext: "\n\n## Prior Session Learnings\nkeep reservations narrow\n",
    allArtifacts: ["src/a.ts", "src/b.ts"],
    callbackHint: "\n\nCALLBACK",
    regressionHint: "\n\nREGRESSION",
};
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
describe("buildFreshEyesPrompt", () => {
    it("pins the reviewer prompt without structured findings byte-for-byte", () => {
        const prompt = buildFreshEyesPrompt({
            ...baseOptions,
            emitStructuredFindings: false,
        });
        expect(Buffer.byteLength(prompt)).toBe(780);
        expect(sha256(prompt)).toBe("7d7eb37605cd8d4257f7d78f890cfc3ca8fd0a47174a07ed7eba8c3a48dd825b");
        expect(prompt).toContain("- src/a.ts\n- src/b.ts");
        expect(prompt).not.toContain("STRUCTURED FINDINGS REQUIRED");
        expect(prompt).not.toContain("Coordinator routing");
        expect(prompt).not.toContain("ntm --robot-send");
        expect(prompt).not.toContain("DO NOT");
        expect(prompt).not.toContain("⚠");
        expect(prompt.match(/Use ultrathink\./g)).toHaveLength(1);
    });
    it("pins the reviewer prompt with its structured findings file byte-for-byte", () => {
        const prompt = buildFreshEyesPrompt({
            ...baseOptions,
            shaRange: "abc123..def456",
            findingsPath: "/repo/.pi-flywheel/batch-reviews/abc123..def456.json",
            emitStructuredFindings: true,
        });
        expect(Buffer.byteLength(prompt)).toBe(1708);
        expect(sha256(prompt)).toBe("56e8abdd5a016479b837d78899443cade33075b44240a5ea00c8d22752b96109");
        expect(prompt).toContain("Every finding becomes a bead, prioritized by severity, so list only real issues.");
        expect(prompt).toContain('"sha_range": "abc123..def456"');
        expect(prompt).toContain("`/repo/.pi-flywheel/batch-reviews/abc123..def456.json`");
        expect(prompt).toContain("The server reads only this file.");
        expect(prompt).not.toContain("append a JSON object");
        expect(prompt).not.toContain("DO NOT");
        expect(prompt).not.toContain("⚠");
        expect(prompt.match(/Use ultrathink\./g)).toHaveLength(1);
    });
});
//# sourceMappingURL=gates.test.js.map