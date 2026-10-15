import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(MCP_ROOT, "scripts", "reachability.mjs");

const tempRoots: string[] = [];

async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reachability-"));
  tempRoots.push(root);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );

  return root;
}

async function runReachability(root: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [SCRIPT_PATH, "--root", root], {
    cwd: MCP_ROOT,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scripts/reachability.mjs", () => {
  it("reports unreachable, test-only, and imported-but-not-called production symbols", async () => {
    const root = await makeFixture({
      "package.json": JSON.stringify({ type: "module" }),
      "src/server.ts": [
        'import { used, notCalled } from "./live.js";',
        "used();",
        "void notCalled;",
        "",
      ].join("\n"),
      "src/live.ts": [
        "export function used(): void { internallyUsed(); }",
        "export function internallyUsed(): void {}",
        "export function notCalled(): void {}",
        "export function unused(): void {}",
        "export function testOnly(): void {}",
        "",
      ].join("\n"),
      "src/dead.ts": "export function orphan(): void {}\n",
      "src/__tests__/live.test.ts": [
        'import { testOnly } from "../live.js";',
        "testOnly();",
        "",
      ].join("\n"),
    });

    const output = await runReachability(root);

    expect(output).toContain("UNREACHABLE_FILE src/dead.ts");
    expect(output).toContain(
      "UNREACHABLE_EXPORT src/dead.ts:1 orphan reason=unreachable-file",
    );
    expect(output).toContain(
      "UNREACHABLE_EXPORT src/live.ts:4 unused reason=no-production-reference",
    );
    expect(output).toContain(
      "TEST_ONLY_EXPORT src/live.ts:5 testOnly test-imports=1 test-calls=1",
    );
    expect(output).toContain(
      "IMPORTED_NOT_CALLED src/live.ts:3 notCalled prod-imports=1 prod-refs=1 test-calls=0",
    );
    expect(output).not.toContain("UNREACHABLE_EXPORT src/live.ts:1 used");
    expect(output).not.toContain("UNREACHABLE_EXPORT src/live.ts:2 internallyUsed");
  });

  it("treats package scripts and statically enumerable dynamic imports as roots", async () => {
    const root = await makeFixture({
      "package.json": JSON.stringify({
        type: "module",
        scripts: { tool: "tsx scripts/tool.ts" },
      }),
      "src/server.ts": "export {};\n",
      "src/from-script.ts": "export function fromScript(): void {}\n",
      "src/dynamic-a.ts": "export const dynamicA = true;\n",
      "src/dynamic-b.ts": "export const dynamicB = true;\n",
      "src/runtime-only.ts": "export const runtimeOnly = true;\n",
      "scripts/tool.ts": [
        'import { fromScript } from "../src/from-script.js";',
        'const target = process.env.USE_A ? "../src/dynamic-a.js" : "../src/dynamic-b.js";',
        'const runtimeUrl = new URL(`file://${resolve(here, "..", "dist", "runtime-only.js")}`);',
        "fromScript();",
        "await import(target);",
        "await import(runtimeUrl.href);",
        "",
      ].join("\n"),
    });

    const output = await runReachability(root);

    expect(output).toContain("ROOT scripts/tool.ts");
    expect(output).not.toContain("UNREACHABLE_FILE src/from-script.ts");
    expect(output).not.toContain("UNREACHABLE_FILE src/dynamic-a.ts");
    expect(output).not.toContain("UNREACHABLE_FILE src/dynamic-b.ts");
    expect(output).not.toContain("UNREACHABLE_FILE src/runtime-only.ts");
  });
});
