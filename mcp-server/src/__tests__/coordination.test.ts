import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCoordinationBackend,
  resetDetection,
  selectMode,
  selectStrategy,
} from "../coordination.js";
import type { CoordinationBackend } from "../coordination.js";
import type { ExecFn } from "../exec.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeBackend(overrides: Partial<CoordinationBackend> = {}): CoordinationBackend {
  return {
    beads: false,
    agentMail: false,
    sophia: false,
    preCommitGuardInstalled: false,
    ...overrides,
  };
}

function makeTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "flywheel-coordination-"));
}

function unavailableToolExec(calls: string[]): ExecFn {
  return vi.fn(async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "br" || cmd === "sophia") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
}

// ─── selectStrategy ─────────────────────────────────────────────

describe("selectStrategy", () => {
  it('returns "beads+agentmail" when beads and agentMail are both available', () => {
    const backend = makeBackend({ beads: true, agentMail: true });
    expect(selectStrategy(backend)).toBe("beads+agentmail");
  });

  it('returns "sophia" when sophia backend is available', () => {
    const backend = makeBackend({ sophia: true });
    expect(selectStrategy(backend)).toBe("sophia");
  });

  it('returns "worktrees" when only beads is available (no agentMail)', () => {
    const backend = makeBackend({ beads: true, agentMail: false });
    expect(selectStrategy(backend)).toBe("worktrees");
  });

  it('returns "worktrees" when nothing is available', () => {
    const backend = makeBackend();
    expect(selectStrategy(backend)).toBe("worktrees");
  });
});

// ─── selectMode ─────────────────────────────────────────────────

describe("selectMode", () => {
  it('returns "single-branch" when agentMail is available', () => {
    const backend = makeBackend({ agentMail: true });
    expect(selectMode(backend)).toBe("single-branch");
  });

  it('returns "worktree" when agentMail is not available', () => {
    const backend = makeBackend({ agentMail: false });
    expect(selectMode(backend)).toBe("worktree");
  });
});

// ─── agent-mail detection ───────────────────────────────────────

describe("coordination agent-mail detection", () => {
  let cwd: string | undefined;

  afterEach(() => {
    resetDetection();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("starts the Rust am CLI before trying legacy Python", async () => {
    cwd = makeTempCwd();
    const calls: string[] = [];
    let curlCalls = 0;
    const baseExec = unavailableToolExec(calls);
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[], opts) => {
      if (cmd === "curl") {
        calls.push(`${cmd} ${args.join(" ")}`);
        curlCalls += 1;
        return curlCalls === 1
          ? { code: 7, stdout: "", stderr: "connection refused" }
          : { code: 0, stdout: '{"status":"alive"}', stderr: "" };
      }
      const commandLine = `${cmd} ${args.join(" ")}`;
      if (commandLine.includes("command -v am")) {
        calls.push(commandLine);
        return { code: 0, stdout: "/Users/test/.local/bin/am\n", stderr: "" };
      }
      if (commandLine.includes("nohup am serve-http")) {
        calls.push(commandLine);
        return { code: 0, stdout: "", stderr: "" };
      }
      return baseExec(cmd, args, opts);
    });

    const result = await detectCoordinationBackend(exec, cwd);

    expect(result.agentMail).toBe(true);
    expect(calls.some((call) => call.includes("nohup am serve-http"))).toBe(true);
    expect(calls.some((call) => call.includes("mcp_agent_mail"))).toBe(false);
  });

  it("starts mcp-agent-mail serve when am is unavailable", async () => {
    cwd = makeTempCwd();
    const calls: string[] = [];
    let curlCalls = 0;
    const baseExec = unavailableToolExec(calls);
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[], opts) => {
      if (cmd === "curl") {
        calls.push(`${cmd} ${args.join(" ")}`);
        curlCalls += 1;
        return curlCalls === 1
          ? { code: 7, stdout: "", stderr: "connection refused" }
          : { code: 0, stdout: '{"status":"alive"}', stderr: "" };
      }
      const commandLine = `${cmd} ${args.join(" ")}`;
      if (commandLine.includes("command -v am")) {
        calls.push(commandLine);
        return { code: 1, stdout: "", stderr: "" };
      }
      if (commandLine.includes("command -v mcp-agent-mail")) {
        calls.push(commandLine);
        return { code: 0, stdout: "/Users/test/.local/bin/mcp-agent-mail\n", stderr: "" };
      }
      if (commandLine.includes("nohup mcp-agent-mail serve")) {
        calls.push(commandLine);
        return { code: 0, stdout: "", stderr: "" };
      }
      return baseExec(cmd, args, opts);
    });

    const result = await detectCoordinationBackend(exec, cwd);

    expect(result.agentMail).toBe(true);
    expect(calls.some((call) => call.includes("nohup mcp-agent-mail serve"))).toBe(true);
    expect(calls.some((call) => call.includes("mcp_agent_mail"))).toBe(false);
  });

  it("falls back to the legacy Python server only when Rust binaries are missing", async () => {
    cwd = makeTempCwd();
    const calls: string[] = [];
    let curlCalls = 0;
    const baseExec = unavailableToolExec(calls);
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[], opts) => {
      if (cmd === "curl") {
        calls.push(`${cmd} ${args.join(" ")}`);
        curlCalls += 1;
        return curlCalls === 1
          ? { code: 7, stdout: "", stderr: "connection refused" }
          : { code: 0, stdout: '{"status":"alive"}', stderr: "" };
      }
      const commandLine = `${cmd} ${args.join(" ")}`;
      if (commandLine.includes("command -v am") || commandLine.includes("command -v mcp-agent-mail")) {
        calls.push(commandLine);
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd === "uv" && args.join(" ") === "run python -c import mcp_agent_mail") {
        calls.push(commandLine);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (commandLine.includes("nohup uv run python -m mcp_agent_mail.cli serve-http")) {
        calls.push(commandLine);
        return { code: 0, stdout: "", stderr: "" };
      }
      return baseExec(cmd, args, opts);
    });

    const result = await detectCoordinationBackend(exec, cwd);

    expect(result.agentMail).toBe(true);
    expect(calls.some((call) => call.includes("nohup uv run python -m mcp_agent_mail.cli serve-http"))).toBe(true);
  });
});
