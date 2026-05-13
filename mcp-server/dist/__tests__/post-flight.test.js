import { describe, it, expect, vi } from "vitest";
import { runPostFlight } from "../setup-detector.js";
/**
 * T3.4 contract — post-flight calls flywheel_doctor exactly once and
 * renders either a success banner (green) or a failing-checks list with
 * each check's hint surfaced.
 */
describe("runPostFlight (T3.4)", () => {
    it("calls doctor once and emits 'Setup complete' on a green report", async () => {
        const doctorMock = vi.fn().mockResolvedValue({
            overall: "green",
            checks: [],
        });
        const summary = await runPostFlight({ cwd: "/test", doctor: doctorMock });
        expect(doctorMock).toHaveBeenCalledTimes(1);
        expect(doctorMock).toHaveBeenCalledWith({ cwd: "/test" });
        expect(summary).toMatch(/Setup complete/);
        expect(summary).toMatch(/\/agent-flywheel:start/);
    });
    it("yellow: lists failing checks with their hint", async () => {
        const doctorMock = vi.fn().mockResolvedValue({
            overall: "yellow",
            checks: [
                { name: "bv_binary", severity: "green", message: "v1" },
                {
                    name: "ntm_binary",
                    severity: "yellow",
                    message: "not on PATH",
                    hint: "brew install dicklesworthstone/tap/ntm",
                },
            ],
        });
        const summary = await runPostFlight({ cwd: "/test", doctor: doctorMock });
        expect(summary).toMatch(/1 issue/);
        expect(summary).toMatch(/ntm_binary/);
        expect(summary).toMatch(/not on PATH/);
        expect(summary).toMatch(/brew install dicklesworthstone\/tap\/ntm/);
    });
    it("red: lists all non-green checks (yellow + red) with hint or default fallback", async () => {
        const doctorMock = vi.fn().mockResolvedValue({
            overall: "red",
            checks: [
                { name: "node_version", severity: "red", message: "node 16 < 20" },
                {
                    name: "agent_mail_liveness",
                    severity: "yellow",
                    message: "no response",
                    hint: "am serve-http &",
                },
            ],
        });
        const summary = await runPostFlight({ cwd: "/test", doctor: doctorMock });
        expect(summary).toMatch(/2 issue/);
        expect(summary).toMatch(/node_version/);
        expect(summary).toMatch(/see \/flywheel-doctor/); // default hint fallback
        expect(summary).toMatch(/agent_mail_liveness/);
        expect(summary).toMatch(/am serve-http/);
    });
    it("never invokes the doctor more than once even on yellow", async () => {
        const doctorMock = vi.fn().mockResolvedValue({
            overall: "yellow",
            checks: [{ name: "x", severity: "yellow", message: "y" }],
        });
        await runPostFlight({ cwd: "/test", doctor: doctorMock });
        expect(doctorMock).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=post-flight.test.js.map