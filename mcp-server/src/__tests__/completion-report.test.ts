import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  CompletionReportSchemaV1,
  type CompletionReportV1,
  type VerificationBlock,
  VerificationBlockSchema,
  appendVerificationLedger,
  assessVerification,
  completionReportPath,
  computePatchId,
  formatCompletionEvidenceSummary,
  readCompletionReport,
  validateCompletionReport,
  writeCompletionReport,
} from "../completion-report.js";
import { makeExec } from "../exec.js";

// ─── Helpers ───────────────────────────────────────────────

function validReport(overrides: Partial<CompletionReportV1> = {}): CompletionReportV1 {
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

async function makeTempCwd(): Promise<string> {
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
    const report = { ...validReport(), version: 2 } as unknown;
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
      const escaping: CompletionReportV1 = {
        ...report,
        changedFiles: ["../outside.ts" as unknown as string],
      };
      const result = validateCompletionReport(escaping, { id: "bead-1" }, { cwd });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.code === "path_escapes_cwd")).toBe(true);
      }
    } finally {
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ─── readCompletionReport (filesystem) ─────────────────────

describe("readCompletionReport", () => {
  let cwd: string;

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
    const out = formatCompletionEvidenceSummary(
      validReport({
        ubs: {
          ran: false,
          summary: "skipped",
          findingsFixed: 0,
          deferredBeadIds: [],
          skippedReason: "docs-only diff",
        },
      }),
    );
    expect(out).toContain("ubs: skipped (docs-only diff)");
  });

  it("renders verify:none for an empty verify array", () => {
    const out = formatCompletionEvidenceSummary(validReport({ verify: [] }));
    expect(out).toContain("verify: none");
  });
});

// ─── Verification block ────────────────────────────────────

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);
const PATCH_ID = "c".repeat(40);

function verifiedBlock(overrides: Partial<VerificationBlock> = {}): VerificationBlock {
  return {
    verdict: "verified",
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    patchId: PATCH_ID,
    verifier: "RubyHawk",
    verifiedAt: "2026-10-21T20:00:00.000Z",
    evidence: ["npm test: 12 passed"],
    ...overrides,
  };
}

describe("CompletionReportSchemaV1 verification block", () => {
  it("still accepts reports written before the block existed", () => {
    const result = CompletionReportSchemaV1.safeParse(validReport());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.verification).toBeUndefined();
  });

  it("accepts a verified block and round-trips every field", () => {
    const block = verifiedBlock();
    const result = CompletionReportSchemaV1.safeParse(validReport({ verification: block }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.verification).toEqual(block);
  });

  it("accepts needs-verification with only the SHA range and defaults evidence", () => {
    const result = VerificationBlockSchema.safeParse({
      verdict: "needs-verification",
      baseSha: "abc1234",
      headSha: "def5678",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evidence).toEqual([]);
  });

  it("rejects verified without a patchId", () => {
    const result = VerificationBlockSchema.safeParse(verifiedBlock({ patchId: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("patchId");
    }
  });

  it("rejects a decided verdict without verifier or verifiedAt", () => {
    const result = VerificationBlockSchema.safeParse(
      verifiedBlock({ verdict: "verification-failed", verifier: undefined, verifiedAt: undefined }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join(".")).sort()).toEqual([
        "verifiedAt",
        "verifier",
      ]);
    }
  });

  it("rejects refs and option-shaped strings in place of SHAs", () => {
    for (const bad of ["HEAD", "main", "--output=/tmp/x", "abc12"]) {
      const result = VerificationBlockSchema.safeParse(verifiedBlock({ headSha: bad }));
      expect(result.success, bad).toBe(false);
    }
  });
});

// ─── computePatchId (real git) ─────────────────────────────

describe("computePatchId", () => {
  const exec = makeExec();
  let repo: string;

  async function git(...args: string[]): Promise<string> {
    const result = await exec(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo, timeout: 10_000 },
    );
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  async function commitFile(file: string, content: string): Promise<string> {
    await writeFile(path.join(repo, file), content, "utf8");
    await git("add", file);
    await git("commit", "-q", "-m", `edit ${file}`);
    return git("rev-parse", "HEAD");
  }

  beforeEach(async () => {
    repo = await makeTempCwd();
    await git("init", "-q");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("keeps the id across a rebase and changes it when the content changes", async () => {
    await commitFile("b.txt", "b\n");
    const base = await commitFile("a.txt", "a\n");
    const head = await commitFile("a.txt", "a\nchange\n");
    const original = await computePatchId(exec, repo, base, head);
    expect(original).toMatch(/^[0-9a-f]{40}$/);

    // Replay the same change onto a different base.
    await git("checkout", "-q", "-b", "rebased", base);
    const newBase = await commitFile("b.txt", "b\nunrelated\n");
    await git("cherry-pick", head);
    const rebasedHead = await git("rev-parse", "HEAD");
    expect(rebasedHead).not.toBe(head);
    expect(await computePatchId(exec, repo, newBase, rebasedHead)).toBe(original);

    const edited = await commitFile("a.txt", "a\nchange\nmore\n");
    expect(await computePatchId(exec, repo, newBase, edited)).not.toBe(original);
  });

  it("returns null for an empty range", async () => {
    const sha = await commitFile("a.txt", "a\n");
    expect(await computePatchId(exec, repo, sha, sha)).toBeNull();
  });

  it("throws when git cannot resolve the range", async () => {
    await commitFile("a.txt", "a\n");
    await expect(computePatchId(exec, repo, "deadbeef", "deadbeef")).rejects.toThrow(/exit/);
  });

  it("refuses non-SHA arguments before running git", async () => {
    let calls = 0;
    const spy: typeof exec = async (...args) => {
      calls += 1;
      return exec(...args);
    };
    await expect(computePatchId(spy, repo, "--output=/tmp/x", SHA_HEAD)).rejects.toThrow(
      /not a hex git object id/,
    );
    expect(calls).toBe(0);
  });
});

// ─── assessVerification ────────────────────────────────────

describe("assessVerification", () => {
  it("reports verification_missing with no block or a needs-verification verdict", () => {
    expect(assessVerification(undefined, { headSha: SHA_HEAD, patchId: PATCH_ID })).toMatchObject({
      ok: false,
      code: "verification_missing",
    });
    expect(
      assessVerification(verifiedBlock({ verdict: "needs-verification" }), {
        headSha: SHA_HEAD,
        patchId: PATCH_ID,
      }),
    ).toMatchObject({ ok: false, code: "verification_missing" });
  });

  it("reports verification_failed for a failed verdict", () => {
    expect(
      assessVerification(verifiedBlock({ verdict: "verification-failed" }), {
        headSha: SHA_HEAD,
        patchId: PATCH_ID,
      }),
    ).toMatchObject({ ok: false, code: "verification_failed" });
  });

  it("accepts the verified head, and a rebased head with the same patch id", () => {
    expect(assessVerification(verifiedBlock(), { headSha: SHA_HEAD, patchId: PATCH_ID })).toEqual({
      ok: true,
      rebased: false,
    });
    expect(
      assessVerification(verifiedBlock(), { headSha: "d".repeat(40), patchId: PATCH_ID.toUpperCase() }),
    ).toEqual({ ok: true, rebased: true });
  });

  it("reports verification_sha_drift when the patch id changed or the diff is now empty", () => {
    expect(
      assessVerification(verifiedBlock(), { headSha: SHA_HEAD, patchId: "e".repeat(40) }),
    ).toMatchObject({ ok: false, code: "verification_sha_drift" });
    expect(assessVerification(verifiedBlock(), { headSha: SHA_HEAD, patchId: null })).toMatchObject({
      ok: false,
      code: "verification_sha_drift",
    });
  });
});

// ─── appendVerificationLedger ──────────────────────────────

describe("appendVerificationLedger", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTempCwd();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function ledgerLines(rel = ".pi-flywheel/ledger.tsv"): Promise<string[]> {
    const raw = await readFile(path.join(cwd, rel), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    return raw.slice(0, -1).split("\n");
  }

  it("writes the header once and one row per transition", async () => {
    await appendVerificationLedger(cwd, {
      beadId: "bead-1",
      verification: verifiedBlock({ verdict: "needs-verification", patchId: undefined }),
      recordedAt: "2026-10-21T19:00:00.000Z",
    });
    const { path: written } = await appendVerificationLedger(cwd, {
      beadId: "bead-1",
      verification: verifiedBlock(),
    });
    expect(written).toBe(path.join(cwd, ".pi-flywheel/ledger.tsv"));

    const lines = await ledgerLines();
    expect(lines).toEqual([
      "recorded_at\tbead_id\tverdict\tbase_sha\thead_sha\tpatch_id\tverifier\tevidence",
      `2026-10-21T19:00:00.000Z\tbead-1\tneeds-verification\t${SHA_BASE}\t${SHA_HEAD}\t\tRubyHawk\tnpm test: 12 passed`,
      `2026-10-21T20:00:00.000Z\tbead-1\tverified\t${SHA_BASE}\t${SHA_HEAD}\t${PATCH_ID}\tRubyHawk\tnpm test: 12 passed`,
    ]);
  });

  it("keeps every row whole under concurrent writers", async () => {
    const n = 40;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        appendVerificationLedger(cwd, { beadId: `bead-${i}`, verification: verifiedBlock() }),
      ),
    );
    const lines = await ledgerLines();
    expect(lines[0]).toMatch(/^recorded_at\t/);
    expect(lines.filter((l) => l.startsWith("recorded_at"))).toHaveLength(1);
    const rows = lines.slice(1);
    expect(rows).toHaveLength(n);
    for (const row of rows) expect(row.split("\t")).toHaveLength(8);
    expect(new Set(rows.map((r) => r.split("\t")[1])).size).toBe(n);
  });

  it("flattens tabs and newlines inside fields", async () => {
    await appendVerificationLedger(cwd, {
      beadId: "bead-1",
      verification: verifiedBlock({ evidence: ["line one\nline two", "col\tumn"] }),
    });
    const lines = await ledgerLines();
    expect(lines).toHaveLength(2);
    expect(lines[1].split("\t")[7]).toBe("line one line two | col umn");
  });

  it("starts a fresh line after a row torn by a crash", async () => {
    await appendVerificationLedger(cwd, { beadId: "bead-1", verification: verifiedBlock() });
    await appendFile(path.join(cwd, ".pi-flywheel/ledger.tsv"), "2026-10-21T20:00:00.000Z\tbead-torn");
    await appendVerificationLedger(cwd, { beadId: "bead-2", verification: verifiedBlock() });
    const lines = await ledgerLines();
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("2026-10-21T20:00:00.000Z\tbead-torn");
    expect(lines[3].split("\t")[1]).toBe("bead-2");
  });

  it("honours a ledgerPath override and leaves no temp files behind", async () => {
    await appendVerificationLedger(
      cwd,
      { beadId: "bead-1", verification: verifiedBlock() },
      { ledgerPath: "custom/verify.tsv" },
    );
    expect(await ledgerLines("custom/verify.tsv")).toHaveLength(2);
    expect(await readdir(path.join(cwd, "custom"))).toEqual(["verify.tsv"]);
  });
});
