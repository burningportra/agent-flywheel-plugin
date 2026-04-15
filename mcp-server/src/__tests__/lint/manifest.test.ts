import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadManifest,
  saveManifest,
  discoverRepoSkills,
  generateManifest,
  type ManifestFile,
} from "../../lint/manifest.js";

describe("loadManifest / saveManifest", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "manifest-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns null when the file is missing", async () => {
    expect(await loadManifest(path.join(tmp, "nope.json"))).toBeNull();
  });

  it("parses a valid manifest", async () => {
    const file = path.join(tmp, "m.json");
    const m: ManifestFile = {
      schemaVersion: 1,
      generated: "2026-04-15T00:00:00Z",
      skills: ["alpha", "beta"],
    };
    await writeFile(file, JSON.stringify(m), "utf8");
    expect(await loadManifest(file)).toEqual(m);
  });

  it("throws on malformed JSON", async () => {
    const file = path.join(tmp, "bad.json");
    await writeFile(file, "{{not json", "utf8");
    await expect(loadManifest(file)).rejects.toThrow();
  });

  it("round-trips via save + load", async () => {
    const file = path.join(tmp, "rt.json");
    const m: ManifestFile = {
      schemaVersion: 1,
      generated: "2026-04-15T00:00:00Z",
      skills: ["one", "two", "three"],
    };
    await saveManifest(file, m);
    expect(await loadManifest(file)).toEqual(m);
  });
});

describe("discoverRepoSkills", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "discover-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns sorted skill names that have a SKILL.md file", async () => {
    await mkdir(path.join(tmp, "skills", "foo"), { recursive: true });
    await writeFile(path.join(tmp, "skills", "foo", "SKILL.md"), "# foo", "utf8");
    await mkdir(path.join(tmp, "skills", "bar-baz"), { recursive: true });
    await writeFile(path.join(tmp, "skills", "bar-baz", "SKILL.md"), "# bar", "utf8");
    await mkdir(path.join(tmp, "skills", "no-skill-md-here"), { recursive: true });

    const skills = await discoverRepoSkills(tmp);
    expect(skills).toEqual(["bar-baz", "foo"]);
  });

  it("returns [] when skills/ is missing", async () => {
    const skills = await discoverRepoSkills(tmp);
    expect(skills).toEqual([]);
  });
});

describe("generateManifest", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "genmanifest-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("produces a valid ManifestFile from the filesystem", async () => {
    await mkdir(path.join(tmp, "skills", "alpha"), { recursive: true });
    await writeFile(path.join(tmp, "skills", "alpha", "SKILL.md"), "# a", "utf8");

    const m = await generateManifest(tmp);
    expect(m.schemaVersion).toBe(1);
    expect(m.skills).toEqual(["alpha"]);
    expect(typeof m.generated).toBe("string");
    expect(() => new Date(m.generated).toISOString()).not.toThrow();
  });
});
