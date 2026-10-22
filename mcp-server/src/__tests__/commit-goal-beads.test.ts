import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "..", "..", "scripts", "commit-goal-beads.mjs");
const LABEL = "flywheel-goal:test-goal:12345678";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function line(id: string, title: string, labels: string[] = []): string {
  return JSON.stringify({ id, title, status: "open", labels });
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "commit-goal-beads-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(path.join(dir, ".beads"));
  writeFileSync(path.join(dir, ".beads/issues.jsonl"), [line("a", "A old", [LABEL]), line("b", "B old")].join("\n") + "\n");
  writeFileSync(path.join(dir, "plan.md"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("scripts/commit-goal-beads.mjs", () => {
  it("commits only the goal's bead lines and leaves other agents' lines in the working file", () => {
    const dir = repo();
    const work = [line("a", "A new", [LABEL]), line("b", "B other agent"), line("c", "C new", [LABEL])].join("\n") + "\n";
    writeFileSync(path.join(dir, ".beads/issues.jsonl"), work);
    writeFileSync(path.join(dir, "plan.md"), "v2\n");

    const out = execFileSync("node", [SCRIPT, "-m", "beads: goal", "--label", LABEL, "--also", "plan.md"], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(out).toContain("committed beads: a, c");
    expect(out).toContain("left uncommitted (other goals): b");
    const committed = git(dir, "show", "HEAD:.beads/issues.jsonl");
    expect(committed).toContain("A new");
    expect(committed).toContain("C new");
    expect(committed).toContain("B old");
    expect(committed).not.toContain("B other agent");
    expect(git(dir, "show", "HEAD:plan.md")).toBe("v2");
    expect(readFileSync(path.join(dir, ".beads/issues.jsonl"), "utf8")).toBe(work);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    expect(git(dir, "status", "--porcelain")).toBe("M .beads/issues.jsonl");
  });

  it("refuses when the bead file is staged in the shared index", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".beads/issues.jsonl"), line("a", "A staged", [LABEL]) + "\n");
    git(dir, "add", ".beads/issues.jsonl");
    let status = 0;
    try {
      execFileSync("node", [SCRIPT, "-m", "x", "--label", LABEL], { cwd: dir, stdio: "pipe" });
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(3);
  });
});
