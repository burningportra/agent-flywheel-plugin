/**
 * skills-bundle: runtime loader for the skills bundle produced by T12's
 * `build-skills-bundle` script. Implements 4-layer drift defense for the
 * `flywheel_get_skill` MCP tool (T13):
 *
 *   1. Build-time CI gate (check:skills-bundle, T12).
 *   2. Runtime manifestSha256 integrity check — on mismatch, log a warn
 *      with code `bundle_integrity_failed` and fall back to disk reads.
 *   3. Per-entry srcSha256 stale-warn — bundle is still served, but the
 *      result carries `staleWarn: true`.
 *   4. `FW_SKILL_BUNDLE=off` env-bypass — short-circuits to disk reads
 *      so contributors editing skills/*.md see live changes.
 *
 * The bundle is cached in module scope after the first successful load.
 * On integrity failure, the cache is invalidated so callers retry from
 * disk on every call until the bundle is rebuilt.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FlywheelError } from "./errors.js";
import { createLogger } from "./logger.js";

const log = createLogger("skills-bundle");

const PLUGIN_NAME = "agent-flywheel";
const DEFAULT_BUNDLE_REL = "mcp-server/dist/skills.bundle.json";

interface Frontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

export interface SkillBundleEntry {
  name: string;
  path: string;
  frontmatter: Frontmatter;
  body: string;
  srcSha256: string;
  sizeBytes: number;
  bundledAt: string;
}

export interface SkillsBundle {
  bundleVersion: 1;
  generatedAt: string;
  generator: string;
  manifestSha256: string;
  entries: SkillBundleEntry[];
}

export interface GetSkillResult {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  source: "bundle" | "disk";
  staleWarn?: boolean;
}

interface CachedBundle {
  bundle: SkillsBundle;
  bundlePath: string;
}

let _cache: CachedBundle | null = null;
let _cacheKey: string | null = null;

function isBundleDisabled(): boolean {
  return (process.env.FW_SKILL_BUNDLE ?? "").toLowerCase() === "off";
}

// --- canonical JSON (must match T12's build-skills-bundle algorithm) ------

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
  return "{" + parts.join(",") + "}";
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// --- bundle path resolution ----------------------------------------------

/**
 * Locate the plugin install directory (the folder containing `mcp-server/`
 * and `skills/`). Honors `CLAUDE_PLUGIN_ROOT` env var (set by Claude Code at
 * launch time) so the bundle/disk lookups resolve against the plugin's own
 * install — NOT the calling project's cwd. Falls back to walking up from
 * `import.meta.url`, then to `process.cwd()`.
 */
function findPluginInstallRoot(): string {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot && envRoot.length > 0) return path.resolve(envRoot);
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (path.basename(dir) === "mcp-server") return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveBundlePath(opts?: { repoRoot?: string; bundlePath?: string }): string {
  if (opts?.bundlePath) return path.resolve(opts.bundlePath);
  const root = opts?.repoRoot ?? findPluginInstallRoot();
  return path.join(root, DEFAULT_BUNDLE_REL);
}

function resolveRepoRoot(opts?: { repoRoot?: string }): string {
  return opts?.repoRoot ?? findPluginInstallRoot();
}

// --- frontmatter parser (matches T12 — defensive YAML subset) ------------

interface FrontmatterParse {
  frontmatter: Frontmatter;
  body: string;
  hasFrontmatter: boolean;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
    }
  }
  return trimmed;
}

function parseFrontmatter(text: string): FrontmatterParse {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { frontmatter: {}, body: normalized, hasFrontmatter: false };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { frontmatter: {}, body: normalized, hasFrontmatter: false };
  }
  const frontmatter: Frontmatter = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1);
    if (key.length === 0) continue;
    frontmatter[key] = stripQuotes(rawValue);
  }
  const body = lines.slice(closeIdx + 1).join("\n");
  return { frontmatter, body, hasFrontmatter: true };
}

// --- integrity check ------------------------------------------------------

function verifyManifestSha(bundle: SkillsBundle): boolean {
  const recomputed = sha256Hex(canonicalJSON(bundle.entries));
  return recomputed === bundle.manifestSha256;
}

// --- public API: loadSkillsBundle ----------------------------------------

/**
 * Load + verify the skills bundle. Returns null on integrity failure or any
 * IO error so the caller can transparently fall back to disk reads.
 *
 * Cached across calls keyed by bundle path. Cache is invalidated on
 * integrity failure.
 */
export function loadSkillsBundle(bundlePath?: string): SkillsBundle | null {
  const resolvedPath = bundlePath ? path.resolve(bundlePath) : resolveBundlePath();

  if (_cache !== null && _cacheKey === resolvedPath) {
    return _cache.bundle;
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    log.warn("Bundle not readable; falling back to disk", {
      bundlePath: resolvedPath,
      err: String(err),
    });
    return null;
  }

  let parsed: SkillsBundle;
  try {
    parsed = JSON.parse(raw) as SkillsBundle;
  } catch (err) {
    log.warn("Bundle JSON parse failed; falling back to disk", {
      bundlePath: resolvedPath,
      err: String(err),
    });
    return null;
  }

  if (!parsed || parsed.bundleVersion !== 1 || !Array.isArray(parsed.entries)) {
    log.warn("Bundle shape invalid; falling back to disk", {
      bundlePath: resolvedPath,
    });
    return null;
  }

  if (!verifyManifestSha(parsed)) {
    log.warn("Bundle integrity check failed", {
      code: "bundle_integrity_failed",
      bundlePath: resolvedPath,
      expected: parsed.manifestSha256,
    });
    _cache = null;
    _cacheKey = null;
    return null;
  }

  _cache = { bundle: parsed, bundlePath: resolvedPath };
  _cacheKey = resolvedPath;
  return parsed;
}

/** Reset the module-scope cache. Test-only. */
export function _resetSkillsBundleCache(): void {
  _cache = null;
  _cacheKey = null;
}

// --- disk fallback --------------------------------------------------------

interface DiskSkillFile {
  absPath: string;
  relPath: string;
  skillName: string;
}

async function walkDiskSkills(repoRoot: string): Promise<DiskSkillFile[]> {
  const skillsDir = path.join(repoRoot, "skills");
  const out: DiskSkillFile[] = [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const dir = path.join(skillsDir, entry);
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillMd = path.join(dir, "SKILL.md");
    try {
      const skillStat = await stat(skillMd);
      if (skillStat.isFile()) {
        out.push({
          absPath: skillMd,
          relPath: path.relative(repoRoot, skillMd),
          skillName: `${PLUGIN_NAME}:${entry}`,
        });
      }
    } catch {
      // missing SKILL.md — skip
    }
  }
  const startDir = path.join(skillsDir, "start");
  try {
    const startEntries = await readdir(startDir);
    for (const entry of startEntries) {
      if (!entry.startsWith("_") || !entry.endsWith(".md")) continue;
      const abs = path.join(startDir, entry);
      const subStat = await stat(abs);
      if (!subStat.isFile()) continue;
      const subSkillName = `start_${entry.slice(1, -3)}`;
      out.push({
        absPath: abs,
        relPath: path.relative(repoRoot, abs),
        skillName: `${PLUGIN_NAME}:${subSkillName}`,
      });
    }
  } catch {
    // no start dir — fine
  }
  return out;
}

async function readSkillFromDisk(
  name: string,
  repoRoot: string,
): Promise<GetSkillResult | null> {
  const sources = await walkDiskSkills(repoRoot);
  const match = sources.find((s) => s.skillName === name);
  if (!match) return null;
  const text = await readFile(match.absPath, "utf8");
  const parsed = parseFrontmatter(text);
  return {
    name,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    source: "disk",
  };
}

// --- public API: getSkill -------------------------------------------------

/**
 * Resolve a skill by name. Honors:
 *   - FW_SKILL_BUNDLE=off → always disk
 *   - bundle integrity → falls back to disk on mismatch
 *   - per-entry srcSha256 → adds staleWarn flag (still serves bundle)
 *
 * Throws FlywheelError(code: "not_found") when the name doesn't resolve in
 * either the bundle or on disk.
 */
export async function getSkill(
  name: string,
  opts?: { repoRoot?: string; bundlePath?: string },
): Promise<GetSkillResult> {
  const repoRoot = resolveRepoRoot(opts);

  if (isBundleDisabled()) {
    const fromDisk = await readSkillFromDisk(name, repoRoot);
    if (!fromDisk) {
      throw new FlywheelError({
        code: "not_found",
        message: `Skill '${name}' not found on disk (FW_SKILL_BUNDLE=off).`,
      });
    }
    return fromDisk;
  }

  const bundlePath = resolveBundlePath(opts);
  const bundle = loadSkillsBundle(bundlePath);

  if (bundle) {
    const entry = bundle.entries.find((e) => e.name === name);
    if (entry) {
      let staleWarn = false;
      try {
        const absSrc = path.join(repoRoot, entry.path);
        const buf = await readFile(absSrc);
        const fresh = sha256Hex(buf);
        if (fresh !== entry.srcSha256) {
          staleWarn = true;
          log.warn("Bundled skill source has drifted", {
            code: "bundle_stale",
            name,
            path: entry.path,
          });
        }
      } catch {
        // source file missing on disk — bundle is authoritative, no stale warn
      }
      const result: GetSkillResult = {
        name: entry.name,
        frontmatter: { ...entry.frontmatter },
        body: entry.body,
        source: "bundle",
      };
      if (staleWarn) result.staleWarn = true;
      return result;
    }
    // not in bundle — fall through to disk
  }

  const fromDisk = await readSkillFromDisk(name, repoRoot);
  if (!fromDisk) {
    throw new FlywheelError({
      code: "not_found",
      message: `Skill '${name}' not found in bundle or on disk.`,
    });
  }
  return fromDisk;
}
