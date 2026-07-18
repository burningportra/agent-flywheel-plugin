#!/usr/bin/env node

/**
 * Acceptance harness for bead claude-25tj — ledger, lock, transactional apply,
 * and recovery. Every scenario runs in a throwaway temp config dir; the live
 * ~/.config/opencode is never touched.
 *
 * Coverage (mirrors the brief's acceptance list):
 *  1. concurrent invocation rejected (exit 2), then succeeds once released;
 *     stale (dead-owner) lock is reclaimed with a WARN.
 *  2. local edit to a managed file → [LOCAL] label + durable backup, unmanaged
 *     siblings byte-identical.
 *  3. forced failure after each commit step (journal|backup|rename|ledger) →
 *     prior tree restored, exit 1, journal + lock cleared.
 *  4. simulated hard-kill journal → next invocation recovers ([RECOVER]): an
 *     uncommitted journal rolls back to pre-apply bytes (4, 4b), while a
 *     committed journal — a crash between the ledger write and removeJournal —
 *     keeps the applied tree instead of rolling it back (4c integration, 4d unit).
 *  5. second --write after a clean apply reports zero owned-path writes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../../../scripts/opencode/sync.mjs";
import {
  acquireLock,
  pidAlive,
  readLedger,
  recoverState,
  releaseLock,
  stateDirFor,
} from "../../../scripts/opencode/apply.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function capture() {
  let value = "";
  return { stream: { write: (chunk) => ((value += String(chunk)), true) }, read: () => value };
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function invoke(modeArgs, configDir, extraEnv = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await run({
    argv: [...modeArgs, "--config-dir", configDir],
    repoRoot: REPO_ROOT,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { HOME: configDir, PATH: process.env.PATH ?? "", ...extraEnv },
    debugProbe: () => ({ configDir, warning: undefined }),
  });
  return { exitCode, stdout: stdout.read(), stderr: stderr.read() };
}

/** A PID that is guaranteed dead: spawnSync waits for the child to exit + reap. */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

/** First managed file (type 'file') recorded in the ledger after an apply. */
async function firstManagedFile(configDir) {
  const ledger = await readLedger(stateDirFor(configDir));
  const key = Object.keys(ledger.entries).find((k) => ledger.entries[k].type === "file");
  assert.ok(key, "an installed managed file exists in the ledger");
  return { relTarget: key, absTarget: path.join(configDir, key) };
}

async function containsInTree(root, needle) {
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) return true;
      } else if (entry.isFile()) {
        const content = await readFile(full, "utf8").catch(() => "");
        if (content.includes(needle)) return true;
      }
    }
    return false;
  };
  return walk(root);
}

const sandbox = await mkdtemp(path.join(tmpdir(), "agent-flywheel-apply-acceptance-"));
try {
  // ── 1. lock semantics (direct) ────────────────────────────────────────────
  {
    const stateDir = stateDirFor(path.join(sandbox, "lock-direct"));
    const out = capture();
    const startedAt = "2026-07-18T00:00:00.000Z";
    const held = await acquireLock(stateDir, { output: out.stream, ownerPid: process.pid, startedAt });
    assert.ok(held?.lockDir, "lock acquired");
    await assert.rejects(
      () => acquireLock(stateDir, { output: out.stream, ownerPid: 987654, startedAt }),
      (error) => error?.exitCode === 2 && /already running/.test(error.message),
      "a live foreign owner rejects with exit 2",
    );
    await releaseLock(held);
    const reacquired = await acquireLock(stateDir, {
      output: out.stream,
      ownerPid: 987654,
      startedAt,
    });
    assert.ok(reacquired?.lockDir, "lock is acquirable again once released");
    await releaseLock(reacquired);

    // Stale (dead-owner) lock is reclaimed with a WARN.
    const dead = deadPid();
    assert.equal(pidAlive(dead), false, "spawned-and-reaped pid is dead");
    const reclaimOut = capture();
    const lockDir = path.join(stateDir, "lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "meta.json"), JSON.stringify({ pid: dead }));
    const reclaimed = await acquireLock(stateDir, {
      output: reclaimOut.stream,
      ownerPid: process.pid,
      startedAt,
    });
    assert.match(reclaimOut.read(), /^\[WARN\] reclaiming stale sync lock/m, "stale lock reclaimed with WARN");
    await releaseLock(reclaimed);
  }

  // ── 1b. lock semantics (integration through run --write) ───────────────────
  {
    const configDir = path.join(sandbox, "lock-run");
    const stateDir = stateDirFor(configDir);
    await mkdir(path.join(stateDir, "lock"), { recursive: true });
    await writeFile(path.join(stateDir, "lock", "meta.json"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(
      () => invoke(["--write"], configDir, { FW_SYNC_PID: "987654" }),
      (error) => error?.exitCode === 2,
      "run --write rejects while a live lock is held",
    );
    await rm(path.join(stateDir, "lock"), { recursive: true, force: true });
    const second = await invoke(["--write"], configDir);
    assert.equal(second.exitCode, 0, "run --write succeeds once the lock is released");
    assert.match(second.stdout, /^\[OK\] OpenCode port is in sync\.$/m);
  }

  // ── 2. local edit → [LOCAL] + backup; unmanaged sibling untouched ──────────
  {
    const configDir = path.join(sandbox, "local-edit");
    const first = await invoke(["--write"], configDir);
    assert.equal(first.exitCode, 0, "initial apply succeeds");

    const sibling = path.join(configDir, "commands", "my-unmanaged-note.md");
    await mkdir(path.dirname(sibling), { recursive: true });
    await writeFile(sibling, "keep me exactly as-is\n");
    const siblingBytes = await readFile(sibling);

    const managed = await firstManagedFile(configDir);
    const sourceBytes = await readFile(managed.absTarget);
    await writeFile(managed.absTarget, `${sourceBytes.toString("utf8")}\n// LOCAL EDIT MARKER\n`);

    const second = await invoke(["--write"], configDir);
    assert.equal(second.exitCode, 0, "apply over a local edit succeeds");
    assert.match(
      second.stdout,
      new RegExp(`^\\[LOCAL\\] ${managed.relTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
      "the locally-edited managed file is labelled [LOCAL]",
    );
    assert.ok(
      await containsInTree(path.join(stateDirFor(configDir), "backups"), "LOCAL EDIT MARKER"),
      "the local edit is preserved in a durable backup before overwrite",
    );
    assert.ok(
      (await readFile(managed.absTarget)).equals(sourceBytes),
      "the managed file is restored to the rendered source bytes",
    );
    assert.ok(
      (await readFile(sibling)).equals(siblingBytes),
      "the unmanaged sibling is byte-identical",
    );
  }

  // ── 3. forced failure after each commit step → rollback, exit 1 ────────────
  for (const step of ["journal", "backup", "rename", "ledger"]) {
    const configDir = path.join(sandbox, `fail-${step}`);
    assert.equal((await invoke(["--write"], configDir)).exitCode, 0, `${step}: clean apply`);

    const sibling = path.join(configDir, "commands", "keep.md");
    await mkdir(path.dirname(sibling), { recursive: true });
    await writeFile(sibling, "sibling stays\n");

    const managed = await firstManagedFile(configDir);
    const pendingBytes = `${(await readFile(managed.absTarget)).toString("utf8")}\n// PENDING LOCAL\n`;
    await writeFile(managed.absTarget, pendingBytes);

    await assert.rejects(
      () => invoke(["--write"], configDir, { FW_SYNC_FAIL_AFTER: step }),
      (error) => error?.exitCode === 1,
      `${step}: injected failure exits 1`,
    );
    assert.equal(
      await readFile(managed.absTarget, "utf8"),
      pendingBytes,
      `${step}: the pre-write (edited) bytes are restored on rollback`,
    );
    assert.equal(
      await readFile(sibling, "utf8"),
      "sibling stays\n",
      `${step}: unmanaged sibling is untouched`,
    );
    assert.equal(
      await fileExists(path.join(stateDirFor(configDir), "journal.json")),
      false,
      `${step}: journal cleared after rollback`,
    );
    assert.equal(
      await fileExists(path.join(stateDirFor(configDir), "lock")),
      false,
      `${step}: lock released after rollback`,
    );
  }

  // ── 4. simulated hard-kill journal → recovery restores pre-apply bytes ─────
  {
    const configDir = path.join(sandbox, "recover");
    assert.equal((await invoke(["--write"], configDir)).exitCode, 0, "clean apply before crash");
    const stateDir = stateDirFor(configDir);
    const managed = await firstManagedFile(configDir);
    const preCrashBytes = await readFile(managed.absTarget);

    // Plant a crashed transaction: a backup holding the pre-crash bytes, a
    // mangled live file (half-applied rename), a dead-owner journal + lock.
    const dead = deadPid();
    const backupPath = path.join(stateDir, "backups", "crash", path.basename(managed.absTarget));
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, preCrashBytes);
    await writeFile(managed.absTarget, "CRASHED-HALF-APPLY GARBAGE\n");
    await writeFile(
      path.join(stateDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        ownerPid: dead,
        startedAt: "2026-07-18T00:00:00.000Z",
        stagingDir: path.join(stateDir, `staging-${dead}`),
        ops: [
          {
            kind: "file",
            target: managed.absTarget,
            relTarget: managed.relTarget,
            backup: backupPath,
            isNew: false,
          },
        ],
      }),
    );
    await mkdir(path.join(stateDir, "lock"), { recursive: true });
    await writeFile(path.join(stateDir, "lock", "meta.json"), JSON.stringify({ pid: dead }));

    const recovered = await invoke(["--write"], configDir);
    assert.equal(recovered.exitCode, 0, "recovery invocation succeeds");
    assert.match(recovered.stdout, /^\[RECOVER\]/m, "recovery is reported with [RECOVER] lines");
    assert.match(recovered.stdout, /^\[WARN\] reclaiming stale sync lock/m, "stale lock reclaimed");
    assert.ok(
      (await readFile(managed.absTarget)).equals(preCrashBytes),
      "the managed file is restored to its pre-apply bytes",
    );
    assert.equal(
      await fileExists(path.join(stateDir, "journal.json")),
      false,
      "the abandoned journal is cleared after recovery",
    );
  }

  // ── 4b. recovery unit: a live-owner journal is left untouched ──────────────
  {
    const stateDir = stateDirFor(path.join(sandbox, "recover-live"));
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "journal.json"),
      JSON.stringify({ schemaVersion: 1, ownerPid: process.pid, startedAt: "x", ops: [] }),
    );
    const out = capture();
    const result = await recoverState(stateDir, { output: out.stream });
    assert.equal(result.skipped, true, "a journal owned by a live pid is not recovered");
    assert.match(out.read(), /skipping recovery/, "the live-owner journal is reported, not clobbered");
  }

  // ── 4c. crash AFTER the ledger write → recovery KEEPS the applied tree ──────
  {
    const configDir = path.join(sandbox, "recover-committed-run");
    const stateDir = stateDirFor(configDir);
    // The first --write crashes right after the ledger write but before the
    // journal is cleared, recording a dead owner pid (FW_SYNC_PID) so the next
    // run treats the leftover journal as abandoned. This drives the real
    // maybeCrash("ledger") path, not a hand-planted journal.
    const dead = deadPid();
    await assert.rejects(
      () => invoke(["--write"], configDir, { FW_SYNC_CRASH_AFTER: "ledger", FW_SYNC_PID: String(dead) }),
      (error) => error?.crash === true,
      "an injected crash after the ledger write propagates without an in-process rollback",
    );

    // The apply reached the ledger, so the journal is committed and the tree is
    // already in its final state (ledger written, files renamed into place).
    const journal = JSON.parse(await readFile(path.join(stateDir, "journal.json"), "utf8"));
    assert.equal(journal.committed, true, "the crashed journal is marked committed");
    const managed = await firstManagedFile(configDir);
    const appliedBytes = await readFile(managed.absTarget);
    assert.ok(appliedBytes.length > 0, "the managed file was applied before the crash");

    const recovered = await invoke(["--write"], configDir);
    assert.equal(recovered.exitCode, 0, "recovery invocation succeeds");
    assert.match(
      recovered.stdout,
      /^\[RECOVER\] already committed — keeping applied tree/m,
      "a committed journal is recovered by keeping the applied tree",
    );
    assert.doesNotMatch(
      recovered.stdout,
      /^\[RECOVER\] restored /m,
      "a committed apply is never rolled back/restored during recovery",
    );
    assert.ok(
      (await readFile(managed.absTarget)).equals(appliedBytes),
      "the applied bytes survive recovery unchanged (no rollback of a committed apply)",
    );
    assert.equal(
      await fileExists(path.join(stateDir, "journal.json")),
      false,
      "the committed journal is cleared after recovery",
    );
  }

  // ── 4d. recovery unit: a committed dead-owner journal keeps applied bytes ───
  {
    const configDir = path.join(sandbox, "recover-committed-unit");
    const stateDir = stateDirFor(configDir);
    const dead = deadPid();
    const target = path.join(configDir, "commands", "committed-keep.md");
    await mkdir(path.dirname(target), { recursive: true });
    const appliedBytes = Buffer.from("APPLIED bytes — must be kept after a committed crash\n");
    await writeFile(target, appliedBytes);
    // A backup holds the OLD pre-apply bytes; a naive rollback would restore them
    // over the applied tree. The committed marker must prevent that.
    const backupPath = path.join(stateDir, "backups", "committed", "committed-keep.md");
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "OLD pre-apply bytes — must NOT be restored\n");
    const stagingDir = path.join(stateDir, `staging-${dead}`);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        ownerPid: dead,
        startedAt: "2026-07-18T00:00:00.000Z",
        committed: true,
        stagingDir,
        ops: [
          {
            kind: "file",
            target,
            relTarget: "commands/committed-keep.md",
            backup: backupPath,
            isNew: false,
          },
        ],
      }),
    );

    const out = capture();
    const result = await recoverState(stateDir, { output: out.stream });
    assert.equal(result.committed, true, "a committed journal is recognised as committed");
    assert.equal(result.recovered, 0, "a committed journal restores nothing");
    assert.match(
      out.read(),
      /^\[RECOVER\] already committed — keeping applied tree/m,
      "the committed journal reports keep-applied, not a restore",
    );
    assert.ok(
      (await readFile(target)).equals(appliedBytes),
      "the applied bytes are kept (the old backup is NOT restored)",
    );
    assert.equal(
      await fileExists(path.join(stateDir, "journal.json")),
      false,
      "the committed journal is cleared after recovery",
    );
    assert.equal(await fileExists(stagingDir), false, "the leftover staging dir is cleaned up");
  }

  // ── 5. idempotence: a second --write reports zero owned-path writes ────────
  {
    const configDir = path.join(sandbox, "idempotent");
    assert.equal((await invoke(["--write"], configDir)).exitCode, 0, "first apply succeeds");
    const second = await invoke(["--write"], configDir);
    assert.equal(second.exitCode, 0, "second apply succeeds");
    assert.doesNotMatch(second.stdout, /^\[WRITE\]/m, "no owned-path writes on the idempotent re-run");
    assert.doesNotMatch(second.stdout, /^\[LOCAL\]/m, "no local overwrites on the idempotent re-run");
    assert.match(second.stdout, /^\[OK\] OpenCode port is in sync\.$/m);
  }
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

process.stdout.write("[OK] apply transaction acceptance\n");
