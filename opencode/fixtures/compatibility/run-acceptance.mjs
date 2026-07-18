#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatCompatibilityReport,
  loadCompatibilityPolicy,
  scanCompatibilityDocuments,
  validateCompatibilityPolicy,
} from "../../../scripts/opencode/validate.mjs";
import {
  DEFAULT_REPO_ROOT,
  renderManagedTree,
  run,
} from "../../../scripts/opencode/sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const POLICY_PATH = path.join(REPO_ROOT, "opencode", "compatibility.json");
const policy = await loadCompatibilityPolicy(POLICY_PATH);

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => ((value += String(chunk)), true) },
    read: () => value,
  };
}

assert.equal(REPO_ROOT, DEFAULT_REPO_ROOT);

const scheduleScratch = scanCompatibilityDocuments(
  [{
    path: "skills/flywheel-scratch/SKILL.md",
    content: "ScheduleWakeup\n(270, { reason: 'new unreviewed call' })\n",
  }],
  policy,
);
assert.equal(scheduleScratch.ok, false, "ScheduleWakeup is not blanket-allowed");
assert.ok(
  scheduleScratch.findings.some(
    (finding) =>
      finding.code === "compatibility_unclassified" &&
      finding.token === "ScheduleWakeup" &&
      finding.path === "skills/flywheel-scratch/SKILL.md",
  ),
  "new ScheduleWakeup occurrence names its token and file",
);

for (const token of ["FutureClaudeTool", "MCPTool", "TeamCreateAsync"]) {
  const unclassified = scanCompatibilityDocuments(
    [{ path: "commands/flywheel-scratch.md", content: `${token}({})\n` }],
    policy,
  );
  assert.equal(unclassified.ok, false);
  assert.ok(
    unclassified.findings.some(
      (finding) => finding.token === token && finding.path === "commands/flywheel-scratch.md",
    ),
    `${token} is rejected as an unclassified Claude-like call`,
  );
}

for (const content of ["Read({ file_path: 'x' })\n", "Edit\n({ file_path: 'x' })\n", "Agent ({})\n"]) {
  const exactClaudeCall = scanCompatibilityDocuments(
    [{ path: "commands/flywheel-scratch.md", content }],
    policy,
  );
  assert.equal(exactClaudeCall.ok, false, `${content.trim()} is rejected`);
}

const mcpOnly = scanCompatibilityDocuments(
  [{
    path: "commands/grill-with-docs.md",
    content: [
      '😀 flywheel_get_skill({ options: { nested: true }, "name": "agent-flywheel:AskUserQuestion" })',
      "flywheel_flywheel_get_skill({ name: 'agent-flywheel:TeamCreate' })",
      "SessionStart is only a generic historical label here.",
      "",
    ].join("\n"),
  }],
  policy,
);
assert.equal(mcpOnly.ok, true, "MCP bundle names are not Claude-isms");
assert.ok(mcpOnly.groups.every((group) => group.count === 0));
assert.doesNotMatch(formatCompatibilityReport(mcpOnly), /agent-flywheel:/);

const hookContext = scanCompatibilityDocuments(
  [{
    path: "plugins/example.js",
    content: "SessionStart -> event session.created\nSessionStart is a generic historical label\n",
  }],
  policy,
);
assert.equal(
  hookContext.groups.find((group) => group.id === "claude-hook-prose")?.count,
  1,
  "hook names count only in hook/event setup context",
);

const hookOutsideContext = scanCompatibilityDocuments(
  [{ path: "commands/flywheel-scratch.md", content: "PreToolUse({})\n" }],
  policy,
);
assert.equal(hookOutsideContext.ok, false);
assert.ok(
  hookOutsideContext.findings.some((finding) => finding.token === "PreToolUse"),
  "a known hook token outside its report context remains unclassified",
);

const malformed = structuredClone(policy);
malformed.knownClaudeTokens[0].reason = "";
assert.throws(
  () => validateCompatibilityPolicy(malformed),
  /reason must be a non-empty string/,
  "every known Claude token requires a review reason",
);

const sandbox = await mkdtemp(path.join(tmpdir(), "agent-flywheel-compatibility-"));
try {
  const reports = [];
  for (const name of ["first", "second"]) {
    const stageRoot = path.join(sandbox, name);
    const rendered = await renderManagedTree({
      repoRoot: REPO_ROOT,
      stageRoot,
      configFile: path.join(sandbox, "opencode.json"),
      skipMcp: true,
    });
    assert.equal(rendered.compatibility.ok, true);
    reports.push(formatCompatibilityReport(rendered.compatibility));
  }
  assert.equal(reports[1], reports[0], "two staged renders produce byte-identical reports");

  const counts = new Map(
    reports[0]
      .split("\n")
      .map((line) => line.match(/^\[REPORT\] group=([^ ]+) count=(\d+) /))
      .filter(Boolean)
      .map((match) => [match[1], Number(match[2])]),
  );
  const baselines = new Map([
    ["ask-user-question", 197],
    ["agent-spawn", 77],
    ["team-comms", 66],
    ["task-lifecycle", 35],
  ]);
  for (const [group, baseline] of baselines) {
    const count = counts.get(group);
    assert.ok(Number.isInteger(count), `${group} appears in the report`);
    assert.ok(
      count >= baseline * 0.9 && count <= baseline * 1.1,
      `${group} count ${count} stays within 10% of baseline ${baseline}`,
    );
  }
  assert.deepEqual(
    Object.fromEntries(counts),
    {
      "ask-user-question": 197,
      "agent-spawn": 77,
      "team-comms": 66,
      "task-lifecycle": 36,
      "claude-paths": 10,
      "claude-hook-prose": 9,
    },
    "current staged occurrence counts are the reviewed deterministic inventory",
  );

  const scratchRepo = path.join(sandbox, "scratch-repo");
  for (const directory of ["commands", "hooks", "opencode", "skills"]) {
    await cp(path.join(REPO_ROOT, directory), path.join(scratchRepo, directory), {
      recursive: true,
    });
  }
  await appendFile(
    path.join(scratchRepo, "skills", "flywheel-doctor", "SKILL.md"),
    "\nScheduleWakeup(270, { reason: 'fixture drift' })\n",
  );
  const scratchTarget = path.join(sandbox, "scratch-target");
  const scratchStdout = capture();
  const scratchStderr = capture();
  await assert.rejects(
    () =>
      run({
        argv: ["--check", "--skip-mcp", "--config-dir", scratchTarget],
        repoRoot: scratchRepo,
        stdout: scratchStdout.stream,
        stderr: scratchStderr.stream,
        debugProbe: () => ({ configDir: scratchTarget, warning: undefined }),
      }),
    (error) =>
      error?.exitCode === 1 &&
      /ScheduleWakeup/.test(error.message) &&
      /skills\/flywheel-doctor\/SKILL\.md/.test(error.message),
    "the sync compatibility validator fails ERROR with the new token and staged file",
  );
  assert.match(scratchStdout.read(), /^\[REPORT\] Claude-ism stale report/m);
  await assert.rejects(
    () => access(scratchTarget),
    (error) => error?.code === "ENOENT",
    "compatibility failure happens before the target directory is written",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

process.stdout.write("[OK] compatibility stale-report acceptance\n");
