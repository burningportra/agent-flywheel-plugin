import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TEXT, diffCounts, parseArgv, run } from "./update-tone-baseline.js";
describe("update-tone-baseline argv parser", () => {
    it("rejects unknown flags with exit 2", () => {
        const r = parseArgv(["--bogus"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error")
            expect(r.exitCode).toBe(2);
    });
    it("--help prints usage", () => {
        const r = parseArgv(["--help"]);
        expect(r.kind).toBe("help");
        if (r.kind === "help")
            expect(r.text).toContain("--allow-raise");
    });
    it("--allow-raise without --reason is refused", () => {
        const r = parseArgv(["--allow-raise"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error")
            expect(r.message).toContain("--reason");
    });
    it("--allow-raise with empty --reason is refused", () => {
        const r = parseArgv(["--allow-raise", "--reason", "   "]);
        expect(r.kind).toBe("error");
    });
    it("--allow-raise with a real reason parses", () => {
        const r = parseArgv(["--allow-raise", "--reason", "intentional"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run") {
            expect(r.options.allowRaise).toBe(true);
            expect(r.options.reason).toBe("intentional");
        }
    });
    it("HELP_TEXT names every documented flag", () => {
        for (const flag of ["--baseline", "--dir", "--repo-root", "--allow-raise", "--reason", "--dry-run", "--help"]) {
            expect(HELP_TEXT).toContain(flag);
        }
    });
});
describe("diffCounts", () => {
    it("classifies lowered / raised / unchanged / removed", () => {
        const d = diffCounts({ "a.md": 5, "b.md": 2, "c.md": 3, "d.md": 1 }, { "a.md": 3, "b.md": 2, "c.md": 7, "e.md": 1 });
        expect(d.lowered.map((x) => x.key)).toEqual(["a.md"]);
        expect(d.unchanged.map((x) => x.key)).toEqual(["b.md"]);
        expect(d.raised.map((x) => x.key).sort()).toEqual(["c.md", "e.md"]);
        expect(d.removed.map((x) => x.key)).toEqual(["d.md"]);
    });
    it("new file at 0 count is unchanged, not raised", () => {
        const d = diffCounts({}, { "new.md": 0 });
        expect(d.unchanged.map((x) => x.key)).toEqual(["new.md"]);
        expect(d.raised).toEqual([]);
    });
});
describe("run (end-to-end with fixtures)", () => {
    let dir;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "tone-fx-"));
        await mkdir(join(dir, "skills", "start"), { recursive: true });
        await mkdir(join(dir, "mcp-server"), { recursive: true });
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const writeSkill = (name, body) => writeFile(join(dir, "skills", "start", name), body, "utf8");
    async function readBaseline(path) {
        const text = await readFile(path, "utf8");
        return JSON.parse(text);
    }
    it("lowers a file's count when its tone tokens drop", async () => {
        // Baseline says old.md had 3 shouty words; the current file has 1.
        const baselinePath = join(dir, "mcp-server", ".lintskill-tone-baseline.json");
        await writeFile(baselinePath, JSON.stringify({
            schemaVersion: 1,
            generated: "2026-10-15T00:00:00.000Z",
            counts: { "skills/start/old.md": 3 },
        }), "utf8");
        await writeSkill("old.md", "# Title\n\nMUST do thing.\n");
        const code = await run({
            repoRoot: dir,
            dirs: [join(dir, "skills", "start")],
            baselinePath,
            allowRaise: false,
            dryRun: false,
        });
        expect(code).toBe(0);
        const after = await readBaseline(baselinePath);
        expect(after.counts["skills/start/old.md"]).toBe(1);
    });
    it("refuses to raise an existing count without --allow-raise", async () => {
        const baselinePath = join(dir, "mcp-server", ".lintskill-tone-baseline.json");
        await writeFile(baselinePath, JSON.stringify({
            schemaVersion: 1,
            generated: "2026-10-15T00:00:00.000Z",
            counts: { "skills/start/one.md": 1 },
        }), "utf8");
        // New file counts 3 MUSTs — above baseline of 1.
        await writeSkill("one.md", "# Title\n\nMUST a. MUST b. MUST c.\n");
        const code = await run({
            repoRoot: dir,
            dirs: [join(dir, "skills", "start")],
            baselinePath,
            allowRaise: false,
            dryRun: false,
        });
        expect(code).toBe(3);
        // Baseline file untouched.
        const after = await readBaseline(baselinePath);
        expect(after.counts["skills/start/one.md"]).toBe(1);
    });
    it("--allow-raise with a reason lets the raise through", async () => {
        const baselinePath = join(dir, "mcp-server", ".lintskill-tone-baseline.json");
        await writeFile(baselinePath, JSON.stringify({
            schemaVersion: 1,
            generated: "2026-10-15T00:00:00.000Z",
            counts: { "skills/start/one.md": 1 },
        }), "utf8");
        await writeSkill("one.md", "# Title\n\nMUST a. MUST b. MUST c.\n");
        const code = await run({
            repoRoot: dir,
            dirs: [join(dir, "skills", "start")],
            baselinePath,
            allowRaise: true,
            reason: "intentional stretch while adding safety wording",
            dryRun: false,
        });
        expect(code).toBe(0);
        const after = await readBaseline(baselinePath);
        expect(after.counts["skills/start/one.md"]).toBe(3);
    });
});
//# sourceMappingURL=update-tone-baseline.test.js.map