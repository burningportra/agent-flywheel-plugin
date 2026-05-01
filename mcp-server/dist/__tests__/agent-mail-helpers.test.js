import { describe, it, expect, vi } from "vitest";
import { reserveOrFail, releaseReservations, } from "../agent-mail-helpers.js";
// ─── Helpers ────────────────────────────────────────────────────
function rpcOk(structuredContent) {
    return {
        code: 0,
        stdout: JSON.stringify({ result: { structuredContent } }),
        stderr: "",
    };
}
function rpcCurlError() {
    return { code: 7, stdout: "", stderr: "Failed to connect" };
}
function scriptedExec(opts) {
    const reservationQueue = [...opts.reservation];
    const releaseQueue = [...(opts.release ?? [])];
    let reservationCalls = 0;
    let releaseCalls = 0;
    const exec = vi.fn(async (_cmd, args) => {
        const dataIdx = args.indexOf("-d");
        const body = dataIdx >= 0 ? args[dataIdx + 1] : "";
        let toolName = "";
        try {
            toolName = JSON.parse(body)?.params?.name ?? "";
        }
        catch {
            toolName = "";
        }
        if (toolName === "file_reservation_paths") {
            reservationCalls++;
            const next = reservationQueue.shift();
            if (!next)
                throw new Error("scriptedExec: ran out of file_reservation_paths responses");
            return next;
        }
        if (toolName === "release_file_reservations") {
            releaseCalls++;
            const next = releaseQueue.shift();
            if (!next) {
                // Default to a successful no-op release if the test didn't script one.
                return rpcOk({ released: 0 });
            }
            return next;
        }
        throw new Error(`scriptedExec: unexpected tool ${toolName}`);
    });
    return {
        exec,
        reservationCalls: () => reservationCalls,
        releaseCalls: () => releaseCalls,
    };
}
function makeOpts(exec, overrides = {}) {
    return {
        exec,
        cwd: "/test/cwd",
        agentName: "TestAgent",
        retryDelayMs: 0,
        reason: "unit-test",
        ...overrides,
    };
}
// ─── reserveOrFail — granted-only success ───────────────────────
describe("reserveOrFail — granted-only success", () => {
    it("returns ok with reservation ids and granted entries on first attempt", async () => {
        const { exec, reservationCalls } = scriptedExec({
            reservation: [
                rpcOk({
                    granted: [{ id: 101, path_pattern: "src/foo.ts", exclusive: true }],
                    conflicts: [],
                }),
            ],
        });
        const result = await reserveOrFail(["src/foo.ts"], makeOpts(exec));
        expect(reservationCalls()).toBe(1);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.reservationIds).toEqual([101]);
            expect(result.granted).toHaveLength(1);
            expect(result.attempts).toBe(1);
        }
    });
    it("treats absent conflicts field as no conflicts", async () => {
        const { exec } = scriptedExec({
            reservation: [rpcOk({ granted: [{ id: 1 }] })],
        });
        const result = await reserveOrFail(["src/x.ts"], makeOpts(exec));
        expect(result.ok).toBe(true);
    });
});
// ─── reserveOrFail — conflicts-only failure ─────────────────────
describe("reserveOrFail — conflicts-only failure", () => {
    it("retries once on conflict, then fails after retry exhausted", async () => {
        const conflicts = [
            { path: "src/foo.ts", holders: [{ agent_name: "OtherAgent", reservation_id: 99 }] },
        ];
        const { exec, reservationCalls, releaseCalls } = scriptedExec({
            reservation: [
                rpcOk({ granted: [], conflicts }),
                rpcOk({ granted: [], conflicts }),
            ],
        });
        const result = await reserveOrFail(["src/foo.ts"], makeOpts(exec));
        expect(reservationCalls()).toBe(2);
        expect(releaseCalls()).toBe(0); // nothing to release — no spurious grants
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("conflicts");
            expect(result.conflicts).toEqual(conflicts);
            expect(result.attempts).toBe(2);
        }
    });
});
// ─── reserveOrFail — granted+conflicts mixed (must fail) ────────
describe("reserveOrFail — mixed granted+conflicts response", () => {
    it("fails even when granted is populated, and releases spurious grants", async () => {
        const conflicts = [
            { path: "src/foo.ts", holders: [{ agent_name: "OtherAgent", reservation_id: 99 }] },
        ];
        const { exec, reservationCalls, releaseCalls } = scriptedExec({
            reservation: [
                rpcOk({
                    granted: [{ id: 555, path_pattern: "src/foo.ts", exclusive: true }],
                    conflicts,
                }),
                rpcOk({
                    granted: [{ id: 556, path_pattern: "src/foo.ts", exclusive: true }],
                    conflicts,
                }),
            ],
            release: [rpcOk({ released: 1 }), rpcOk({ released: 1 })],
        });
        const result = await reserveOrFail(["src/foo.ts"], makeOpts(exec));
        expect(reservationCalls()).toBe(2);
        // The helper must release the spurious grant on EACH conflicted attempt.
        expect(releaseCalls()).toBe(2);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("conflicts");
            expect(result.conflicts).toEqual(conflicts);
        }
    });
});
// ─── reserveOrFail — retry resolves on second attempt ───────────
describe("reserveOrFail — retry-on-conflict resolves on second attempt", () => {
    it("returns ok when the second attempt has no conflicts", async () => {
        const conflicts = [{ path: "src/foo.ts" }];
        const { exec, reservationCalls } = scriptedExec({
            reservation: [
                rpcOk({ granted: [], conflicts }),
                rpcOk({ granted: [{ id: 700 }], conflicts: [] }),
            ],
        });
        const result = await reserveOrFail(["src/foo.ts"], makeOpts(exec));
        expect(reservationCalls()).toBe(2);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.reservationIds).toEqual([700]);
            expect(result.attempts).toBe(2);
        }
    });
});
// ─── reserveOrFail — RPC failure (no retry) ─────────────────────
describe("reserveOrFail — RPC failures do not retry", () => {
    it("returns ok:false reason:rpc_error after a single attempt on transport failure", async () => {
        const { exec, reservationCalls } = scriptedExec({
            reservation: [rpcCurlError()],
        });
        const result = await reserveOrFail(["src/foo.ts"], makeOpts(exec));
        expect(reservationCalls()).toBe(1);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("rpc_error");
            expect(result.attempts).toBe(1);
            expect(result.error?.kind).toMatch(/network|timeout/);
        }
    });
});
// ─── reserveOrFail — empty response ─────────────────────────────
describe("reserveOrFail — empty response edge case", () => {
    it("returns ok:false reason:empty_response when both granted and conflicts are empty", async () => {
        const { exec } = scriptedExec({
            reservation: [rpcOk({ granted: [], conflicts: [] })],
        });
        const result = await reserveOrFail(["src/foo.ts"], makeOpts(exec));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("empty_response");
        }
    });
});
// ─── reserveOrFail — invalid args ───────────────────────────────
describe("reserveOrFail — invalid_args guard", () => {
    it("returns ok:false reason:invalid_args without making an RPC call when paths is empty", async () => {
        const { exec, reservationCalls } = scriptedExec({ reservation: [] });
        const result = await reserveOrFail([], makeOpts(exec));
        expect(reservationCalls()).toBe(0);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("invalid_args");
            expect(result.attempts).toBe(0);
        }
    });
});
// ─── releaseReservations ────────────────────────────────────────
describe("releaseReservations", () => {
    function releaseOpts(exec) {
        return { exec, cwd: "/test/cwd", agentName: "TestAgent" };
    }
    it("returns ok released:0 for empty id list without calling RPC", async () => {
        const exec = vi.fn();
        const result = await releaseReservations([], releaseOpts(exec));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.released).toBe(0);
        expect(exec).not.toHaveBeenCalled();
    });
    it("returns ok with the server-reported released count on success", async () => {
        const { exec } = scriptedExec({
            reservation: [],
            release: [rpcOk({ released: 3 })],
        });
        const result = await releaseReservations([1, 2, 3], releaseOpts(exec));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.released).toBe(3);
    });
    it("falls back to id count when server omits the released field", async () => {
        const { exec } = scriptedExec({
            reservation: [],
            release: [rpcOk({})],
        });
        const result = await releaseReservations([10, 20], releaseOpts(exec));
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.released).toBe(2);
    });
    it("returns ok:false on RPC failure", async () => {
        const { exec } = scriptedExec({
            reservation: [],
            release: [rpcCurlError()],
        });
        const result = await releaseReservations([1], releaseOpts(exec));
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.kind).toMatch(/network|timeout/);
    });
});
//# sourceMappingURL=agent-mail-helpers.test.js.map