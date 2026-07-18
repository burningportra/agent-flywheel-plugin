/**
 * Post-render Claude-compatibility inventory for the OpenCode port.
 *
 * The sync pipeline passes only manifest-owned staged artifacts here. Known
 * semantic gaps remain informational in v1, while a new call-like Claude token
 * must be classified in opencode/compatibility.json before it can ship.
 */

import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

export const COMPATIBILITY_FINDING_CODES = Object.freeze({
  UNCLASSIFIED: "compatibility_unclassified",
  POLICY_STALE: "compatibility_policy_stale",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelativePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function compileGlobal(pattern, label) {
  let regex;
  try {
    regex = new RegExp(pattern, "g");
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${String(error)}`);
  }
  if (new RegExp(pattern).test("")) {
    throw new Error(`${label} must not match an empty string`);
  }
  return regex;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/** Parse and fail-closed shape-check opencode/compatibility.json. */
export async function loadCompatibilityPolicy(policyPath) {
  let raw;
  try {
    raw = await readFile(policyPath, "utf8");
  } catch (error) {
    throw new Error(`compatibility policy is not readable at ${policyPath}: ${String(error)}`);
  }

  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    throw new Error(`compatibility policy is not valid JSON (${policyPath}): ${String(error)}`);
  }
  validateCompatibilityPolicy(policy);
  return policy;
}

/** Validate policy references, reasons, regexes, and scoped allowances. */
export function validateCompatibilityPolicy(policy) {
  if (!isObject(policy) || policy.version !== 1 || policy.kind !== "opencode-compatibility") {
    throw new Error('compatibility policy must have version 1 and kind "opencode-compatibility"');
  }
  if (!isObject(policy.scan)) throw new Error("compatibility policy scan must be an object");
  if (!Array.isArray(policy.scan.roots) || policy.scan.roots.length === 0) {
    throw new Error("compatibility policy scan.roots must be a non-empty array");
  }
  if (!Array.isArray(policy.scan.extensions) || policy.scan.extensions.length === 0) {
    throw new Error("compatibility policy scan.extensions must be a non-empty array");
  }
  for (const [index, root] of policy.scan.roots.entries()) {
    assertNonEmptyString(root, `compatibility policy scan.roots[${index}]`);
  }
  for (const [index, extension] of policy.scan.extensions.entries()) {
    if (typeof extension !== "string" || !/^\.[a-z0-9]+$/i.test(extension)) {
      throw new Error(`compatibility policy scan.extensions[${index}] must be a file extension`);
    }
  }
  assertNonEmptyString(policy.scan.candidateCallPattern, "compatibility policy candidateCallPattern");
  const candidate = compileGlobal(
    policy.scan.candidateCallPattern,
    "compatibility policy candidateCallPattern",
  );
  const candidateProbe = candidate.exec("FutureClaudeTool(");
  if (candidateProbe?.groups?.token !== "FutureClaudeTool") {
    throw new Error(
      'compatibility policy candidateCallPattern must capture FutureClaudeTool as named group "token"',
    );
  }

  if (!Array.isArray(policy.reportGroups) || policy.reportGroups.length === 0) {
    throw new Error("compatibility policy reportGroups must be a non-empty array");
  }
  const groupIds = new Set();
  for (const [index, group] of policy.reportGroups.entries()) {
    const label = `compatibility policy reportGroups[${index}]`;
    if (!isObject(group)) throw new Error(`${label} must be an object`);
    assertNonEmptyString(group.id, `${label}.id`);
    if (groupIds.has(group.id)) throw new Error(`duplicate compatibility report group ${group.id}`);
    groupIds.add(group.id);
    assertNonEmptyString(group.pattern, `${label}.pattern`);
    compileGlobal(group.pattern, `${label}.pattern`);
    assertNonEmptyString(group.reason, `${label}.reason`);
    assertNonEmptyString(group.rgCommand, `${label}.rgCommand`);
    if (group.baseline !== undefined && (!Number.isInteger(group.baseline) || group.baseline < 0)) {
      throw new Error(`${label}.baseline must be a non-negative integer when present`);
    }
  }

  if (!Array.isArray(policy.knownClaudeTokens) || policy.knownClaudeTokens.length === 0) {
    throw new Error("compatibility policy knownClaudeTokens must be a non-empty array");
  }
  const tokens = new Set();
  for (const [index, entry] of policy.knownClaudeTokens.entries()) {
    const label = `compatibility policy knownClaudeTokens[${index}]`;
    if (!isObject(entry)) throw new Error(`${label} must be an object`);
    assertNonEmptyString(entry.token, `${label}.token`);
    if (tokens.has(entry.token)) throw new Error(`duplicate known Claude token ${entry.token}`);
    tokens.add(entry.token);
    assertNonEmptyString(entry.reason, `${label}.reason`);
    if (entry.classification === "REPORT") {
      if (!groupIds.has(entry.group)) {
        throw new Error(`${label}.group must reference a report group (got ${String(entry.group)})`);
      }
      if (entry.callPattern !== undefined) {
        assertNonEmptyString(entry.callPattern, `${label}.callPattern`);
        const callPattern = compileGlobal(entry.callPattern, `${label}.callPattern`);
        if (!callPattern.test(`${entry.token}(`)) {
          throw new Error(`${label}.callPattern must match its token as a call`);
        }
      }
    } else if (entry.classification === "WARN") {
      assertNonEmptyString(entry.pattern, `${label}.pattern`);
      const retainedPattern = compileGlobal(entry.pattern, `${label}.pattern`);
      if (!retainedPattern.test(`${entry.token}(`)) {
        throw new Error(`${label}.pattern must match its token as a call`);
      }
      if (!Array.isArray(entry.allowedOccurrences) || entry.allowedOccurrences.length === 0) {
        throw new Error(`${label}.allowedOccurrences must be a non-empty array for WARN entries`);
      }
      const paths = new Set();
      for (const [allowIndex, allowed] of entry.allowedOccurrences.entries()) {
        const allowLabel = `${label}.allowedOccurrences[${allowIndex}]`;
        if (!isObject(allowed)) throw new Error(`${allowLabel} must be an object`);
        assertNonEmptyString(allowed.path, `${allowLabel}.path`);
        if (path.isAbsolute(allowed.path) || normalizeRelativePath(allowed.path) !== allowed.path) {
          throw new Error(`${allowLabel}.path must be a normalized relative path`);
        }
        if (paths.has(allowed.path)) throw new Error(`${label} repeats allowed path ${allowed.path}`);
        paths.add(allowed.path);
        if (!Number.isInteger(allowed.count) || allowed.count < 1) {
          throw new Error(`${allowLabel}.count must be a positive integer`);
        }
      }
    } else if (entry.classification === "ERROR") {
      assertNonEmptyString(entry.pattern, `${label}.pattern`);
      const forbiddenPattern = compileGlobal(entry.pattern, `${label}.pattern`);
      if (!forbiddenPattern.test(`${entry.token}(`)) {
        throw new Error(`${label}.pattern must match its token as a call`);
      }
    } else {
      throw new Error(`${label}.classification must be ERROR, REPORT, or WARN`);
    }
  }

  if (!Array.isArray(policy.carveouts)) throw new Error("compatibility policy carveouts must be an array");
  const carveoutIds = new Set();
  for (const [index, carveout] of policy.carveouts.entries()) {
    const label = `compatibility policy carveouts[${index}]`;
    if (!isObject(carveout)) throw new Error(`${label} must be an object`);
    assertNonEmptyString(carveout.id, `${label}.id`);
    if (carveoutIds.has(carveout.id)) throw new Error(`duplicate compatibility carveout ${carveout.id}`);
    carveoutIds.add(carveout.id);
    if (carveout.kind !== "mcp-bundle-name-argument") {
      throw new Error(`${label}.kind is unsupported: ${String(carveout.kind)}`);
    }
    assertNonEmptyString(carveout.prefix, `${label}.prefix`);
    assertNonEmptyString(carveout.reason, `${label}.reason`);
  }
  return policy;
}

function pathIsInRoots(relativePath, roots) {
  return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}

/** Read manifest-owned staged Markdown/JavaScript files in stable target order. */
export async function collectCompatibilityDocuments(items, policy) {
  const roots = policy.scan.roots.map(normalizeRelativePath);
  const extensions = new Set(policy.scan.extensions);
  const documents = [];

  const addFile = async (stagePath, targetPath) => {
    const normalizedTarget = normalizeRelativePath(targetPath);
    if (!pathIsInRoots(normalizedTarget, roots)) return;
    if (!extensions.has(path.extname(normalizedTarget))) return;
    documents.push({ path: normalizedTarget, content: await readFile(stagePath, "utf8") });
  };

  const walkTree = async (stageRoot, targetRoot) => {
    const entries = (await readdir(stageRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const stagePath = path.join(stageRoot, entry.name);
      const targetPath = `${targetRoot}/${entry.name}`;
      if (entry.isDirectory()) await walkTree(stagePath, targetPath);
      else if (entry.isFile()) await addFile(stagePath, targetPath);
      else throw new Error(`compatibility scan encountered unsupported staged entry ${targetPath}`);
    }
  };

  for (const item of [...items].sort((a, b) => String(a.target).localeCompare(String(b.target)))) {
    if (item.kind === "mcp") continue;
    const target = normalizeRelativePath(item.target);
    if (!pathIsInRoots(target, roots)) continue;
    if (item.kind === "tree") await walkTree(item.stagePath, target);
    else if (item.kind === "file") await addFile(item.stagePath, target);
  }

  documents.sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set();
  for (const document of documents) {
    if (seen.has(document.path)) throw new Error(`compatibility scan received duplicate target ${document.path}`);
    seen.add(document.path);
  }
  return documents;
}

function maskRanges(content, ranges) {
  if (ranges.length === 0) return content;
  // RegExp match indexes use UTF-16 code units, which split("") preserves.
  const chars = content.split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  }
  return chars.join("");
}

function findClosingCallParen(content, openParen) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = openParen; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

/** Mask only the agent-flywheel:* string value inside flywheel_get_skill name args. */
function applyCarveouts(content, policy) {
  const ranges = [];
  const callPattern = /\b(?:flywheel_)?flywheel_get_skill\s*\(/g;
  for (const carveout of policy.carveouts) {
    if (carveout.kind !== "mcp-bundle-name-argument") continue;
    const escapedPrefix = carveout.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(
      `(?:\\bname\\b|["']name["'])\\s*:\\s*(["'])(${escapedPrefix}[^"']+)\\1`,
      "g",
    );
    for (const call of content.matchAll(callPattern)) {
      const openParen = call.index + call[0].lastIndexOf("(");
      const callEnd = findClosingCallParen(content, openParen);
      if (callEnd === undefined) continue;
      const body = content.slice(openParen + 1, callEnd);
      for (const name of body.matchAll(namePattern)) {
        const value = name[2];
        const valueOffset = name[0].lastIndexOf(value);
        const start = openParen + 1 + name.index + valueOffset;
        ranges.push([start, start + value.length]);
      }
    }
  }
  return maskRanges(content, ranges);
}

function lineNumberAt(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (content[index] === "\n") line += 1;
  return line;
}

function matchRangesByPath(documents, pattern, options = {}) {
  const ranges = new Map();
  const regex = compileGlobal(pattern, "compatibility scan pattern");
  for (const document of documents) {
    const matches = [];
    if (options.lineScoped === false) {
      for (const match of document.masked.matchAll(regex)) {
        matches.push([match.index, match.index + match[0].length]);
      }
    } else {
      let lineOffset = 0;
      for (const line of document.masked.split("\n")) {
        for (const match of line.matchAll(regex)) {
          matches.push([lineOffset + match.index, lineOffset + match.index + match[0].length]);
        }
        lineOffset += line.length + 1;
      }
    }
    if (matches.length > 0) ranges.set(document.path, matches);
  }
  return ranges;
}

function matchesByPath(documents, pattern, options) {
  return new Map(
    [...matchRangesByPath(documents, pattern, options)]
      .map(([relativePath, ranges]) => [relativePath, ranges.length]),
  );
}

/**
 * Scan in-memory staged documents. Fragment fixtures disable allowance
 * completeness, while the real staged-tree validator requires exact baselines.
 */
export function scanCompatibilityDocuments(documents, policy, options = {}) {
  validateCompatibilityPolicy(policy);
  const enforceAllowanceCompleteness = options.enforceAllowanceCompleteness ?? false;
  const normalized = documents
    .map((document) => ({
      path: normalizeRelativePath(document.path),
      content: String(document.content),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((document) => ({ ...document, masked: applyCarveouts(document.content, policy) }));

  const groupCoverage = new Map();
  const groups = policy.reportGroups.map((group) => {
    const coverage = matchRangesByPath(normalized, group.pattern);
    groupCoverage.set(group.id, coverage);
    const counts = new Map(
      [...coverage].map(([relativePath, ranges]) => [relativePath, ranges.length]),
    );
    return {
      id: group.id,
      count: [...counts.values()].reduce((sum, count) => sum + count, 0),
      firstPath: counts.keys().next().value,
      baseline: group.baseline,
      reason: group.reason,
      rgCommand: group.rgCommand,
    };
  });

  const knownByToken = new Map(policy.knownClaudeTokens.map((entry) => [entry.token, entry]));
  const findings = [];
  const findingKeys = new Set();
  const documentsByPath = new Map(normalized.map((document) => [document.path, document]));
  const isGroupCovered = (entry, relativePath, offset) =>
    (groupCoverage.get(entry.group)?.get(relativePath) ?? [])
      .some(([start, end]) => offset >= start && offset < end);
  const addUnclassified = (entry) => {
    const key = `${entry.token}\0${entry.path}\0${entry.offset ?? "path"}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    const document = documentsByPath.get(entry.path);
    const line = entry.offset === undefined || !document
      ? undefined
      : lineNumberAt(document.masked, entry.offset);
    findings.push({
      code: COMPATIBILITY_FINDING_CODES.UNCLASSIFIED,
      token: entry.token,
      path: entry.path,
      line,
      message:
        entry.message ??
        `Claude-like call ${JSON.stringify(entry.token)} at ${entry.path}${line ? `:${line}` : ""} ` +
          "has no matching REPORT context or narrowly scoped WARN allowance in " +
          "opencode/compatibility.json",
    });
  };

  for (const entry of policy.knownClaudeTokens.filter((item) => item.classification === "ERROR")) {
    const occurrences = matchRangesByPath(normalized, entry.pattern, { lineScoped: false });
    for (const [relativePath, ranges] of occurrences) {
      for (const [start] of ranges) {
        addUnclassified({
          token: entry.token,
          path: relativePath,
          offset: start,
          message:
            `Claude-only call ${JSON.stringify(entry.token)} is forbidden in the staged OpenCode tree ` +
            `(${relativePath}:${lineNumberAt(documentsByPath.get(relativePath).masked, start)}); ` +
            entry.reason,
        });
      }
    }
  }

  for (const entry of policy.knownClaudeTokens.filter(
    (item) => item.classification === "REPORT" && item.callPattern !== undefined,
  )) {
    const occurrences = matchRangesByPath(normalized, entry.callPattern, { lineScoped: false });
    for (const [relativePath, ranges] of occurrences) {
      for (const [start] of ranges) {
        if (!isGroupCovered(entry, relativePath, start)) {
          addUnclassified({ token: entry.token, path: relativePath, offset: start });
        }
      }
    }
  }

  const candidateRegex = compileGlobal(
    policy.scan.candidateCallPattern,
    "compatibility policy candidateCallPattern",
  );
  for (const document of normalized) {
    for (const match of document.masked.matchAll(candidateRegex)) {
      const token = match.groups?.token;
      const known = knownByToken.get(token);
      if (known?.classification === "WARN" || known?.classification === "ERROR") continue;
      if (known?.classification === "REPORT" && isGroupCovered(known, document.path, match.index)) {
        continue;
      }
      addUnclassified({ token, path: document.path, offset: match.index });
    }
  }

  const warnings = [];
  for (const entry of policy.knownClaudeTokens.filter((item) => item.classification === "WARN")) {
    const actual = matchesByPath(normalized, entry.pattern, { lineScoped: false });
    const expected = new Map(entry.allowedOccurrences.map((row) => [row.path, row.count]));
    const allPaths = new Set([...actual.keys(), ...(enforceAllowanceCompleteness ? expected.keys() : [])]);
    for (const relativePath of [...allPaths].sort()) {
      const actualCount = actual.get(relativePath) ?? 0;
      const expectedCount = expected.get(relativePath);
      if (expectedCount === undefined && actualCount > 0) {
        findings.push({
          code: COMPATIBILITY_FINDING_CODES.UNCLASSIFIED,
          token: entry.token,
          path: relativePath,
          message:
            `Claude-only token ${JSON.stringify(entry.token)} has ${actualCount} unclassified occurrence(s) ` +
            `in ${relativePath}; its WARN allowance is intentionally path-scoped`,
        });
      } else if (
        expectedCount !== undefined &&
        (actualCount > expectedCount || (enforceAllowanceCompleteness && actualCount !== expectedCount))
      ) {
        findings.push({
          code:
            actualCount > expectedCount
              ? COMPATIBILITY_FINDING_CODES.UNCLASSIFIED
              : COMPATIBILITY_FINDING_CODES.POLICY_STALE,
          token: entry.token,
          path: relativePath,
          message:
            `Claude-only token ${JSON.stringify(entry.token)} has ${actualCount} occurrence(s) in ` +
            `${relativePath}; compatibility policy expects exactly ${expectedCount}`,
        });
      }
    }
    const count = [...actual.values()].reduce((sum, value) => sum + value, 0);
    if (count > 0) {
      warnings.push({
        token: entry.token,
        count,
        firstPath: actual.keys().next().value,
        reason: entry.reason,
      });
    }
  }

  findings.sort(
    (a, b) =>
      String(a.path).localeCompare(String(b.path)) ||
      String(a.token).localeCompare(String(b.token)) ||
      String(a.code).localeCompare(String(b.code)),
  );
  warnings.sort((a, b) => a.token.localeCompare(b.token));
  return { ok: findings.length === 0, findings, groups, warnings, documents: normalized };
}

/** Validate exactly the owned staged artifacts, never validation-only stage files. */
export async function validateCompatibilityItems(items, policy) {
  const documents = await collectCompatibilityDocuments(items, policy);
  return scanCompatibilityDocuments(documents, policy, { enforceAllowanceCompleteness: true });
}

/** Stable stdout block used unchanged in --check, --dry-run, and --write. */
export function formatCompatibilityReport(result) {
  const lines = [
    "[REPORT] Claude-ism stale report (informational; rg commands run from repository root)",
  ];
  for (const group of result.groups) {
    lines.push(
      `[REPORT] group=${group.id} count=${group.count} first=${group.firstPath ?? "none"}`,
      `[REPORT] rg[${group.id}]=${group.rgCommand}`,
    );
  }
  for (const warning of result.warnings) {
    lines.push(
      `[REPORT] retained=${warning.token} classification=WARN count=${warning.count} ` +
        `first=${warning.firstPath} reason=${warning.reason}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
