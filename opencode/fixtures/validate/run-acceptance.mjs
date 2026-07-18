/**
 * Acceptance harness for bead claude-3hzk (T1).
 *
 * Exercises the five acceptance items from the impl brief against scratch
 * fixtures (temp dirs) and the live repo. Run:
 *
 *   node opencode/fixtures/validate/run-acceptance.mjs
 *
 * Exits 0 iff every item passes. No deps beyond node stdlib; imports the
 * validator module under test.
 */

import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateManifest,
  checkInventory,
  discoverManaged,
  checkOwnershipBoundary,
  checkDelegationClosure,
  extractDelegations,
  classifyDelegation,
  loadManifest,
} from "../../../scripts/opencode/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

let failures = 0;
function check(label, cond, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  process.stdout.write(`[${status}] ${label}${detail ? ` — ${detail}` : ""}\n`);
}

/** Build a minimal synthetic repo (manifest + skills + commands) in `root`. */
async function buildSyntheticRepo(root, { skills, commands }) {
  await mkdir(path.join(root, "skills"), { recursive: true });
  await mkdir(path.join(root, "commands"), { recursive: true });
  await mkdir(path.join(root, "opencode"), { recursive: true });
  for (const name of skills) {
    await mkdir(path.join(root, "skills", name), { recursive: true });
    await writeFile(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: synthetic\n---\nbody\n`);
  }
  for (const name of commands) {
    await writeFile(path.join(root, "commands", `${name}.md`), `---\ndescription: synthetic\n---\nbody $ARGUMENTS\n`);
  }
  const manifest = {
    version: 1,
    discovery: {
      skillDirPattern: "^(flywheel-.+|start)$",
      commandFilePattern: "^(flywheel-.+|start)\\.md$",
      skillsRoot: "skills",
      commandsRoot: "commands",
    },
    skills: skills.map((name) => ({ name, source: `skills/${name}/`, target: `skills/${name}/`, kind: "skill-dir" })),
    commands: commands.map((name) => ({ name, source: `commands/${name}.md`, target: `commands/${name}.md`, kind: "command" })),
    commandOverrides: [],
    dependencyClassification: {},
    externalAllowlist: { entries: {} },
  };
  await writeFile(path.join(root, "opencode", "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function main() {
  // ── Acceptance #1: synthetic extra managed skill dir → inventory_unclassified
  {
    const root = await mkdtemp(path.join(tmpdir(), "cl3hzk-1-"));
    try {
      const manifest = await buildSyntheticRepo(root, {
        skills: ["flywheel-audit", "start"],
        commands: ["flywheel-audit", "start"],
      });
      // Add a synthetic dir the manifest does not list.
      await mkdir(path.join(root, "skills", "flywheel-new"), { recursive: true });
      await writeFile(path.join(root, "skills", "flywheel-new", "SKILL.md"), "---\nname: flywheel-new\ndescription: x\n---\n");
      const discovered = await discoverManaged(root, manifest);
      const inv = checkInventory(manifest, discovered);
      const hit = inv.findings.find((f) => f.code === "inventory_unclassified" && f.name === "flywheel-new");
      check("#1 synthetic skills/flywheel-new/ → inventory_unclassified", !!hit && !inv.ok, hit ? "" : JSON.stringify(inv.findings));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ── Acceptance #2: removing a listed source → inventory_missing
  {
    const root = await mkdtemp(path.join(tmpdir(), "cl3hzk-2-"));
    try {
      const manifest = await buildSyntheticRepo(root, {
        skills: ["flywheel-audit", "start"],
        commands: ["flywheel-audit", "start"],
      });
      // Remove a listed source dir.
      await rm(path.join(root, "skills", "flywheel-audit"), { recursive: true, force: true });
      const discovered = await discoverManaged(root, manifest);
      const inv = checkInventory(manifest, discovered);
      const hit = inv.findings.find((f) => f.code === "inventory_missing" && f.name === "flywheel-audit");
      check("#2 removed listed source → inventory_missing", !!hit && !inv.ok, hit ? "" : JSON.stringify(inv.findings));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ── Acceptance #3: every managed command dependency classified (live repo)
  {
    const result = await validateManifest(REPO_ROOT);
    const closureHoles = result.checks.closure.findings.filter((f) => f.code === "delegation_unresolved");
    check(
      "#3 live repo: every managed command delegation classified",
      closureHoles.length === 0,
      closureHoles.length ? JSON.stringify(closureHoles) : `${result.checks.closure.resolved.length} delegations resolved`,
    );
    // The whole live tree should validate clean.
    check("#3b live repo: full validateManifest ok", result.ok, result.ok ? "" : JSON.stringify(result.findings));
  }

  // ── Acceptance #4: parent-dir ownership target → ownership_too_broad
  {
    const { manifest } = await loadManifest(path.join(REPO_ROOT, "opencode", "manifest.json"));
    const broad = structuredClone(manifest);
    broad.skills = [...broad.skills, { name: "evil", source: "skills/", target: "skills/", kind: "skill-dir" }];
    const own = checkOwnershipBoundary(broad);
    const hit = own.findings.find((f) => f.code === "ownership_too_broad");
    check("#4 skills/ as ownership target → ownership_too_broad", !!hit && !own.ok, hit ? "" : JSON.stringify(own.findings));
    // And the real manifest's ownership boundary is clean.
    const realOwn = checkOwnershipBoundary(manifest);
    check("#4b real manifest ownership boundary clean", realOwn.ok, realOwn.ok ? "" : JSON.stringify(realOwn.findings));
  }

  // ── Acceptance #5: grill override delegates via MCP path, not native skill
  {
    const { manifest } = await loadManifest(path.join(REPO_ROOT, "opencode", "manifest.json"));
    const overrideContent = await (await import("node:fs/promises")).readFile(
      path.join(REPO_ROOT, "opencode", "commands", "grill-with-docs.md"),
      "utf8",
    );
    const dels = extractDelegations(overrideContent);
    const mcpDel = dels.find((d) => d.target === "grill-with-docs" && d.kind === "mcp");
    const badDel = dels.find((d) => d.target === "grill-with-docs" && d.kind !== "mcp");
    check("#5 override delegates to grill-with-docs via MCP", !!mcpDel, JSON.stringify(dels));
    check("#5b override has NO native/slash grill-with-docs delegation", !badDel, badDel ? JSON.stringify(badDel) : "");
    // The MCP delegation resolves; a hypothetical native one would NOT.
    check("#5c MCP grill-with-docs delegation resolves", classifyDelegation("grill-with-docs", "mcp", manifest).ok);
    check(
      "#5d native grill-with-docs delegation is a closure hole",
      classifyDelegation("grill-with-docs", "native-skill", manifest).ok === false,
    );
    // Closure over the override alone is clean.
    const closure = checkDelegationClosure(manifest, [{ name: "grill-with-docs", content: overrideContent }]);
    check("#5e closure over override is clean", closure.ok, closure.ok ? "" : JSON.stringify(closure.findings));
  }

  process.stdout.write(failures === 0 ? "\nALL ACCEPTANCE ITEMS PASS\n" : `\n${failures} ACCEPTANCE FAILURE(S)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stdout.write(`[FATAL] ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
