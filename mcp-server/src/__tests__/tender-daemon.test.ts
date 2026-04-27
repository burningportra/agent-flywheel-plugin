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
  let tempDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    fetchInboxMock.mockReset();
    childExecMock.mockReset();
    tempDir = await mkdtemp(path.join(tmpdir(), "tender-daemon-"));

    fetchInboxMock.mockResolvedValue([]);
    childExecMock.mockImplementation((command: string, options: unknown, callback?: (...args: unknown[]) => void) => {
      const cb = typeof options === "function" ? options : callback;
      if (command.includes("--robot-is-working")) {
        cb?.(null, "working\n", "");
      } else {
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
      .map((line) => JSON.parse(line) as { kind: string });

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
