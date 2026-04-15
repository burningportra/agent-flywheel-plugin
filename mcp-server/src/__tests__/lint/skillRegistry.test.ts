import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillRegistry } from "../../lint/skillRegistry.js";

async function makeTmp(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "skillreg-"));
}

async function writeSkill(root: string, dir: string, name: string): Promise<void> {
  const skillDir = path.join(root, dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# stub", "utf8");
}

describe("loadSkillRegistry", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmp();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("layer 1 (repo-local skills)", () => {
    it("resolves repo skills/*/SKILL.md as installed", async () => {
      await writeSkill(tmp, "skills", "foo");
      await writeSkill(tmp, "skills", "bar-baz");
      const reg = await loadSkillRegistry({ repoRoot: tmp, ci: true, pluginsRoot: null });
      expect(reg.has("foo")).toBe(true);
      expect(reg.has("bar-baz")).toBe(true);
      expect(reg.has("/foo")).toBe(true);
      expect(reg.size).toBe(2);
      expect(reg.source("foo")).toBe("repo");
    });

    it("ignores skills directories without SKILL.md", async () => {
      const skillDir = path.join(tmp, "skills", "no-skill-md");
      await mkdir(skillDir, { recursive: true });
      const reg = await loadSkillRegistry({ repoRoot: tmp, ci: true, pluginsRoot: null });
      expect(reg.size).toBe(0);
    });

    it("handles missing skills/ directory gracefully", async () => {
      const reg = await loadSkillRegistry({ repoRoot: tmp, ci: true, pluginsRoot: null });
      expect(reg.size).toBe(0);
    });
  });

  describe("layer 2 (manifest)", () => {
    it("loads skills from a valid manifest file", async () => {
      const manifestAbs = path.join(tmp, "manifest.json");
      await writeFile(
        manifestAbs,
        JSON.stringify({ schemaVersion: 1, skills: ["m1", "m2"] }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        manifestPath: manifestAbs,
      });
      expect(reg.has("m1")).toBe(true);
      expect(reg.has("m2")).toBe(true);
      expect(reg.source("m1")).toBe("manifest");
    });

    it("treats absent manifest as silent skip", async () => {
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        manifestPath: path.join(tmp, "missing.json"),
      });
      expect(reg.size).toBe(0);
    });

    it("treats malformed manifest as zero contribution and continues", async () => {
      const manifestAbs = path.join(tmp, "manifest.json");
      await writeFile(manifestAbs, "{not json", "utf8");
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        manifestPath: manifestAbs,
      });
      expect(reg.size).toBe(0);
    });

    it("ignores manifest with wrong schemaVersion", async () => {
      const manifestAbs = path.join(tmp, "manifest.json");
      await writeFile(
        manifestAbs,
        JSON.stringify({ schemaVersion: 2, skills: ["x"] }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        manifestPath: manifestAbs,
      });
      expect(reg.has("x")).toBe(false);
    });
  });

  describe("layer 3 (allowlist)", () => {
    it("normalizes leading slashes from knownExternalSlashes", async () => {
      const allowlistAbs = path.join(tmp, "allowlist.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({ schemaVersion: 1, knownExternalSlashes: ["fast", "/clear"] }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      expect(reg.has("fast")).toBe(true);
      expect(reg.has("clear")).toBe(true);
      expect(reg.has("/clear")).toBe(true);
      expect(reg.source("fast")).toBe("allowlist");
    });

    it("ignores allowlist with wrong schemaVersion", async () => {
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({ schemaVersion: 9, knownExternalSlashes: ["x"] }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      expect(reg.has("x")).toBe(false);
    });

    it("ignores allowlist with malformed JSON", async () => {
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(allowlistAbs, "{not-json", "utf8");
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      expect(reg.size).toBe(0);
    });

    it("handles allowlist without knownExternalSlashes field", async () => {
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(allowlistAbs, JSON.stringify({ schemaVersion: 1 }), "utf8");
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      expect(reg.size).toBe(0);
    });

    it("handles missing allowlist silently", async () => {
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: path.join(tmp, "nope.json"),
      });
      expect(reg.size).toBe(0);
    });
  });

  describe("layer 4 (plugins, dev mode)", () => {
    it("discovers SKILL.md beneath pluginsRoot", async () => {
      const pluginsRoot = await makeTmp();
      try {
        await writeSkill(pluginsRoot, "p1/skills", "p1s1");
        const reg = await loadSkillRegistry({
          repoRoot: tmp,
          ci: false,
          pluginsRoot,
        });
        expect(reg.has("p1s1")).toBe(true);
        expect(reg.source("p1s1")).toBe("plugins");
      } finally {
        await rm(pluginsRoot, { recursive: true, force: true });
      }
    });

    it("recurses into nested plugin directories to find skills/", async () => {
      const pluginsRoot = await makeTmp();
      try {
        await writeSkill(pluginsRoot, "vendor/category/plugin/skills", "deepskill");
        const reg = await loadSkillRegistry({
          repoRoot: tmp,
          ci: false,
          pluginsRoot,
        });
        expect(reg.has("deepskill")).toBe(true);
      } finally {
        await rm(pluginsRoot, { recursive: true, force: true });
      }
    });

    it("ignores skill directories under plugins/ that lack SKILL.md", async () => {
      const pluginsRoot = await makeTmp();
      try {
        const skillsDir = path.join(pluginsRoot, "p1/skills");
        await mkdir(path.join(skillsDir, "no-md"), { recursive: true });
        await writeSkill(pluginsRoot, "p1/skills", "with-md");
        const reg = await loadSkillRegistry({
          repoRoot: tmp,
          ci: false,
          pluginsRoot,
        });
        expect(reg.has("with-md")).toBe(true);
        expect(reg.has("no-md")).toBe(false);
      } finally {
        await rm(pluginsRoot, { recursive: true, force: true });
      }
    });

    it("skips dotted directories during plugins walk", async () => {
      const pluginsRoot = await makeTmp();
      try {
        await writeSkill(pluginsRoot, ".hidden/skills", "shouldskip");
        await writeSkill(pluginsRoot, "visible/skills", "shouldfind");
        const reg = await loadSkillRegistry({
          repoRoot: tmp,
          ci: false,
          pluginsRoot,
        });
        expect(reg.has("shouldfind")).toBe(true);
        expect(reg.has("shouldskip")).toBe(false);
      } finally {
        await rm(pluginsRoot, { recursive: true, force: true });
      }
    });

    it("CI mode skips plugins layer entirely", async () => {
      const pluginsRoot = await makeTmp();
      try {
        await writeSkill(pluginsRoot, "p1/skills", "p1s1");
        const reg = await loadSkillRegistry({
          repoRoot: tmp,
          ci: true,
          pluginsRoot,
        });
        expect(reg.has("p1s1")).toBe(false);
        expect(reg.size).toBe(0);
      } finally {
        await rm(pluginsRoot, { recursive: true, force: true });
      }
    });

    it("pluginsRoot=null disables layer 4 in dev mode", async () => {
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: false,
        pluginsRoot: null,
      });
      expect(reg.size).toBe(0);
    });

    // NON-NEGOTIABLE per Codex
    it("HOME=/nonexistent: pluginsRoot pointing nowhere does not throw", async () => {
      await writeSkill(tmp, "skills", "repoSkill");
      const manifestAbs = path.join(tmp, "manifest.json");
      await writeFile(
        manifestAbs,
        JSON.stringify({ schemaVersion: 1, skills: ["mfest"] }),
        "utf8",
      );
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({ schemaVersion: 1, knownExternalSlashes: ["allowed"] }),
        "utf8",
      );

      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: false,
        pluginsRoot: "/nonexistent-path-for-test-only",
        manifestPath: manifestAbs,
        allowlistPath: allowlistAbs,
      });
      expect(reg.has("reposkill")).toBe(true);
      expect(reg.has("mfest")).toBe(true);
      expect(reg.has("allowed")).toBe(true);
      expect(reg.size).toBe(3);
    });

    it("integration: ci=true with pluginsRoot=/nonexistent returns successfully", async () => {
      await writeSkill(tmp, "skills", "r");
      const manifestAbs = path.join(tmp, "manifest.json");
      await writeFile(
        manifestAbs,
        JSON.stringify({ schemaVersion: 1, skills: ["m"] }),
        "utf8",
      );
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({ schemaVersion: 1, knownExternalSlashes: ["a"] }),
        "utf8",
      );

      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: "/nonexistent",
        manifestPath: manifestAbs,
        allowlistPath: allowlistAbs,
      });
      expect(reg.size).toBe(3);
      expect(reg.has("r")).toBe(true);
      expect(reg.has("m")).toBe(true);
      expect(reg.has("a")).toBe(true);
    });
  });

  describe("Levenshtein suggest", () => {
    it("returns nearest match first", async () => {
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({
          schemaVersion: 1,
          knownExternalSlashes: ["idea-wizard", "ubs-workflow"],
        }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      const suggestions = reg.suggest("/idea-wizrd");
      expect(suggestions[0]).toBe("idea-wizard");
    });

    it("returns up to k results", async () => {
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({
          schemaVersion: 1,
          knownExternalSlashes: ["foo", "fop", "bar", "baz"],
        }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      const out = reg.suggest("foo", 2);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe("foo");
    });

    it("filters distance > 5 as irrelevant", async () => {
      const allowlistAbs = path.join(tmp, "allow.json");
      await writeFile(
        allowlistAbs,
        JSON.stringify({ schemaVersion: 1, knownExternalSlashes: ["abc"] }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        allowlistPath: allowlistAbs,
      });
      expect(reg.suggest("zzzzzzzzzzzzz")).toEqual([]);
    });

    it("returns [] for empty registry", async () => {
      const reg = await loadSkillRegistry({ repoRoot: tmp, ci: true, pluginsRoot: null });
      expect(reg.suggest("anything")).toEqual([]);
    });
  });

  describe("priority and merging", () => {
    it("first layer to register a name wins for source()", async () => {
      await writeSkill(tmp, "skills", "shared");
      const manifestAbs = path.join(tmp, "manifest.json");
      await writeFile(
        manifestAbs,
        JSON.stringify({ schemaVersion: 1, skills: ["shared"] }),
        "utf8",
      );
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        manifestPath: manifestAbs,
      });
      expect(reg.has("shared")).toBe(true);
      expect(reg.source("shared")).toBe("repo");
      expect(reg.size).toBe(1);
    });
  });

  describe("timeout and abort", () => {
    it("returns gracefully when AbortSignal fires before load", async () => {
      const ac = new AbortController();
      ac.abort();
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        signal: ac.signal,
      });
      expect(reg.size).toBe(0);
    });

    it("with a tiny timeout the resolver returns without throwing", async () => {
      // Layer 1 may attempt fs ops; tiny timeout forces partial recovery.
      await writeSkill(tmp, "skills", "x");
      const reg = await loadSkillRegistry({
        repoRoot: tmp,
        ci: true,
        pluginsRoot: null,
        timeoutMs: 1,
      });
      // No throw is the contract; size may be 0 or 1 depending on fs speed.
      expect(reg.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("logger silence", () => {
    it("does not write to stdout for any layer", async () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const manifestAbs = path.join(tmp, "manifest.json");
        await writeFile(manifestAbs, "garbage", "utf8");
        await loadSkillRegistry({
          repoRoot: tmp,
          ci: false,
          pluginsRoot: "/nonexistent",
          manifestPath: manifestAbs,
        });
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });
});
