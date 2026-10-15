import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const mcpServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(mcpServerRoot, "scripts", "team-drain.sh");

function writeTeam(root: string, name: string, members: Array<Record<string, unknown>>): string {
  const teamDir = path.join(root, name);
  mkdirSync(teamDir, { recursive: true });
  const configPath = path.join(teamDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ name, members }, null, 2)}\n`, "utf8");
  return configPath;
}

describe("team-drain.sh", () => {
  let teamsDir: string;

  beforeEach(() => {
    teamsDir = mkdtempSync(path.join(tmpdir(), "team-drain-"));
  });

  afterEach(() => {
    rmSync(teamsDir, { recursive: true, force: true });
  });

  it("retains only team-lead and prints each TeamDelete target", () => {
    const alpha = writeTeam(teamsDir, "alpha", [
      { name: "team-lead", agentId: "lead-a" },
      { name: "worker-a", agentId: "worker-a" },
    ]);
    const beta = writeTeam(teamsDir, "beta", [
      { name: "worker-b", agentId: "worker-b" },
      { name: "team-lead", agentId: "lead-b" },
    ]);
    const active = writeTeam(teamsDir, "active-elsewhere", [
      { name: "team-lead", agentId: "lead-active" },
      { name: "worker-active", agentId: "worker-active" },
    ]);

    const result = spawnSync("/bin/sh", [scriptPath, "alpha", "beta"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_TEAMS_DIR: teamsDir },
    });

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trim().split("\n").sort()).toEqual(["alpha", "beta"]);
    expect(JSON.parse(readFileSync(alpha, "utf8")).members).toEqual([
      { name: "team-lead", agentId: "lead-a" },
    ]);
    expect(JSON.parse(readFileSync(beta, "utf8")).members).toEqual([
      { name: "team-lead", agentId: "lead-b" },
    ]);
    expect(JSON.parse(readFileSync(active, "utf8")).members).toEqual([
      { name: "team-lead", agentId: "lead-active" },
      { name: "worker-active", agentId: "worker-active" },
    ]);
  });

  it("leaves a malformed config unchanged and removes its temporary file", () => {
    const teamDir = path.join(teamsDir, "broken");
    mkdirSync(teamDir);
    const configPath = path.join(teamDir, "config.json");
    writeFileSync(configPath, "{not-json\n", "utf8");

    const result = spawnSync("/bin/sh", [scriptPath, "broken"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_TEAMS_DIR: teamsDir },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe("{not-json\n");
    expect(readdirSync(teamDir)).toEqual(["config.json"]);
  });

  it("exits cleanly when no teams directory exists", () => {
    const missing = path.join(teamsDir, "missing");
    const result = spawnSync("/bin/sh", [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_TEAMS_DIR: missing },
    });

    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
});
