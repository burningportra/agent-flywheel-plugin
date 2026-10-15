import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__/lint -> __tests__ -> src -> mcp-server
const MCP_SERVER_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(MCP_SERVER_ROOT, "..");
const DRIVER = join(MCP_SERVER_ROOT, "scripts", "lint-skill-dir.ts");
const START_DIR = join(REPO_ROOT, "skills", "start");
describe("lint-skill-dir baseline-reason check", () => {
    it("every entry in the committed baseline has a one-line reason (>=10 chars)", () => {
        const baselinePath = join(MCP_SERVER_ROOT, ".lintskill-baseline.json");
        const text = readFileSync(baselinePath, "utf8");
        const parsed = JSON.parse(text);
        const empty = parsed.entries.filter((e) => !e.reason || e.reason.trim().length < 10);
        expect(empty).toEqual([]);
    });
    it("driver rejects a baseline with empty reasons (exit 3)", () => {
        const dir = mkdtempSync(join(tmpdir(), "lint-skill-dir-baseline-"));
        const emptyPath = join(dir, "baseline-empty.json");
        const committed = JSON.parse(readFileSync(join(MCP_SERVER_ROOT, ".lintskill-baseline.json"), "utf8"));
        const emptied = {
            ...committed,
            entries: committed.entries.map((e) => ({ ...e, reason: "" })),
        };
        writeFileSync(emptyPath, JSON.stringify(emptied, null, 2));
        const result = spawnSync(process.execPath, ["--import", "tsx", DRIVER, "--dir", START_DIR, "--ci", "--baseline", emptyPath], { cwd: MCP_SERVER_ROOT, encoding: "utf8" });
        expect(result.status).toBe(3);
        expect(result.stderr).toMatch(/empty or trivially-short reasons/);
    });
});
//# sourceMappingURL=baseline-reasons.test.js.map