import { describe, it, expect } from "vitest";
import { HELP_TEXT, parseArgv } from "../../scripts/eval/argv.js";
describe("eval argv parser (M4)", () => {
    it("rejects unknown flags with exit code 2", () => {
        const r = parseArgv(["--bogus"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error") {
            expect(r.exitCode).toBe(2);
            expect(r.message).toContain("Unknown flag: --bogus");
        }
    });
    it("prints help and exits 0 on --help", () => {
        const r = parseArgv(["--help"]);
        expect(r.kind).toBe("help");
        if (r.kind === "help")
            expect(r.text).toContain("Usage:");
    });
    it("prints help on -h", () => {
        const r = parseArgv(["-h"]);
        expect(r.kind).toBe("help");
    });
    it("defaults to NO baseline write", () => {
        const r = parseArgv([]);
        expect(r.kind).toBe("run");
        if (r.kind === "run")
            expect(r.writeBaseline).toBe(false);
    });
    it("refuses --write-baseline together with --only", () => {
        const r = parseArgv(["--write-baseline", "--only", "s1"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error") {
            expect(r.exitCode).toBe(2);
            expect(r.message).toContain("--write-baseline cannot be combined with --only");
        }
    });
    it("accepts --write-baseline alone", () => {
        const r = parseArgv(["--write-baseline"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run") {
            expect(r.writeBaseline).toBe(true);
            expect(r.onlyIds.size).toBe(0);
        }
    });
    it("accepts --no-write-baseline as a no-op (backwards compat)", () => {
        const r = parseArgv(["--no-write-baseline"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run")
            expect(r.writeBaseline).toBe(false);
    });
    it("parses --only with a comma-separated list", () => {
        const r = parseArgv(["--only", "s1,s2"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run") {
            expect([...r.onlyIds]).toEqual(["s1", "s2"]);
        }
    });
    it("rejects --only with no argument", () => {
        const r = parseArgv(["--only"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error")
            expect(r.exitCode).toBe(2);
    });
    it("rejects --sha with no argument", () => {
        const r = parseArgv(["--sha"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error")
            expect(r.exitCode).toBe(2);
    });
    it("parses --sha", () => {
        const r = parseArgv(["--sha", "abc123"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run")
            expect(r.sha).toBe("abc123");
    });
    it("sets --list, --dry-run, --keep-worktrees flags", () => {
        const r1 = parseArgv(["--list"]);
        const r2 = parseArgv(["--dry-run"]);
        const r3 = parseArgv(["--keep-worktrees"]);
        if (r1.kind === "run")
            expect(r1.listOnly).toBe(true);
        if (r2.kind === "run")
            expect(r2.dryRun).toBe(true);
        if (r3.kind === "run")
            expect(r3.keepWorktrees).toBe(true);
    });
    it("--append-baseline alone parses with appendBaseline=true", () => {
        const r = parseArgv(["--append-baseline"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run") {
            expect(r.appendBaseline).toBe(true);
            expect(r.writeBaseline).toBe(false);
        }
    });
    it("--append-baseline is allowed with --only (partial update is the point)", () => {
        const r = parseArgv(["--append-baseline", "--only", "s5-impl,s6-review"]);
        expect(r.kind).toBe("run");
        if (r.kind === "run") {
            expect(r.appendBaseline).toBe(true);
            expect([...r.onlyIds].sort()).toEqual(["s5-impl", "s6-review"]);
        }
    });
    it("--write-baseline + --append-baseline is refused", () => {
        const r = parseArgv(["--write-baseline", "--append-baseline"]);
        expect(r.kind).toBe("error");
        if (r.kind === "error") {
            expect(r.exitCode).toBe(2);
            expect(r.message).toContain("mutually exclusive");
        }
    });
    it("HELP_TEXT lists every documented flag + env knob", () => {
        for (const flag of [
            "--only",
            "--sha",
            "--list",
            "--dry-run",
            "--write-baseline",
            "--no-write-baseline",
            "--append-baseline",
            "--keep-worktrees",
            "--help",
        ]) {
            expect(HELP_TEXT).toContain(flag);
        }
        for (const envVar of [
            "FW_EVAL_MODEL",
            "FW_EVAL_TIMEOUT_MS",
            "FW_EVAL_MAX_BUDGET_USD",
            "FW_EVAL_SCRATCH",
        ]) {
            expect(HELP_TEXT).toContain(envVar);
        }
    });
});
//# sourceMappingURL=argv.test.js.map