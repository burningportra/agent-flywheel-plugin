import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { reserve001 } from "../../lint/rules/reserve001.js";
import type { Document, RuleContext } from "../../lint/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "reserve001");

const emptyDoc: Document = { source: "", filePath: "<unused>" };

interface Reserve001TestContext extends RuleContext {
  srcRoot: string;
  allowlist?: string[];
}

function makeCtx(overrides: Partial<Reserve001TestContext> = {}): Reserve001TestContext {
  return {
    filePath: "<unused>",
    source: "",
    srcRoot: FIXTURE_ROOT,
    ...overrides,
  };
}

describe("RESERVE001 — deliberately raw call site triggers the rule", () => {
  it("flags every fixture containing a direct file_reservation_paths call when no allowlist", async () => {
    const findings = await reserve001.check(emptyDoc, makeCtx({ allowlist: [] }));
    const ids = new Set(findings.map((f) => f.file));
    expect(ids.has("raw-call.ts")).toBe(true);
    expect(ids.has("multi-line.ts")).toBe(true);
    expect(ids.has("allowlisted-helper.ts")).toBe(true);
  });

  it("captures line:column for the agentMailRPC token", async () => {
    const findings = await reserve001.check(emptyDoc, makeCtx({ allowlist: [] }));
    const raw = findings.find((f) => f.file === "raw-call.ts");
    expect(raw).toBeDefined();
    expect(raw?.line).toBeGreaterThan(0);
    expect(raw?.severity).toBe("warn");
    expect(raw?.ruleId).toBe("RESERVE001");
    expect(raw?.message).toMatch(/reserveOrFail/);
    expect(raw?.hint).toMatch(/result\.ok/);
  });
});

describe("RESERVE001 — multi-line invocations are detected", () => {
  it("matches across newlines, comments, and type parameters", async () => {
    const findings = await reserve001.check(emptyDoc, makeCtx({ allowlist: [] }));
    const ml = findings.find((f) => f.file === "multi-line.ts");
    expect(ml).toBeDefined();
  });
});

describe("RESERVE001 — false-positive guards", () => {
  it("does NOT flag agentMailRPC calls with a different tool name", async () => {
    const findings = await reserve001.check(emptyDoc, makeCtx({ allowlist: [] }));
    expect(findings.find((f) => f.file === "unrelated-tool.ts")).toBeUndefined();
  });

  it("does NOT flag the literal string when it isn't inside an agentMailRPC call", async () => {
    const findings = await reserve001.check(emptyDoc, makeCtx({ allowlist: [] }));
    expect(findings.find((f) => f.file === "quoted-string-only.ts")).toBeUndefined();
  });
});

describe("RESERVE001 — allowlist", () => {
  it("skips files whose relative path matches an allowlist entry", async () => {
    const findings = await reserve001.check(
      emptyDoc,
      makeCtx({ allowlist: ["allowlisted-helper.ts"] }),
    );
    expect(findings.find((f) => f.file === "allowlisted-helper.ts")).toBeUndefined();
    // Other fixtures still flagged
    expect(findings.find((f) => f.file === "raw-call.ts")).toBeDefined();
  });

  it("matches allowlist by path suffix (so deep fixture paths work like real repo paths)", async () => {
    const findings = await reserve001.check(
      emptyDoc,
      makeCtx({
        allowlist: [
          "fixtures/reserve001/raw-call.ts",
          "fixtures/reserve001/multi-line.ts",
          "fixtures/reserve001/allowlisted-helper.ts",
        ],
      }),
    );
    expect(findings.find((f) => f.file === "raw-call.ts")).toBeUndefined();
    expect(findings.find((f) => f.file === "multi-line.ts")).toBeUndefined();
    expect(findings.find((f) => f.file === "allowlisted-helper.ts")).toBeUndefined();
  });
});

describe("RESERVE001 — graceful degradation", () => {
  it("returns no findings when neither srcRoot nor repoRoot is provided", async () => {
    const findings = await reserve001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
    });
    expect(findings).toEqual([]);
  });

  it("returns no findings when scan root does not exist", async () => {
    const findings = await reserve001.check(
      emptyDoc,
      makeCtx({ srcRoot: path.join(FIXTURE_ROOT, "this-dir-does-not-exist") }),
    );
    expect(findings).toEqual([]);
  });
});

describe("RESERVE001 — production scan against repo (smoke)", () => {
  it("finds exactly one direct call site in mcp-server/src (the agent-mail.ts orphan)", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const ctx: RuleContext & { repoRoot: string } = {
      filePath: "<unused>",
      source: "",
      repoRoot,
    };
    const findings = await reserve001.check(emptyDoc, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("mcp-server/src/agent-mail.ts");
    expect(findings[0].line).toBe(228);
  });
});
