import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MCP_ROOT = "/Volumes/1tb/Projects/claude-orchestrator/mcp-server";
const CLI = join(MCP_ROOT, "dist", "scripts", "lint-skill.js");
const SKILL = "../skills/orchestrate/SKILL.md";

describe("live-orchestrate canary", () => {
  it("CLI build artifact exists", () => {
    expect(existsSync(CLI)).toBe(true);
  });

  it("baseline file exists and is valid JSON with rulesetVersion", () => {
    const r = spawnSync(
      "node",
      [
        "-e",
        "const j = require('./.lintskill-baseline.json'); process.stdout.write(JSON.stringify({ s: j.schemaVersion, r: j.rulesetVersion, n: j.entries.length }))",
      ],
      { cwd: MCP_ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.s).toBe(1);
    expect(summary.r).toBe(1);
    expect(summary.n).toBeGreaterThanOrEqual(0);
  });

  it("manifest file exists and lists at least one skill", () => {
    const r = spawnSync(
      "node",
      [
        "-e",
        "const j = require('./.lintskill-manifest.json'); process.stdout.write(String(j.skills.length))",
      ],
      { cwd: MCP_ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(parseInt(r.stdout, 10)).toBeGreaterThan(0);
  });

  it("lint-skill --ci --baseline against real SKILL.md exits 0", () => {
    const r = spawnSync(
      "node",
      [
        CLI,
        "--file",
        SKILL,
        "--ci",
        "--baseline",
        ".lintskill-baseline.json",
        "--format",
        "json",
      ],
      { cwd: MCP_ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.summary.errors).toBe(0);
  });
});
