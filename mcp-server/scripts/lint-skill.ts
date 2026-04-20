#!/usr/bin/env node
// lint-skill: standalone CLI for the SKILL.md linter.
//
// Heuristics (per v1.0 plan):
//   - AUQ001..AUQ004 — AskUserQuestion shape rules (header/options/etc.)
//   - SLASH001       — slash references must resolve to an installed skill
//   - PLACE001       — placeholder tags must have a referent in the same step
//   - IMPL001        — flag implicit-decision phrases not protected by AUQ/UR1/code
//
// Suppression: `<!-- lintskill-disable RULEID -->` at end-of-line suppresses one rule.
// Baseline: pre-existing findings can be suppressed via a checked-in JSON baseline file
// (see --baseline / --update-baseline). Baselined findings are demoted to "info" with a
// `[baselined]` prefix so they remain visible but no longer fail CI.
//
// Dual runtime:
//   - Local dev: `tsx scripts/lint-skill.ts ...` resolves lint imports against TS sources.
//   - CI:        `node dist/scripts/lint-skill.js ...` resolves against compiled JS.
// The script detects which mode it is in via `import.meta.url` and dynamically imports the
// correct lint module path; this avoids a build-time path rewrite.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --- dual-runtime lint module loading -------------------------------------------------
// Compiled location: <repo>/mcp-server/dist/scripts/lint-skill.js -> ../lint/...
// Source location:   <repo>/mcp-server/scripts/lint-skill.ts      -> ../src/lint/...
const isCompiled = import.meta.url.includes("/dist/scripts/");
const lintBase = isCompiled ? "../lint" : "../src/lint";

interface LintModule {
  lint: (opts: unknown) => Promise<{ findings: unknown[]; internalErrors: unknown[] }>;
  computeExitCode: (result: unknown) => number;
  EXIT_CLEAN: number;
  EXIT_FINDINGS: number;
  EXIT_INTERNAL: number;
  EXIT_INVALID_ARGS: number;
  EXIT_FILE_ERROR: number;
}

interface SkillRegistryModule {
  loadSkillRegistry: (opts: unknown) => Promise<unknown>;
}

interface BaselineModule {
  loadBaseline: (p: string) => Promise<unknown>;
  saveBaseline: (p: string, b: unknown) => Promise<void>;
  applyBaseline: (
    findings: unknown[],
    baseline: unknown,
    source: string,
  ) => { live: unknown[]; baselined: unknown[] };
  generateBaseline: (findings: unknown[], source: string) => unknown;
  normalizeSourceForFingerprint: (s: string) => string;
}

interface ManifestModule {
  saveManifest: (p: string, m: unknown) => Promise<void>;
  generateManifest: (repoRoot: string) => Promise<{ skills: string[] }>;
}

type ReporterName = "pretty" | "compact" | "gha" | "json";

interface ReportersModule {
  format: (name: ReporterName, result: unknown, opts?: unknown) => string;
  selectReporter: () => ReporterName;
  sortFindings: (findings: unknown[]) => unknown[];
}

interface RulesModule {
  rules: unknown[];
}

async function loadLintModules(): Promise<{
  lintMod: LintModule;
  registryMod: SkillRegistryModule;
  baselineMod: BaselineModule;
  manifestMod: ManifestModule;
  reportersMod: ReportersModule;
  rules: RulesModule;
}> {
  const lintMod = (await import(`${lintBase}/index.js`)) as unknown as LintModule;
  const registryMod = (await import(`${lintBase}/skillRegistry.js`)) as unknown as SkillRegistryModule;
  const baselineMod = (await import(`${lintBase}/baseline.js`)) as unknown as BaselineModule;
  const manifestMod = (await import(`${lintBase}/manifest.js`)) as unknown as ManifestModule;
  const reportersMod = (await import(`${lintBase}/reporters/index.js`)) as unknown as ReportersModule;
  const auq = (await import(`${lintBase}/rules/askUserQuestion.js`)) as unknown as { auqRules: unknown[] };
  const slashMod = (await import(`${lintBase}/rules/slashReferences.js`)) as unknown as { slash001: unknown };
  const placeMod = (await import(`${lintBase}/rules/placeholders.js`)) as unknown as { place001: unknown };
  const implMod = (await import(`${lintBase}/rules/implicitDecisions.js`)) as unknown as { impl001: unknown };
  const errMod = (await import(`${lintBase}/rules/errorCodeReferences.js`)) as unknown as { err001: unknown };
  const rules: RulesModule = {
    rules: [...auq.auqRules, slashMod.slash001, placeMod.place001, implMod.impl001, errMod.err001],
  };
  return { lintMod, registryMod, baselineMod, manifestMod, reportersMod, rules };
}

// --- CLI options + parsing ------------------------------------------------------------

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MANIFEST_REL = "mcp-server/.lintskill-manifest.json";

interface CliOpts {
  file: string | null;
  ci: boolean;
  baseline: string | null;
  format: ReporterName | null;
  maxBytes: number;
  updateBaseline: boolean;
  updateManifest: boolean;
  rule: string[];
  noColor: boolean;
  help: boolean;
  version: boolean;
}

function defaultOpts(): CliOpts {
  return {
    file: null,
    ci: false,
    baseline: null,
    format: null,
    maxBytes: DEFAULT_MAX_BYTES,
    updateBaseline: false,
    updateManifest: false,
    rule: [],
    noColor: false,
    help: false,
    version: false,
  };
}

function parseArgs(argv: string[]): { opts: CliOpts; error: string | null } {
  const opts = defaultOpts();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeNext = (): string | null => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i++;
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--version":
        opts.version = true;
        break;
      case "--ci":
        opts.ci = true;
        break;
      case "--no-color":
        opts.noColor = true;
        break;
      case "--update-baseline":
        opts.updateBaseline = true;
        break;
      case "--update-manifest":
        opts.updateManifest = true;
        break;
      case "--file": {
        const v = takeNext();
        if (v === null) return { opts, error: "--file requires a path argument" };
        opts.file = v;
        break;
      }
      case "--baseline": {
        const v = takeNext();
        if (v === null) return { opts, error: "--baseline requires a path argument" };
        opts.baseline = v;
        break;
      }
      case "--format": {
        const v = takeNext();
        if (v === null) return { opts, error: "--format requires a value (pretty|compact|gha|json)" };
        if (v !== "pretty" && v !== "compact" && v !== "gha" && v !== "json") {
          return { opts, error: `invalid --format '${v}' (expected pretty|compact|gha|json)` };
        }
        opts.format = v;
        break;
      }
      case "--max-bytes": {
        const v = takeNext();
        if (v === null) return { opts, error: "--max-bytes requires an integer argument" };
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          return { opts, error: `invalid --max-bytes '${v}' (expected positive integer)` };
        }
        opts.maxBytes = n;
        break;
      }
      case "--rule": {
        const v = takeNext();
        if (v === null) return { opts, error: "--rule requires a rule id" };
        opts.rule.push(v);
        break;
      }
      default:
        return { opts, error: `unknown argument '${a}' (use --help)` };
    }
  }
  return { opts, error: null };
}

function helpText(version: string): string {
  return [
    `lint-skill ${version}`,
    "",
    "Usage:",
    "  lint-skill --file <path> [--baseline <path>] [--format <pretty|compact|gha|json>]",
    "             [--ci] [--max-bytes <n>] [--rule <id>]... [--no-color]",
    "  lint-skill --update-baseline --baseline <path> --file <path>",
    "  lint-skill --update-manifest",
    "  lint-skill --help | --version",
    "",
    "Flags:",
    "  --file <path>           SKILL.md file to lint (required for normal lint).",
    "  --ci                    Skip ~/.claude/plugins skill discovery; manifest + repo only.",
    "  --baseline <path>       Apply (or write) a baseline JSON file.",
    "  --format <name>         Force reporter: pretty, compact, gha, or json.",
    "                          Default: gha when GITHUB_ACTIONS=true, pretty when TTY, else compact.",
    "  --max-bytes <n>         Reject files larger than n bytes (default 10485760).",
    "  --update-baseline       Lint then write findings to --baseline (overwrite). Exits 0.",
    "  --update-manifest       Discover skills/ and write manifest. Exits 0.",
    "  --rule <id>             Only run this rule (repeatable).",
    "  --no-color              Disable ANSI colors even in TTY.",
    "  -h, --help              Show this help.",
    "  --version               Print version.",
    "",
    "Rules:",
    "  AUQ001  AskUserQuestion option count (2..4 per question).",
    "  AUQ002  AskUserQuestion option labels + descriptions required.",
    "  AUQ003  AskUserQuestion question header presence + length (<=12 graphemes, no emoji).",
    "  AUQ004  AskUserQuestion vs implicit-decision phrasing.",
    "  SLASH001 Slash references must resolve to an installed skill.",
    "  PLACE001 Placeholder tags must have a referent in the same step.",
    "  IMPL001  Implicit-decision phrases that should be AskUserQuestion calls.",
    "  ERR001   String-matching on error text; branch on data.error.code instead.",
    "",
    "Exit codes:",
    "  0  Clean (no error-severity findings).",
    "  1  Error-severity findings present.",
    "  2  Internal error (rule threw or timed out).",
    "  3  Invalid CLI arguments.",
    "  4  File error (missing/unreadable/oversized).",
    "",
    "Suppression:",
    "  Append `<!-- lintskill-disable RULEID -->` to a line to suppress one rule on that line.",
    "",
  ].join("\n");
}

async function readVersion(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "package.json"),
    path.join(here, "..", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const text = await readFile(c, "utf8");
      const pkg = JSON.parse(text) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}

function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (path.basename(dir) === "mcp-server") return parent;
    dir = parent;
  }
  return process.cwd();
}

function pickRules(allRules: unknown[], filter: string[]): unknown[] {
  if (filter.length === 0) return allRules;
  const set = new Set(filter.map((r) => r.toUpperCase()));
  return allRules.filter((r) => {
    const id = (r as { id?: string }).id;
    return typeof id === "string" && set.has(id.toUpperCase());
  });
}

async function readSourceFile(file: string, maxBytes: number): Promise<string> {
  const st = await stat(file);
  if (!st.isFile()) throw new Error(`not a regular file: ${file}`);
  if (st.size > maxBytes) {
    throw new Error(`file too large: ${st.size} bytes > --max-bytes ${maxBytes}`);
  }
  return await readFile(file, "utf8");
}

export async function main(argv: string[]): Promise<number> {
  const { opts, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`lint-skill: ${error}\n`);
    // Exit codes are static (3 = invalid args); don't need to load lint modules first.
    return 3;
  }

  if (opts.help) {
    const v = await readVersion();
    process.stdout.write(helpText(v));
    return 0;
  }
  if (opts.version) {
    const v = await readVersion();
    process.stdout.write(v + "\n");
    return 0;
  }

  const { lintMod, registryMod, baselineMod, manifestMod, reportersMod, rules } =
    await loadLintModules();

  const repoRoot = findRepoRoot();

  if (opts.updateManifest) {
    const manifestPath = path.join(repoRoot, DEFAULT_MANIFEST_REL);
    try {
      const m = await manifestMod.generateManifest(repoRoot);
      await manifestMod.saveManifest(manifestPath, m);
      process.stdout.write(`wrote manifest: ${manifestPath} (${m.skills.length} skills)\n`);
      return lintMod.EXIT_CLEAN;
    } catch (err) {
      process.stderr.write(`lint-skill: failed to write manifest: ${String(err)}\n`);
      return lintMod.EXIT_INTERNAL;
    }
  }

  if (!opts.file) {
    process.stderr.write("lint-skill: --file is required (use --help for usage)\n");
    return lintMod.EXIT_INVALID_ARGS;
  }

  const filePath = path.resolve(process.cwd(), opts.file);

  let raw: string;
  try {
    raw = await readSourceFile(filePath, opts.maxBytes);
  } catch (err) {
    process.stderr.write(`lint-skill: cannot read ${filePath}: ${String(err)}\n`);
    return lintMod.EXIT_FILE_ERROR;
  }

  const source = baselineMod.normalizeSourceForFingerprint(raw);
  const ruleSet = pickRules(rules.rules, opts.rule);

  const registry = await registryMod.loadSkillRegistry({ repoRoot, ci: opts.ci });

  let result: { findings: unknown[]; internalErrors: unknown[] };
  try {
    result = await lintMod.lint({
      source,
      filePath,
      rules: ruleSet,
      ruleContextExtras: { registry, source },
    });
  } catch (err) {
    process.stderr.write(`lint-skill: lint failed: ${String(err)}\n`);
    return lintMod.EXIT_INTERNAL;
  }

  if (opts.updateBaseline) {
    if (!opts.baseline) {
      process.stderr.write("lint-skill: --update-baseline requires --baseline <path>\n");
      return lintMod.EXIT_INVALID_ARGS;
    }
    try {
      const bf = baselineMod.generateBaseline(result.findings, source);
      await baselineMod.saveBaseline(opts.baseline, bf);
      const count = (bf as { entries?: unknown[] }).entries?.length ?? 0;
      process.stdout.write(`wrote baseline: ${opts.baseline} (${count} entries)\n`);
      return lintMod.EXIT_CLEAN;
    } catch (err) {
      process.stderr.write(`lint-skill: failed to write baseline: ${String(err)}\n`);
      return lintMod.EXIT_INTERNAL;
    }
  }

  if (opts.baseline) {
    let bf: unknown;
    try {
      bf = await baselineMod.loadBaseline(opts.baseline);
    } catch (err) {
      process.stderr.write(`lint-skill: failed to load baseline ${opts.baseline}: ${String(err)}\n`);
      return lintMod.EXIT_FILE_ERROR;
    }
    const { live, baselined } = baselineMod.applyBaseline(result.findings, bf, source);
    result = { findings: [...live, ...baselined], internalErrors: result.internalErrors };
  }

  result.findings = reportersMod.sortFindings(result.findings);

  const reporterName: ReporterName = opts.format ?? reportersMod.selectReporter();
  const out = reportersMod.format(reporterName, result, { noColor: opts.noColor });
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");

  return lintMod.computeExitCode(result);
}

const invokedDirect = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirect) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`lint-skill: unexpected error: ${String(err)}\n`);
      process.exit(2);
    },
  );
}
