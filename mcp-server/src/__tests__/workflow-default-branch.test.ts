import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const WORKFLOWS_ROOT = join(REPO_ROOT, ".github", "workflows");
const DEFAULT_BRANCH = "main";

type BranchEvent = "push" | "pull_request";

type BranchFilter =
  | { kind: "branches"; patterns: string[] }
  | { kind: "branches-ignore"; patterns: string[] };

interface BranchExclusion {
  file: string;
  event: BranchEvent;
  filter: BranchFilter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflow(source: string): Record<string, unknown> {
  const value: unknown = parse(source);
  if (!isRecord(value)) throw new Error("workflow root must be a mapping");
  return value;
}

function parsePatterns(value: unknown, label: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error(`${label} must be a string or string array`);
}

function escapeRegexLiteral(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function githubPatternMatches(value: string, pattern: string): boolean {
  const atoms: string[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "\\" && index + 1 < pattern.length) {
      index += 1;
      atoms.push(escapeRegexLiteral(pattern[index] ?? ""));
      continue;
    }
    if (character === "*" && pattern[index + 1] === "*") {
      atoms.push(".*");
      index += 1;
      continue;
    }
    if (character === "*") {
      atoms.push("[^/]*");
      continue;
    }
    if (character === "?" || character === "+") {
      const previous = atoms.pop();
      if (previous === undefined) {
        atoms.push(escapeRegexLiteral(character));
      } else {
        atoms.push(`(?:${previous})${character}`);
      }
      continue;
    }
    if (character === "[") {
      const closingBracket = pattern.indexOf("]", index + 1);
      if (closingBracket !== -1) {
        const range = pattern.slice(index + 1, closingBracket);
        if (/^[A-Za-z0-9-]+$/.test(range)) {
          atoms.push(`[${range}]`);
          index = closingBracket;
          continue;
        }
      }
    }
    atoms.push(escapeRegexLiteral(character));
  }
  return new RegExp(`^${atoms.join("")}$`).test(value);
}

function patternMatchesMain(rawPattern: string): boolean {
  const pattern = rawPattern.startsWith("!") ? rawPattern.slice(1) : rawPattern;
  return githubPatternMatches(DEFAULT_BRANCH, pattern);
}

function includePatternsMatchMain(patterns: string[]): boolean {
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    if (patternMatchesMain(rawPattern)) included = !excluded;
  }
  return included;
}

function ignorePatternsMatchMain(patterns: string[]): boolean {
  return patterns.some(patternMatchesMain);
}

function findMainBranchExclusions(file: string, source: string): BranchExclusion[] {
  const workflow = parseWorkflow(source);
  const triggers = workflow.on;
  if (!isRecord(triggers)) return [];

  const findings: BranchExclusion[] = [];
  const events: BranchEvent[] = ["push", "pull_request"];
  for (const event of events) {
    const configuration = triggers[event];
    if (!isRecord(configuration)) continue;

    if (Object.prototype.hasOwnProperty.call(configuration, "branches")) {
      const patterns = parsePatterns(configuration.branches, `${file} on.${event}.branches`);
      if (!includePatternsMatchMain(patterns)) {
        findings.push({ file, event, filter: { kind: "branches", patterns } });
      }
    }

    if (Object.prototype.hasOwnProperty.call(configuration, "branches-ignore")) {
      const patterns = parsePatterns(
        configuration["branches-ignore"],
        `${file} on.${event}.branches-ignore`,
      );
      if (ignorePatternsMatchMain(patterns)) {
        findings.push({ file, event, filter: { kind: "branches-ignore", patterns } });
      }
    }
  }
  return findings;
}

function triggerNames(source: string): string[] {
  const triggers = parseWorkflow(source).on;
  if (typeof triggers === "string") return [triggers];
  if (Array.isArray(triggers)) {
    return triggers.filter((trigger): trigger is string => typeof trigger === "string");
  }
  if (isRecord(triggers)) return Object.keys(triggers);
  return [];
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_ROOT)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => join(WORKFLOWS_ROOT, file));
}

describe("workflow default-branch triggers", () => {
  it("flags planted master-only push and pull-request filters", () => {
    const source = [
      "name: fixture",
      "on:",
      "  push:",
      "    branches: [master]",
      "  pull_request:",
      "    branches:",
      "      - master",
    ].join("\n");

    expect(findMainBranchExclusions("fixture.yml", source)).toEqual([
      {
        file: "fixture.yml",
        event: "push",
        filter: { kind: "branches", patterns: ["master"] },
      },
      {
        file: "fixture.yml",
        event: "pull_request",
        filter: { kind: "branches", patterns: ["master"] },
      },
    ]);
  });

  it("accepts unrestricted triggers and ordered patterns that include main", () => {
    const source = [
      "on:",
      "  push:",
      "    branches: ['*', '!main', 'main']",
      "  pull_request:",
    ].join("\n");

    expect(findMainBranchExclusions("fixture.yml", source)).toEqual([]);
  });

  it("uses GitHub's optional and repetition branch-pattern operators", () => {
    const source = [
      "on:",
      "  push:",
      "    branches: ['main?']",
      "  pull_request:",
      "    branches: ['mai+n']",
    ].join("\n");

    expect(findMainBranchExclusions("fixture.yml", source)).toEqual([]);
  });

  it("flags branches-ignore when it matches main", () => {
    const source = [
      "on:",
      "  push:",
      "    branches-ignore: [main, 'release/**']",
    ].join("\n");

    expect(findMainBranchExclusions("fixture.yml", source)).toEqual([
      {
        file: "fixture.yml",
        event: "push",
        filter: { kind: "branches-ignore", patterns: ["main", "release/**"] },
      },
    ]);
  });

  it("applies GitHub's optional operator to branches-ignore", () => {
    const source = [
      "on:",
      "  pull_request:",
      "    branches-ignore: ['main?']",
    ].join("\n");

    expect(findMainBranchExclusions("fixture.yml", source)).toEqual([
      {
        file: "fixture.yml",
        event: "pull_request",
        filter: { kind: "branches-ignore", patterns: ["main?"] },
      },
    ]);
  });

  it("keeps every workflow branch filter compatible with main", () => {
    const findings = workflowFiles().flatMap((filePath) => {
      const file = relative(REPO_ROOT, filePath).split(sep).join("/");
      return findMainBranchExclusions(file, readFileSync(filePath, "utf8"));
    });

    expect(findings).toEqual([]);
  });

  it("keeps CI manually dispatchable", () => {
    const ci = readFileSync(join(WORKFLOWS_ROOT, "ci.yml"), "utf8");
    expect(triggerNames(ci)).toContain("workflow_dispatch");
  });
});
