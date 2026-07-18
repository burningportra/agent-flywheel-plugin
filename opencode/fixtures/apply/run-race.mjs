#!/usr/bin/env node

/**
 * Race fixture for bead claude-2lkr — the single-writer lock must admit exactly
 * one winner under genuine contention.
 *
 * Regression target: the pre-fix acquireLock used mkdir(lockDir) as the gate but
 * wrote meta.json a step later, so two concurrent acquirers could BOTH observe
 * an EEXIST lock dir with meta.json not-yet-written, BOTH treat it as a stale
 * lock, BOTH reclaim it, and BOTH acquire — a double-acquire that defeats the
 * transaction's single-writer guarantee. The fix makes the O_EXCL create of
 * meta.json the atomic claim (owner pid stamped in the same syscall), so a loser
 * can always PID-check the holder.
 *
 * The fixture is deterministic, not timing-dependent: each round two child
 * processes rendezvous on a filesystem barrier (both write a ready marker, both
 * spin until they see the pair), THEN race acquireLock at the same instant. The
 * kernel serialises the O_EXCL create so exactly one child wins; the winner holds
 * the lock long enough that the loser's PID-check always sees a live foreign
 * owner and exits with the lock-contract code (2). Run against the pre-fix code
 * this asserts fails (two winners); against the fix it passes 20/20.
 *
 * Modes:
 *   (default)            harness: 20 contended rounds + stale/foreign unit checks
 *   --worker <stateDir>  one contender (self-spawned by the harness)
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLock, pidAlive, releaseLock, stateDirFor } from "../../../scripts/opencode/apply.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROUNDS = 20;
const BARRIER_PARTIES = 2;
const BARRIER_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sink = { write: () => true };

/** Spin until `barrierDir` holds at least `parties` files with `prefix`. */
async function waitForParties(barrierDir, prefix, parties) {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  for (;;) {
    const seen = (await readdir(barrierDir)).filter((name) => name.startsWith(prefix));
    if (seen.length >= parties) return true;
    if (Date.now() > deadline) return false;
    await sleep(2);
  }
}

// ── worker: one contender ────────────────────────────────────────────────────
async function runWorker(stateDir) {
  const barrierDir = path.join(stateDir, ".race-barrier");
  await mkdir(barrierDir, { recursive: true });
  await writeFile(path.join(barrierDir, `ready-${process.pid}`), "1");

  // Rendezvous 1: proceed only once every party is ready, so both contenders
  // enter acquireLock at the same instant and genuinely race the claim.
  if (!(await waitForParties(barrierDir, "ready-", BARRIER_PARTIES))) {
    process.stderr.write("barrier timeout (ready)\n");
    process.exit(4);
  }

  let outcome;
  let handle = null;
  try {
    handle = await acquireLock(stateDir, {
      output: sink,
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
    });
    outcome = "won";
  } catch (error) {
    outcome = error?.exitCode === 2 ? "lost" : "err";
    if (outcome === "err") process.stderr.write(`ERR ${error?.message ?? String(error)}\n`);
  }

  // Record that we resolved our claim. The winner then holds the lock until the
  // loser has ALSO attempted (rendezvous 2), so the loser's PID-check is
  // guaranteed to observe a live foreign owner — the single-winner assertion is
  // deterministic, never a timing race on a fixed hold.
  await writeFile(path.join(barrierDir, `attempted-${process.pid}`), outcome);
  if (outcome === "won") {
    await waitForParties(barrierDir, "attempted-", BARRIER_PARTIES);
    await releaseLock(handle);
    process.stdout.write("WON\n");
    process.exit(0);
  }
  process.stdout.write(outcome === "lost" ? "LOST\n" : "ERR\n");
  process.exit(outcome === "lost" ? 2 : 3);
}

// ── harness: spawn contenders and assert exactly one winner ──────────────────
function spawnContender(stateDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HERE, "--worker", stateDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

async function runHarness() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "agent-flywheel-lock-race-"));
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const configDir = path.join(sandbox, `round-${round}`);
      const stateDir = stateDirFor(configDir);
      // Start both contenders as close together as possible; the barrier inside
      // each worker turns that into a true simultaneous claim.
      const results = await Promise.all([spawnContender(stateDir), spawnContender(stateDir)]);

      const winners = results.filter((r) => r.code === 0);
      const losers = results.filter((r) => r.code === 2);
      const detail = results.map((r) => `code=${r.code} out=${r.out || "-"} err=${r.err || "-"}`).join(" | ");
      assert.equal(winners.length, 1, `round ${round}: expected exactly one winner, got ${winners.length} — ${detail}`);
      assert.equal(losers.length, 1, `round ${round}: expected exactly one loser (exit 2), got ${losers.length} — ${detail}`);
      assert.equal(winners[0].out, "WON", `round ${round}: winner did not report WON — ${detail}`);
      assert.equal(losers[0].out, "LOST", `round ${round}: loser did not report LOST — ${detail}`);
    }

    // ── stale (dead-owner) lock is still reclaimed with a WARN ────────────────
    {
      const stateDir = stateDirFor(path.join(sandbox, "stale"));
      const dead = deadPid();
      assert.equal(pidAlive(dead), false, "spawned-and-reaped pid is dead");
      await mkdir(path.join(stateDir, "lock"), { recursive: true });
      await writeFile(path.join(stateDir, "lock", "meta.json"), JSON.stringify({ pid: dead }));
      const warn = capture();
      const handle = await acquireLock(stateDir, {
        output: warn.stream,
        ownerPid: process.pid,
        startedAt: new Date().toISOString(),
      });
      assert.ok(handle?.lockDir, "stale dead-owner lock is reclaimed and acquired");
      assert.match(warn.read(), /^\[WARN\] reclaiming stale sync lock/m, "stale reclaim still emits the WARN");
      await releaseLock(handle);
    }

    // ── a live foreign owner is still rejected with exit 2 ────────────────────
    {
      const stateDir = stateDirFor(path.join(sandbox, "foreign"));
      const held = await acquireLock(stateDir, {
        output: sink,
        ownerPid: process.pid,
        startedAt: new Date().toISOString(),
      });
      await assert.rejects(
        () =>
          acquireLock(stateDir, {
            output: sink,
            ownerPid: process.pid + 1,
            startedAt: new Date().toISOString(),
          }),
        (error) => error?.exitCode === 2 && /already running/.test(error.message),
        "a live foreign owner is rejected with exit 2",
      );
      await releaseLock(held);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }

  process.stdout.write(`[OK] lock race fixture: ${ROUNDS}/${ROUNDS} single-winner rounds + stale reclaim + foreign reject\n`);
}

/** A PID guaranteed dead: spawnSync waits for the child to exit and reap. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

function capture() {
  let value = "";
  return { stream: { write: (chunk) => ((value += String(chunk)), true) }, read: () => value };
}

const workerIndex = process.argv.indexOf("--worker");
if (workerIndex !== -1) {
  await runWorker(process.argv[workerIndex + 1]);
} else {
  await runHarness();
}
