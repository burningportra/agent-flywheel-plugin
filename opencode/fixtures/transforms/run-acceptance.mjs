#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRANSFORMS,
  applyTransformProfile,
  assertMcpNamesPreserved,
  deriveMcpEntry,
  dropArgumentHintFromFrontmatter,
  renderPluginRootTemplate,
  replacePluginRootTokens,
  rewriteSkillInvocations,
  rewriteSlashPrefixes,
} from "../../../scripts/opencode/transforms.mjs";

const FIXTURE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_REPO_ROOT = "/tmp/Flywheel Ω/root with spaces";

async function fixture(id) {
  const root = path.join(FIXTURE_ROOT, id);
  return Promise.all([readFile(path.join(root, "in"), "utf8"), readFile(path.join(root, "out"), "utf8")]);
}

const runners = {
  "t-plugin-root": (input) => replacePluginRootTokens(input, TEST_REPO_ROOT),
  "t-slash-prefix": (input) => rewriteSlashPrefixes(input, "fixture/t-slash-prefix"),
  "t-skill-invoke": (input) => rewriteSkillInvocations(input),
  "t-frontmatter": (input) => dropArgumentHintFromFrontmatter(input),
  "t-plugin-root-template": (input) => renderPluginRootTemplate(input, TEST_REPO_ROOT),
  "t-mcp-command": (input) => `${JSON.stringify(deriveMcpEntry(JSON.parse(input), TEST_REPO_ROOT), null, 2)}\n`,
};

for (const transform of TRANSFORMS) {
  const runner = runners[transform.id];
  assert.equal(typeof runner, "function", `missing fixture runner for ${transform.id}`);
  const [input, expected] = await fixture(transform.id);
  const first = runner(input);
  const second = runner(input);
  assert.equal(first, expected, `${transform.id} golden output`);
  assert.equal(second, first, `${transform.id} is deterministic`);
}

assert.throws(
  () =>
    assertMcpNamesPreserved(
      'flywheel_get_skill({ name: "agent-flywheel:start_planning" })',
      'flywheel_get_skill({ name: "start_planning" })',
      "corruption-sentinel",
    ),
  /names changed/,
  "MCP name corruption must fail the postcondition",
);

assert.throws(
  () =>
    assertMcpNamesPreserved(
      'flywheel_get_skill({ name: "start_planning" })',
      'flywheel_get_skill({ name: "start_planning" })',
      "missing-namespace-sentinel",
    ),
  /is not namespaced/,
  "an already-invalid MCP name must fail closed",
);

assert.throws(
  () =>
    applyTransformProfile('flywheel_get_skill({ name: "start_planning" })', {
      profile: "command-override",
      repoRoot: TEST_REPO_ROOT,
      sourcePath: "override/missing-namespace.md",
    }),
  /is not namespaced/,
  "verbatim command overrides still enforce the MCP namespace postcondition",
);

const shellCommand = replacePluginRootTokens(
  "set -- node $CLAUDE_PLUGIN_ROOT/mcp-server/dist/server.js",
  TEST_REPO_ROOT,
);
const shellProbe = spawnSync(
  "bash",
  ["-c", `${shellCommand}\ntest "$2" = ${JSON.stringify(`${TEST_REPO_ROOT}/mcp-server/dist/server.js`)}`],
  { timeout: 5_000, stdio: "ignore" },
);
assert.equal(shellProbe.status, 0, "unquoted plugin-root references remain one shell argv path");

assert.equal(
  renderPluginRootTemplate('const FLYWHEEL_ROOT = "/legacy/machine/path"\n', TEST_REPO_ROOT),
  `const FLYWHEEL_ROOT = ${JSON.stringify(TEST_REPO_ROOT)}\n`,
  "legacy plugin templates receive the typed root literal",
);

process.stdout.write(`[OK] ${TRANSFORMS.length} transform fixture pairs\n`);
