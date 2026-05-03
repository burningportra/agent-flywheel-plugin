import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const fetchInboxMock = vi.fn();
const childExecMock = vi.fn();
vi.mock("../agent-mail.js", () => ({
    fetchInbox: fetchInboxMock,
}));
vi.mock("node:child_process", () => ({
    exec: childExecMock,
}));
vi.mock("../logger.js", () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));
async function loadDaemonModule() {
    return import("../tender-daemon.js");
}
describe("tender-daemon script", () => {
    let tempDir;
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        fetchInboxMock.mockReset();
        childExecMock.mockReset();
        tempDir = await mkdtemp(path.join(tmpdir(), "tender-daemon-"));
        fetchInboxMock.mockResolvedValue([]);
        childExecMock.mockImplementation((command, options, callback) => {
            const cb = typeof options === "function" ? options : callback;
            if (command.includes("--robot-is-working")) {
                cb?.(null, "working\n", "");
            }
            else {
                cb?.(null, JSON.stringify([{ pane: "pane-0", state: "working" }]), "");
            }
            return { pid: 1234, kill: vi.fn() };
        });
    });
    afterEach(async () => {
        vi.useRealTimers();
        await rm(tempDir, { recursive: true, force: true });
    });
    it("returns exit code 2 and prints usage on malformed args", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { runCli } = await loadDaemonModule();
        const code = await runCli(["--unknown=foo"]);
        expect(code).toBe(2);
        const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(output).toContain("Usage:");
        expect(output).toContain("unknown flag '--unknown'");
        stderrSpy.mockRestore();
    });
    it("returns exit code 2 when --session is omitted (still required)", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { runCli } = await loadDaemonModule();
        const code = await runCli(["--project=/tmp"]);
        expect(code).toBe(2);
        const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(output).toContain("missing required --session");
        stderrSpy.mockRestore();
    });
    it("defaults --project to process.cwd() when omitted (regression for v8n)", async () => {
        const { parseTenderDaemonArgs } = await loadDaemonModule();
        const result = parseTenderDaemonArgs(["--session=test-session"]);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.args.session).toBe("test-session");
            expect(result.args.project).toBe(process.cwd());
        }
    });
    it("writes tick events periodically and appends daemon_stopped on stop", async () => {
        const firstMessageTs = new Date("2026-04-24T00:00:00.000Z").toISOString();
        fetchInboxMock
            .mockResolvedValueOnce([
            {
                id: 100,
                sender_name: "RedBear",
                subject: "hello",
                created_ts: firstMessageTs,
            },
        ])
            .mockResolvedValue([]);
        const logfile = path.join(tempDir, "events.log");
        const { startTenderDaemon } = await loadDaemonModule();
        const daemon = await startTenderDaemon({
            session: "test-session",
            project: tempDir,
            interval: 1000,
            logfile,
            agent: "FlywheelAgent",
            ntmTimeoutMs: 2000,
        });
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(1000);
        }
        await daemon.stop("SIGTERM");
        const lines = (await readFile(logfile, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        const tickCount = lines.filter((event) => event.kind === "tick").length;
        expect(tickCount).toBeGreaterThanOrEqual(3);
        expect(lines.some((event) => event.kind === "message_received")).toBe(true);
        expect(lines.at(-1)?.kind).toBe("daemon_stopped");
    });
    it("appends to an existing logfile (does not truncate)", async () => {
        const logfile = path.join(tempDir, "existing.log");
        await writeFile(logfile, '{"kind":"seed"}\n', "utf8");
        const { startTenderDaemon } = await loadDaemonModule();
        const daemon = await startTenderDaemon({
            session: "test-session",
            project: tempDir,
            interval: 1000,
            logfile,
            agent: "FlywheelAgent",
            ntmTimeoutMs: 2000,
        });
        await daemon.stop("SIGTERM");
        const contents = await readFile(logfile, "utf8");
        const lines = contents.trim().split("\n");
        expect(lines[0]).toBe('{"kind":"seed"}');
        expect(lines.some((line) => line.includes('"kind":"tick"'))).toBe(true);
        expect(lines.some((line) => line.includes('"kind":"daemon_stopped"'))).toBe(true);
    });
});
// ─── 3ag — parsePaneStates schema strictness ──────────────────────────────
//
// Before 3ag: parsePaneStates walked every nested object and coerced any
// string-valued top-level key (e.g. health_grade, recommendation, fleet_health)
// into a fake pane entry. The events log filled with bogus
// pane_state_changed entries where `pane` was a JSON key, not a real pane
// ID. Fix: only iterate `parsed.panes[]` (or `parsed.agents[]`); never
// iterate top-level keys.
describe("parsePaneStates schema strictness (3ag)", () => {
    it("ignores top-level scalar keys when no panes[] array is present", async () => {
        const { parsePaneStates } = await loadDaemonModule();
        const realNtmHealthPayload = JSON.stringify({
            health_grade: "B",
            fleet_health: "ok",
            recommendation: "idle",
            summary: "2 working / 4 idle",
        });
        expect(parsePaneStates(realNtmHealthPayload)).toEqual({});
    });
    it("iterates panes[] when the array carrier is present", async () => {
        const { parsePaneStates } = await loadDaemonModule();
        const payload = JSON.stringify({
            health_grade: "B",
            recommendation: "fan-out",
            panes: [
                { pane: "pane-0", state: "working" },
                { name: "pane-1", status: "idle" },
                { id: "pane-2", health: "ok" },
            ],
        });
        expect(parsePaneStates(payload)).toEqual({
            "pane-0": "working",
            "pane-1": "idle",
            "pane-2": "ok",
        });
    });
    it("iterates agents[] as alternate carrier", async () => {
        const { parsePaneStates } = await loadDaemonModule();
        const payload = JSON.stringify({
            agents: [{ pane: "pane-0", state: "working" }],
        });
        expect(parsePaneStates(payload)).toEqual({ "pane-0": "working" });
    });
    it("handles a top-level array of pane rows", async () => {
        const { parsePaneStates } = await loadDaemonModule();
        const payload = JSON.stringify([
            { pane: "pane-0", state: "working" },
            { pane: "pane-1", state: "idle" },
        ]);
        expect(parsePaneStates(payload)).toEqual({
            "pane-0": "working",
            "pane-1": "idle",
        });
    });
    it("does not mistake numeric or non-pane top-level keys for panes", async () => {
        const { parsePaneStates } = await loadDaemonModule();
        // The exact malformed shape observed in the 2026-05-03 feedback:
        // top-level keys "2", "3", and JSON literal-ish state strings.
        const malformed = JSON.stringify({
            "2": "{",
            "3": "[",
            health_grade: "unknown",
        });
        expect(parsePaneStates(malformed)).toEqual({});
    });
});
//# sourceMappingURL=tender-daemon.test.js.map