import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CHECK_BEAD_VERIFY = path.join(REPO_ROOT, "scripts", "check-bead-verify.mjs");
const CHECK_PLAN = path.join(REPO_ROOT, "scripts", "check-plan.mjs");
const VENDOR_JSON = path.join(REPO_ROOT, "skills", "PSTACK_VENDOR.json");

type RunResult = { status: number; stdout: string; stderr: string };

function run(script: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [script, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
    };
  }
}

function writeTmp(name: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "check-bead-verify-"));
  const abs = path.join(dir, name);
  writeFileSync(abs, body);
  return abs;
}

const VALID_PLAN = `## Wave 0

#### Bead T.1 Do a thing
- **Verify, unit**: \`npm --prefix mcp-server test -- src/__tests__/thing.test.ts\`
- **Verify, live**: \`node mcp-server/dist/scripts/thing.js --help\`
- **Verify, perf**: \`npm --prefix mcp-server test -- src/__tests__/thing.test.ts\` (under 2000ms)

#### Bead T.2 Do another thing
- **Verify, unit**: \`npm --prefix mcp-server test -- src/__tests__/other.test.ts\`
- **Verify, live**: \`bash scripts/other.sh --check\`
- **Verify, perf**: \`node -e 'console.log(1)'\`
`;

const MISSING_LANE_PLAN = `## Wave 0

#### Bead T.1 Do a thing
- **Verify, unit**: \`npm --prefix mcp-server test -- src/__tests__/thing.test.ts\`
- **Verify, perf**: \`npm --prefix mcp-server test -- src/__tests__/thing.test.ts\`
`;

const PROSE_ONLY_PLAN = `## Wave 0

#### Bead T.1 Do a thing
- **Verify, unit**: \`npm --prefix mcp-server test -- src/__tests__/thing.test.ts\`
- **Verify, live**: \`node mcp-server/dist/scripts/thing.js --help\`
- **Verify, perf**: probe latency stays under the documented budget.
`;

const RULE =
  "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";

// Minimal doc satisfying every check-plan.mjs rule: H1, How to read this
// with all markers, Program checklist with ordered H3s plus markers, one PR
// section with all nine sub-blocks in order, Close the program. No long
// dashes, curly quotes, or mid-sentence colons outside backticks.
function conformingPlan(): string {
  const lanes = Array.from(
    { length: 10 },
    (_, i) => `- [ ] Lane ${i + 1}. Save \`shot${i + 1}.png\` Pass when green`,
  ).join("\n");
  return `# Demo plan
## How to read this
One box is one unit of work
Each box names the evidence
Check a box only when its evidence exists
See playbooks/demo.md
${RULE}
## Program checklist
### Arm the program
Diff base is git show origin/main:
### Spawn owners
Poll with /loop 1h
### PR mechanics
Send a status message
### Verdict and merge
Merge when green
### Boot recipe
Boot and go
## PR 1 Demo change
**Depends on.** nothing else
- [ ] placeholder keeps the parser aligned
**Files.** touched files
- [ ] \`a.ts\`
**Build.** build steps
- [ ] \`npm run build\`
**You see.** visible result
- [ ] screenshot attached
**Verify, unit.** ${RULE}
- [ ] \`npm test\`
**Verify, live.** ${RULE} Ten lanes on \`grok-4.7\` at the PR head
${lanes}
**Verify, perf.** ${RULE}
- [ ] Metric. p95 under 200ms
- [ ] Probe. \`bench.sh\`
- [ ] Baseline. main branch
- [ ] Rule. fail over budget
**Review gate.** None.
**Merge.** merge steps
- [ ] merge when green
## Close the program
- [ ] done
## Appendix A Prototype evidence
- [ ] prototype sketch saved
`;
}

describe("scripts/check-bead-verify.mjs", () => {
  it("passes a plan whose beads carry the full triad with runnable commands", () => {
    const file = writeTmp("valid.md", VALID_PLAN);
    const r = run(CHECK_BEAD_VERIFY, [file, "--json"]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      sources: { beads: { ok: boolean; commands: Record<string, string | null> }[] }[];
    };
    expect(report.ok).toBe(true);
    expect(report.sources[0].beads).toHaveLength(2);
    for (const bead of report.sources[0].beads) {
      expect(bead.ok).toBe(true);
      expect(bead.commands.unit).toContain("npm");
      expect(bead.commands.live).toBeTruthy();
      expect(bead.commands.perf).toBeTruthy();
    }
  });

  it("fails a bead missing a triad lane", () => {
    const file = writeTmp("missing.md", MISSING_LANE_PLAN);
    const r = run(CHECK_BEAD_VERIFY, [file]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("missing Verify, live");
  });

  it("warns (not fails) on prose-only commands unless --strict", () => {
    const file = writeTmp("prose.md", PROSE_ONLY_PLAN);
    expect(run(CHECK_BEAD_VERIFY, [file]).status).toBe(0);
    const strict = run(CHECK_BEAD_VERIFY, [file, "--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("no runnable command");
  });
});

describe("scripts/check-plan.mjs (vendored)", () => {
  it("exits 2 with usage when no file is given", () => {
    expect(run(CHECK_PLAN, []).status).toBe(2);
  });

  it("flags style violations in prose", () => {
    const file = writeTmp("dash.md", "# T\nSome prose with a long \u2014 dash\n");
    const r = run(CHECK_PLAN, [file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("long dash");
  });

  it("passes a minimal conforming pstack-format plan", () => {
    const file = writeTmp("good.md", conformingPlan());
    const r = run(CHECK_PLAN, [file]);
    expect(r.stdout).toContain("1 PR sections, 0 problems");
    expect(r.status).toBe(0);
  });
});

describe("skills/PSTACK_VENDOR.json integrity", () => {
  it("exists with provenance fields and matching SHA-256 hashes", () => {
    expect(existsSync(VENDOR_JSON)).toBe(true);
    const vendor = JSON.parse(readFileSync(VENDOR_JSON, "utf8")) as {
      upstreamRepo: string;
      vendoredAt: string;
      files: Record<string, { sha256: string }>;
    };
    expect(vendor.upstreamRepo).toContain("github.com/cursor/plugins");
    expect(vendor.vendoredAt).toBeTruthy();
    const entries = Object.entries(vendor.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const [rel, meta] of entries) {
      const abs = path.join(REPO_ROOT, rel);
      expect(existsSync(abs), `${rel} exists`).toBe(true);
      const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
      expect(actual, `${rel} sha256`).toBe(meta.sha256);
    }
  });

  it("vendors the four available core skills with normalized frontmatter", () => {
    for (const skill of ["poteto-mode", "interrogate", "architect", "why"]) {
      const skillMd = path.join(REPO_ROOT, "skills", skill, "SKILL.md");
      expect(existsSync(skillMd)).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, "skills", skill, "references"))).toBe(true);
      const text = readFileSync(skillMd, "utf8");
      const close = text.indexOf("\n---", 3);
      const keys = text
        .slice(4, close)
        .split("\n")
        .map((l) => l.split(":")[0].trim())
        .filter(Boolean);
      expect(keys.sort()).toEqual(["description", "name"]);
    }
  });
});
