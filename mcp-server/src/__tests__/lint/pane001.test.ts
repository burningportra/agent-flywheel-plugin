import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  extractLaneCounts,
  pane001,
  parseCanonicalFromAgentsMd,
  validateLaneCounts,
  type CanonicalRule,
} from "../../lint/rules/pane001.js";
import type { Document } from "../../lint/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

const CANONICAL_AGENTS_MD = `# AGENTS.md

Some preamble.

## NTM pane priority

When spawning NTM panes for the swarm, prefer **cc:cod:gem 1:1:1**
model-diversified default as of v3.17.0. Substitution ladder when a lane is
unavailable: gmi→cod→pi→cc.

## Next section
unrelated content.
`;

const CANONICAL_RULE: CanonicalRule = {
  lanes: ["cc", "cod", "gmi"],
  ratio: [1, 1, 1],
  ladder: ["gmi", "cod", "pi", "cc"],
  version: "v3.17.0",
};

function freshDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ─── parseCanonicalFromAgentsMd ──────────────────────────────────────────

describe("PANE001 — parseCanonicalFromAgentsMd", () => {
  it("extracts ratio + ladder + version from a well-formed section", () => {
    const r = parseCanonicalFromAgentsMd(CANONICAL_AGENTS_MD);
    expect(r).not.toBeNull();
    expect(r!.ratio).toEqual([1, 1, 1]);
    expect(r!.ladder).toEqual(["gmi", "cod", "pi", "cc"]);
    expect(r!.version).toBe("v3.17.0");
  });

  it("returns null when the NTM pane priority section is missing", () => {
    const r = parseCanonicalFromAgentsMd("# AGENTS.md\n\nNo NTM pane priority section here.\n");
    expect(r).toBeNull();
  });

  it("returns null when ratio is missing", () => {
    const r = parseCanonicalFromAgentsMd(
      "## NTM pane priority\n\nSubstitution ladder: gmi→cod→pi→cc.\n",
    );
    expect(r).toBeNull();
  });

  it("falls back to the default ladder when the inline arrow form is missing", () => {
    // AGENTS.md sometimes formats the ladder as a numbered list rather than
    // an inline arrow chain; we accept that and default to the canonical
    // gmi→cod→pi→cc ladder when the inline regex doesn't match.
    const r = parseCanonicalFromAgentsMd(
      "## NTM pane priority\n\ncc:cod:gem 1:1:1 default.\n",
    );
    expect(r).not.toBeNull();
    expect(r!.ladder).toEqual(["gmi", "cod", "pi", "cc"]);
  });

  it("accepts the ASCII -> arrow form alongside Unicode →", () => {
    const r = parseCanonicalFromAgentsMd(
      "## NTM pane priority\n\ncc:cod:gem 1:1:1; ladder: gmi -> cod -> pi -> cc.\n",
    );
    expect(r).not.toBeNull();
    expect(r!.ladder).toEqual(["gmi", "cod", "pi", "cc"]);
  });

  it("tolerates backticks around cc:cod:gem (markdown code styling)", () => {
    const r = parseCanonicalFromAgentsMd(
      "## NTM pane priority\n\nMixed `cc:cod:gem` 1:1:1 — diverse models.\n",
    );
    expect(r).not.toBeNull();
    expect(r!.ratio).toEqual([1, 1, 1]);
  });
});

// ─── extractLaneCounts ───────────────────────────────────────────────────

describe("PANE001 — extractLaneCounts", () => {
  it("parses --cc=N --cod=M --gmi=K from a single line", () => {
    const c = extractLaneCounts("ntm spawn proj --label x --cc=2 --cod=2 --gmi=2 --stagger-mode=smart");
    expect(c).toEqual({ cc: 2, cod: 2, gmi: 2 });
  });

  it("treats --gem= as --gmi= (deprecated synonym)", () => {
    const c = extractLaneCounts("ntm spawn proj --cc=1 --cod=1 --gem=1");
    expect(c).toEqual({ cc: 1, cod: 1, gmi: 1 });
  });

  it("returns empty map when no lane flags are present", () => {
    const c = extractLaneCounts("ntm spawn proj --label x --stagger-mode=smart");
    expect(c).toEqual({});
  });

  it("includes --pi=N in the output map", () => {
    const c = extractLaneCounts("ntm spawn proj --cc=2 --pi=4");
    expect(c).toEqual({ cc: 2, pi: 4 });
  });
});

// ─── validateLaneCounts ──────────────────────────────────────────────────

describe("PANE001 — validateLaneCounts", () => {
  it("returns null (valid) for cc:cod:gmi 2:2:2 against canonical 1:1:1", () => {
    expect(validateLaneCounts({ cc: 2, cod: 2, gmi: 2 }, CANONICAL_RULE)).toBeNull();
  });

  it("returns null for cc:cod:gmi 1:1:1 (exact canonical)", () => {
    expect(validateLaneCounts({ cc: 1, cod: 1, gmi: 1 }, CANONICAL_RULE)).toBeNull();
  });

  it("flags non-canonical ratio like 4:2:0 (4cc + 2cod, gmi dropped)", () => {
    // Note: gmi=0 is allowed (substitution ladder permits drops), so this
    // should validate as 4cc + 2cod where multipliers are 4 vs 2 — mismatch.
    const v = validateLaneCounts({ cc: 4, cod: 2 }, CANONICAL_RULE);
    expect(v).not.toBeNull();
    expect(v).toMatch(/lane ratio/);
  });

  it("returns null for cc-only spawn (cod=0, gmi=0) — all-cc fallback case", () => {
    expect(validateLaneCounts({ cc: 6 }, CANONICAL_RULE)).toBeNull();
  });

  it("returns null for cc:cod with gmi=0 IF cc and cod scale together (ladder applied: gmi missing → bump cod)", () => {
    // After gmi missing, the ladder reassigns gmi's share to cod. So cc:cod
    // 2:4 corresponds to (cc=2, cod=2+2=4) — but ratio-wise this is 2:4 which
    // doesn't match canonical 1:1. Validation flags this.
    // The validation rule is "each present lane scales by the same integer
    // multiple of canonical" — for cc=2 cod=4, multipliers are 2 and 4. Flag.
    const v = validateLaneCounts({ cc: 2, cod: 4 }, CANONICAL_RULE);
    expect(v).not.toBeNull();
  });

  it("flags --pi=N alongside both cod>0 AND gmi>0 (pi gate)", () => {
    const v = validateLaneCounts({ cc: 2, cod: 2, gmi: 2, pi: 1 }, CANONICAL_RULE);
    expect(v).not.toBeNull();
    expect(v).toMatch(/pi=1 present alongside both/);
  });

  it("allows --pi=N when cod=0 (substitution ladder: cod missing → bump pi)", () => {
    expect(validateLaneCounts({ cc: 2, pi: 4 }, CANONICAL_RULE)).toBeNull();
  });
});

// ─── End-to-end rule check ───────────────────────────────────────────────

describe("PANE001 — rule.check (cross-file scan)", () => {
  const emptyDoc: Document = { source: "", filePath: "<unused>" };

  async function findingForDriftFixture(source: string, prefix: string) {
    const dir = freshDir(prefix);
    const skillsRoot = path.join(dir, "skills", "start");
    const fileName = "_implement.md";
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(path.join(skillsRoot, fileName), source, "utf8");

    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      canonical: CANONICAL_RULE,
      repoRoot: dir,
      skillsRoot,
    } as never);

    return findings.find((x) => x.file.endsWith(fileName));
  }

  it("returns no findings when no skill files contain spawn lines", async () => {
    const dir = freshDir("pane001-clean-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      path.join(skillsRoot, "_clean.md"),
      "# Clean file\n\nNo ntm spawn lines here.\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    expect(findings.length).toBe(0);
  });

  it("flags a non-canonical spawn line", async () => {
    const dir = freshDir("pane001-drift-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      path.join(skillsRoot, "_drift.md"),
      "# Drift fixture\n\n```bash\nntm spawn proj --label x --no-user --cc=4 --cod=2 --stagger-mode=smart\n```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const f = findings.find((x) => x.file.endsWith("_drift.md"));
    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.severity).toBe("error");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("does NOT suppress a nearby drift when only loose 'explicit override' prose is nearby", async () => {
    const dir = freshDir("pane001-loose-near-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      path.join(skillsRoot, "_implement.md"),
      "# Impl file\n\nThis path mentions the cc-only floor (explicit override) in normal substitution-ladder prose.\n\n```bash\nntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    const f = findings.find((x) => x.file.endsWith("_implement.md"));
    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("suppresses a non-canonical spawn line when a canonical override marker is within ±6 lines", async () => {
    const dir = freshDir("pane001-override-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      path.join(skillsRoot, "_deslop.md"),
      "# Deslop file\n\n<!-- pane001-override: deslop is intentionally cod-heavy -->\n\n```bash\nntm spawn proj --label deslop --no-user --cod=5 --stagger-mode=smart\n```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    expect(findings.find((f) => f.file.endsWith("_deslop.md"))).toBeUndefined();
  });

  it("returns no findings when canonical cannot be parsed (graceful degrade)", async () => {
    const dir = freshDir("pane001-no-agents-");
    const agentsPath = path.join(dir, "AGENTS.md");
    writeFileSync(agentsPath, "# AGENTS.md\n\nNo NTM pane priority section.\n", "utf8");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      path.join(skillsRoot, "_drift.md"),
      "```bash\nntm spawn proj --cc=99 --cod=1\n```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      agentsMdPath: agentsPath,
      skillsRoot,
    } as never);
    expect(findings.length).toBe(0);
  });

  it("scans the SKILL.md Document itself, not just sub-files", async () => {
    const dir = freshDir("pane001-skill-md-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    const skillMdSrc =
      "# SKILL.md\n\n```bash\nntm spawn proj --label x --cc=3 --cod=1 --gmi=1\n```\n";
    const doc: Document = { source: skillMdSrc, filePath: "skills/start/SKILL.md" };
    const findings = await pane001.check(doc, {
      filePath: "skills/start/SKILL.md",
      source: skillMdSrc,
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    const f = findings.find((x) => x.file === "skills/start/SKILL.md");
    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("returns no findings when neither repoRoot nor canonical override is provided", async () => {
    const findings = await pane001.check(
      { source: "ntm spawn --cc=2 --cod=2 --gmi=2", filePath: "<unused>" },
      { filePath: "<unused>", source: "ntm spawn --cc=2 --cod=2 --gmi=2" },
    );
    expect(findings.length).toBe(0);
  });

  // ─── Whole-file fallback: strict-marker semantics ──────────────────────
  //
  // Regression for beads claude-orchestrator-bkuy and claude-orchestrator-25nj.
  // Loose "explicit override" prose in unrelated substitution-ladder
  // documentation must not suppress drift, either nearby or file-wide. Only the
  // canonical `<!-- pane001-override -->` and `PANE001-OVERRIDE:` markers opt in.

  it("does NOT suppress a far-away drift when only the loose 'explicit override' phrase appears file-wide", async () => {
    const dir = freshDir("pane001-loose-far-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    // The "explicit override" sidebar comment is >6 lines from the spawn AND
    // discusses an unrelated substitution-ladder case. The spawn itself has
    // genuine drift (--cc=4 --cod=2, ratio 2:1 — not canonical 1:1:1). Under
    // the old whole-file fallback this would be silently suppressed.
    const padding = Array.from({ length: 20 }, () => "filler line").join("\n");
    writeFileSync(
      path.join(skillsRoot, "_implement.md"),
      `# Impl file\n\n` +
        `Note: all three peers unavailable → cc-only floor (explicit override).\n\n` +
        `${padding}\n\n` +
        "```bash\n" +
        "ntm spawn proj --label impl-x --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
        "```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    const f = findings.find((x) => x.file.endsWith("_implement.md"));
    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("does NOT suppress drift for any previously loose override phrase", async () => {
    const loosePhrases = [
      "intentional override",
      "signature override",
      "override of the canonical",
      "override of the v3.17",
      "signature and an explicit override",
    ];

    for (const [index, phrase] of loosePhrases.entries()) {
      const f = await findingForDriftFixture(
        "# Impl file\n\n" +
          `This substitution-ladder note mentions ${phrase} in prose.\n\n` +
          "```bash\n" +
          "ntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
          "```\n",
        `pane001-retired-loose-${index}-`,
      );

      expect(f, phrase).toBeDefined();
      expect(f!.ruleId).toBe("PANE001");
      expect(f!.message).toMatch(/lane ratio/);
    }
  });

  it("does NOT suppress drift for a lowercase pane001-override token", async () => {
    const f = await findingForDriftFixture(
      "# Impl file\n\n" +
        "pane001-override: experimental run\n\n" +
        "```bash\n" +
        "ntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
        "```\n",
      "pane001-lower-token-",
    );

    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("does NOT suppress drift for a PANE001-OVERRIDE token without a colon", async () => {
    const f = await findingForDriftFixture(
      "# Impl file\n\n" +
        "PANE001-OVERRIDE experimental run\n\n" +
        "```bash\n" +
        "ntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
        "```\n",
      "pane001-token-no-colon-",
    );

    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("does NOT suppress drift when pane001-override appears later in an HTML comment", async () => {
    const f = await findingForDriftFixture(
      "# Impl file\n\n" +
        "<!-- TODO: see pane001-override docs -->\n\n" +
        "```bash\n" +
        "ntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
        "```\n",
      "pane001-html-text-before-marker-",
    );

    expect(f).toBeDefined();
    expect(f!.ruleId).toBe("PANE001");
    expect(f!.message).toMatch(/lane ratio/);
  });

  it("suppresses drift for an HTML pane001-override marker with a colon reason", async () => {
    const f = await findingForDriftFixture(
      "# Impl file\n\n" +
        "<!-- pane001-override: deslop reason -->\n\n" +
        "```bash\n" +
        "ntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
        "```\n",
      "pane001-html-colon-reason-",
    );

    expect(f).toBeUndefined();
  });

  it("suppresses drift when the strict PANE001-OVERRIDE token appears mid-sentence", async () => {
    const padding = Array.from({ length: 20 }, () => "filler line").join("\n");
    const f = await findingForDriftFixture(
      "# Impl file\n\n" +
        "Note: PANE001-OVERRIDE: experimental run\n\n" +
        padding +
        "\n\n```bash\n" +
        "ntm spawn proj --label impl --no-user --cc=4 --cod=2 --stagger-mode=smart\n" +
        "```\n",
      "pane001-token-mid-sentence-",
    );

    expect(f).toBeUndefined();
  });

  it("suppresses a far-away drift when the strict `<!-- pane001-override -->` marker is present", async () => {
    const dir = freshDir("pane001-strict-html-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    const padding = Array.from({ length: 20 }, () => "filler line").join("\n");
    writeFileSync(
      path.join(skillsRoot, "_deslop.md"),
      `# Deslop file\n\n<!-- pane001-override: codex-heavy by design -->\n\n` +
        `${padding}\n\n` +
        "```bash\n" +
        "ntm spawn proj --label deslop --no-user --cod=5 --stagger-mode=smart\n" +
        "```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    expect(findings.find((f) => f.file.endsWith("_deslop.md"))).toBeUndefined();
  });

  it("suppresses a far-away drift when the strict `PANE001-OVERRIDE:` token is present", async () => {
    const dir = freshDir("pane001-strict-token-");
    const skillsRoot = path.join(dir, "skills", "start");
    mkdirSync(skillsRoot, { recursive: true });
    const padding = Array.from({ length: 20 }, () => "filler line").join("\n");
    writeFileSync(
      path.join(skillsRoot, "_swarm.md"),
      `# Swarm file\n\nPANE001-OVERRIDE: experimental cod-heavy run\n\n` +
        `${padding}\n\n` +
        "```bash\n" +
        "ntm spawn proj --label swarm --no-user --cc=1 --cod=4 --stagger-mode=smart\n" +
        "```\n",
      "utf8",
    );
    const findings = await pane001.check(emptyDoc, {
      filePath: "<unused>",
      source: "",
      skillsRoot,
      canonical: CANONICAL_RULE,
    } as never);
    expect(findings.find((f) => f.file.endsWith("_swarm.md"))).toBeUndefined();
  });
});
