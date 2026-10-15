#!/usr/bin/env tsx
/**
 * TONE001 baseline updater — `npm run lint:skill:update-tone-baseline`.
 *
 * Walks every file the dir runner covers (default `../skills/start/*.md`),
 * reuses the parser + prose-extraction + token-count helpers from
 * `src/lint/rules/tone001.ts`, and writes the resulting per-file counts to
 * `.lintskill-tone-baseline.json`.
 *
 * The script is a ratchet: it refuses to RAISE any file's count above the
 * committed baseline unless `--allow-raise --reason "<non-empty>"` is given.
 * Regeneration only lowers the ceiling, as docs/skill-style.md promises.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Dual-runtime module loading, mirrors scripts/lint-skill.ts. In dev (tsx)
// we import the TS sources under ../src/lint/*; in CI (node dist/) we
// import the compiled JS under ../lint/*. The string literal is opaque to
// tsc, so tsconfig.scripts.json's rootDir constraint is preserved.
const isCompiled = import.meta.url.includes("/dist/scripts/");
const lintBase = isCompiled ? "../lint" : "../src/lint";
const parserMod = (await import(`${lintBase}/parser.js`)) as {
  parse: (source: string, filePath: string) => Promise<unknown>;
};
const tone001Mod = (await import(`${lintBase}/rules/tone001.js`)) as {
  countToneTokens: (prose: string) => number;
  proseFrom: (doc: unknown) => string;
};
const { parse } = parserMod;
const { countToneTokens, proseFrom } = tone001Mod;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_BASELINE = resolve(HERE, "..", ".lintskill-tone-baseline.json");
const DEFAULT_DIR = resolve(DEFAULT_REPO_ROOT, "skills", "start");

export type Options = {
  repoRoot: string;
  dirs: string[];
  baselinePath: string;
  allowRaise: boolean;
  reason?: string;
  dryRun: boolean;
};

export type ParseResult =
  | { kind: "run"; options: Options }
  | { kind: "help"; text: string }
  | { kind: "error"; exitCode: number; message: string };

export const HELP_TEXT = `Usage: tsx scripts/update-tone-baseline.ts [options]

Regenerates mcp-server/.lintskill-tone-baseline.json from the current
TONE001 counts across the covered skill files. The ratchet is one-way:
regeneration can lower a file's ceiling but must not raise it unless
--allow-raise is passed with a non-empty --reason.

Options:
  --baseline <path>  Baseline file to update (default:
                     mcp-server/.lintskill-tone-baseline.json).
  --dir <path>       A directory of *.md files to scan. May be repeated.
                     Default: skills/start.
  --repo-root <dir>  Repo root for computing POSIX-relative keys
                     (default: autodetected from this script's location).
  --allow-raise     Allow raising a file's count. Requires --reason.
  --reason <text>   Human reason for the raise, logged to stdout.
  --dry-run         Report the diff and exit; don't write.
  --help, -h        Print this help and exit 0.
`;

const KNOWN = new Set([
  "--baseline",
  "--dir",
  "--repo-root",
  "--allow-raise",
  "--reason",
  "--dry-run",
  "--help",
  "-h",
]);

export function parseArgv(argv: readonly string[]): ParseResult {
  const dirs: string[] = [];
  let baselinePath = DEFAULT_BASELINE;
  let repoRoot = DEFAULT_REPO_ROOT;
  let allowRaise = false;
  let reason: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!KNOWN.has(a)) {
      return {
        kind: "error",
        exitCode: 2,
        message: `Unknown flag: ${a}\n\n${HELP_TEXT}`,
      };
    }
    if (a === "--help" || a === "-h") return { kind: "help", text: HELP_TEXT };
    if (a === "--dir") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        return { kind: "error", exitCode: 2, message: `--dir requires a path.\n\n${HELP_TEXT}` };
      }
      dirs.push(v);
      i += 1;
    } else if (a === "--baseline") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        return { kind: "error", exitCode: 2, message: `--baseline requires a path.\n\n${HELP_TEXT}` };
      }
      baselinePath = v;
      i += 1;
    } else if (a === "--repo-root") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        return { kind: "error", exitCode: 2, message: `--repo-root requires a path.\n\n${HELP_TEXT}` };
      }
      repoRoot = v;
      i += 1;
    } else if (a === "--reason") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        return { kind: "error", exitCode: 2, message: `--reason requires text.\n\n${HELP_TEXT}` };
      }
      reason = v;
      i += 1;
    } else if (a === "--allow-raise") allowRaise = true;
    else if (a === "--dry-run") dryRun = true;
  }

  if (allowRaise && (!reason || reason.trim().length === 0)) {
    return {
      kind: "error",
      exitCode: 2,
      message: `--allow-raise requires --reason "<non-empty>".\n\n${HELP_TEXT}`,
    };
  }

  return {
    kind: "run",
    options: {
      repoRoot,
      dirs: dirs.length > 0 ? dirs : [DEFAULT_DIR],
      baselinePath,
      allowRaise,
      reason,
      dryRun,
    },
  };
}

async function discoverMarkdownFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith(".md"))
    .map((n) => join(dir, n))
    .sort();
}

export async function countFileTokens(filePath: string): Promise<number> {
  const source = await readFile(filePath, "utf8");
  const doc = await parse(source, filePath);
  const prose = proseFrom(doc);
  return countToneTokens(prose);
}

async function loadBaseline(path: string): Promise<Record<string, number>> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as { counts?: Record<string, number> };
  return parsed.counts ?? {};
}

export type Diff = {
  key: string;
  from: number;
  to: number;
};

export function diffCounts(
  before: Record<string, number>,
  after: Record<string, number>,
): { lowered: Diff[]; raised: Diff[]; unchanged: Diff[]; removed: Diff[] } {
  const lowered: Diff[] = [];
  const raised: Diff[] = [];
  const unchanged: Diff[] = [];
  const removed: Diff[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const from = before[key];
    const to = after[key];
    if (to === undefined && from !== undefined) {
      removed.push({ key, from, to: 0 });
    } else if (from === undefined && to !== undefined) {
      // New files start at ceiling=0, so a non-zero count is a raise.
      if (to > 0) raised.push({ key, from: 0, to });
      else unchanged.push({ key, from: 0, to: 0 });
    } else if (from !== undefined && to !== undefined) {
      if (to > from) raised.push({ key, from, to });
      else if (to < from) lowered.push({ key, from, to });
      else unchanged.push({ key, from, to });
    }
  }
  return { lowered, raised, unchanged, removed };
}

export async function run(options: Options): Promise<number> {
  const files: string[] = [];
  for (const dir of options.dirs) files.push(...(await discoverMarkdownFiles(dir)));

  const after: Record<string, number> = {};
  for (const file of files) {
    const rel = relative(options.repoRoot, file).split("/").join("/");
    after[rel] = await countFileTokens(file);
  }

  const before = await loadBaseline(options.baselinePath);
  const { lowered, raised, unchanged: _unchanged, removed } = diffCounts(before, after);

  for (const d of lowered) console.log(`${d.key}: ${d.from} -> ${d.to}`);
  for (const d of removed) console.log(`${d.key}: ${d.from} -> (removed)`);
  for (const d of raised) console.log(`${d.key}: ${d.from} -> ${d.to} (RAISE)`);

  if (raised.length > 0 && !options.allowRaise) {
    console.error(
      `\nRefusing to raise ${raised.length} file(s) above their baseline. ` +
        `Pass --allow-raise --reason "<why>" to override.`,
    );
    return 3;
  }
  if (options.allowRaise && options.reason) {
    console.log(`\n--allow-raise reason: ${options.reason}`);
  }

  if (options.dryRun) {
    console.log(`\n(dry run; ${options.baselinePath} not written)`);
    return 0;
  }

  const payload = {
    schemaVersion: 1 as const,
    generated: new Date().toISOString(),
    counts: after,
  };
  await writeFile(options.baselinePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\n${options.baselinePath} written (${Object.keys(after).length} files).`);
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(parsed.text);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    return parsed.exitCode;
  }
  return run(parsed.options);
}

// Only invoke main when executed directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(99);
    },
  );
}
