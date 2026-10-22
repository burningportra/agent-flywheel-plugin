#!/usr/bin/env node
// Commit only one goal's beads from .beads/issues.jsonl in a shared checkout.
//
// `br` rewrites the whole JSONL file, so a plain `git commit -- .beads/issues.jsonl`
// also commits every other agent's uncommitted bead changes. This script builds
// the file from HEAD's copy plus only the lines whose bead carries the goal
// label, commits it through a temporary index (the shared index is never
// touched), and moves HEAD with a compare-and-swap, retrying when another agent
// commits in between. Other agents' lines stay uncommitted in the working file.
//
// Usage:
//   node scripts/commit-goal-beads.mjs -m "<message>" [--label <goal-label>] [--also <path>]... [--cwd <repo>]
//
// --label defaults to the current goal's label, computed from
// .pi-flywheel/checkpoint.json selectedGoal. --also adds other files as they
// are on disk (for example the plan the beads came from). Commits made here
// skip git hooks, like any `git commit-tree`.
//
// Exit codes: 0 committed or nothing to commit, 2 bad usage or setup,
// 3 the bead file is staged in the shared index, 4 HEAD kept moving.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BEADS = ".beads/issues.jsonl";
const ATTEMPTS = 6;

function parseArgs(argv) {
  const out = { also: [], cwd: process.cwd(), label: null, message: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m" || a === "--message") out.message = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--also") out.also.push(argv[++i]);
    else if (a === "--cwd") out.cwd = argv[++i];
    else fail(2, `unknown argument: ${a}`);
  }
  if (!out.message) fail(2, "missing -m <message>");
  return out;
}

function fail(code, msg) {
  console.error(`commit-goal-beads: ${msg}`);
  process.exit(code);
}

function git(cwd, args, { input, env } = {}) {
  // Real bead exports pass 1 MB, the execFileSync default buffer.
  return execFileSync("git", args, { cwd, input, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();
}

async function defaultLabel(cwd) {
  const checkpoint = path.join(cwd, ".pi-flywheel", "checkpoint.json");
  if (!existsSync(checkpoint)) fail(2, "no --label and no .pi-flywheel/checkpoint.json");
  const raw = JSON.parse(readFileSync(checkpoint, "utf8"));
  const goal = (raw.state ?? raw).selectedGoal;
  if (!goal) fail(2, "no --label and the checkpoint has no selectedGoal");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mod = path.join(here, "..", "mcp-server", "dist", "tools", "bead-program.js");
  const { goalBeadProgramLabel } = await import(pathToFileURL(mod).href);
  return goalBeadProgramLabel(goal);
}

function rows(text) {
  return text.split("\n").filter((l) => l.trim()).map((line) => {
    const bead = JSON.parse(line);
    return { id: bead.id, labels: bead.labels ?? [], line };
  });
}

function buildBeadFile(headText, workText, label) {
  const work = rows(workText);
  const mine = new Map(work.filter((r) => r.labels.includes(label)).map((r) => [r.id, r.line]));
  const out = [];
  const seen = new Set();
  for (const r of rows(headText)) {
    seen.add(r.id);
    out.push(mine.get(r.id) ?? r.line);
  }
  for (const [id, line] of mine) if (!seen.has(id)) out.push(line);
  const headLines = new Set(rows(headText).map((r) => r.line));
  const committed = [...mine].filter(([, line]) => !headLines.has(line)).map(([id]) => id);
  const leftOut = work.filter((r) => !mine.has(r.id) && !headLines.has(r.line)).map((r) => r.id);
  return { text: out.join("\n") + "\n", committed, leftOut };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = git(args.cwd, ["rev-parse", "--show-toplevel"]);
  const label = args.label ?? (await defaultLabel(cwd));
  const paths = [BEADS, ...args.also];
  if (git(cwd, ["diff", "--cached", "--name-only", "--", BEADS])) {
    fail(3, `${BEADS} is staged in the shared index; leave it to whoever staged it`);
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const oldHead = git(cwd, ["rev-parse", "HEAD"]);
    const headText = git(cwd, ["show", `HEAD:${BEADS}`]);
    const workText = readFileSync(path.join(cwd, BEADS), "utf8");
    const built = buildBeadFile(headText, workText, label);
    const alsoChanged = args.also.filter((p) => git(cwd, ["diff", "--name-only", "HEAD", "--", p]) || !git(cwd, ["ls-files", "--", p]));
    if (built.committed.length === 0 && alsoChanged.length === 0) {
      console.log(`nothing to commit for ${label}`);
      return;
    }

    const tmp = mkdtempSync(path.join(tmpdir(), "commit-goal-beads-"));
    let commit;
    try {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
      git(cwd, ["read-tree", "HEAD"], { env });
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: built.text });
      git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${BEADS}`], { env });
      for (const p of args.also) git(cwd, ["update-index", "--add", "--", p], { env });
      const tree = git(cwd, ["write-tree"], { env });
      commit = git(cwd, ["commit-tree", tree, "-p", oldHead, "-m", args.message]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    try {
      git(cwd, ["update-ref", "-m", `commit-goal-beads: ${args.message}`, "HEAD", commit, oldHead]);
    } catch {
      continue;
    }
    git(cwd, ["reset", "-q", "--", ...paths]);
    console.log(`${commit.slice(0, 8)} ${args.message}`);
    console.log(`committed beads: ${built.committed.join(", ") || "(none)"}`);
    if (built.leftOut.length) console.log(`left uncommitted (other goals): ${built.leftOut.join(", ")}`);
    return;
  }
  fail(4, `HEAD moved on each of ${ATTEMPTS} attempts; try again`);
}

main().catch((err) => fail(2, err instanceof Error ? err.message : String(err)));
