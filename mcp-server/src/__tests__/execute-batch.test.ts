import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, mkdir, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeBatch,
  performSymlink,
  registerMcpAtomic,
  type BatchExecutor,
  type BatchResult,
  type InstallPlan,
} from "../setup-detector.js";

/**
 * T3.3 contract — executeBatch walks an InstallPlan in a fixed order:
 *   install → register → configure (symlink) → start (agent-mail)
 * with no parallelism, and surfaces per-step results in the returned array.
 */

function createBatchStub(): BatchExecutor & {
  calls: Array<{ fn: string; arg?: string }>;
  failOn?: string;
} {
  const calls: Array<{ fn: string; arg?: string }> = [];
  const stub = {
    calls,
    failOn: undefined as string | undefined,
    async installTool(name: string): Promise<BatchResult> {
      calls.push({ fn: "installTool", arg: name });
      if (this.failOn === `installTool:${name}`) {
        return { status: "error", step: "installTool", target: name, error: "boom" };
      }
      return { status: "ok", step: "installTool", target: name };
    },
    async registerMcp(name: string): Promise<BatchResult> {
      calls.push({ fn: "registerMcp", arg: name });
      return { status: "ok", step: "registerMcp", target: name };
    },
    async symlink(spec: string): Promise<BatchResult> {
      calls.push({ fn: "symlink", arg: spec });
      return { status: "ok", step: "symlink", target: spec };
    },
    async startAgentMail(): Promise<BatchResult> {
      calls.push({ fn: "startAgentMail" });
      return { status: "ok", step: "startAgentMail" };
    },
  };
  return stub;
}

describe("executeBatch (T3.3)", () => {
  it("runs install → register → symlink → startAgentMail in that order", async () => {
    const plan: InstallPlan = {
      install: ["br"],
      register: ["agent-flywheel MCP server"],
      start: ["agent-mail HTTP"],
      configure: ["projects_base symlink: /base/proj"],
      skip: [],
    };
    const stub = createBatchStub();
    const results = await executeBatch(plan, stub);
    expect(stub.calls).toEqual([
      { fn: "installTool", arg: "br" },
      { fn: "registerMcp", arg: "agent-flywheel MCP server" },
      { fn: "symlink", arg: "projects_base symlink: /base/proj" },
      { fn: "startAgentMail" },
    ]);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("returns one result per planned action; empty bucket → zero calls in that bucket", async () => {
    const plan: InstallPlan = {
      install: ["br", "bv"],
      register: [],
      start: ["agent-mail HTTP"],
      configure: [],
      skip: ["cm"],
    };
    const stub = createBatchStub();
    const results = await executeBatch(plan, stub);
    expect(stub.calls.map((c) => c.fn)).toEqual([
      "installTool",
      "installTool",
      "startAgentMail",
    ]);
    expect(results).toHaveLength(3);
  });

  it("does not invoke startAgentMail when the start bucket is empty", async () => {
    const plan: InstallPlan = {
      install: [],
      register: [],
      start: [],
      configure: [],
      skip: ["agent-mail HTTP", "br", "bv"],
    };
    const stub = createBatchStub();
    const results = await executeBatch(plan, stub);
    expect(stub.calls).toEqual([]);
    expect(results).toEqual([]);
  });

  it("does not short-circuit on a failed step — caller decides retry/skip/abort", async () => {
    const plan: InstallPlan = {
      install: ["br"],
      register: ["MCP"],
      start: [],
      configure: [],
      skip: [],
    };
    const stub = createBatchStub();
    stub.failOn = "installTool:br";
    const results = await executeBatch(plan, stub);
    expect(results[0].status).toBe("error");
    expect(stub.calls.map((c) => c.fn)).toEqual(["installTool", "registerMcp"]);
  });
});

describe("performSymlink", () => {
  let scratch: string;
  let ntmBase: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fw-batch-cwd-"));
    ntmBase = await mkdtemp(join(tmpdir(), "fw-batch-ntm-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(ntmBase, { recursive: true, force: true });
  });

  it("parses plan-line spec and creates the symlink", async () => {
    const target = join(ntmBase, "proj");
    const result = await performSymlink(scratch, `projects_base symlink: ${target}`);
    expect(result.status).toBe("ok");
    expect(result.target).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(await readlink(target)).toBe(scratch);
  });

  it("is idempotent when target already exists", async () => {
    const target = join(ntmBase, "proj");
    await performSymlink(scratch, target);
    const second = await performSymlink(scratch, target);
    expect(second.status).toBe("ok");
    expect(second.note).toBe("already symlinked");
  });

  it("returns error on filesystem failure", async () => {
    const target = join(ntmBase, "does-not-exist-dir", "proj");
    const result = await performSymlink(scratch, target);
    expect(result.status).toBe("error");
    expect(result.error).toBeTruthy();
  });
});

describe("registerMcpAtomic", () => {
  let scratch: string;
  let cfg: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fw-batch-cfg-"));
    cfg = join(scratch, ".claude.json");
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("creates ~/.claude.json with the agent-flywheel MCP entry when the file is missing", async () => {
    const result = await registerMcpAtomic({ configPath: cfg, pluginRoot: "/plugin" });
    expect(result.status).toBe("ok");
    const parsed = JSON.parse(await readFile(cfg, "utf8"));
    expect(parsed.mcpServers["agent-flywheel"]).toEqual({
      command: "node",
      args: ["/plugin/mcp-server/dist/index.js"],
    });
  });

  it("preserves existing mcpServers entries when merging", async () => {
    await writeFile(
      cfg,
      JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2),
    );
    const result = await registerMcpAtomic({ configPath: cfg, pluginRoot: "/plugin" });
    expect(result.status).toBe("ok");
    const parsed = JSON.parse(await readFile(cfg, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers["agent-flywheel"]).toBeTruthy();
  });

  it("is idempotent: re-running reports already registered without mutation", async () => {
    await registerMcpAtomic({ configPath: cfg, pluginRoot: "/plugin" });
    const before = await readFile(cfg, "utf8");
    const second = await registerMcpAtomic({ configPath: cfg, pluginRoot: "/plugin" });
    expect(second.status).toBe("ok");
    expect(second.note).toBe("already registered");
    const after = await readFile(cfg, "utf8");
    expect(after).toBe(before);
  });
});
