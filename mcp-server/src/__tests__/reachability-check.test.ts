import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "..", "scripts", "reachability.mjs");

type RunResult = { status: number; stdout: string; stderr: string };

function runCheck(root: string, allowlistPath?: string): RunResult {
  const args = ["--root", root, "--check"];
  if (allowlistPath) args.push("--allowlist", allowlistPath);
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
    };
  }
}

function writeFixture(root: string, files: Record<string, string>): void {
  for (const [relPath, body] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

describe("reachability --check", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "reachability-check-"));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newProject(name: string): string {
    const projectRoot = path.join(tmpRoot, name);
    writeFixture(projectRoot, {
      "package.json": JSON.stringify(
        { name: "fixture", version: "0.0.0", type: "module", scripts: {} },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            allowJs: true,
            noEmit: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "src/server.ts": `import { reachable } from "./reachable.js";\n\nreachable();\n`,
      "src/reachable.ts": `export function reachable(): number {\n  return 1;\n}\n`,
      "src/orphan.ts": `export function orphan(): number {\n  return 2;\n}\n`,
    });
    return projectRoot;
  }

  it("fails on a planted unreachable file with no allowlist", () => {
    const root = newProject("case-planted-unreachable");
    // No allowlist file written at all.
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/UNREACHABLE_FILE\s+src\/orphan\.ts/);
    expect(result.stdout).toMatch(/reachability check: FAIL/);
  });

  it("passes when the unreachable row is allowlisted with a non-empty reason", () => {
    const root = newProject("case-allowlisted-ok");
    writeFixture(root, {
      ".reachability-allowlist.json": JSON.stringify({
        version: 1,
        unreachableFiles: [
          { file: "src/orphan.ts", reason: "fixture library entry point, retained for external callers" },
        ],
        unreachableExports: [],
      }),
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/reachability check: ok/);
    expect(result.stdout).not.toMatch(/UNREACHABLE_FILE/);
  });

  it("fails when an allowlist entry has an empty reason", () => {
    const root = newProject("case-empty-reason");
    writeFixture(root, {
      ".reachability-allowlist.json": JSON.stringify({
        version: 1,
        unreachableFiles: [{ file: "src/orphan.ts", reason: "   " }],
        unreachableExports: [],
      }),
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/has no non-empty reason/);
    expect(result.stdout).toMatch(/reachability check: FAIL/);
  });

  it("fails when an allowlist entry is stale (no matching report row)", () => {
    const root = newProject("case-stale-entry");
    writeFixture(root, {
      ".reachability-allowlist.json": JSON.stringify({
        version: 1,
        unreachableFiles: [
          { file: "src/orphan.ts", reason: "fixture library entry point, retained for external callers" },
          { file: "src/does-not-exist.ts", reason: "legacy, never cleaned up" },
        ],
        unreachableExports: [],
      }),
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Stale allowlist files\s*\(1\):/);
    expect(result.stdout).toMatch(/STALE\s+src\/does-not-exist\.ts/);
    expect(result.stdout).toMatch(/reachability check: FAIL/);
  });
});
