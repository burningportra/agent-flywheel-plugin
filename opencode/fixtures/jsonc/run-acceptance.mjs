#!/usr/bin/env node

/**
 * Acceptance harness for bead claude-1pzv — JSONC-preserving MCP config merge.
 *
 * Two layers:
 *  1. Editor-level byte-preservation, driven directly through the pinned JSONC
 *     editor (`setMcpFlywheelEntry`). Proves that only the `mcp.flywheel` subtree
 *     changes and that every other byte (comments, trailing commas, key order,
 *     unrelated keys, provider secrets) is preserved.
 *  2. End-to-end through the sync CLI (`run`) for the write pipeline: permission
 *     preservation, a durable pre-rename backup, atomic replacement, and the
 *     fail-before-any-write cases (missing explicit file, ambiguous pair).
 */

import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../../../scripts/opencode/sync.mjs";
import { stateDirFor } from "../../../scripts/opencode/apply.mjs";
import { deriveMcpEntry } from "../../../scripts/opencode/transforms.mjs";
import { parseJsonc, setMcpFlywheelEntry } from "../../../scripts/opencode/jsonc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const pluginManifest = JSON.parse(
  await readFile(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
);
const EXPECTED = deriveMcpEntry(pluginManifest, REPO_ROOT);
const SERVER_PATH = EXPECTED.command[EXPECTED.command.length - 1];

function capture() {
  let value = "";
  return { stream: { write: (chunk) => ((value += String(chunk)), true) }, read: () => value };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findBackupFile(transactionDir, basename) {
  const opDirs = await readdir(transactionDir);
  for (const opDir of opDirs) {
    const candidate = path.join(transactionDir, opDir, basename);
    if (await fileExists(candidate)) return candidate;
  }
  assert.fail(`backup ${basename} not found under ${transactionDir}`);
}

async function invoke(argv, configDir) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await run({
    argv,
    repoRoot: REPO_ROOT,
    stdout: stdout.stream,
    stderr: stderr.stream,
    debugProbe: () => ({ configDir, warning: undefined }),
  });
  return { exitCode, stdout: stdout.read(), stderr: stderr.read() };
}

/** Deep clone a value, drop mcp.<key>, and drop mcp entirely if it empties out. */
function stripFlywheel(value, key = "flywheel") {
  const clone = structuredClone(value);
  if (clone && typeof clone === "object" && clone.mcp && typeof clone.mcp === "object") {
    delete clone.mcp[key];
    if (Object.keys(clone.mcp).length === 0) delete clone.mcp;
  }
  return clone;
}

/** Locate the single contiguous [start, end) window in which `before`/`after` differ. */
function singleChangedRegion(before, after) {
  let p = 0;
  const min = Math.min(before.length, after.length);
  while (p < min && before[p] === after[p]) p += 1;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before.at(-1 - s) === after.at(-1 - s)) {
    s += 1;
  }
  return {
    prefix: before.slice(0, p),
    suffix: before.slice(before.length - s),
    changedBefore: before.slice(p, before.length - s),
    changedAfter: after.slice(p, after.length - s),
  };
}

/**
 * Assert the merge changed exactly one contiguous region and that region never
 * spilled into a sibling key or a secret. Because everything outside the region
 * is byte-identical by construction, this proves unrelated content is preserved.
 */
function assertPreserved(before, after, { forbidden, oldMarker }, label) {
  const parsedAfter = parseJsonc(after);
  assert.deepEqual(parsedAfter.mcp.flywheel, EXPECTED, `${label}: mcp.flywheel updated to derived entry`);
  assert.deepEqual(
    stripFlywheel(parseJsonc(before)),
    stripFlywheel(parsedAfter),
    `${label}: every value outside mcp.flywheel is unchanged`,
  );

  const region = singleChangedRegion(before, after);
  assert.ok(region.changedAfter.length > 0, `${label}: a change was applied`);
  assert.ok(
    region.changedAfter.includes(SERVER_PATH),
    `${label}: the changed region carries the derived server path`,
  );
  for (const marker of forbidden) {
    assert.ok(
      !region.changedBefore.includes(marker) && !region.changedAfter.includes(marker),
      `${label}: sibling/secret ${JSON.stringify(marker)} stays outside the changed region`,
    );
    assert.ok(after.includes(marker), `${label}: sibling/secret ${JSON.stringify(marker)} survives verbatim`);
  }
  if (oldMarker !== undefined) {
    assert.ok(region.changedBefore.includes(oldMarker), `${label}: old entry occupied the changed region`);
    assert.ok(!after.includes(oldMarker), `${label}: stale entry ${JSON.stringify(oldMarker)} is gone`);
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — editor-level byte-preservation
// ---------------------------------------------------------------------------

const commentsText = await readFile(path.join(HERE, "comments.jsonc"), "utf8");
const commentsAfter = setMcpFlywheelEntry(commentsText, "flywheel", EXPECTED, { path: "comments.jsonc" });
assertPreserved(
  commentsText,
  commentsAfter,
  {
    forbidden: [
      '"context7"',
      "sk-ant-DO-NOT-TOUCH-me-please-0xC0FFEE",
      "https://mcp.context7.com/mcp",
    ],
    oldMarker: "/old/stale/path/server.js",
  },
  "comments.jsonc (replace)",
);
for (const comment of [
  "// OpenCode configuration — hand-edited, merged by the flywheel sync.",
  "// preferred theme, keep as-is",
  "/* Secret material lives here and must survive the merge untouched. */",
  "// context7 stays remote",
]) {
  assert.ok(commentsAfter.includes(comment), `comments.jsonc: comment preserved: ${comment}`);
}

const commaText = await readFile(path.join(HERE, "trailing-commas.jsonc"), "utf8");
const commaAfter = setMcpFlywheelEntry(commaText, "flywheel", EXPECTED, { path: "trailing-commas.jsonc" });
assertPreserved(
  commaText,
  commaAfter,
  { forbidden: ['"pencil"', '"leader": "ctrl+x"'], oldMarker: "/old/path.js" },
  "trailing-commas.jsonc (replace)",
);
// The sibling member and its trailing comma survive verbatim (flywheel was first).
assert.ok(
  commaAfter.includes('"enabled": true,\n    },\n  },\n}'),
  "trailing-commas.jsonc: sibling trailing commas preserved byte-for-byte",
);

const otherText = await readFile(path.join(HERE, "other-servers.json"), "utf8");
const otherAfter = setMcpFlywheelEntry(otherText, "flywheel", EXPECTED, { path: "other-servers.json" });
assertPreserved(
  otherText,
  otherAfter,
  {
    forbidden: ['"context7"', '"pencil"', "sk-ant-secret-stays-put-0xFEEDFACE"],
  },
  "other-servers.json (insert alongside context7 + pencil)",
);
assert.ok(otherAfter.includes('"flywheel"'), "other-servers.json: flywheel inserted");

const noMcpText = await readFile(path.join(HERE, "no-mcp.json"), "utf8");
const noMcpAfter = setMcpFlywheelEntry(noMcpText, "flywheel", EXPECTED, { path: "no-mcp.json" });
assertPreserved(
  noMcpText,
  noMcpAfter,
  { forbidden: ['"theme": "opencode"', "sk-ant-untouched-0xBADC0DE"] },
  "no-mcp.json (insert mcp object)",
);
assert.equal(parseJsonc(noMcpAfter).theme, "opencode", "no-mcp.json: unrelated top-level keys intact");

// Malformed input must be refused, never silently rewritten.
assert.throws(
  () => setMcpFlywheelEntry('{ "mcp": { "flywheel": }', "flywheel", EXPECTED),
  /JSONC syntax error/,
  "editor refuses to edit a document that does not parse",
);
assert.throws(
  () => setMcpFlywheelEntry('{ "mcp": [] }', "flywheel", EXPECTED),
  /"mcp" must be a JSON object/,
  "editor refuses when mcp is not an object",
);

// ---------------------------------------------------------------------------
// Layer 2 — end-to-end write pipeline through the sync CLI
// ---------------------------------------------------------------------------

const sandbox = await mkdtemp(path.join(tmpdir(), "agent-flywheel-jsonc-acceptance-"));
try {
  // E1: .json insert — permissions preserved + durable backup + atomic replace.
  {
    const target = path.join(sandbox, "insert");
    await mkdir(target, { recursive: true });
    const configFile = path.join(target, "opencode.json");
    await writeFile(configFile, otherText);
    await chmod(configFile, 0o600);
    const original = await readFile(configFile);

    const result = await invoke(["--write", "--config-dir", target], target);
    assert.equal(result.exitCode, 0, "E1 write succeeds");
    assert.match(result.stdout, /^\[OK\] OpenCode port is in sync\.$/m);

    const after = await readFile(configFile, "utf8");
    const parsed = parseJsonc(after);
    assert.deepEqual(parsed.mcp.flywheel, EXPECTED, "E1 flywheel derived");
    assert.deepEqual(parsed.mcp.context7, parseJsonc(otherText).mcp.context7, "E1 context7 preserved");
    assert.deepEqual(parsed.mcp.pencil, parseJsonc(otherText).mcp.pencil, "E1 pencil preserved");
    assert.deepEqual(parsed.provider, parseJsonc(otherText).provider, "E1 provider secret preserved");
    assert.equal((await stat(configFile)).mode & 0o777, 0o600, "E1 permissions preserved");

    const backupRoot = path.join(stateDirFor(target), "backups");
    const backups = await readdir(backupRoot);
    assert.equal(backups.length, 1, "E1 exactly one transaction backup created");
    const backupBytes = await readFile(
      await findBackupFile(path.join(backupRoot, backups[0]), "opencode.json"),
    );
    assert.ok(backupBytes.equals(original), "E1 backup holds the original bytes verbatim");
    assert.equal((await stat(path.join(backupRoot, backups[0]))).mode & 0o777, 0o700, "E1 backup dir is 0700");
    assert.equal(
      await fileExists(path.join(target, ".flywheel-opencode-backups")),
      false,
      "E1 no independent MCP backup tree is created",
    );
  }

  // E2: .jsonc replace via explicit --config-file — comments + secret survive on disk.
  {
    const target = path.join(sandbox, "replace-jsonc");
    await mkdir(target, { recursive: true });
    const configFile = path.join(target, "opencode.jsonc");
    await writeFile(configFile, commentsText);
    await chmod(configFile, 0o640);
    const original = await readFile(configFile);

    const result = await invoke(["--write", "--config-file", configFile], target);
    assert.equal(result.exitCode, 0, "E2 write succeeds");

    const after = await readFile(configFile, "utf8");
    assert.deepEqual(parseJsonc(after).mcp.flywheel, EXPECTED, "E2 flywheel derived");
    assert.ok(after.includes("/* Secret material lives here"), "E2 block comment preserved on disk");
    assert.ok(after.includes("// context7 stays remote"), "E2 line comment preserved on disk");
    assert.ok(after.includes("sk-ant-DO-NOT-TOUCH-me-please-0xC0FFEE"), "E2 provider secret preserved on disk");
    assert.ok(!after.includes("/old/stale/path/server.js"), "E2 stale flywheel command replaced");
    assert.equal((await stat(configFile)).mode & 0o777, 0o640, "E2 permissions preserved");

    const backupRoot = path.join(stateDirFor(target), "backups");
    const backups = await readdir(backupRoot);
    const backupBytes = await readFile(
      await findBackupFile(path.join(backupRoot, backups[0]), "opencode.jsonc"),
    );
    assert.ok(backupBytes.equals(original), "E2 backup holds original JSONC bytes verbatim");
  }

  // E3: explicit --config-file that does not exist fails before any write.
  {
    const target = path.join(sandbox, "missing");
    await mkdir(target, { recursive: true });
    const configFile = path.join(target, "opencode.json");
    await assert.rejects(
      () => invoke(["--write", "--config-file", configFile], target),
      (error) => error?.exitCode === 2 && /config file is missing/.test(error.message),
      "E3 missing explicit config file is a prerequisite error",
    );
    assert.equal(await fileExists(configFile), false, "E3 no config written");
    assert.equal(await fileExists(path.join(target, "skills")), false, "E3 nothing written before the failure");
  }

  // E4: ambiguous opencode.json + opencode.jsonc pair fails before any write.
  {
    const target = path.join(sandbox, "ambiguous");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "opencode.json"), "{}\n");
    await writeFile(path.join(target, "opencode.jsonc"), "{}\n");
    await assert.rejects(
      () => invoke(["--write", "--config-dir", target], target),
      (error) => error?.exitCode === 2 && /both .*opencode\.json/.test(error.message),
      "E4 ambiguous pair requires an explicit selection",
    );
    assert.equal(await readFile(path.join(target, "opencode.json"), "utf8"), "{}\n", "E4 json untouched");
    assert.equal(await readFile(path.join(target, "opencode.jsonc"), "utf8"), "{}\n", "E4 jsonc untouched");
  }

  // E5: --skip-mcp leaves the config file (and its bytes) entirely untouched.
  {
    const target = path.join(sandbox, "skip");
    await mkdir(target, { recursive: true });
    const configFile = path.join(target, "opencode.json");
    await writeFile(configFile, otherText);
    await chmod(configFile, 0o600);
    const original = await readFile(configFile);

    const result = await invoke(["--write", "--skip-mcp", "--config-dir", target], target);
    assert.equal(result.exitCode, 0, "E5 skip-mcp write succeeds");
    assert.match(result.stdout, /^\[SKIP\] mcp\.flywheel/m);
    assert.ok((await readFile(configFile)).equals(original), "E5 config bytes untouched under --skip-mcp");
    assert.equal((await stat(configFile)).mode & 0o777, 0o600, "E5 permissions untouched");
    assert.deepEqual(
      await readdir(path.join(stateDirFor(target), "backups")),
      [],
      "E5 no backup copy is created when the merge is skipped",
    );
  }

  // E6: successful writes retain only the ten newest transaction backups.
  {
    const target = path.join(sandbox, "retention");
    await mkdir(target, { recursive: true });
    const configFile = path.join(target, "opencode.json");
    await writeFile(configFile, otherText);

    for (let write = 0; write < 11; write += 1) {
      if (write > 0) {
        const config = parseJsonc(await readFile(configFile, "utf8"));
        config.mcp.flywheel.command = ["node", `/tmp/mcp-drift-${write}.js`];
        await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
      }
      const result = await invoke(["--write", "--config-dir", target], target);
      assert.equal(result.exitCode, 0, `E6 write ${write + 1} succeeds`);
    }

    const backups = await readdir(path.join(stateDirFor(target), "backups"));
    assert.equal(backups.length, 10, "E6 only the ten newest transaction backups remain");
  }
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

process.stdout.write("[OK] jsonc MCP merge acceptance\n");
