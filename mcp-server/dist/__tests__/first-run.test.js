import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFirstRun } from "../first-run.js";
const empty = async () => [];
describe("isFirstRun (T5.1)", () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "fw-firstrun-"));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it("true when all 5 signals are absent (fresh repo)", async () => {
        await mkdir(join(cwd, ".git"));
        const result = await isFirstRun({ cwd, brList: empty, cassSearch: empty });
        expect(result).toBe(true);
    });
    it("false when .pi-flywheel/checkpoint.json exists", async () => {
        await mkdir(join(cwd, ".pi-flywheel"), { recursive: true });
        await writeFile(join(cwd, ".pi-flywheel/checkpoint.json"), "{}");
        expect(await isFirstRun({ cwd, brList: empty, cassSearch: empty })).toBe(false);
    });
    it("false when docs/plans contains any .md file", async () => {
        await mkdir(join(cwd, "docs/plans"), { recursive: true });
        await writeFile(join(cwd, "docs/plans/test.md"), "# plan");
        expect(await isFirstRun({ cwd, brList: empty, cassSearch: empty })).toBe(false);
    });
    it("true when docs/plans exists but contains zero .md files", async () => {
        await mkdir(join(cwd, "docs/plans"), { recursive: true });
        await writeFile(join(cwd, "docs/plans/notes.txt"), "scratch");
        expect(await isFirstRun({ cwd, brList: empty, cassSearch: empty })).toBe(true);
    });
    it("false when .pi-orchestrator/ exists", async () => {
        await mkdir(join(cwd, ".pi-orchestrator"), { recursive: true });
        await writeFile(join(cwd, ".pi-orchestrator/state.json"), "{}");
        expect(await isFirstRun({ cwd, brList: empty, cassSearch: empty })).toBe(false);
    });
    it("false when br returns ≥1 bead", async () => {
        const brList = async () => [{ id: "x" }];
        expect(await isFirstRun({ cwd, brList, cassSearch: empty })).toBe(false);
    });
    it("false when cass returns ≥1 entry", async () => {
        const cassSearch = async () => [{ id: "cass1" }];
        expect(await isFirstRun({ cwd, brList: empty, cassSearch })).toBe(false);
    });
    it("tolerates brList that throws — treats it as 0 entries", async () => {
        const brList = async () => {
            throw new Error("br offline");
        };
        expect(await isFirstRun({ cwd, brList, cassSearch: empty })).toBe(true);
    });
    it("skips the br and cass probes when a local signal already answers", async () => {
        await mkdir(join(cwd, ".pi-flywheel"), { recursive: true });
        await writeFile(join(cwd, ".pi-flywheel/checkpoint.json"), "{}");
        let probes = 0;
        const counted = async () => {
            probes++;
            return [];
        };
        expect(await isFirstRun({ cwd, brList: counted, cassSearch: counted })).toBe(false);
        expect(probes).toBe(0);
    });
    it("answers from br without waiting for a cass search that never returns", async () => {
        const brList = async () => [{ id: "x" }];
        const cassSearch = () => new Promise(() => { });
        expect(await isFirstRun({ cwd, brList, cassSearch })).toBe(false);
    });
    it("tolerates cassSearch that throws — treats it as 0 entries", async () => {
        const cassSearch = async () => {
            throw new Error("cm unavailable");
        };
        expect(await isFirstRun({ cwd, brList: empty, cassSearch })).toBe(true);
    });
});
//# sourceMappingURL=first-run.test.js.map