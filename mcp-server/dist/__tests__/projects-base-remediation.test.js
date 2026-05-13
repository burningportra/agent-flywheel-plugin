import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remediateProjectsBase } from "../tools/remediations/projects_base_misconfig.js";
describe("remediateProjectsBase (T6.1)", () => {
    let scratch;
    let ntmBase;
    beforeEach(async () => {
        scratch = await mkdtemp(join(tmpdir(), "fw-projbase-"));
        ntmBase = await mkdtemp(join(tmpdir(), "fw-ntmbase-"));
    });
    afterEach(async () => {
        await rm(scratch, { recursive: true, force: true });
        await rm(ntmBase, { recursive: true, force: true });
    });
    it("dry-run returns the ln -s command without creating the symlink", async () => {
        const cwd = scratch;
        const result = await remediateProjectsBase({ cwd, ntmBase, mode: "dry-run" });
        expect(result.command).toBe(`ln -s "${cwd}" "${ntmBase}/${cwd.split("/").pop()}"`);
        expect(result.executed).toBe(false);
        expect(result.target).toBe(`${ntmBase}/${cwd.split("/").pop()}`);
        expect(existsSync(result.target)).toBe(false);
    });
    it("skip mode is identical to dry-run (no mutation)", async () => {
        const result = await remediateProjectsBase({ cwd: scratch, ntmBase, mode: "skip" });
        expect(result.executed).toBe(false);
        expect(existsSync(result.target)).toBe(false);
    });
    it("execute creates the symlink and reports executed=true", async () => {
        const result = await remediateProjectsBase({ cwd: scratch, ntmBase, mode: "execute" });
        expect(result.executed).toBe(true);
        expect(existsSync(result.target)).toBe(true);
        const linkTarget = await readlink(result.target);
        expect(linkTarget).toBe(scratch);
        // Confirms ntm spawn would resolve through the symlink to the real cwd.
        const stats = await stat(result.target);
        expect(stats.isDirectory()).toBe(true);
    });
    it("execute is idempotent when the target already exists", async () => {
        // First execute creates the symlink.
        const first = await remediateProjectsBase({ cwd: scratch, ntmBase, mode: "execute" });
        expect(first.executed).toBe(true);
        // Second execute on the same target should not throw and still report executed=true.
        const second = await remediateProjectsBase({ cwd: scratch, ntmBase, mode: "execute" });
        expect(second.executed).toBe(true);
        expect(existsSync(second.target)).toBe(true);
    });
});
//# sourceMappingURL=projects-base-remediation.test.js.map