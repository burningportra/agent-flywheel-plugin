/**
 * Tests for the AGY mirror port engine (bead agent-flywheel-plugin-dm1).
 *
 * Covers scripts/sync-agy.sh --write / --check / --prune behavior, the
 * [LOCAL] backup flow, the rules byte budget, rewrite-body postconditions,
 * the emitted hook wrappers, and `agy plugin validate --strict --json` as
 * the host oracle (skipped when agy is not on PATH).
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SYNC_MJS = path.join(REPO_ROOT, "scripts", "agy", "sync.mjs");
const REWRITE_MJS = path.join(REPO_ROOT, "scripts", "agy", "rewrite-body.mjs");
const EMIT_HOOKS_MJS = path.join(REPO_ROOT, "scripts", "agy", "emit-hooks.mjs");
const RULES_SOURCE = path.join(REPO_ROOT, "agy", "rules", "AGENTS.md");
const CLAUDE_HOOKS = JSON.parse(readFileSync(path.join(REPO_ROOT, "hooks", "hooks.json"), "utf8"));
function runNode(script, args, timeoutMs = 120_000) {
    try {
        const stdout = execFileSync("node", [script, ...args], {
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 32 * 1024 * 1024,
        });
        return { status: 0, stdout, stderr: "" };
    }
    catch (err) {
        const e = err;
        return {
            status: typeof e.status === "number" ? e.status : 1,
            stdout: e.stdout?.toString?.() ?? "",
            stderr: e.stderr?.toString?.() ?? "",
        };
    }
}
function runSync(args, timeoutMs = 120_000) {
    return runNode(SYNC_MJS, args, timeoutMs);
}
function agyOnPath() {
    const probe = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return probe.status === 0;
}
function freshTarget() {
    return mkdtempSync(path.join(tmpdir(), "fw-agy-test-"));
}
async function importMjs(absPath) {
    return (await import(pathToFileURL(absPath).href));
}
// ─── Source invariants ────────────────────────────────────────────────────
describe("agy source rules file", () => {
    it("stays under both the authored 20,000-byte budget and the 24,000-byte AGY cap", () => {
        const size = readFileSync(RULES_SOURCE).length;
        expect(size).toBeLessThanOrEqual(20_000);
        expect(size).toBeLessThanOrEqual(24_000);
    });
    it("carries the harness-translation glossary rows", () => {
        const text = readFileSync(RULES_SOURCE, "utf8");
        for (const pair of [
            "`AskUserQuestion` | `ask_question`",
            "`Bash` | `run_command`",
            "`Read` | `read_file`",
            "`Edit` | `edit_file`",
            "`Write` | `write_file`",
        ]) {
            expect(text).toContain(pair);
        }
        expect(text).toContain("invoke_subagent");
    });
});
// ─── rewrite-body unit tests ──────────────────────────────────────────────
describe("rewrite-body", () => {
    it("translates tool vocabulary and preserves MCP names", async () => {
        const { rewriteBody } = (await importMjs(REWRITE_MJS));
        const input = [
            "Call AskUserQuestion({ question: 'q' }) to pick.",
            "Use Bash('npm test'), then Read('a.ts'), Edit('a.ts', old, new), Write('b.ts', body).",
            "Spawn Agent({ prompt: 'x' }) or Task(prompt).",
            "`Bash` and `Read` in backticks too.",
            "load via flywheel_get_skill({ name: \"agent-flywheel:start\" })",
            'see /agent-flywheel:flywheel-status and "${CLAUDE_PLUGIN_ROOT}/mcp-server"',
        ].join("\n");
        const out = rewriteBody(input, { repoRoot: "/repo" });
        expect(out).toContain("ask_question({ question: 'q' })");
        expect(out).toContain("run_command('npm test')");
        expect(out).toContain("read_file('a.ts')");
        expect(out).toContain("edit_file('a.ts', old, new)");
        expect(out).toContain("write_file('b.ts', body)");
        expect(out).toContain("invoke_subagent({ prompt: 'x' })");
        expect(out).toContain("invoke_subagent(prompt)");
        expect(out).toContain("`run_command` and `read_file` in backticks");
        // MCP name byte-preserved, slash namespace dropped, root token expanded.
        expect(out).toContain('flywheel_get_skill({ name: "agent-flywheel:start" })');
        expect(out).toContain("/flywheel-status");
        expect(out).not.toContain("/agent-flywheel:flywheel-status");
        expect(out).toContain('"/repo/mcp-server"');
    });
    it("translates namespaced Skill calls and leaves non-namespaced ones alone", async () => {
        const { rewriteBody } = (await importMjs(REWRITE_MJS));
        const out = rewriteBody('Skill(skill: "agent-flywheel:grill-with-docs") then Skill(skill: "reality-check-for-project")', { repoRoot: "/repo" });
        expect(out).toContain('flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })');
        expect(out).toContain('Skill(skill: "reality-check-for-project")');
    });
    it("rebuilds command frontmatter as a cmd- skill", async () => {
        const { rewriteCommand } = (await importMjs(REWRITE_MJS));
        const out = rewriteCommand('---\ndescription: Show status.\nargument-hint: "[--json]"\n---\nCall Bash("br list").', { repoRoot: "/repo", name: "flywheel-status" });
        expect(out.startsWith("---\nname: cmd-flywheel-status\ndescription: Show status.\n---\n")).toBe(true);
        expect(out).not.toContain("argument-hint");
        expect(out).toContain('run_command("br list")');
    });
});
// ─── emit-hooks unit tests ────────────────────────────────────────────────
describe("emit-hooks", () => {
    it("translates the Claude hook table into flat AGY events with run_command matchers", async () => {
        const { emitHooks } = (await importMjs(EMIT_HOOKS_MJS));
        const emitted = emitHooks(CLAUDE_HOOKS, { repoRoot: "/repo" });
        const guard = emitted.hooksJson["agent-flywheel-guard"];
        expect(guard).toBeDefined();
        expect(Array.isArray(guard.PreToolUse)).toBe(true);
        const group = guard.PreToolUse[0];
        expect(group.matcher).toBe("run_command");
        expect(group.hooks?.[0]?.command).toBe("./hooks/agent-mail-guard.sh");
        expect(emitted.hooksJson["agent-flywheel-startup"].SessionStart).toBeDefined();
        expect(emitted.hooksJson["agent-flywheel-stop"].Stop).toBeDefined();
        expect(emitted.files["hooks/agent-mail-guard.sh"].executable).toBe(true);
        // PostToolUse (echo notice) and SubagentStop are explicitly unsupported.
        expect(emitted.unsupported.map((u) => u.event).sort()).toEqual(["PostToolUse", "SubagentStop"]);
    });
    it("emits wrappers that print valid JSON decisions on matching, clean, empty, and malformed stdin", async () => {
        const { emitHooks } = (await importMjs(EMIT_HOOKS_MJS));
        const dir = mkdtempSync(path.join(tmpdir(), "fw-agy-hooks-"));
        const emitted = emitHooks(CLAUDE_HOOKS, { repoRoot: REPO_ROOT });
        for (const [rel, entry] of Object.entries(emitted.files)) {
            const abs = path.join(dir, rel);
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, entry.content);
            if (entry.executable)
                chmodSync(abs, 0o755);
        }
        const guard = path.join(dir, "hooks", "agent-mail-guard.sh");
        const deny = spawnSync(guard, [], {
            input: '{"toolCall":{"name":"run_command","args":{"CommandLine":"am doctor repair --yes"}}}',
            encoding: "utf8",
            timeout: 15_000,
        });
        expect(deny.status).toBe(0);
        expect(JSON.parse(deny.stdout)).toMatchObject({ decision: "deny" });
        for (const input of [
            '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}',
            "",
            "not-json",
        ]) {
            const allow = spawnSync(guard, [], { input, encoding: "utf8", timeout: 15_000 });
            expect(allow.status).toBe(0);
            expect(JSON.parse(allow.stdout)).toEqual({ decision: "allow" });
        }
        const stop = spawnSync(path.join(dir, "hooks", "release-reservations.sh"), [], {
            input: "{}",
            encoding: "utf8",
            timeout: 15_000,
        });
        expect(stop.status).toBe(0);
        expect(JSON.parse(stop.stdout)).toEqual({});
        const startup = spawnSync(path.join(dir, "hooks", "startup.sh"), [], {
            input: "{}",
            encoding: "utf8",
            timeout: 30_000,
        });
        expect(startup.status).toBe(0);
        const parsed = JSON.parse(startup.stdout);
        expect(typeof parsed.injectSteps?.[0]?.systemMessage?.systemMessage).toBe("string");
        rmSync(dir, { recursive: true, force: true });
    });
});
// ─── Integration: sync CLI ────────────────────────────────────────────────
describe("scripts/sync-agy.sh (sync.mjs)", () => {
    it("--write into a fresh target succeeds, --check is then clean, and a re-write is a no-op", () => {
        const target = freshTarget();
        try {
            const write = runSync(["--write", "--target", target]);
            expect(write.status).toBe(0);
            // Target layout contract.
            expect(existsSync(path.join(target, "plugin.json"))).toBe(true);
            expect(existsSync(path.join(target, ".agy-plugin", "plugin.json"))).toBe(true);
            expect(existsSync(path.join(target, "mcp_config.json"))).toBe(true);
            expect(existsSync(path.join(target, ".mcp.json"))).toBe(false); // AGY rejects Claude's file name
            expect(existsSync(path.join(target, "hooks.json"))).toBe(true);
            expect(existsSync(path.join(target, "rules", "AGENTS.md"))).toBe(true);
            expect(existsSync(path.join(target, "logo.svg"))).toBe(true);
            expect(existsSync(path.join(target, "skills", "cmd-start", "SKILL.md"))).toBe(true);
            const pluginJson = JSON.parse(readFileSync(path.join(target, "plugin.json"), "utf8"));
            expect(Object.keys(pluginJson).sort()).toEqual([
                "description",
                "disabled",
                "displayName",
                "logo",
                "name",
                "suggestedPrompts",
                "version",
            ]);
            const mcp = JSON.parse(readFileSync(path.join(target, "mcp_config.json"), "utf8"));
            expect(mcp.mcpServers["agent-flywheel"].args[0]).toContain("/mcp-server/dist/server.js");
            const rulesSize = readFileSync(path.join(target, "rules", "AGENTS.md")).length;
            expect(rulesSize).toBeLessThanOrEqual(24_000);
            const check = runSync(["--check", "--target", target]);
            expect(check.status).toBe(0);
            const second = runSync(["--write", "--target", target, "--json"]);
            expect(second.status).toBe(0);
            const report = JSON.parse(second.stdout.slice(second.stdout.indexOf("{")));
            expect(report.wrote).toEqual([]);
            expect(report.summary).toMatchObject({ add: 0, update: 0, local: 0, prune: 0 });
        }
        finally {
            rmSync(target, { recursive: true, force: true });
        }
    }, 180_000);
    it("flags hand-edited managed files as [LOCAL], exits 1, and --write backs the divergence up before restoring", () => {
        const target = freshTarget();
        const backupDir = mkdtempSync(path.join(tmpdir(), "fw-agy-backup-"));
        try {
            expect(runSync(["--write", "--target", target]).status).toBe(0);
            const rulesPath = path.join(target, "rules", "AGENTS.md");
            writeFileSync(rulesPath, `${readFileSync(rulesPath, "utf8")}\nhand edit\n`);
            const check = runSync(["--check", "--target", target]);
            expect(check.status).toBe(1);
            expect(check.stdout).toContain("[LOCAL] rules/AGENTS.md");
            const write = runSync(["--write", "--target", target, "--backup-dir", backupDir]);
            expect(write.status).toBe(0);
            const backupPath = path.join(backupDir, "rules", "AGENTS.md");
            expect(existsSync(backupPath)).toBe(true);
            expect(readFileSync(backupPath, "utf8")).toContain("hand edit");
            expect(readFileSync(rulesPath, "utf8")).not.toContain("hand edit");
            expect(runSync(["--check", "--target", target]).status).toBe(0);
        }
        finally {
            rmSync(target, { recursive: true, force: true });
            rmSync(backupDir, { recursive: true, force: true });
        }
    }, 180_000);
    it("prunes files a previous sync wrote that are no longer rendered", () => {
        const target = freshTarget();
        try {
            expect(runSync(["--write", "--target", target]).status).toBe(0);
            const staleRel = "skills/gone/SKILL.md";
            mkdirSync(path.join(target, "skills", "gone"), { recursive: true });
            writeFileSync(path.join(target, staleRel), "stale");
            const statePath = path.join(target, ".sync-state.json");
            const state = JSON.parse(readFileSync(statePath, "utf8"));
            state.files[staleRel] = { sha: "deadbeef", executable: false };
            writeFileSync(statePath, JSON.stringify(state, null, 2));
            const check = runSync(["--check", "--target", target]);
            expect(check.status).toBe(1);
            expect(check.stdout).toContain(`[PRUNE] ${staleRel}`);
            const prune = runSync(["--prune", "--target", target]);
            expect(prune.status).toBe(0);
            expect(existsSync(path.join(target, staleRel))).toBe(false);
            expect(runSync(["--check", "--target", target]).status).toBe(0);
        }
        finally {
            rmSync(target, { recursive: true, force: true });
        }
    }, 180_000);
    it("rejects unknown arguments with exit 2 and prints usage with --help", () => {
        expect(runSync(["--nope"]).status).toBe(2);
        const help = runSync(["--help"]);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("--write");
    });
    it("passes the host oracle agy plugin validate --strict --json (skipped when agy is absent)", () => {
        if (!agyOnPath())
            return;
        const target = freshTarget();
        try {
            expect(runSync(["--write", "--target", target]).status).toBe(0);
            const validate = spawnSync("agy", ["plugin", "validate", target, "--strict", "--json"], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
            expect(validate.status).toBe(0);
            const parsed = JSON.parse(validate.stdout.slice(validate.stdout.indexOf("{")));
            expect(parsed.findings).toEqual([]);
        }
        finally {
            rmSync(target, { recursive: true, force: true });
        }
    }, 180_000);
});
//# sourceMappingURL=agy-sync.test.js.map