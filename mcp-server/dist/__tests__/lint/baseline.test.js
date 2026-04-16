import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeSourceForFingerprint, computeFingerprint, loadBaseline, saveBaseline, applyBaseline, generateBaseline, RULESET_VERSION, } from "../../lint/baseline.js";
describe("normalizeSourceForFingerprint", () => {
    it("converts CRLF to LF", () => {
        expect(normalizeSourceForFingerprint("a\r\nb\r\nc")).toBe("a\nb\nc");
    });
    it("strips a leading BOM", () => {
        expect(normalizeSourceForFingerprint("\uFEFFhello")).toBe("hello");
    });
});
describe("computeFingerprint", () => {
    it("is deterministic across calls", () => {
        const src = "alpha\nbeta\ngamma\ndelta";
        const a = computeFingerprint(src, 2);
        const b = computeFingerprint(src, 2);
        expect(a).toBe(b);
        expect(a.startsWith("sha256:")).toBe(true);
    });
    it("CRLF normalization runs BEFORE fingerprint (NON-NEGOTIABLE)", () => {
        const lf = "abc\nfoo\nbar";
        const crlf = "abc\r\nfoo\r\nbar";
        expect(computeFingerprint(crlf, 2)).toBe(computeFingerprint(lf, 2));
    });
    it("is invariant under whitespace-only edits in adjacent lines (we trim)", () => {
        const src1 = "alpha\nbeta\ngamma";
        const src2 = "  alpha  \nbeta\n   gamma";
        expect(computeFingerprint(src1, 2)).toBe(computeFingerprint(src2, 2));
    });
    it("changes when current line content changes", () => {
        const src1 = "alpha\nbeta\ngamma";
        const src2 = "alpha\nBETA\ngamma";
        expect(computeFingerprint(src1, 2)).not.toBe(computeFingerprint(src2, 2));
    });
    it("inserting a blank line above shifts the line number but the new line at same number has different fingerprint", () => {
        const src1 = "alpha\nbeta\ngamma";
        const src2 = "\nalpha\nbeta\ngamma"; // beta is now at line 3, line 2 is "alpha"
        expect(computeFingerprint(src1, 2)).not.toBe(computeFingerprint(src2, 2));
        // but the same content (beta) at its new line still matches the original
        expect(computeFingerprint(src2, 3)).toBe(computeFingerprint(src1, 2));
    });
});
describe("loadBaseline / saveBaseline", () => {
    let tmp;
    beforeEach(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), "baseline-"));
    });
    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });
    it("returns null when the file is missing", async () => {
        const result = await loadBaseline(path.join(tmp, "nope.json"));
        expect(result).toBeNull();
    });
    it("parses a valid baseline file", async () => {
        const file = path.join(tmp, "baseline.json");
        const content = {
            schemaVersion: 1,
            rulesetVersion: 1,
            generated: "2026-04-15T00:00:00Z",
            entries: [
                {
                    ruleId: "no-foo",
                    rulesetVersion: 1,
                    file: "a.md",
                    line: 3,
                    fingerprint: "sha256:abc",
                    reason: "",
                },
            ],
        };
        await writeFile(file, JSON.stringify(content), "utf8");
        const loaded = await loadBaseline(file);
        expect(loaded).toEqual(content);
    });
    it("throws on malformed JSON", async () => {
        const file = path.join(tmp, "bad.json");
        await writeFile(file, "not json {{{", "utf8");
        await expect(loadBaseline(file)).rejects.toThrow();
    });
    it("throws on schema mismatch", async () => {
        const file = path.join(tmp, "schema-mismatch.json");
        await writeFile(file, JSON.stringify({ schemaVersion: 999 }), "utf8");
        await expect(loadBaseline(file)).rejects.toThrow();
    });
    it("round-trips via save + load", async () => {
        const file = path.join(tmp, "rt.json");
        const baseline = {
            schemaVersion: 1,
            rulesetVersion: 1,
            generated: "2026-04-15T00:00:00Z",
            entries: [
                {
                    ruleId: "r1",
                    rulesetVersion: 1,
                    file: "x.md",
                    line: 1,
                    fingerprint: "sha256:zzz",
                    reason: "test",
                },
            ],
        };
        await saveBaseline(file, baseline);
        const loaded = await loadBaseline(file);
        expect(loaded).toEqual(baseline);
        const text = await readFile(file, "utf8");
        expect(text.endsWith("\n")).toBe(true);
    });
});
describe("applyBaseline", () => {
    const source = "alpha\nbeta\ngamma\ndelta";
    const finding = (overrides = {}) => ({
        ruleId: "no-foo",
        severity: "warn",
        file: "a.md",
        line: 2,
        column: 1,
        message: "foo found",
        ...overrides,
    });
    it("returns all findings live when baseline is null", () => {
        const f = finding();
        const { live, baselined } = applyBaseline([f], null, source);
        expect(live).toEqual([f]);
        expect(baselined).toEqual([]);
    });
    it("demotes matching findings to info with [baselined] prefix", () => {
        const baseline = {
            schemaVersion: 1,
            rulesetVersion: 1,
            generated: "now",
            entries: [
                {
                    ruleId: "no-foo",
                    rulesetVersion: 1,
                    file: "a.md",
                    line: 2,
                    fingerprint: computeFingerprint(source, 2),
                    reason: "",
                },
            ],
        };
        const f = finding();
        const { live, baselined } = applyBaseline([f], baseline, source);
        expect(live).toEqual([]);
        expect(baselined).toHaveLength(1);
        expect(baselined[0].severity).toBe("info");
        expect(baselined[0].message).toBe("[baselined] foo found");
    });
    it("leaves non-matching findings live", () => {
        const baseline = {
            schemaVersion: 1,
            rulesetVersion: 1,
            generated: "now",
            entries: [
                {
                    ruleId: "no-foo",
                    rulesetVersion: 1,
                    file: "different.md",
                    line: 2,
                    fingerprint: "sha256:something",
                    reason: "",
                },
            ],
        };
        const f = finding();
        const { live, baselined } = applyBaseline([f], baseline, source);
        expect(live).toEqual([f]);
        expect(baselined).toEqual([]);
    });
    it("matches by fingerprint when line number drifts", () => {
        // Original baseline captured beta at line 2.
        const originalSource = "alpha\nbeta\ngamma\ndelta";
        const fpAtLine2 = computeFingerprint(originalSource, 2);
        // New source: a line was inserted above; beta is now at line 3.
        const driftedSource = "intro\nalpha\nbeta\ngamma\ndelta";
        const baseline = {
            schemaVersion: 1,
            rulesetVersion: 1,
            generated: "now",
            entries: [
                {
                    ruleId: "no-foo",
                    rulesetVersion: 1,
                    file: "a.md",
                    line: 2, // stale line number
                    fingerprint: fpAtLine2,
                    reason: "",
                },
            ],
        };
        // The new finding reports beta at line 3. Line numbers do not match,
        // but fingerprint at line 3 of driftedSource should equal the captured fp.
        const f = finding({ line: 3 });
        const { live, baselined } = applyBaseline([f], baseline, driftedSource);
        expect(live).toEqual([]);
        expect(baselined).toHaveLength(1);
    });
});
describe("generateBaseline", () => {
    it("produces a valid BaselineFile with computed fingerprints", () => {
        const source = "alpha\nbeta\ngamma";
        const findings = [
            { ruleId: "r1", severity: "warn", file: "x.md", line: 2, column: 1, message: "m" },
        ];
        const out = generateBaseline(findings, source, "2026-04-15T00:00:00Z");
        expect(out.schemaVersion).toBe(1);
        expect(out.rulesetVersion).toBe(RULESET_VERSION);
        expect(out.generated).toBe("2026-04-15T00:00:00Z");
        expect(out.entries).toHaveLength(1);
        expect(out.entries[0].fingerprint).toBe(computeFingerprint(source, 2));
        expect(out.entries[0].ruleId).toBe("r1");
        expect(out.entries[0].file).toBe("x.md");
        expect(out.entries[0].line).toBe(2);
        expect(out.entries[0].rulesetVersion).toBe(RULESET_VERSION);
        expect(out.entries[0].reason).toBe("");
    });
});
//# sourceMappingURL=baseline.test.js.map