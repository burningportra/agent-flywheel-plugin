import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CompletionReportSchemaV1, completionReportPath, formatCompletionEvidenceSummary, readCompletionReport, validateCompletionReport, writeCompletionReport, } from "../completion-report.js";
// ─── Helpers ───────────────────────────────────────────────
function validReport(overrides = {}) {
    return {
        version: 1,
        beadId: "bead-1",
        agentName: "AmberBrook",
        paneName: "agent-flywheel--impl-wave1__cc_1",
        status: "closed",
        changedFiles: ["mcp-server/src/completion-report.ts"],
        commits: ["a1b2c3d"],
        ubs: {
            ran: true,
            summary: "clean",
            findingsFixed: 0,
            deferredBeadIds: [],
        },
        verify: [
            { command: "npm run build --prefix mcp-server", exitCode: 0, summary: "ok" },
            { command: "npm test --prefix mcp-server -- completion-report", exitCode: 0, summary: "5 passed" },
        ],
        selfReview: { ran: true, summary: "no regressions, edge cases covered" },
        beadClosedVerified: true,
        reservationsReleased: true,
        createdAt: "2026-04-30T23:59:59.000Z",
        ...overrides,
    };
}
async function makeTempCwd() {
    return await mkdtemp(path.join(tmpdir(), "fw-completion-test-"));
}
// ─── Schema validation ─────────────────────────────────────
describe("CompletionReportSchemaV1", () => {
    it("accepts a valid full report", () => {
        const result = CompletionReportSchemaV1.safeParse(validReport());
        expect(result.success).toBe(true);
    });
    it("accepts a docs-only UBS skip with reason", () => {
        const report = validReport({
            changedFiles: ["docs/plans/2026-04-30-duel-winners.md"],
            ubs: {
                ran: false,
                summary: "skipped (docs-only)",
                findingsFixed: 0,
                deferredBeadIds: [],
                skippedReason: "docs-only diff",
            },
        });
        const result = CompletionReportSchemaV1.safeParse(report);
        expect(result.success).toBe(true);
    });
    it("rejects ubs.ran=false without skippedReason", () => {
        const report = validReport({
            ubs: {
                ran: false,
                summary: "skipped",
                findingsFixed: 0,
                deferredBeadIds: [],
            },
        });
        const result = CompletionReportSchemaV1.safeParse(report);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => /skippedReason/.test(i.message))).toBe(true);
        }
    });
    it("rejects a report missing the verify field entirely", () => {
        const { verify: _omit, ...rest } = validReport();
        void _omit;
        const result = CompletionReportSchemaV1.safeParse(rest);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.path.includes("verify"))).toBe(true);
        }
    });
    it("rejects an absolute changedFile path at schema level", () => {
        const report = validReport({ changedFiles: ["/etc/passwd"] });
        const result = CompletionReportSchemaV1.safeParse(report);
        expect(result.success).toBe(false);
    });
    it("rejects a `..` traversal changedFile path at schema level", () => {
        const report = validReport({ changedFiles: ["../escape/me.ts"] });
        const result = CompletionReportSchemaV1.safeParse(report);
        expect(result.success).toBe(false);
    });
    it("rejects version != 1", () => {
        const report = { ...validReport(), version: 2 };
        const result = CompletionReportSchemaV1.safeParse(report);
        expect(result.success).toBe(false);
    });
    it("rejects a bad ISO-8601 createdAt", () => {
        const report = validReport({ createdAt: "yesterday" });
        const result = CompletionReportSchemaV1.safeParse(report);
        expect(result.success).toBe(false);
    });
});
// ─── validateCompletionReport (cross-bead) ─────────────────
describe("validateCompletionReport", () => {
    it("returns ok for a matching bead and verified close", () => {
        const result = validateCompletionReport(validReport(), { id: "bead-1" });
        expect(result.ok).toBe(true);
    });
    it("flags closed-without-verification when beadClosedVerified=false", () => {
        const report = validReport({ status: "closed", beadClosedVerified: false });
        const result = validateCompletionReport(report, { id: "bead-1" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues.some((i) => i.code === "closed_without_verification")).toBe(true);
        }
    });
    it("allows status=blocked with beadClosedVerified=false", () => {
        const report = validReport({ status: "blocked", beadClosedVerified: false });
        const result = validateCompletionReport(report, { id: "bead-1" });
        expect(result.ok).toBe(true);
    });
    it("flags bead_id_mismatch when report and bead disagree", () => {
        const report = validReport({ beadId: "wrong" });
        const result = validateCompletionReport(report, { id: "bead-1" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues.some((i) => i.code === "bead_id_mismatch")).toBe(true);
        }
    });
    it("flags path_escapes_cwd when changedFiles resolve outside cwd", async () => {
        const cwd = await makeTempCwd();
        try {
            // Bypass the schema-level refine by constructing the object directly.
            const report = validReport();
            // The textual path `../outside.ts` is rejected by schema; to test the
            // resolve-based escape check we construct a path that would only escape
            // when resolved from cwd. The schema accepts `foo/../../escape.ts`
            // because raw normalisation produces `../escape.ts` — but Zod's refine
            // rejects that. So we craft a sibling-cwd path via unicode trick? Not
            // portable. Instead, exercise the resolve-check by supplying a cwd
            // whose resolution differs and using `os.tmpdir`-style absolute-prefixed
            // path that the schema will not see (we feed validateCompletionReport
            // directly with a cast). This documents the residual defense-in-depth.
            const escaping = {
                ...report,
                changedFiles: ["../outside.ts"],
            };
            const result = validateCompletionReport(escaping, { id: "bead-1" }, { cwd });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.issues.some((i) => i.code === "path_escapes_cwd")).toBe(true);
            }
        }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });
    it("accepts in-cwd changedFiles when cwd is provided", async () => {
        const cwd = await makeTempCwd();
        try {
            const report = validReport({
                changedFiles: ["src/foo.ts", "tests/foo.test.ts"],
            });
            const result = validateCompletionReport(report, { id: "bead-1" }, { cwd });
            expect(result.ok).toBe(true);
        }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });
});
// ─── readCompletionReport (filesystem) ─────────────────────
describe("readCompletionReport", () => {
    let cwd;
    beforeEach(async () => {
        cwd = await makeTempCwd();
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it("returns not_found when the file is missing", async () => {
        const result = await readCompletionReport(cwd, "missing-bead");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("not_found");
        }
    });
    it("returns invalid_json when the file is not JSON", async () => {
        const filePath = completionReportPath(cwd, "bead-1");
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "{ not json", "utf8");
        const result = await readCompletionReport(cwd, "bead-1");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("invalid_json");
        }
    });
    it("returns schema_invalid when the JSON does not match the schema", async () => {
        const filePath = completionReportPath(cwd, "bead-1");
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify({ version: 1, beadId: "bead-1" }), "utf8");
        const result = await readCompletionReport(cwd, "bead-1");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("schema_invalid");
        }
    });
    it("round-trips a written report", async () => {
        const report = validReport();
        await writeCompletionReport(cwd, report);
        const result = await readCompletionReport(cwd, report.beadId);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.report).toEqual(report);
        }
    });
});
// ─── formatCompletionEvidenceSummary ───────────────────────
describe("formatCompletionEvidenceSummary", () => {
    it("renders ubs:clean / verify list / self-review:ran for a healthy report", () => {
        const out = formatCompletionEvidenceSummary(validReport());
        expect(out).toContain("[bead-1]");
        expect(out).toContain("closed by AmberBrook");
        expect(out).toContain("ubs: clean");
        expect(out).toContain("verify: npm run build --prefix mcp-server=0");
        expect(out).toContain("self-review: ran");
        expect(out).toContain("closed=true");
    });
    it("renders ubs:skipped with reason for a docs-only report", () => {
        const out = formatCompletionEvidenceSummary(validReport({
            ubs: {
                ran: false,
                summary: "skipped",
                findingsFixed: 0,
                deferredBeadIds: [],
                skippedReason: "docs-only diff",
            },
        }));
        expect(out).toContain("ubs: skipped (docs-only diff)");
    });
    it("renders verify:none for an empty verify array", () => {
        const out = formatCompletionEvidenceSummary(validReport({ verify: [] }));
        expect(out).toContain("verify: none");
    });
});
//# sourceMappingURL=completion-report.test.js.map