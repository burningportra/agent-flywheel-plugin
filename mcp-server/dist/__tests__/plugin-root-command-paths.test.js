import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");
const COMMANDS_ROOT = join(REPO_ROOT, "commands");
function walkMarkdown(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory())
            files.push(...walkMarkdown(entryPath));
        else if (entry.isFile() && extname(entry.name) === ".md")
            files.push(entryPath);
    }
    return files;
}
function markdownCommands(markdown) {
    const commands = [];
    let fenceMarker;
    for (const [index, line] of markdown.split("\n").entries()) {
        const trimmed = line.trim();
        if (fenceMarker) {
            if (trimmed.startsWith(fenceMarker)) {
                fenceMarker = undefined;
                continue;
            }
            if (trimmed) {
                commands.push({
                    text: trimmed,
                    line: index + 1,
                    kind: "fenced",
                    sourceLine: line,
                    sourcePrefix: "",
                });
            }
            continue;
        }
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
            continue;
        }
        for (const match of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
            const text = match[1]?.trim();
            if (text) {
                commands.push({
                    text,
                    line: index + 1,
                    kind: "inline",
                    sourceLine: line,
                    sourcePrefix: line.slice(0, match.index ?? 0),
                });
            }
        }
    }
    return commands;
}
function repoRelativePluginPath(command) {
    const normalized = command.text.replace(/^\$\s+/, "").trim();
    const beginsWithRunner = /^(?:sh|bash|node|tsx|npx|ls)\s+/.test(normalized);
    const changesIntoPluginDirectory = /^cd\s+((?:\.\/)?(?:scripts|mcp-server))(?:\/|\s|$)/.exec(normalized)?.[1];
    const directPath = /^(?:["'])?((?:\.\/)?(?:scripts|mcp-server)\/[^\s"'`|;]+)/.exec(normalized)?.[1];
    const embeddedPath = /(?:^|[\s"'=])((?:\.\/)?(?:scripts|mcp-server)\/[^\s"'`|;]+)/.exec(normalized)?.[1];
    if (beginsWithRunner)
        return embeddedPath;
    if (changesIntoPluginDirectory)
        return changesIntoPluginDirectory;
    if (!directPath)
        return undefined;
    if (command.kind === "inline" && !/\s/.test(normalized)) {
        const standalone = command.sourceLine.trim() === `\`${command.text}\``;
        const imperative = /\b(?:run|use|invoke|execute|call|try)(?:\s+the)?(?:\s+(?:command|script))?\s*$/i.test(command.sourcePrefix);
        if (!standalone && !imperative)
            return undefined;
    }
    return directPath;
}
function skillOwnsScript(file, commandPath) {
    if (!commandPath.replace(/^\.\//, "").startsWith("scripts/"))
        return false;
    const parts = file.split("/");
    if (parts[0] !== "skills" || !parts[1])
        return false;
    const skillRoot = join(SKILLS_ROOT, parts[1]);
    const scriptPath = resolve(skillRoot, commandPath.replace(/^\.\//, ""));
    return scriptPath.startsWith(`${skillRoot}${sep}`) && existsSync(scriptPath);
}
function findUnrootedPluginCommands(file, markdown) {
    const findings = [];
    for (const command of markdownCommands(markdown)) {
        const commandPath = repoRelativePluginPath(command);
        if (!commandPath || skillOwnsScript(file, commandPath))
            continue;
        findings.push({ file, line: command.line, command: command.text });
    }
    return findings;
}
describe("plugin-root command paths", () => {
    it("flags a planted repo-relative plugin command", () => {
        const markdown = [
            "# Fixture",
            "",
            "Run `node mcp-server/dist/scripts/bead-viewer.js --port 0`.",
        ].join("\n");
        expect(findUnrootedPluginCommands("skills/example/SKILL.md", markdown)).toEqual([
            {
                file: "skills/example/SKILL.md",
                line: 3,
                command: "node mcp-server/dist/scripts/bead-viewer.js --port 0",
            },
        ]);
    });
    it("flags every supported runnable command shape", () => {
        const commands = [
            "sh scripts/build-mutex.sh rch test",
            "bash scripts/build-mutex.sh rch test",
            "node mcp-server/dist/server.js",
            "tsx mcp-server/src/refresh-learnings.ts",
            "npx tsx mcp-server/src/refresh-learnings.ts",
            "ls mcp-server/dist/server.js",
            "scripts/build-mutex.sh rch test",
            "\"scripts/build-mutex.sh\" rch test",
            "./scripts/missing.sh --check",
            "mcp-server/dist/server.js --version",
            "cd mcp-server && npm run bead-viewer",
        ];
        for (const command of commands) {
            expect(findUnrootedPluginCommands("commands/example.md", `\`${command}\``)).toEqual([
                { file: "commands/example.md", line: 1, command },
            ]);
        }
    });
    it("allows descriptive source paths and plugin-rooted commands", () => {
        const markdown = [
            "See `mcp-server/src/beads.ts` for the state model.",
            "Run `node \"$CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/bead-viewer.js\" --port 0`.",
        ].join("\n");
        expect(findUnrootedPluginCommands("skills/example/SKILL.md", markdown)).toEqual([]);
    });
    it("distinguishes imperative direct paths from descriptive mentions", () => {
        expect(findUnrootedPluginCommands("commands/example.md", "Execute the `scripts/build-mutex.sh`.")).toEqual([
            {
                file: "commands/example.md",
                line: 1,
                command: "scripts/build-mutex.sh",
            },
        ]);
        expect(findUnrootedPluginCommands("skills/start/example.md", "Repo-relative `scripts/build-mutex.sh` breaks in a user's project.")).toEqual([]);
    });
    it("allows scripts that exist inside their owning skill directory", () => {
        const cases = [
            [
                "skills/brainstorming/visual-companion.md",
                "`scripts/start-server.sh --project-dir /tmp/project`",
            ],
            ["skills/cass/SELF-TEST.md", "`./scripts/validate.sh`"],
            [
                "skills/changelog-md-workmanship/SKILL.md",
                "`scripts/validate-changelog-md.py CHANGELOG.md`",
            ],
            [
                "skills/multi-model-triangulation/SKILL.md",
                "`./scripts/format-prompt.py idea one two`",
            ],
        ];
        for (const [file, markdown] of cases) {
            expect(findUnrootedPluginCommands(file, markdown)).toEqual([]);
        }
    });
    it("does not offer the unavailable tsx compound-refresh fallback", () => {
        const skill = readFileSync(join(SKILLS_ROOT, "flywheel-compound-refresh", "SKILL.md"), "utf8");
        expect(skill).not.toMatch(/tsx\s+[^`\n]*refresh-learnings\.ts/);
        expect(skill).toContain("refresh-learnings.ts` has no CLI entry point");
    });
    it("runs the bead viewer from the user's project directory", () => {
        const command = readFileSync(join(COMMANDS_ROOT, "flywheel-bead-viewer.md"), "utf8");
        expect(command).toContain('node "$CLAUDE_PLUGIN_ROOT/mcp-server/dist/scripts/bead-viewer.js"');
        expect(command).not.toMatch(/\bcd\s+mcp-server\b/);
    });
    it("roots every runnable plugin-bundled command in skills and commands", () => {
        const findings = [];
        for (const filePath of [
            ...walkMarkdown(SKILLS_ROOT),
            ...walkMarkdown(COMMANDS_ROOT),
        ]) {
            const file = relative(REPO_ROOT, filePath).split(sep).join("/");
            findings.push(...findUnrootedPluginCommands(file, readFileSync(filePath, "utf8")));
        }
        expect(findings).toEqual([]);
    });
});
//# sourceMappingURL=plugin-root-command-paths.test.js.map