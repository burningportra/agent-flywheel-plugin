/**
 * Tests for fs-safety — the ownership-guard module that wraps every
 * destructive fs call in the flywheel (bead agent-flywheel-plugin-8tf).
 *
 * Acceptance criteria from the bead:
 *   1. user-owned file preserved (guard refuses),
 *   2. flywheel-owned file updated (guard allows),
 *   3. backup created before overwrite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { FLYWHEEL_MANAGED_DIRS, FLYWHEEL_TMP_PREFIX, backupThenReplace, getFlywheelManagedDirs, guardedRemoveDir, guardedRename, guardedUnlink, isFlywheelManagedPath, } from "../../utils/fs-safety.js";
/**
 * Fake plugin-repo marker. `getFlywheelManagedDirs` adds `mcp-server/dist`
 * only when cwd looks like the plugin repo — in the tests we materialise
 * a tiny `mcp-server/package.json` with the right `name`.
 */
function markPluginRepo(root) {
    mkdirSync(join(root, "mcp-server"), { recursive: true });
    writeFileSync(join(root, "mcp-server", "package.json"), JSON.stringify({ name: "agent-flywheel-mcp" }), "utf8");
}
let tmp;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fs-safety-test-"));
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});
describe("isFlywheelManagedPath", () => {
    it("accepts paths inside .pi-flywheel/", () => {
        const p = join(tmp, ".pi-flywheel", "checkpoint.json");
        expect(isFlywheelManagedPath(p, tmp)).toBe(true);
    });
    it("accepts paths inside .pi-flywheel-feedback/", () => {
        const p = join(tmp, ".pi-flywheel-feedback", "tools", "x.jsonl");
        expect(isFlywheelManagedPath(p, tmp)).toBe(true);
    });
    it("accepts paths inside mcp-server/dist/ when cwd is the plugin repo", () => {
        markPluginRepo(tmp);
        const p = join(tmp, "mcp-server", "dist", "server.js");
        expect(isFlywheelManagedPath(p, tmp)).toBe(true);
    });
    it("rejects paths inside mcp-server/dist/ for a non-plugin consumer cwd", () => {
        // No plugin marker — a consumer project's own mcp-server/dist must NOT
        // be classified as flywheel-managed (would let `flywheel_doctor --autofix`
        // clobber the consumer's build output).
        const p = join(tmp, "mcp-server", "dist", "server.js");
        expect(isFlywheelManagedPath(p, tmp)).toBe(false);
    });
    it("rejects the cwd root itself", () => {
        const p = join(tmp, "README.md");
        expect(isFlywheelManagedPath(p, tmp)).toBe(false);
    });
    it("rejects a user-owned skills/ path", () => {
        const p = join(tmp, "skills", "my-skill", "SKILL.md");
        expect(isFlywheelManagedPath(p, tmp)).toBe(false);
    });
    it("rejects .pi-flywheel-ish prefix confusables", () => {
        // .pi-flywheelX must NOT slip through a naive startsWith check.
        const p = join(tmp, ".pi-flywheel-evil", "x");
        expect(isFlywheelManagedPath(p, tmp)).toBe(false);
    });
    it("accepts tmpdir paths with the flywheel prefix", () => {
        const p = join(tmpdir(), `${FLYWHEEL_TMP_PREFIX}scratch-123`, "note.md");
        expect(isFlywheelManagedPath(p, tmp)).toBe(true);
    });
    it("rejects tmpdir paths without the flywheel prefix", () => {
        const p = join(tmpdir(), "unrelated-app", "x");
        expect(isFlywheelManagedPath(p, tmp)).toBe(false);
    });
    it("exposes the allowlist constant for doc/reference consumers", () => {
        // The static allowlist is part of the module contract — changing it
        // should be an explicit, reviewable change.
        expect(FLYWHEEL_MANAGED_DIRS).toContain(".pi-flywheel");
        expect(FLYWHEEL_MANAGED_DIRS).not.toContain(`mcp-server${sep}dist`);
    });
    it("getFlywheelManagedDirs adds mcp-server/dist only for the plugin repo", () => {
        // Consumer cwd: just the static allowlist.
        expect(getFlywheelManagedDirs(tmp)).not.toContain(`mcp-server${sep}dist`);
        // Plugin repo cwd: mcp-server/dist is appended.
        markPluginRepo(tmp);
        expect(getFlywheelManagedDirs(tmp)).toContain(`mcp-server${sep}dist`);
    });
});
describe("guardedUnlink — user-owned file preserved", () => {
    it("refuses to unlink a user-owned file and leaves it intact", () => {
        // Simulate CE's forceSymlink scenario: a user hand-edit at ~/.agents.
        // We stand in for ~/.agents via a path outside .pi-flywheel/.
        const userFile = join(tmp, "skills", "my-skill", "SKILL.md");
        mkdirSync(join(tmp, "skills", "my-skill"), { recursive: true });
        writeFileSync(userFile, "hand-authored content", "utf8");
        const r = guardedUnlink(userFile, tmp);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe("target_outside_allowlist");
        expect(existsSync(userFile)).toBe(true);
        expect(readFileSync(userFile, "utf8")).toBe("hand-authored content");
    });
});
describe("guardedUnlink — flywheel-owned file updated", () => {
    it("unlinks a file inside .pi-flywheel/", () => {
        const pf = join(tmp, ".pi-flywheel");
        mkdirSync(pf, { recursive: true });
        const p = join(pf, "checkpoint.json.tmp");
        writeFileSync(p, "{}", "utf8");
        const r = guardedUnlink(p, tmp);
        expect(r.ok).toBe(true);
        expect(existsSync(p)).toBe(false);
    });
    it("is idempotent when the target does not exist", () => {
        const p = join(tmp, ".pi-flywheel", "nope.json");
        const r = guardedUnlink(p, tmp);
        expect(r.ok).toBe(true);
        expect(r.detail).toContain("does not exist");
    });
});
describe("backupThenReplace — backup created before overwrite", () => {
    it("moves the existing file to .pi-flywheel/_backup/<ts>/ before returning", () => {
        const pf = join(tmp, ".pi-flywheel");
        mkdirSync(pf, { recursive: true });
        const target = join(pf, "checkpoint.json");
        writeFileSync(target, "v1", "utf8");
        const backupPath = backupThenReplace(target, tmp);
        // Backup exists, target no longer (caller is expected to write v2 next).
        expect(backupPath).not.toBe("");
        expect(existsSync(backupPath)).toBe(true);
        expect(readFileSync(backupPath, "utf8")).toBe("v1");
        expect(backupPath.startsWith(join(tmp, ".pi-flywheel", "_backup") + sep)).toBe(true);
        // The backup basename matches the original file's basename.
        expect(backupPath.endsWith(`${sep}checkpoint.json`)).toBe(true);
    });
    it("returns empty string when the target does not exist (no-op)", () => {
        const p = join(tmp, ".pi-flywheel", "never-existed.json");
        const backupPath = backupThenReplace(p, tmp);
        expect(backupPath).toBe("");
    });
    it("produces unique backup dirs when called twice in quick succession", () => {
        // The CE phase4 blunder #6 lesson: ISO-only timestamps collide under
        // CI/test harnesses. backupThenReplace must fold in hrtime+pid.
        const pf = join(tmp, ".pi-flywheel");
        mkdirSync(pf, { recursive: true });
        const target = join(pf, "checkpoint.json");
        writeFileSync(target, "a", "utf8");
        const b1 = backupThenReplace(target, tmp);
        writeFileSync(target, "b", "utf8");
        const b2 = backupThenReplace(target, tmp);
        expect(b1).not.toBe(b2);
        expect(existsSync(b1)).toBe(true);
        expect(existsSync(b2)).toBe(true);
        expect(readFileSync(b1, "utf8")).toBe("a");
        expect(readFileSync(b2, "utf8")).toBe("b");
        // And the backup root contains two distinct subdirs.
        const backupRoot = join(tmp, ".pi-flywheel", "_backup");
        const subdirs = readdirSync(backupRoot).filter((name) => statSync(join(backupRoot, name)).isDirectory());
        expect(subdirs.length).toBe(2);
    });
});
describe("guardedRename", () => {
    it("allows rename entirely inside .pi-flywheel/", () => {
        const pf = join(tmp, ".pi-flywheel");
        mkdirSync(pf, { recursive: true });
        const src = join(pf, "x.tmp");
        const dest = join(pf, "x");
        writeFileSync(src, "v", "utf8");
        const r = guardedRename(src, dest, tmp);
        expect(r.ok).toBe(true);
        expect(existsSync(src)).toBe(false);
        expect(readFileSync(dest, "utf8")).toBe("v");
    });
    it("refuses when source escapes the allowlist", () => {
        const src = join(tmp, "README.md");
        const dest = join(tmp, ".pi-flywheel", "README.md");
        writeFileSync(src, "readme", "utf8");
        const r = guardedRename(src, dest, tmp);
        expect(r.ok).toBe(false);
        expect(existsSync(src)).toBe(true);
    });
    it("refuses when destination escapes the allowlist", () => {
        const pf = join(tmp, ".pi-flywheel");
        mkdirSync(pf, { recursive: true });
        const src = join(pf, "x");
        const dest = join(tmp, "x");
        writeFileSync(src, "v", "utf8");
        const r = guardedRename(src, dest, tmp);
        expect(r.ok).toBe(false);
        expect(existsSync(src)).toBe(true);
        expect(existsSync(dest)).toBe(false);
    });
});
describe("guardedRemoveDir", () => {
    it("removes a dir under the flywheel tmpdir prefix", () => {
        const scratch = join(tmpdir(), `${FLYWHEEL_TMP_PREFIX}test-${Date.now()}`);
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, "f.txt"), "x", "utf8");
        const r = guardedRemoveDir(scratch, tmp);
        expect(r.ok).toBe(true);
        expect(existsSync(scratch)).toBe(false);
    });
    it("refuses to recursively-rm a user-owned directory", () => {
        const userDir = join(tmp, "skills");
        mkdirSync(userDir, { recursive: true });
        writeFileSync(join(userDir, "important.md"), "keep me", "utf8");
        const r = guardedRemoveDir(userDir, tmp);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe("target_outside_allowlist");
        expect(existsSync(join(userDir, "important.md"))).toBe(true);
    });
    it("is idempotent when the target does not exist", () => {
        const p = join(tmp, ".pi-flywheel", "nope");
        const r = guardedRemoveDir(p, tmp);
        expect(r.ok).toBe(true);
    });
});
//# sourceMappingURL=fs-safety.test.js.map