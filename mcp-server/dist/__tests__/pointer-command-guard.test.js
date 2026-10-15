import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
const MCP_SERVER_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(MCP_SERVER_ROOT, "..");
const COMMANDS_DIR = join(REPO_ROOT, "commands");
const SKILLS_DIR = join(REPO_ROOT, "skills");
/**
 * Pointer-command dedup guard.
 *
 * The slash harness treats a slash command and a same-named skill as the
 * same "loaded skill": when the slash expands to the command file, a
 * `Skill(skill: "agent-flywheel:<name>")` call inside that command comes
 * back as "already loaded above", so the sibling `skills/<name>/SKILL.md`
 * body never reaches the model. The fix (bead PTR, 2026-10-15) is to call
 * `flywheel_get_skill({ name: "agent-flywheel:<name>" })` instead — the MCP
 * tool returns the body directly.
 *
 * This test fails if any pointer command regresses to the Skill() form.
 * It asserts the shape, not the exact wording, so the lead-in prose can
 * change without tripping this guard.
 */
function skillDirHasSkill(name) {
    try {
        const dir = join(SKILLS_DIR, name);
        const st = statSync(dir);
        if (!st.isDirectory())
            return false;
        // Count a skill dir if it holds a SKILL.md OR is one of the start sub-skills
        // referenced by name (we only guard same-named top-level pairs here).
        const entries = readdirSync(dir);
        return entries.some((e) => e === "SKILL.md");
    }
    catch {
        return false;
    }
}
function commandCallsSkillToolForSelf(commandPath, commandName) {
    const text = readFileSync(commandPath, "utf8");
    // The dedup bug fires when the command invokes the Skill tool with its own
    // name as the skill argument. Match on the key pattern, ignoring quote style
    // and whitespace variants. If the string appears inside a "do NOT ..." or
    // "did not load" context — because the file now documents the anti-pattern —
    // it should still fail: the point of the pattern-match is that any mention
    // of `Skill(skill: "agent-flywheel:<name>"` reads to the model as an
    // instruction to call that tool. The fix files reword to avoid the literal.
    const pattern = new RegExp(`Skill\\s*\\(\\s*skill\\s*:\\s*["']agent-flywheel:${commandName.replace(/[-]/g, "\\-")}["']`);
    return pattern.test(text);
}
describe("pointer-command dedup guard (bead PTR)", () => {
    const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
    it("no commands/<name>.md whose sibling skills/<name>/ exists invokes Skill(agent-flywheel:<name>) as a first action", () => {
        const offenders = [];
        for (const file of commandFiles) {
            const name = basename(file, ".md");
            // The slash harness registers the command under the stripped-flywheel-
            // prefix skill name sometimes; here we match the literal filename-vs-
            // skill-dir pairing because that's where the dedup fires.
            if (!skillDirHasSkill(name))
                continue;
            const commandPath = join(COMMANDS_DIR, file);
            if (commandCallsSkillToolForSelf(commandPath, name)) {
                offenders.push({ command: file, skillName: name, file: commandPath });
            }
        }
        expect(offenders).toEqual([]);
    });
    it("each of the four pointer commands calls flywheel_get_skill as its primary skill fetch", () => {
        // These four were the originally-broken pointers. The test asserts the
        // MCP-tool path is present so a future "revert to Skill tool" edit fails.
        const pointers = [
            "start.md",
            "flywheel-reality-check.md",
            "flywheel-speedup.md",
            "grill-with-docs.md",
        ];
        const missing = [];
        for (const file of pointers) {
            const text = readFileSync(join(COMMANDS_DIR, file), "utf8");
            if (!/flywheel_get_skill\s*\(\s*\{\s*name\s*:\s*["']agent-flywheel:/.test(text)) {
                missing.push(file);
            }
        }
        expect(missing).toEqual([]);
    });
    /**
     * Allowlist for same-name pairs that are intentionally NOT flywheel_get_skill
     * pointers. Every entry must carry a one-line reason. The default position is
     * "same-name pair → pointer"; an allowlist entry means the pair has been
     * reviewed and the exemption is deliberate (e.g. the command file is itself
     * the canonical body and the skill is the thin alias, or the command has
     * runtime-side arg routing that cannot be deferred into the skill body).
     */
    const POINTER_ALLOWLIST = {
    // (empty — add entries as `"<command-name>": "reason"` when a new same-name
    // pair ships that cannot be a pointer; see VCE.1/VCE.2 handoff notes.)
    };
    it("every commands/<name>.md with a same-name skills/<name>/SKILL.md is a flywheel_get_skill pointer or on the allowlist", () => {
        const violations = [];
        for (const file of commandFiles) {
            const name = basename(file, ".md");
            if (!skillDirHasSkill(name))
                continue;
            if (name in POINTER_ALLOWLIST)
                continue;
            const text = readFileSync(join(COMMANDS_DIR, file), "utf8");
            const callsGetSkill = /flywheel_get_skill\s*\(\s*\{\s*name\s*:\s*["']agent-flywheel:/.test(text);
            if (!callsGetSkill) {
                violations.push({
                    command: file,
                    reason: `commands/${file} has sibling skills/${name}/SKILL.md but does not call flywheel_get_skill — add a pointer or allowlist with a reason`,
                });
            }
        }
        expect(violations).toEqual([]);
    });
});
//# sourceMappingURL=pointer-command-guard.test.js.map