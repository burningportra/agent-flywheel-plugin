import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// __tests__/lint -> __tests__ -> src -> mcp-server
const MCP_SERVER_ROOT = path.resolve(HERE, "..", "..", "..");
const CLI_PATH = path.join(MCP_SERVER_ROOT, "dist", "scripts", "lint-skill.js");
const FIXTURES = path.join(MCP_SERVER_ROOT, "src", "__tests__", "lint", "fixtures");
function run(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, ...args], {
            cwd: opts.cwd ?? MCP_SERVER_ROOT,
            env: { ...process.env, GITHUB_ACTIONS: "" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
        child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    });
}
describe("lint-skill CLI", () => {
    beforeAll(async () => {
        // Ensure compiled CLI exists; fail loud if T11's build hasn't run.
        try {
            await stat(CLI_PATH);
        }
        catch {
            throw new Error(`compiled CLI not found at ${CLI_PATH} — run "npm run build" before vitest`);
        }
    });
    it("--help prints usage including rule ids and exit codes", async () => {
        const r = await run(["--help"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/lint-skill\s+\d+\.\d+\.\d+/);
        expect(r.stdout).toContain("AUQ001");
        expect(r.stdout).toContain("SLASH001");
        expect(r.stdout).toContain("PLACE001");
        expect(r.stdout).toContain("IMPL001");
        expect(r.stdout).toContain("Exit codes:");
    });
    it("--version prints semver and exits 0", async () => {
        const r = await run(["--version"]);
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
    it("unknown flag exits 3 (EXIT_INVALID_ARGS)", async () => {
        const r = await run(["--unknown"]);
        expect(r.code).toBe(3);
        expect(r.stderr).toContain("unknown argument");
    });
    it("missing file exits 4 (EXIT_FILE_ERROR)", async () => {
        const r = await run([
            "--file",
            "/nonexistent/path/to/skill.md",
            "--ci",
            "--format",
            "compact",
        ]);
        expect(r.code).toBe(4);
        expect(r.stderr).toContain("cannot read");
    });
    it("clean fixture lints with no error findings (exit 0)", async () => {
        // Create a minimal clean SKILL.md in a temp dir to avoid relying on repo skill state.
        const dir = await mkdtemp(path.join(tmpdir(), "lintskill-clean-"));
        try {
            const file = path.join(dir, "SKILL.md");
            await writeFile(file, "# Clean\n\nA simple skill description with no rule violations.\n", "utf8");
            const r = await run(["--file", file, "--ci", "--format", "compact"]);
            expect(r.code).toBe(0);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("AUQ001-violating fixture exits 1 with AUQ001 finding in JSON output", async () => {
        const fixture = path.join(FIXTURES, "auq001-too-few.md");
        const r = await run(["--file", fixture, "--ci", "--format", "json"]);
        expect(r.code).toBe(1);
        const parsed = JSON.parse(r.stdout);
        expect(parsed.findings.some((f) => f.ruleId === "AUQ001")).toBe(true);
    });
    it("--rule filters to only the specified rule", async () => {
        const fixture = path.join(FIXTURES, "slash001-typo.md");
        const r = await run([
            "--file",
            fixture,
            "--ci",
            "--format",
            "json",
            "--rule",
            "SLASH001",
        ]);
        // SLASH001 is severity warn — exit 0 even with a finding present.
        expect(r.code).toBe(0);
        const parsed = JSON.parse(r.stdout);
        expect(parsed.findings.length).toBeGreaterThan(0);
        for (const f of parsed.findings) {
            expect(f.ruleId).toBe("SLASH001");
        }
    });
    it("--update-baseline writes a baseline file then exits 0", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "lintskill-baseline-"));
        try {
            const baselinePath = path.join(dir, "baseline.json");
            const fixture = path.join(FIXTURES, "auq001-too-few.md");
            const r = await run([
                "--file",
                fixture,
                "--ci",
                "--update-baseline",
                "--baseline",
                baselinePath,
            ]);
            expect(r.code).toBe(0);
            const text = await readFile(baselinePath, "utf8");
            const parsed = JSON.parse(text);
            expect(parsed.schemaVersion).toBe(1);
            expect(parsed.entries.length).toBeGreaterThan(0);
            expect(parsed.entries.some((e) => e.ruleId === "AUQ001")).toBe(true);
            // Re-running with --baseline should now demote that finding -> exit 0.
            const r2 = await run([
                "--file",
                fixture,
                "--ci",
                "--baseline",
                baselinePath,
                "--format",
                "json",
            ]);
            expect(r2.code).toBe(0);
            const parsed2 = JSON.parse(r2.stdout);
            const auq = parsed2.findings.find((f) => f.ruleId === "AUQ001");
            expect(auq).toBeDefined();
            expect(auq?.severity).toBe("info");
            expect(auq?.message).toMatch(/^\[baselined\]/);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("--format requires a value and rejects invalid values", async () => {
        const r = await run(["--format", "yaml"]);
        expect(r.code).toBe(3);
        expect(r.stderr).toContain("invalid --format");
    });
});
//# sourceMappingURL=cli.test.js.map