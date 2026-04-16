import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExecFn } from "./exec.js";
import type { TodoItem } from "./types.js";

/**
 * Pluggable TODO scanner interface.
 *
 * Each scanner produces a list of TodoItems for a repo at `cwd`.
 * Scanners receive an `exec` function (so tests can mock subprocess calls)
 * and must return identical TodoItem shapes regardless of implementation.
 *
 * The default is `grepScanner` (subprocess-based), which preserves the
 * pre-refactor behavior. Bead 5w3 adds `tsAstScanner` (TS/JS AST-aware)
 * and `pythonTodoScanner` (Python regex-tuned) on top.
 */
export interface TodoScanner {
  name: string;
  scan(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]>;
}

/**
 * Legacy grep-based TODO scanner. Spawns `grep -rnE "(TODO|FIXME|HACK|XXX):"`
 * scoped to common source extensions and directories.
 */
export const grepScanner: TodoScanner = {
  name: "grep",
  async scan(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]> {
    const result = await exec(
      "grep",
      [
        "-rn",
        "--include=*.ts", "--include=*.js", "--include=*.tsx", "--include=*.jsx",
        "--include=*.py", "--include=*.rs", "--include=*.go", "--include=*.rb",
        "--include=*.java", "--include=*.kt", "--include=*.swift",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=build",
        "--exclude-dir=vendor",
        "--exclude-dir=target",
        "--exclude-dir=__pycache__",
        "--exclude-dir=.venv",
        "--exclude-dir=.pi-flywheel",
        "-E", "(TODO|FIXME|HACK|XXX):",
        ".",
      ],
      { timeout: 10000, cwd, signal }
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 50)
      .map((line) => {
        const match = line.match(
          /^\.\/(.+?):(\d+):\s*.*?(TODO|FIXME|HACK|XXX):\s*(.*)$/
        );
        if (!match) return null;
        return {
          file: match[1],
          line: parseInt(match[2], 10),
          type: match[3] as TodoItem["type"],
          text: match[4].trim(),
        };
      })
      .filter((t): t is TodoItem => t !== null);
  },
};

// ─── Shared directory traversal ──────────────────────────────────

const TS_SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "build", "coverage", ".pi-flywheel",
]);

const PY_SKIP_DIRS = new Set([
  ".venv", "venv", "__pycache__", ".git", "build", "dist", ".pi-flywheel",
]);

async function walkFiles(
  root: string,
  extensions: Set<string>,
  skipDirs: Set<string>,
  signal?: AbortSignal,
  maxFiles = 5000
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (signal?.aborted) return;
    if (out.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.has(ext)) out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

// ─── TS/JS AST-aware scanner ─────────────────────────────────────

type TsModule = typeof import("typescript");
let tsModulePromise: Promise<TsModule | null> | null = null;

async function loadTypeScript(): Promise<TsModule | null> {
  if (!tsModulePromise) {
    tsModulePromise = import("typescript")
      .then((m) => (m.default ?? m) as TsModule)
      .catch(() => null);
  }
  return tsModulePromise;
}

/** Reset cached lazy-load. Exported for test isolation. */
export function _resetTsModuleCache(): void {
  tsModulePromise = null;
}

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

// Marker types the AST scanner recognizes.
type MarkerType = TodoItem["type"];

const TS_MARKER_RE =
  /\b(TODO|FIXME|HACK|XXX)\b\s*(?:\(.*?\))?\s*:?\s*(.*)/;

function extractTsMarker(commentText: string): { type: MarkerType; text: string } | null {
  // Strip leading comment decorations ("//", "/*", "*", "*/")
  const cleaned = commentText
    .replace(/^\s*\/\*+/, "")
    .replace(/\*+\/\s*$/, "")
    .replace(/^\s*\/\/+/, "")
    .replace(/^\s*\*+/gm, "")
    .trim();

  // JSDoc @todo tag (case-insensitive)
  const jsdocTodo = cleaned.match(/@todo\b\s*:?\s*(.*)/i);
  if (jsdocTodo) {
    return { type: "TODO", text: jsdocTodo[1].trim() };
  }

  const m = cleaned.match(TS_MARKER_RE);
  if (m) {
    return { type: m[1] as MarkerType, text: m[2].trim() };
  }
  return null;
}

async function scanTsFile(
  ts: TsModule,
  filePath: string,
  relPath: string
): Promise<TodoItem[]> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false);
  const items: TodoItem[] = [];
  const seenLines = new Set<number>();

  // Walk comments by scanning the full source text with the TS scanner-like
  // approach: use getLeadingCommentRanges and getTrailingCommentRanges on each
  // token position. A simpler, AST-friendly approach is to walk all nodes and
  // for each check leading/trailing comments once; dedupe by (start, kind).
  const seenRanges = new Set<string>();

  function visit(node: import("typescript").Node): void {
    const ranges = [
      ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.getEnd()) ?? []),
    ];
    for (const r of ranges) {
      const key = `${r.pos}-${r.end}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);
      const commentText = source.slice(r.pos, r.end);
      const marker = extractTsMarker(commentText);
      if (!marker) continue;
      const line = sf.getLineAndCharacterOfPosition(r.pos).line + 1;
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      items.push({ file: relPath, line, type: marker.type, text: marker.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Also scan the EOF position for trailing comments at end of file.
  const tailRanges = ts.getLeadingCommentRanges(source, sf.getEnd()) ?? [];
  for (const r of tailRanges) {
    const key = `${r.pos}-${r.end}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);
    const commentText = source.slice(r.pos, r.end);
    const marker = extractTsMarker(commentText);
    if (!marker) continue;
    const line = sf.getLineAndCharacterOfPosition(r.pos).line + 1;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    items.push({ file: relPath, line, type: marker.type, text: marker.text });
  }

  return items;
}

export const tsAstScanner: TodoScanner = {
  name: "ts-ast",
  async scan(_exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]> {
    const files = await walkFiles(cwd, TS_EXTS, TS_SKIP_DIRS, signal);
    if (files.length === 0) return [];
    const ts = await loadTypeScript();
    if (!ts) return [];
    const out: TodoItem[] = [];
    for (const f of files) {
      if (signal?.aborted) break;
      const rel = path.relative(cwd, f);
      const items = await scanTsFile(ts, f, rel);
      out.push(...items);
      if (out.length >= 500) break;
    }
    return out;
  },
};

// ─── Python scanner ──────────────────────────────────────────────

const PY_EXTS = new Set([".py"]);
const PY_MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b\s*:?\s*(.*)/;

/**
 * Strip non-docstring string literals from a Python source file.
 *
 * Approximations:
 * - Triple-quoted strings at the top of the file, a module, or directly after
 *   a `def`/`class` line are treated as docstrings and preserved.
 * - All other string literals (single/double, f-strings, r-strings) get their
 *   contents replaced with blanks (keeping line breaks intact so line numbers
 *   stay accurate).
 */
function stripPyStrings(source: string): string {
  const lines = source.split("\n");
  // First pass: mark line indexes that are inside "docstring" triple-quoted blocks.
  const docstringLines = new Set<number>();
  let inDoc = false;
  let docQuote = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inDoc) {
      docstringLines.add(i);
      if (line.includes(docQuote)) {
        inDoc = false;
        docQuote = "";
      }
      continue;
    }
    // Detect start of a docstring: a line whose first non-ws token is """ or '''
    // and (top-of-file or previous non-blank line ends with ":") — module/class/func docstring.
    const trimmed = line.trimStart();
    const startsTriple = trimmed.startsWith('"""') || trimmed.startsWith("'''");
    if (startsTriple) {
      const quote = trimmed.startsWith('"""') ? '"""' : "'''";
      // Look back for previous non-blank line
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === "") prev--;
      const prevLine = prev >= 0 ? lines[prev].trimEnd() : "";
      const isDocstring =
        prev < 0 || // top of file
        prevLine.endsWith(":"); // after def/class
      if (isDocstring) {
        docstringLines.add(i);
        // Check if closes on same line
        const rest = trimmed.slice(3);
        if (rest.includes(quote)) {
          // single-line docstring
        } else {
          inDoc = true;
          docQuote = quote;
        }
        continue;
      }
    }
  }

  // Second pass: blank out string contents on non-docstring lines.
  // Simple regex-based stripping — preserves line count by not touching newlines.
  const stripped = lines.map((line, i) => {
    if (docstringLines.has(i)) return line;
    // Blank out triple-quoted blocks on one line (non-docstring usage).
    let out = line.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, (m) => '"' + " ".repeat(Math.max(0, m.length - 2)) + '"');
    // Blank out regular strings: handle f/r/b prefixes
    out = out.replace(/([fFrRbBuU]{0,2})(["'])((?:\\.|(?!\2).)*)\2/g, (_m, prefix: string, q: string, body: string) => {
      return prefix + q + " ".repeat(body.length) + q;
    });
    return out;
  });

  return stripped.join("\n");
}

async function scanPyFile(filePath: string, relPath: string): Promise<TodoItem[]> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  // We need to preserve docstring contents (so markers inside them are found)
  // and strip non-docstring strings (so markers inside them are NOT found).
  const lines = source.split("\n");
  // Determine which lines are docstring lines.
  const docstringLines = new Set<number>();
  {
    let inDoc = false;
    let docQuote = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inDoc) {
        docstringLines.add(i);
        if (line.includes(docQuote)) {
          inDoc = false;
          docQuote = "";
        }
        continue;
      }
      const trimmed = line.trimStart();
      const startsTriple = trimmed.startsWith('"""') || trimmed.startsWith("'''");
      if (startsTriple) {
        const quote = trimmed.startsWith('"""') ? '"""' : "'''";
        let prev = i - 1;
        while (prev >= 0 && lines[prev].trim() === "") prev--;
        const prevLine = prev >= 0 ? lines[prev].trimEnd() : "";
        const isDocstring = prev < 0 || prevLine.endsWith(":");
        if (isDocstring) {
          docstringLines.add(i);
          const rest = trimmed.slice(3);
          if (!rest.includes(quote)) {
            inDoc = true;
            docQuote = quote;
          }
          continue;
        }
      }
    }
  }

  const strippedSource = stripPyStrings(source);
  const strippedLines = strippedSource.split("\n");
  const items: TodoItem[] = [];
  const seenLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const origLine = lines[i];
    const isDoc = docstringLines.has(i);
    // Search target: if docstring, use original; else, use stripped line and
    // also look at `#` comment portion.
    let searchText = "";
    if (isDoc) {
      searchText = origLine;
    } else {
      // Only care about `#` comments on stripped (non-string) text
      const strippedLine = strippedLines[i] ?? "";
      const hashIdx = strippedLine.indexOf("#");
      if (hashIdx >= 0) {
        searchText = strippedLine.slice(hashIdx);
      }
    }
    if (!searchText) continue;
    const m = searchText.match(PY_MARKER_RE);
    if (!m) continue;
    const lineNo = i + 1;
    if (seenLines.has(lineNo)) continue;
    seenLines.add(lineNo);
    items.push({
      file: relPath,
      line: lineNo,
      type: m[1] as MarkerType,
      text: m[2].trim(),
    });
  }

  return items;
}

export const pythonTodoScanner: TodoScanner = {
  name: "python",
  async scan(_exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]> {
    const files = await walkFiles(cwd, PY_EXTS, PY_SKIP_DIRS, signal);
    const out: TodoItem[] = [];
    for (const f of files) {
      if (signal?.aborted) break;
      const rel = path.relative(cwd, f);
      const items = await scanPyFile(f, rel);
      out.push(...items);
      if (out.length >= 500) break;
    }
    return out;
  },
};

// ─── Dedup helper ────────────────────────────────────────────────

/**
 * Merge and dedupe TodoItems by (file, line). First occurrence wins so that
 * grep-based results (which run first in the default scanner list) are
 * preserved over AST-scanner finds on the same line.
 */
export function mergeAndDedup(items: TodoItem[]): TodoItem[] {
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const item of items) {
    const key = `${item.file}:${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ─── Scanner selection ───────────────────────────────────────────

/**
 * Choose which scanners to run based on env configuration.
 *
 * Default: `[grepScanner, tsAstScanner, pythonTodoScanner]`.
 * `FLYWHEEL_PROFILE_SCANNER=grep` forces only grep (legacy rollback).
 */
export function selectScanners(env: NodeJS.ProcessEnv = process.env): TodoScanner[] {
  if (env.FLYWHEEL_PROFILE_SCANNER === "grep") {
    return [grepScanner];
  }
  return [grepScanner, tsAstScanner, pythonTodoScanner];
}
