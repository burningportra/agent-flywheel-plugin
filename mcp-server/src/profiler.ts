import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn } from "./exec.js";
import type { RepoProfile, TodoItem, CommitSummary } from "./types.js";
import { createLogger } from './logger.js';
import { selectScanners } from './todo-scanner.js';

const log = createLogger('profiler');

const CACHE_DIR = ".pi-flywheel";
const CACHE_FILE = "profile-cache.json";

interface ProfileCache {
  gitHead: string;
  cachedAt: string;
  profile: RepoProfile;
}

/**
 * Load cached profile if the git HEAD matches.
 * Returns the cached RepoProfile or null if stale/missing.
 */
export async function loadCachedProfile(exec: ExecFn, cwd: string): Promise<RepoProfile | null> {
  const cachePath = join(cwd, CACHE_DIR, CACHE_FILE);
  if (!existsSync(cachePath)) return null;

  try {
    const raw = readFileSync(cachePath, "utf8");
    let cache: ProfileCache;
    try {
      cache = JSON.parse(raw);
    } catch {
      log.warn("Profile cache contains invalid JSON");
      return null;
    }

    if (!cache || typeof cache !== "object" || typeof cache.gitHead !== "string") {
      log.warn("Profile cache has unexpected shape");
      return null;
    }

    // Check if HEAD matches
    const headResult = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
    if (headResult.code !== 0) return null;

    const currentHead = headResult.stdout.trim();
    if (cache.gitHead !== currentHead) {
      log.info("Profile cache stale", { cached: cache.gitHead.slice(0, 8), current: currentHead.slice(0, 8) });
      return null;
    }

    log.info("Profile cache hit", { head: currentHead.slice(0, 8), cachedAt: cache.cachedAt });
    return cache.profile;
  } catch (err) {
    log.warn("Failed to read profile cache", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Save a RepoProfile to the cache file with the current git HEAD.
 */
/**
 * Save profile to cache. Accepts optional gitHead to avoid redundant git call.
 * Designed to be called fire-and-forget (don't await if you don't need to).
 */
export async function saveCachedProfile(exec: ExecFn, cwd: string, profile: RepoProfile, gitHead?: string): Promise<void> {
  try {
    let head = gitHead;
    if (!head) {
      const headResult = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
      if (headResult.code !== 0) return;
      head = headResult.stdout.trim();
    }

    const cacheDir = join(cwd, CACHE_DIR);
    mkdirSync(cacheDir, { recursive: true });

    const cache: ProfileCache = {
      gitHead: head,
      cachedAt: new Date().toISOString(),
      profile,
    };

    writeFileSync(join(cacheDir, CACHE_FILE), JSON.stringify(cache, null, 2), "utf8");
    log.info("Profile cached", { head: head.slice(0, 8) });
  } catch (err) {
    log.warn("Failed to write profile cache", { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Collect raw repo signals using exec for shell commands.
 * Returns a RepoProfile with everything except LLM-generated fields.
 */
export async function profileRepo(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<RepoProfile> {
  const results = await Promise.allSettled([
    collectFileTree(exec, cwd, signal),
    collectCommits(exec, cwd, signal),
    collectTodos(exec, cwd, signal),
    collectKeyFiles(exec, cwd, signal),
  ]);

  const fileTree = results[0].status === "fulfilled" ? results[0].value : "";
  const commits = results[1].status === "fulfilled" ? results[1].value : [];
  const todos = results[2].status === "fulfilled" ? results[2].value : [];
  const keyFiles = results[3].status === "fulfilled" ? results[3].value : {};

  for (const [i, label] of (["fileTree", "commits", "todos", "keyFiles"] as const).entries()) {
    if (results[i].status === "rejected") {
      log.warn(`${label} collector failed`, { reason: String((results[i] as PromiseRejectedResult).reason) });
    }
  }

  let bestPracticesGuides: Array<{ name: string; content: string }> = [];
  try {
    bestPracticesGuides = await collectBestPracticesGuides(exec, cwd, fileTree, signal);
  } catch {
    // Best practices collection is non-critical
  }

  // Detect languages from extensions
  const extCounts = new Map<string, number>();
  for (const line of fileTree.split("\n")) {
    const ext = line.match(/\.([a-zA-Z0-9]+)$/)?.[1];
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const languages = detectLanguages(extCounts);
  const frameworks = detectFrameworks(keyFiles);

  return {
    name: cwd.split("/").pop() ?? "unknown",
    languages,
    frameworks,
    structure: fileTree,
    entrypoints: detectEntrypoints(fileTree, keyFiles),
    recentCommits: commits,
    hasTests: fileTree.includes("test") || fileTree.includes("spec") || fileTree.includes("__tests__"),
    testFramework: detectTestFramework(keyFiles),
    hasDocs: fileTree.includes("docs/") || fileTree.includes("doc/") || !!keyFiles["README.md"],
    hasCI:
      fileTree.includes(".github/workflows") ||
      fileTree.includes(".gitlab-ci") ||
      fileTree.includes("Jenkinsfile"),
    ciPlatform: detectCI(fileTree),
    todos,
    keyFiles,
    readme: keyFiles["README.md"] ?? keyFiles["README"] ?? undefined,
    packageManager: detectPackageManager(keyFiles, fileTree),
    bestPracticesGuides,
  };
}

// ─── Collectors ────────────────────────────────────────────────

async function collectFileTree(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const result = await exec(
    "find",
    [
      ".",
      "-maxdepth", "4",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
      "-not", "-path", "*/dist/*",
      "-not", "-path", "*/__pycache__/*",
      "-not", "-path", "*/.venv/*",
      "-not", "-path", "*/vendor/*",
      "-not", "-path", "*/target/*",
    ],
    { timeout: 10000, cwd, signal }
  );
  return result.stdout.trim();
}

async function collectCommits(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<CommitSummary[]> {
  const result = await exec(
    "git",
    ["log", "--oneline", "--no-decorate", "-n", "20", "--format=%H%x00%s%x00%ai%x00%an"],
    { timeout: 5000, cwd, signal }
  );
  if (result.code !== 0) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date, author] = line.split("\0");
      return {
        hash: hash?.slice(0, 7) ?? "",
        message: message ?? "",
        date: date ?? "",
        author: author ?? "",
      };
    });
}

async function collectTodos(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<TodoItem[]> {
  const scanners = selectScanners();
  const results = await Promise.all(scanners.map((s) => s.scan(exec, cwd, signal)));
  return results.flat();
}

async function collectKeyFiles(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const paths = [
    "README.md", "README",
    "CLAUDE.md", "AGENTS.md",
    "package.json", "Cargo.toml", "pyproject.toml", "go.mod",
    "Gemfile", "Makefile", "Dockerfile", "docker-compose.yml",
    ".github/workflows/ci.yml", ".github/workflows/ci.yaml",
    ".gitlab-ci.yml",
    "tsconfig.json", "vite.config.ts", "webpack.config.js",
    "jest.config.ts", "jest.config.js", "vitest.config.ts",
    ".eslintrc.json", ".prettierrc",
  ];

  const files: Record<string, string> = {};
  const reads = paths.map(async (p) => {
    try {
      const r = await exec("head", ["-c", "4096", p], {
        timeout: 2000,
        cwd,
        signal,
      });
      if (r.code === 0 && r.stdout.trim()) {
        files[p] = r.stdout.trim();
      }
    } catch {
      // skip
    }
  });
  await Promise.all(reads);
  return files;
}

async function collectBestPracticesGuides(
  exec: ExecFn,
  cwd: string,
  fileTree: string,
  signal?: AbortSignal
): Promise<Array<{ name: string; content: string }>> {
  const candidatePaths = [
    "BEST_PRACTICES.md",
    "docs/best-practices.md",
    "docs/BEST_PRACTICES.md",
    "best_practices.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "docs/architecture.md",
  ];

  // Also scan directories for markdown files
  const dirCandidates: string[] = [];
  for (const line of fileTree.split("\n")) {
    const trimmed = line.trim();
    if (
      (trimmed.startsWith("./best_practices/") || trimmed.startsWith("./docs/guides/") || trimmed.startsWith("./.claude/")) &&
      trimmed.endsWith(".md")
    ) {
      dirCandidates.push(trimmed.replace(/^\.\//,""));
    }
  }

  const allPaths = [...candidatePaths, ...dirCandidates];
  const guides: Array<{ name: string; content: string }> = [];

  await Promise.all(
    allPaths.map(async (p) => {
      try {
        const r = await exec("head", ["-c", "3000", p], { timeout: 2000, cwd, signal });
        if (r.code === 0 && r.stdout.trim()) {
          guides.push({ name: p, content: r.stdout.trim() });
        }
      } catch {
        // skip
      }
    })
  );

  return guides;
}

/**
 * Format best-practices guides for injection into planning prompts.
 * Truncates to avoid overwhelming context windows.
 */
export function formatBestPracticesGuides(
  guides: Array<{ name: string; content: string }>
): string {
  if (guides.length === 0) return "";
  const parts = guides.map(g => `### ${g.name}\n${g.content.slice(0, 2000)}`);
  return `## Best Practices & Architecture Guides\n\n${parts.join("\n\n---\n\n")}`;
}

// ─── Detectors ─────────────────────────────────────────────────

function detectLanguages(extCounts: Map<string, number>): string[] {
  const extToLang: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", rs: "Rust", go: "Go", rb: "Ruby",
    java: "Java", kt: "Kotlin", swift: "Swift", cs: "C#",
    cpp: "C++", c: "C", hs: "Haskell", ex: "Elixir",
    php: "PHP", scala: "Scala", zig: "Zig",
  };
  const langs = new Map<string, number>();
  for (const [ext, count] of extCounts) {
    const lang = extToLang[ext];
    if (lang) langs.set(lang, (langs.get(lang) ?? 0) + count);
  }
  return [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);
}

function detectFrameworks(keyFiles: Record<string, string>): string[] {
  const frameworks: string[] = [];
  const pkg = keyFiles["package.json"];
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      const allDeps = {
        ...parsed.dependencies,
        ...parsed.devDependencies,
      };
      if (allDeps["next"]) frameworks.push("Next.js");
      if (allDeps["react"]) frameworks.push("React");
      if (allDeps["vue"]) frameworks.push("Vue");
      if (allDeps["svelte"] || allDeps["@sveltejs/kit"]) frameworks.push("Svelte");
      if (allDeps["express"]) frameworks.push("Express");
      if (allDeps["fastify"]) frameworks.push("Fastify");
      if (allDeps["hono"]) frameworks.push("Hono");
      if (allDeps["nestjs"] || allDeps["@nestjs/core"]) frameworks.push("NestJS");
      if (allDeps["tailwindcss"]) frameworks.push("Tailwind CSS");
      if (allDeps["prisma"] || allDeps["@prisma/client"]) frameworks.push("Prisma");
      if (allDeps["drizzle-orm"]) frameworks.push("Drizzle");
    } catch {}
  }
  if (keyFiles["Cargo.toml"]?.includes("actix")) frameworks.push("Actix");
  if (keyFiles["Cargo.toml"]?.includes("axum")) frameworks.push("Axum");
  if (keyFiles["Cargo.toml"]?.includes("tokio")) frameworks.push("Tokio");
  if (keyFiles["Gemfile"]?.includes("rails")) frameworks.push("Rails");
  if (keyFiles["go.mod"]?.includes("gin")) frameworks.push("Gin");
  if (keyFiles["pyproject.toml"]?.includes("django")) frameworks.push("Django");
  if (keyFiles["pyproject.toml"]?.includes("fastapi")) frameworks.push("FastAPI");
  if (keyFiles["pyproject.toml"]?.includes("flask")) frameworks.push("Flask");
  return frameworks;
}

function detectTestFramework(keyFiles: Record<string, string>): string | undefined {
  if (keyFiles["vitest.config.ts"]) return "Vitest";
  if (keyFiles["jest.config.ts"] || keyFiles["jest.config.js"]) return "Jest";
  const pkg = keyFiles["package.json"];
  if (pkg) {
    if (pkg.includes('"vitest"')) return "Vitest";
    if (pkg.includes('"jest"')) return "Jest";
    if (pkg.includes('"mocha"')) return "Mocha";
  }
  if (keyFiles["Cargo.toml"]) return "cargo test";
  if (keyFiles["pyproject.toml"]?.includes("pytest")) return "pytest";
  if (keyFiles["go.mod"]) return "go test";
  return undefined;
}

function detectCI(fileTree: string): string | undefined {
  if (fileTree.includes(".github/workflows")) return "GitHub Actions";
  if (fileTree.includes(".gitlab-ci")) return "GitLab CI";
  if (fileTree.includes("Jenkinsfile")) return "Jenkins";
  if (fileTree.includes(".circleci")) return "CircleCI";
  return undefined;
}

function detectEntrypoints(
  fileTree: string,
  keyFiles: Record<string, string>
): string[] {
  const entries: string[] = [];
  const pkg = keyFiles["package.json"];
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      if (parsed.main) entries.push(parsed.main);
      if (parsed.module) entries.push(parsed.module);
      if (parsed.bin) {
        if (typeof parsed.bin === "string") entries.push(parsed.bin);
        else Object.values(parsed.bin).forEach((v) => entries.push(v as string));
      }
    } catch {}
  }
  // Common entrypoints
  const common = [
    "src/index.ts", "src/main.ts", "src/app.ts",
    "src/index.js", "src/main.js", "src/app.js",
    "main.go", "cmd/main.go",
    "src/main.rs", "src/lib.rs",
    "app.py", "main.py", "manage.py",
  ];
  for (const c of common) {
    if (fileTree.includes(c) && !entries.includes(c)) entries.push(c);
  }
  return entries.slice(0, 5);
}

function detectPackageManager(
  keyFiles: Record<string, string>,
  fileTree: string
): string | undefined {
  if (fileTree.includes("pnpm-lock.yaml")) return "pnpm";
  if (fileTree.includes("yarn.lock")) return "yarn";
  if (fileTree.includes("bun.lockb")) return "bun";
  if (fileTree.includes("package-lock.json")) return "npm";
  if (keyFiles["Cargo.toml"]) return "cargo";
  if (keyFiles["go.mod"]) return "go";
  if (fileTree.includes("uv.lock") || keyFiles["pyproject.toml"]?.includes("[tool.uv]")) return "uv";
  if (fileTree.includes("Pipfile")) return "pipenv";
  if (keyFiles["pyproject.toml"]) return "pip";
  if (keyFiles["Gemfile"]) return "bundler";
  return undefined;
}

export function createEmptyRepoProfile(cwd: string): RepoProfile {
  return {
    name: cwd.split("/").pop() ?? "unknown",
    languages: [],
    frameworks: [],
    structure: "",
    entrypoints: [],
    recentCommits: [],
    hasTests: false,
    testFramework: undefined,
    hasDocs: false,
    hasCI: false,
    ciPlatform: undefined,
    todos: [],
    keyFiles: {},
    readme: undefined,
    packageManager: undefined,
    bestPracticesGuides: [],
  };
}
