#!/usr/bin/env node
// lint-skill-dir: lint every .md file in a directory with ONE shared baseline.
//
// Why this exists: `lint-skill.ts` lints a single file per invocation and
// overwrites the baseline on --update-baseline. The flywheel's `skills/start/`
// directory has 11 skill files; linting only SKILL.md left blind spots that
// shipped unparseable AskUserQuestion calls (M2 beads). This driver covers the
// whole directory with one baseline so a 5-option AUQ added to any start file
// fails CI.
//
// Semantics mirror lint-skill.ts for the surface it reuses: --ci, --baseline,
// --format, --max-bytes. Multi-file additions: --dir <path> and
// --update-baseline writes merged entries from every file in one pass.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const isCompiled = import.meta.url.includes("/dist/scripts/");
const lintBase = isCompiled ? "../lint" : "../src/lint";

type ReporterName = "pretty" | "compact" | "gha" | "json";

interface Finding {
  ruleId: string;
  severity: "error" | "warning" | "info";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
}

interface LintModule {
  lint: (opts: unknown) => Promise<{ findings: Finding[]; internalErrors: unknown[] }>;
  EXIT_CLEAN: number;
  EXIT_FINDINGS: number;
  EXIT_INTERNAL: number;
  EXIT_INVALID_ARGS: number;
  EXIT_FILE_ERROR: number;
}

interface BaselineModule {
  loadBaseline: (p: string) => Promise<unknown>;
  saveBaseline: (p: string, b: unknown) => Promise<void>;
  applyBaseline: (
    findings: unknown[],
    baseline: unknown,
    source: string,
    repoRoot?: string,
  ) => { live: Finding[]; baselined: Finding[] };
  generateBaseline: (
    findings: unknown[],
    source: string,
    generated?: string,
    repoRoot?: string,
  ) => unknown;
  normalizeSourceForFingerprint: (s: string) => string;
}

interface ReportersModule {
  format: (name: ReporterName, result: unknown, opts?: unknown) => string;
  selectReporter: () => ReporterName;
  sortFindings: (findings: unknown[]) => unknown[];
}

interface SkillRegistryModule {
  loadSkillRegistry: (opts: unknown) => Promise<unknown>;
}

interface CliOpts {
  dir: string | null;
  ci: boolean;
  baseline: string | null;
  format: ReporterName | null;
  updateBaseline: boolean;
  help: boolean;
}

function defaultOpts(): CliOpts {
  return {
    dir: null,
    ci: false,
    baseline: null,
    format: null,
    updateBaseline: false,
    help: false,
  };
}

function parseArgs(argv: string[]): { opts: CliOpts; error: string | null } {
  const opts = defaultOpts();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
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
      case "--ci":
        opts.ci = true;
        break;
      case "--update-baseline":
        opts.updateBaseline = true;
        break;
      case "--dir": {
        const v = takeNext();
        if (v === null) return { opts, error: "--dir requires a path" };
        opts.dir = v;
        break;
      }
      case "--baseline": {
        const v = takeNext();
        if (v === null) return { opts, error: "--baseline requires a path" };
        opts.baseline = v;
        break;
      }
      case "--format": {
        const v = takeNext();
        if (v === null) return { opts, error: "--format requires a value" };
        if (v !== "pretty" && v !== "compact" && v !== "gha" && v !== "json") {
          return { opts, error: `invalid --format '${v}'` };
        }
        opts.format = v;
        break;
      }
      default:
        return { opts, error: `unknown flag: ${a}` };
    }
  }
  return { opts, error: null };
}

function printHelp(): void {
  process.stdout.write(
    [
      "lint-skill-dir: lint every .md file in a directory with ONE baseline.",
      "",
      "Usage: lint-skill-dir --dir <path> [--baseline <path>] [--ci] [--format <name>]",
      "       lint-skill-dir --dir <path> --baseline <path> --update-baseline",
      "",
      "Each file is linted via the lint-skill rule set. One baseline covers all",
      "files; --update-baseline rewrites the baseline with the UNION of every",
      "file's current findings.",
      "",
    ].join("\n"),
  );
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkMd(p));
    } else if (entry.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

async function main(): Promise<number> {
  const { opts, error } = parseArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`lint-skill-dir: ${error}\n`);
    return 3;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (!opts.dir) {
    process.stderr.write("lint-skill-dir: --dir is required\n");
    return 3;
  }

  const lintMod = (await import(`${lintBase}/index.js`)) as unknown as LintModule;
  const baselineMod = (await import(`${lintBase}/baseline.js`)) as unknown as BaselineModule;
  const reportersMod = (await import(`${lintBase}/reporters/index.js`)) as unknown as ReportersModule;
  const registryMod = (await import(`${lintBase}/skillRegistry.js`)) as unknown as SkillRegistryModule;

  const auq = (await import(`${lintBase}/rules/askUserQuestion.js`)) as unknown as { auqRules: unknown[] };
  const slash = (await import(`${lintBase}/rules/slashReferences.js`)) as unknown as { slash001: unknown };
  const place = (await import(`${lintBase}/rules/placeholders.js`)) as unknown as { place001: unknown };
  const impl = (await import(`${lintBase}/rules/implicitDecisions.js`)) as unknown as { impl001: unknown };
  const err = (await import(`${lintBase}/rules/errorCodeReferences.js`)) as unknown as { err001: unknown };
  const reserve = (await import(`${lintBase}/rules/reserve001.js`)) as unknown as { reserve001: unknown };
  const pane = (await import(`${lintBase}/rules/pane001.js`)) as unknown as { pane001: unknown };
  const rules = [...auq.auqRules, slash.slash001, place.place001, impl.impl001, err.err001, reserve.reserve001, pane.pane001];

  // repoRoot = parent of this script's mcp-server/
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerRoot = path.resolve(here, "..", "..");
  const repoRoot = path.resolve(mcpServerRoot, "..");

  const dirAbs = path.resolve(process.cwd(), opts.dir);
  let files: string[];
  try {
    files = walkMd(dirAbs);
  } catch (e) {
    process.stderr.write(`lint-skill-dir: cannot read ${dirAbs}: ${String(e)}\n`);
    return 4;
  }
  if (files.length === 0) {
    process.stderr.write(`lint-skill-dir: no .md files under ${dirAbs}\n`);
    return 4;
  }

  const registry = await registryMod.loadSkillRegistry({ repoRoot, ci: opts.ci });

  // One lint per file, then merge findings.
  const allFindings: Finding[] = [];
  const perFileSources = new Map<string, string>();

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      process.stderr.write(`lint-skill-dir: cannot read ${file}: ${String(e)}\n`);
      return 4;
    }
    const source = baselineMod.normalizeSourceForFingerprint(raw);
    perFileSources.set(file, source);
    const result = await lintMod.lint({
      source,
      filePath: file,
      rules,
      ruleContextExtras: { registry, source, repoRoot },
    });
    allFindings.push(...result.findings);
  }

  if (opts.updateBaseline) {
    if (!opts.baseline) {
      process.stderr.write("lint-skill-dir: --update-baseline requires --baseline <path>\n");
      return 3;
    }
    // Fingerprints are per-file: regenerate baseline from each file's own source so
    // the resulting entries match correctly on re-lint.
    const entriesByFile = new Map<string, Finding[]>();
    for (const f of allFindings) {
      const arr = entriesByFile.get(f.file) ?? [];
      arr.push(f);
      entriesByFile.set(f.file, arr);
    }
    const allEntries: unknown[] = [];
    for (const [file, findings] of entriesByFile) {
      const source = perFileSources.get(file) ?? "";
      const bf = baselineMod.generateBaseline(findings, source, undefined, repoRoot) as {
        entries: unknown[];
      };
      allEntries.push(...bf.entries);
    }
    const merged = {
      schemaVersion: 1,
      rulesetVersion: 1,
      generated: new Date().toISOString(),
      entries: allEntries,
    };
    await baselineMod.saveBaseline(opts.baseline, merged);
    process.stdout.write(
      `wrote baseline: ${opts.baseline} (${allEntries.length} entries across ${entriesByFile.size} files)\n`,
    );
    return 0;
  }

  // Apply baseline (per-file source for fingerprint matching).
  let liveFindings: Finding[] = [];
  let baselinedCount = 0;
  if (opts.baseline) {
    let bf: unknown;
    try {
      bf = await baselineMod.loadBaseline(opts.baseline);
    } catch (e) {
      process.stderr.write(`lint-skill-dir: failed to load baseline ${opts.baseline}: ${String(e)}\n`);
      return 4;
    }
    const byFile = new Map<string, Finding[]>();
    for (const f of allFindings) {
      const arr = byFile.get(f.file) ?? [];
      arr.push(f);
      byFile.set(f.file, arr);
    }
    for (const [file, findings] of byFile) {
      const source = perFileSources.get(file) ?? "";
      const { live, baselined } = baselineMod.applyBaseline(findings, bf, source, repoRoot);
      liveFindings.push(...live, ...baselined);
      baselinedCount += baselined.length;
    }
  } else {
    liveFindings = allFindings.slice();
  }

  const reporter = opts.format ?? reportersMod.selectReporter();
  const sorted = reportersMod.sortFindings(liveFindings);
  const text = reportersMod.format(reporter, { findings: sorted, internalErrors: [] });
  if (text) process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));

  const liveErrors = (liveFindings as Finding[]).filter((f) => f.severity === "error");
  return liveErrors.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`lint-skill-dir: ${String(err)}\n`);
    process.exit(2);
  },
);
