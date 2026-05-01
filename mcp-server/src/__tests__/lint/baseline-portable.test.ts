// Regression test for agent-flywheel-plugin-lss: baseline must store
// repo-relative paths so a baseline generated in worktree A still applies in
// worktree B (or a fresh clone) where absolute paths differ.

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyBaseline,
  generateBaseline,
  toRepoRelativePosix,
  computeFingerprint,
  type BaselineFile,
} from "../../lint/baseline.js";
import type { Finding } from "../../lint/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// __tests__/lint -> __tests__ -> src -> mcp-server
const MCP_SERVER_ROOT = path.resolve(HERE, "..", "..", "..");
const REPO_ROOT = path.resolve(MCP_SERVER_ROOT, "..");
const CLI_PATH = path.join(MCP_SERVER_ROOT, "dist", "scripts", "lint-skill.js");
const FIXTURE = path.join(MCP_SERVER_ROOT, "src", "__tests__", "lint", "fixtures", "auq001-too-few.md");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd ?? MCP_SERVER_ROOT,
      env: { ...process.env, GITHUB_ACTIONS: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

describe("toRepoRelativePosix", () => {
  it("converts an absolute path under repoRoot to a POSIX-relative path", () => {
    const abs = path.join("/tmp/myrepo", "skills", "start", "SKILL.md");
    expect(toRepoRelativePosix(abs, "/tmp/myrepo")).toBe("skills/start/SKILL.md");
  });

  it("leaves an already-relative path repo-relative (POSIX form)", () => {
    expect(toRepoRelativePosix("skills/start/SKILL.md", "/tmp/myrepo")).toBe(
      "skills/start/SKILL.md",
    );
  });

  it("does not collapse paths outside repoRoot to ambiguous strings", () => {
    // Outside-of-repo paths produce a `..`-prefixed result; that's fine — they
    // simply won't match any in-repo entry, which is the desired behavior.
    const out = toRepoRelativePosix("/tmp/elsewhere/file.md", "/tmp/myrepo");
    expect(out.startsWith("../")).toBe(true);
    expect(out.includes("\\")).toBe(false);
  });
});

describe("baseline portability across worktrees (unit)", () => {
  const source = "alpha\nbeta\ngamma\ndelta";

  // Two different "worktrees" representing the same repo content. The baseline
  // is generated against worktreeA but compared against findings from worktreeB.
  const worktreeA = "/tmp/agent-flywheel/worktreeA";
  const worktreeB = "/tmp/agent-flywheel/worktreeB";
  const findingFileA = path.join(worktreeA, "skills", "start", "SKILL.md");
  const findingFileB = path.join(worktreeB, "skills", "start", "SKILL.md");

  it("generateBaseline writes repo-relative file paths when repoRoot is provided", () => {
    const findings: Finding[] = [
      { ruleId: "PLACE001", severity: "warn", file: findingFileA, line: 2, column: 1, message: "m" },
    ];
    const bf = generateBaseline(findings, source, "now", worktreeA);
    expect(bf.entries).toHaveLength(1);
    // Must NOT contain the absolute worktree prefix.
    expect(bf.entries[0].file).toBe("skills/start/SKILL.md");
    expect(path.isAbsolute(bf.entries[0].file)).toBe(false);
  });

  it("applyBaseline matches a finding from a different worktree (repo-relative)", () => {
    const baseline: BaselineFile = {
      schemaVersion: 1,
      rulesetVersion: 1,
      generated: "now",
      entries: [
        {
          ruleId: "PLACE001",
          rulesetVersion: 1,
          file: "skills/start/SKILL.md", // repo-relative — portable
          line: 2,
          fingerprint: computeFingerprint(source, 2),
          reason: "",
        },
      ],
    };
    const findingFromWorktreeB: Finding = {
      ruleId: "PLACE001",
      severity: "warn",
      file: findingFileB, // absolute — different worktree
      line: 2,
      column: 1,
      message: "placeholder",
    };
    const { live, baselined } = applyBaseline(
      [findingFromWorktreeB],
      baseline,
      source,
      worktreeB,
    );
    expect(live).toHaveLength(0);
    expect(baselined).toHaveLength(1);
    expect(baselined[0].severity).toBe("info");
  });

  it("without repoRoot, absolute mismatch leaves the finding live (regression guard)", () => {
    const baseline: BaselineFile = {
      schemaVersion: 1,
      rulesetVersion: 1,
      generated: "now",
      entries: [
        {
          ruleId: "PLACE001",
          rulesetVersion: 1,
          file: findingFileA, // absolute path captured under worktreeA
          line: 2,
          fingerprint: computeFingerprint(source, 2),
          reason: "",
        },
      ],
    };
    const findingFromB: Finding = {
      ruleId: "PLACE001",
      severity: "warn",
      file: findingFileB, // different absolute path
      line: 2,
      column: 1,
      message: "placeholder",
    };
    const { live, baselined } = applyBaseline([findingFromB], baseline, source);
    // Documents the legacy behavior: without repoRoot we can't normalize,
    // and the baseline doesn't apply across worktrees. This is exactly the
    // bug that lss fixes when callers pass repoRoot.
    expect(live).toHaveLength(1);
    expect(baselined).toHaveLength(0);
  });
});

describe("lint-skill CLI baseline portability (end-to-end)", () => {
  beforeAll(async () => {
    try {
      await stat(CLI_PATH);
    } catch {
      throw new Error(
        `compiled CLI not found at ${CLI_PATH} — run "npm run build" before vitest`,
      );
    }
  });

  it("--update-baseline writes repo-relative file paths (no absolute leak)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lintskill-portable-"));
    try {
      const baselinePath = path.join(dir, "baseline.json");
      const r = await run([
        "--file",
        FIXTURE,
        "--ci",
        "--update-baseline",
        "--baseline",
        baselinePath,
      ]);
      expect(r.code).toBe(0);
      const text = await readFile(baselinePath, "utf8");
      const parsed = JSON.parse(text) as {
        entries: Array<{ file: string; ruleId: string }>;
      };
      expect(parsed.entries.length).toBeGreaterThan(0);
      // Every entry — regardless of rule — must be repo-relative POSIX. The
      // path-equality check only applies to findings attributed to the input
      // SKILL.md fixture; cross-file rules (RESERVE001) attribute findings to
      // src files instead, so filter before asserting fixture identity.
      for (const e of parsed.entries) {
        expect(path.isAbsolute(e.file)).toBe(false);
        expect(e.file.includes("\\")).toBe(false);
      }
      const fixtureEntries = parsed.entries.filter(
        (e) => e.file === "mcp-server/src/__tests__/lint/fixtures/auq001-too-few.md",
      );
      expect(fixtureEntries.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("baseline generated in repo applies when CLI is invoked from a tmp working dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lintskill-portable-cwd-"));
    try {
      const baselinePath = path.join(dir, "baseline.json");
      // 1) Generate baseline (default cwd = mcp-server).
      const gen = await run([
        "--file",
        FIXTURE,
        "--ci",
        "--update-baseline",
        "--baseline",
        baselinePath,
      ]);
      expect(gen.code).toBe(0);

      // 2) Run from a tmp cwd outside the repo. With portable paths this
      // must still demote findings to info (severity-only impact: exit 0
      // instead of leaking the originally-warn-severity rule as live).
      const r = await run(
        [
          "--file",
          FIXTURE,
          "--ci",
          "--baseline",
          baselinePath,
          "--format",
          "json",
        ],
        { cwd: dir },
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        findings: Array<{ ruleId: string; severity: string; message: string }>;
      };
      const auq = parsed.findings.find((f) => f.ruleId === "AUQ001");
      expect(auq).toBeDefined();
      expect(auq?.severity).toBe("info");
      expect(auq?.message).toMatch(/^\[baselined\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checked-in baseline at .lintskill-baseline.json contains only repo-relative paths", async () => {
    const baselinePath = path.join(MCP_SERVER_ROOT, ".lintskill-baseline.json");
    let text: string;
    try {
      text = await readFile(baselinePath, "utf8");
    } catch {
      // No checked-in baseline is fine — nothing to assert.
      return;
    }
    const parsed = JSON.parse(text) as {
      entries: Array<{ file: string }>;
    };
    for (const e of parsed.entries) {
      expect(path.isAbsolute(e.file)).toBe(false);
      // No worktree-shaped paths embedded.
      expect(e.file.includes(".claude/worktrees/")).toBe(false);
      expect(e.file.startsWith(REPO_ROOT)).toBe(false);
    }
  });
});
