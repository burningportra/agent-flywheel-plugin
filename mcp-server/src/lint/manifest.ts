import { readFile, writeFile, readdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ManifestFileSchema = z.object({
  schemaVersion: z.literal(1),
  generated: z.string(),
  skills: z.array(z.string()),
});

export type ManifestFile = z.infer<typeof ManifestFileSchema>;

export async function loadManifest(filepath: string): Promise<ManifestFile | null> {
  let text: string;
  try {
    text = await readFile(filepath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(text);
  return ManifestFileSchema.parse(parsed);
}

export async function saveManifest(filepath: string, manifest: ManifestFile): Promise<void> {
  const tmp = `${filepath}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, filepath);
}

export async function discoverRepoSkills(repoRoot: string): Promise<string[]> {
  const skillsRoot = path.join(repoRoot, "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const name of entries) {
    const skillMd = path.join(skillsRoot, name, "SKILL.md");
    try {
      const st = await stat(skillMd);
      if (st.isFile()) out.push(name);
    } catch {
      // not a skill dir
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export async function generateManifest(repoRoot: string): Promise<ManifestFile> {
  return {
    schemaVersion: 1,
    generated: new Date().toISOString(),
    skills: await discoverRepoSkills(repoRoot),
  };
}
