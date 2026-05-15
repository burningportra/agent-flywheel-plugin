import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Regression test for claude-orchestrator-6bxt.
 *
 * Step 0c of `skills/start/SKILL.md` must surface failing doctor checks when
 * the overall severity is either yellow OR red — not red-only. Prior wording
 * gated the per-check list on `overall === "red"`, which silently hid
 * `checkpoint_validity` and `codex_config_compat` yellow rows that materially
 * affected the 2026-05-15 session. This test guards against drift back to
 * red-only.
 *
 * Markdown lint, not unit — Step 0c is markdown prose interpreted by the LLM,
 * so we assert the document carries the canonical phrasing rather than test a
 * runtime function.
 */
const SKILL_PATH = resolve(__dirname, "../../../skills/start/SKILL.md");
let skillBody;
beforeAll(() => {
    skillBody = readFileSync(SKILL_PATH, "utf8");
});
describe("Step 0c yellow doctor surfacing (claude-orchestrator-6bxt)", () => {
    it("trigger condition mentions both red and yellow overalls", () => {
        // The exact match string. If anyone reverts to red-only, this fails loudly.
        expect(skillBody).toMatch(/`DOCTOR_REPORT\.overall === "red"` OR `DOCTOR_REPORT\.overall === "yellow"`/);
    });
    it("doctor surfacing block mentions both severities in {yellow, red}", () => {
        // Looser content check: the per-check filter must cover both severities.
        expect(skillBody).toMatch(/severity` in `\{ "yellow", "red" \}`/);
    });
    it("yellow rows render with ⚠ and red rows render with ✗", () => {
        expect(skillBody).toMatch(/⚠ <check_name>/);
        expect(skillBody).toMatch(/✗ <check_name>/);
    });
    it('non-blocking note for yellow is present', () => {
        expect(skillBody).toMatch(/Yellow checks are non-blocking/);
    });
    it("Step 0b smoke-check description also covers yellow (not just red)", () => {
        // Line 148 used to say only red — keep it aligned with the Step 0c rule.
        expect(skillBody).toMatch(/`DOCTOR_REPORT\.overall` is `"red"` OR `"yellow"`/);
    });
    it("red-only phrasing is fully retired from Step 0b/0c surfacing rule", () => {
        // Guard against partial reverts: the exact red-only conditional must not
        // exist anywhere in the doctor-surfacing prose. Step 0b smoke-check + Step
        // 0c surfacing rule are the two sites that previously hard-coded it.
        const redOnlyConditional = /If `DOCTOR_REPORT\.overall === "red"`, (?:the banner|under the banner)/;
        expect(skillBody).not.toMatch(redOnlyConditional);
    });
});
//# sourceMappingURL=preflight-yellow.test.js.map