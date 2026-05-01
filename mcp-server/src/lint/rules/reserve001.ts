import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import type { Document, Finding, Rule, RuleContext } from "../types.js";

/**
 * RESERVE001 — direct `agentMailRPC("file_reservation_paths")` calls must
 * route through `reserveOrFail()` in `mcp-server/src/agent-mail-helpers.ts`.
 *
 * Why this rule exists: AGENTS.md "Known issue" documents that agent-mail's
 * server-side enforcement is advisory — the second exclusive request returns
 * a response with both `granted` and `conflicts` populated. The `reserveOrFail`
 * helper (T4) codifies the mitigation. This rule prevents new direct call
 * sites from sneaking past code review.
 *
 * Cross-file rule: ignores its `Document` (a parsed SKILL.md) and walks
 * `<repoRoot>/mcp-server/src/**\/*.ts` itself. Receives `repoRoot` from
 * `ctx.repoRoot` (passed in `ruleContextExtras` by the CLI).
 *
 * Severity is `warn` initially per the duel-plan T5 rollout (promote to
 * `error` after one release cycle).
 */

export interface Reserve001Context extends RuleContext {
  repoRoot?: string;
  /** Override scan root (tests inject this to point at fixture trees). */
  srcRoot?: string;
  /** Override allowlist (tests inject this for fixture-based behaviour). */
  allowlist?: string[];
}

/**
 * Files exempt from RESERVE001:
 * - `agent-mail-helpers.ts` is the implementing module — it OWNS the wrapped call.
 * - `lint/rules/reserve001.ts` is THIS rule, whose own source contains the
 *   literal patterns `agentMailRPC` and `file_reservation_paths` for detection
 *   purposes; without the self-exemption it would flag itself.
 *
 * Allowlist entries are matched by suffix against the repo-relative POSIX
 * path of each scanned file.
 */
const DEFAULT_ALLOWLIST: string[] = [
  "mcp-server/src/agent-mail-helpers.ts",
  "mcp-server/src/lint/rules/reserve001.ts",
];

/**
 * Directories the walker never descends into. `__tests__` is skipped so
 * fixture files containing deliberate raw calls (used for testing this very
 * rule) don't trigger live findings.
 */
const SKIP_DIRS = new Set(["dist", "node_modules", "__tests__"]);

/**
 * Heuristic for the call-site pattern. Matches `agentMailRPC` followed by
 * up to 200 characters of any content (including newlines) and then the
 * literal string `"file_reservation_paths"` or `'file_reservation_paths'`.
 *
 * The 200-char window is generous enough to handle multi-line invocations
 * with type parameters, comments, and whitespace, while staying tight enough
 * that an unrelated `agentMailRPC` call followed much later in the same file
 * by a literal string doesn't produce a false-positive cross-call match.
 */
const RESERVE_CALL_PATTERN = /agentMailRPC[\s\S]{0,200}["']file_reservation_paths["']/g;

interface WalkedFile {
  abs: string;
  /** Path relative to `relBase`, normalised to POSIX separators. */
  rel: string;
}

interface WalkOpts {
  skipDirs: Set<string>;
  relBase: string;
}

async function walkTsFiles(root: string, opts: WalkOpts): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (opts.skipDirs.has(entry.name)) continue;
      const sub = await walkTsFiles(path.join(root, entry.name), opts);
      out.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      const abs = path.join(root, entry.name);
      const rel = path.relative(opts.relBase, abs).split(path.sep).join("/");
      out.push({ abs, rel });
    }
  }
  return out;
}

function isAllowlisted(rel: string, allowlist: string[]): boolean {
  const norm = rel.split(path.sep).join("/");
  return allowlist.some((a) => {
    const aNorm = a.split(path.sep).join("/");
    return norm === aNorm || norm.endsWith(`/${aNorm}`) || aNorm.endsWith(norm);
  });
}

function lineColOfOffset(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

export const reserve001: Rule = {
  id: "RESERVE001",
  description:
    "Direct agentMailRPC file-reservation calls must route through reserveOrFail() in agent-mail-helpers.ts.",
  severity: "warn",
  async check(_doc: Document, ctx: RuleContext): Promise<Finding[]> {
    const rc = ctx as Reserve001Context;
    const explicitSrc = rc.srcRoot;
    const repoRoot = rc.repoRoot;
    if (!explicitSrc && !repoRoot) {
      // No scan root available — rule is effectively a no-op outside the CLI.
      return [];
    }
    const srcRoot = explicitSrc ?? path.join(repoRoot!, "mcp-server", "src");
    const relBase = explicitSrc ? srcRoot : repoRoot!;
    const allowlist = rc.allowlist ?? DEFAULT_ALLOWLIST;

    const files = await walkTsFiles(srcRoot, { skipDirs: SKIP_DIRS, relBase });
    const findings: Finding[] = [];
    for (const file of files) {
      if (isAllowlisted(file.rel, allowlist)) continue;
      let source: string;
      try {
        source = await readFile(file.abs, "utf8");
      } catch {
        continue;
      }
      // Quick reject before regex scan — most files won't contain the literal.
      if (!source.includes("file_reservation_paths")) continue;
      if (!source.includes("agentMailRPC")) continue;

      RESERVE_CALL_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RESERVE_CALL_PATTERN.exec(source)) !== null) {
        const { line, column } = lineColOfOffset(source, match.index);
        findings.push({
          ruleId: "RESERVE001",
          severity: "warn",
          file: file.rel,
          line,
          column,
          message:
            'Direct agentMailRPC("file_reservation_paths") call. Route through reserveOrFail() in mcp-server/src/agent-mail-helpers.ts so non-empty conflicts are treated as failure (AGENTS.md "Known issue").',
          hint: "Replace with reserveOrFail(paths, { exec, cwd, agentName, ttlSeconds, exclusive, reason }) and branch on result.ok.",
        });
      }
    }
    return findings;
  },
};

export default reserve001;
