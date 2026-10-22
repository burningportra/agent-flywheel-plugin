#!/usr/bin/env node
// Interleaved A/B benchmark for `npm run lint:skill`.
//
// usage: node scripts/bench-lint-skill.mjs [baseline-ref] [runs]
//   baseline-ref  git ref whose committed mcp-server/dist/ is the baseline (default HEAD)
//   runs          timed runs per side (default 30)
//
// The candidate is this checkout's dist/, so build it first. The baseline runs
// from a temporary detached worktree at <baseline-ref> with this checkout's
// tracked changes outside mcp-server/dist/ applied on top, plus its untracked
// files under skills/. lint-skill-dir resolves the repo root from its own path
// and reads the registry, manifest and tone baseline from there, so this is what
// keeps everything but the compiled lint code identical between the two sides.
//
// Sides alternate order every run so machine load hits both equally. Prints
// median and p95 wall-clock and exits 1 when the two disagree on exit code,
// stdout or stderr (golden parity) after each side's repo root becomes <repo>.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const [baseRef = "HEAD", runsArg = "30"] = process.argv.slice(2);
const runs = Number(runsArg);
if (!Number.isInteger(runs) || runs < 1) {
  process.stderr.write("usage: bench-lint-skill.mjs [baseline-ref] [runs]\n");
  process.exit(2);
}

const candMcp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candRepo = path.dirname(candMcp);
// Same argv as the lint:skill script in package.json, run from each side's mcp-server/.
const args = ["dist/scripts/lint-skill-dir.js", "--dir", "../skills/start", "--baseline", ".lintskill-baseline.json"];

function git(cwd, gitArgs, input) {
  const r = spawnSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8", input, timeout: 120_000, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bench-lint-skill-")));
const baseRepo = path.join(tmp, "repo");
const baseMcp = path.join(baseRepo, "mcp-server");

function cleanup() {
  spawnSync("git", ["-C", candRepo, "worktree", "remove", "--force", baseRepo], { timeout: 120_000 });
  rmSync(tmp, { recursive: true, force: true });
}

function prepareBaseline() {
  git(candRepo, ["worktree", "add", "--detach", baseRepo, baseRef]);
  const patch = git(candRepo, ["diff", "--binary", baseRef, "--", ".", ":(exclude)mcp-server/dist"]);
  if (patch) git(baseRepo, ["apply", "--binary", "--whitespace=nowarn"], patch);
  const untracked = git(candRepo, ["ls-files", "--others", "--exclude-standard", "--", "skills"]).split("\n").filter(Boolean);
  for (const rel of untracked) {
    mkdirSync(path.dirname(path.join(baseRepo, rel)), { recursive: true });
    copyFileSync(path.join(candRepo, rel), path.join(baseRepo, rel));
  }
  symlinkSync(path.join(candMcp, "node_modules"), path.join(baseMcp, "node_modules"), "dir");
}

function once(mcpDir, repoDir) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, {
    cwd: mcpDir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, GITHUB_ACTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const norm = (s) => (s ?? "").split(repoDir).join("<repo>");
  return { ms, status: r.status, out: norm(r.stdout), err: norm(r.stderr) };
}

const quantile = (xs, p) => {
  const s = [...xs].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};

const firstDiff = (p, q) => {
  const pl = p.split("\n");
  const ql = q.split("\n");
  const i = pl.findIndex((line, k) => line !== ql[k]);
  const at = i === -1 ? pl.length : i;
  return `line ${at + 1}\n    base: ${pl[at] ?? "<eof>"}\n    cand: ${ql[at] ?? "<eof>"}`;
};

let code = 0;
try {
  prepareBaseline();
  const base = () => once(baseMcp, baseRepo);
  const cand = () => once(candMcp, candRepo);
  base();
  cand();
  const a = [];
  const b = [];
  let first = null;
  let mismatch = null;
  for (let i = 0; i < runs; i++) {
    let ra;
    let rb;
    if (i % 2 === 0) {
      ra = base();
      rb = cand();
    } else {
      rb = cand();
      ra = base();
    }
    a.push(ra.ms);
    b.push(rb.ms);
    first ??= ra;
    if (!mismatch && (ra.status !== rb.status || ra.out !== rb.out || ra.err !== rb.err)) {
      mismatch = { run: i, base: ra, cand: rb };
    }
  }
  const ma = quantile(a, 0.5);
  const mb = quantile(b, 0.5);
  const sha = git(candRepo, ["rev-parse", "--short", baseRef]).trim();
  process.stdout.write(
    `baseline  ${baseRef} (${sha}) dist/  median ${ma.toFixed(0)}ms p95 ${quantile(a, 0.95).toFixed(0)}ms\n` +
      `candidate working tree dist/ median ${mb.toFixed(0)}ms p95 ${quantile(b, 0.95).toFixed(0)}ms\n` +
      `speedup   ${(((ma - mb) / ma) * 100).toFixed(1)}% of median (runs=${runs}, lint exit ${first.status})\n` +
      `parity    ${mismatch ? `MISMATCH at run ${mismatch.run}` : "identical exit/stdout/stderr"}\n`,
  );
  if (mismatch) {
    const { base: x, cand: y } = mismatch;
    process.stdout.write(`  exit   ${x.status} vs ${y.status}\n`);
    if (x.out !== y.out) process.stdout.write(`  stdout ${x.out.length}B vs ${y.out.length}B, first diff at ${firstDiff(x.out, y.out)}\n`);
    if (x.err !== y.err) process.stdout.write(`  stderr ${x.err.length}B vs ${y.err.length}B, first diff at ${firstDiff(x.err, y.err)}\n`);
    code = 1;
  }
} catch (err) {
  process.stderr.write(`bench-lint-skill: ${err instanceof Error ? err.message : String(err)}\n`);
  code = 2;
} finally {
  cleanup();
}
process.exit(code);
