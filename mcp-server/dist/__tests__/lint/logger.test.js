import { describe, it, expect, vi } from "vitest";
import { createLintLogger } from "../../lint/logger.js";
describe("createLintLogger", () => {
    it("writes only to stderr (NOT stdout)", () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const log = createLintLogger("test", { levelOverride: "info" });
        log.warn("hello");
        expect(stderrSpy).toHaveBeenCalled();
        expect(stdoutSpy).not.toHaveBeenCalled();
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
    });
    it("respects level cap (warn does not emit info)", () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const log = createLintLogger("test", { levelOverride: "warn" });
        log.info("should not emit");
        expect(stderrSpy).not.toHaveBeenCalled();
        stderrSpy.mockRestore();
    });
    it("emits valid JSON line per call", () => {
        const captured = [];
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
            captured.push(String(s));
            return true;
        });
        const log = createLintLogger("ctx", { levelOverride: "debug" });
        log.error("msg", { a: 1 });
        stderrSpy.mockRestore();
        expect(captured).toHaveLength(1);
        const parsed = JSON.parse(captured[0]);
        expect(parsed).toMatchObject({ level: "error", ctx: "ctx", msg: "msg", a: 1 });
        expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});
//# sourceMappingURL=logger.test.js.map