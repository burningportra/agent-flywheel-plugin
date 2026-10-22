import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Golden parity for the lint:skill CLIs. The compiled drivers lint a frozen
// copy of skills/start/SKILL.md (which lints clean) and the per-rule fixtures
// under lint/fixtures (which trip every rule), and the exit code, stdout and
// stderr must match expected.json byte for byte, so a speedup can't quietly
// change output.
// Regenerate after an intended output change: UPDATE_GOLDEN=1 npx vitest run src/__tests__/lint-skill-golden.test.ts
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE_DIR = path.join(HERE, "fixtures", "lint-skill-golden");
const SKILL = path.join(FIXTURE_DIR, "SKILL.md");
const EXPECTED = path.join(FIXTURE_DIR, "expected.json");
const RULE_FIXTURES = path.join(HERE, "lint", "fixtures");
const CASES = {
    "lint-skill-dir pretty": ["dist/scripts/lint-skill-dir.js", "--dir", FIXTURE_DIR, "--ci"],
    "lint-skill-dir json": ["dist/scripts/lint-skill-dir.js", "--dir", FIXTURE_DIR, "--ci", "--format", "json"],
    "lint-skill file pretty": ["dist/scripts/lint-skill.js", "--file", SKILL, "--ci"],
    "rule fixtures pretty": ["dist/scripts/lint-skill-dir.js", "--dir", RULE_FIXTURES, "--ci"],
    "rule fixtures json": ["dist/scripts/lint-skill-dir.js", "--dir", RULE_FIXTURES, "--ci", "--format", "json"],
};
function run(args) {
    const r = spawnSync(process.execPath, args, {
        cwd: MCP_SERVER_ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, GITHUB_ACTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    // Findings carry absolute paths; pin them relative to the fixture so the
    // golden holds in any checkout.
    const norm = (s) => s.split(FIXTURE_DIR).join("<fixture>").split(RULE_FIXTURES).join("<rule-fixtures>");
    return { exitCode: r.status, stdout: norm(r.stdout), stderr: norm(r.stderr) };
}
describe("lint:skill golden output", () => {
    beforeAll(() => {
        for (const args of Object.values(CASES)) {
            const cli = path.join(MCP_SERVER_ROOT, args[0]);
            if (!existsSync(cli))
                throw new Error(`missing ${cli}; run npm run build first`);
        }
    });
    it("matches expected.json for the frozen SKILL.md", () => {
        const actual = {};
        for (const [name, args] of Object.entries(CASES))
            actual[name] = run(args);
        if (process.env.UPDATE_GOLDEN === "1") {
            writeFileSync(EXPECTED, `${JSON.stringify(actual, null, 2)}\n`);
        }
        const expected = JSON.parse(readFileSync(EXPECTED, "utf8"));
        expect(actual).toEqual(expected);
    }, 120_000);
});
//# sourceMappingURL=lint-skill-golden.test.js.map