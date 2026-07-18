/**
 * OpenCode port — manifest ownership + dependency-closure validator.
 *
 * Bead claude-3hzk (T1). Node 20+ ESM, node stdlib only (no deps) so the sync
 * CLI (T3, `scripts/opencode/sync.mjs`) can import it directly.
 *
 * The manifest (`opencode/manifest.json`) is the source-of-truth inventory of
 * every artifact the sync script owns. This module enforces two contracts:
 *
 *   1. Ownership / inventory cross-check — the DECLARED inventory in the
 *      manifest must exactly match what discovery finds in the live tree.
 *      A managed-pattern skill/command dir that discovery finds but the
 *      manifest omits is `inventory_unclassified`; a manifest entry with no
 *      matching source is `inventory_missing`. Counts are never hardcoded —
 *      discovery is dynamic; the manifest arrays are what it diffs against.
 *
 *   2. Dependency-closure — every delegation a managed command makes
 *      (native `skill(name:)` / `Skill(...)`, an MCP bundle load via
 *      `flywheel_get_skill`, or a namespaced `/agent-flywheel:X` slash) must
 *      resolve to a manifest-owned skill/command, a flywheel MCP bundle name,
 *      or an explicit external-allowlist entry. An unresolved delegation is a
 *      closure hole (the `grill-with-docs` bug class) and fails.
 *
 * Resolution is KIND-AWARE. A dependency classified `mcp-bundle` (e.g.
 * `grill-with-docs`, which ships in the bundle but is NOT a managed native
 * skill dir) resolves ONLY through the MCP path. A native `skill(...)` or
 * slash delegation to that same name is a closure hole, because on a machine
 * without a separately-installed skill dir the native lookup fails. This is
 * exactly what keeps acceptance #5 honest.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ─── Discovery patterns (defaults; manifest.discovery overrides) ────────────

/** A skill dir is managed iff its name matches this AND it contains SKILL.md. */
export const MANAGED_SKILL_PATTERN = /^(flywheel-.+|start)$/;
/** A command file is managed iff its basename matches this. */
export const MANAGED_COMMAND_PATTERN = /^(flywheel-.+|start)\.md$/;

// ─── Finding codes ──────────────────────────────────────────────────────────

export const FINDING_CODES = Object.freeze({
  INVENTORY_UNCLASSIFIED: "inventory_unclassified",
  INVENTORY_MISSING: "inventory_missing",
  DELEGATION_UNRESOLVED: "delegation_unresolved",
  OWNERSHIP_TOO_BROAD: "ownership_too_broad",
  MANIFEST_INVALID: "manifest_invalid",
  SOURCE_MISSING: "source_missing",
});

// ─── Manifest loading ───────────────────────────────────────────────────────

/**
 * Parse + shape-check `opencode/manifest.json`. Throws on unreadable/invalid
 * JSON so the caller fails closed rather than validating against a partial
 * manifest. Returns the parsed object plus a `findings[]` of soft shape issues.
 */
export async function loadManifest(manifestPath) {
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`manifest not readable at ${manifestPath}: ${String(err)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest is not valid JSON (${manifestPath}): ${String(err)}`);
  }
  const findings = shapeCheckManifest(manifest);
  return { manifest, findings };
}

/** Cheap structural sanity check. Returns findings; does not throw. */
export function shapeCheckManifest(manifest) {
  const findings = [];
  const requireArray = (key) => {
    if (!Array.isArray(manifest?.[key])) {
      findings.push({
        code: FINDING_CODES.MANIFEST_INVALID,
        message: `manifest.${key} must be an array`,
      });
    }
  };
  if (manifest?.version !== 1) {
    findings.push({
      code: FINDING_CODES.MANIFEST_INVALID,
      message: `manifest.version must be 1 (got ${JSON.stringify(manifest?.version)})`,
    });
  }
  requireArray("skills");
  requireArray("commands");
  if (manifest?.commandOverrides != null && !Array.isArray(manifest.commandOverrides)) {
    findings.push({
      code: FINDING_CODES.MANIFEST_INVALID,
      message: "manifest.commandOverrides, when present, must be an array",
    });
  }
  return findings;
}

// ─── Set helpers over the manifest ──────────────────────────────────────────

function namesOf(list) {
  return (Array.isArray(list) ? list : []).map((e) => e?.name).filter(Boolean);
}

/** Owned skill names (resolve native `skill()` / slash-to-skill / MCP loads). */
export function ownedSkillNames(manifest) {
  return new Set(namesOf(manifest.skills));
}

/** Owned command names, including command overrides (resolve slash refs). */
export function ownedCommandNames(manifest) {
  return new Set([...namesOf(manifest.commands), ...namesOf(manifest.commandOverrides)]);
}

/** External-allowlist name set (separately-installed skills). */
export function externalAllowlistNames(manifest) {
  const entries = manifest?.externalAllowlist?.entries ?? {};
  return new Set(Object.keys(entries));
}

// ─── Discovery (dynamic; never hardcoded counts) ────────────────────────────

async function dirExists(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan the live repo for managed skill dirs and command files. Uses the
 * manifest's discovery patterns when supplied, else the module defaults.
 * Missing roots yield an empty list for that kind rather than throwing.
 *
 * @returns {{ skills: string[], commands: string[] }} sorted name lists.
 */
export async function discoverManaged(repoRoot, manifest = {}) {
  const skillPattern = manifest?.discovery?.skillDirPattern
    ? new RegExp(manifest.discovery.skillDirPattern)
    : MANAGED_SKILL_PATTERN;
  const commandPattern = manifest?.discovery?.commandFilePattern
    ? new RegExp(manifest.discovery.commandFilePattern)
    : MANAGED_COMMAND_PATTERN;
  const skillsRoot = path.join(repoRoot, manifest?.discovery?.skillsRoot ?? "skills");
  const commandsRoot = path.join(repoRoot, manifest?.discovery?.commandsRoot ?? "commands");

  const skills = [];
  if (await dirExists(skillsRoot)) {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!skillPattern.test(e.name)) continue;
      // A managed skill dir must actually carry a SKILL.md body.
      if (await fileExists(path.join(skillsRoot, e.name, "SKILL.md"))) {
        skills.push(e.name);
      }
    }
  }

  const commands = [];
  if (await dirExists(commandsRoot)) {
    const entries = await readdir(commandsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!commandPattern.test(e.name)) continue;
      commands.push(e.name.replace(/\.md$/, ""));
    }
  }

  return { skills: skills.sort(), commands: commands.sort() };
}

async function fileExists(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// ─── Check 1: inventory cross-check ─────────────────────────────────────────

/**
 * Diff the DECLARED manifest inventory against DISCOVERED live-tree entries.
 *   - discovered but not declared → inventory_unclassified
 *   - declared but not discovered → inventory_missing
 *
 * @param {object} manifest
 * @param {{ skills: string[], commands: string[] }} discovered
 */
export function checkInventory(manifest, discovered) {
  const findings = [];
  const pairs = [
    { kind: "skill", declared: new Set(namesOf(manifest.skills)), found: discovered.skills ?? [] },
    { kind: "command", declared: new Set(namesOf(manifest.commands)), found: discovered.commands ?? [] },
  ];
  for (const { kind, declared, found } of pairs) {
    const foundSet = new Set(found);
    for (const name of found) {
      if (!declared.has(name)) {
        findings.push({
          code: FINDING_CODES.INVENTORY_UNCLASSIFIED,
          kind,
          name,
          message: `${kind} "${name}" exists in the tree and matches the managed pattern but is not listed in the manifest — add it or it will not be classified`,
        });
      }
    }
    for (const name of declared) {
      if (!foundSet.has(name)) {
        findings.push({
          code: FINDING_CODES.INVENTORY_MISSING,
          kind,
          name,
          message: `${kind} "${name}" is listed in the manifest but no matching source was discovered — the source was removed or renamed`,
        });
      }
    }
  }
  findings.sort(findingSort);
  return { ok: findings.length === 0, findings };
}

// ─── Delegation extraction ──────────────────────────────────────────────────

/**
 * Extract the UNAMBIGUOUS delegations from a command body. We deliberately do
 * NOT scrape bare `/word` slashes: `/usr`, `/tmp`, `/main`, `/null` and dozens
 * of filesystem paths / git refs appear in prose and would swamp the signal.
 * The reliable delegation forms are:
 *
 *   - Skill-tool calls (Claude form, namespaced arg):
 *       Skill(skill: "agent-flywheel:X")  /  Skill(skill_name: "…")  /  Skill("agent-flywheel:X")
 *   - Native skill calls (OpenCode form, bare arg):
 *       skill(name: "X")
 *   - MCP bundle loads (prefixed or unprefixed — suffix resolution):
 *       flywheel_get_skill({ name: "agent-flywheel:X" })
 *       flywheel_flywheel_get_skill({ name: "agent-flywheel:X" })
 *   - Namespaced slash references (unambiguous — the agent-flywheel: marker):
 *       /agent-flywheel:X
 *
 * @returns {{ kind: 'native-skill'|'mcp'|'slash', target: string, raw: string }[]}
 *   deduped by (kind, target).
 */
export function extractDelegations(content) {
  const out = [];
  const push = (kind, target, raw) => {
    if (target) out.push({ kind, target, raw });
  };

  // MCP bundle loads FIRST so `flywheel_get_skill(...)` is never mis-read as a
  // native `skill(...)` call below.
  const mcpRe = /\bflywheel_(?:flywheel_)?get_skill\s*\(\s*\{\s*name\s*:\s*["']agent-flywheel:([a-z0-9_-]+)["']/gi;
  for (const m of content.matchAll(mcpRe)) push("mcp", m[1], m[0]);

  // Claude Skill-tool calls (namespaced arg): keyword or positional.
  const skillToolRe = /\bSkill\s*\(\s*(?:(?:skill|skill_name)\s*:\s*)?["']agent-flywheel:([a-z0-9_-]+)["']/gi;
  for (const m of content.matchAll(skillToolRe)) push("native-skill", m[1], m[0]);

  // OpenCode-native skill calls (bare name arg). `\bskill\(` cannot match the
  // `_skill(` tail of `flywheel_get_skill(` (no word boundary), and the arg
  // shape `name:` differs from the MCP form `{ name:`.
  const nativeSkillRe = /\bskill\s*\(\s*name\s*:\s*["']([a-z0-9_-]+)["']/gi;
  for (const m of content.matchAll(nativeSkillRe)) push("native-skill", m[1], m[0]);

  // Namespaced slash references.
  const slashRe = /\/agent-flywheel:([a-z0-9_-]+)/gi;
  for (const m of content.matchAll(slashRe)) push("slash", m[1], m[0]);

  // Dedup by (kind, target).
  const seen = new Set();
  const deduped = [];
  for (const d of out) {
    const key = `${d.kind}:${d.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(d);
  }
  return deduped;
}

// ─── Delegation classification (kind-aware) ─────────────────────────────────

/**
 * Classify one delegation against the manifest. Returns
 *   { ok: true, class: 'owned'|'mcp-bundle'|'external-allowlisted' }
 * or
 *   { ok: false, reason }
 *
 * Kind-aware rules (this is the closure contract):
 *   - kind 'mcp'  (flywheel_get_skill load): resolves if the target is an owned
 *     skill (owned skills are always in the bundle) OR classified 'mcp-bundle'.
 *   - kind 'native-skill' / 'slash': resolves if the target is an owned skill,
 *     an owned command (slash), or external-allowlisted. A target classified
 *     'mcp-bundle' does NOT resolve here — that is the grill-with-docs hole:
 *     the bundled skill is reachable only via MCP, so a native/slash reference
 *     to it fails on any machine without a separately-installed skill dir.
 */
export function classifyDelegation(target, kind, manifest) {
  const ownedSkills = ownedSkillNames(manifest);
  const ownedCommands = ownedCommandNames(manifest);
  const extAllow = externalAllowlistNames(manifest);
  const depClass = manifest?.dependencyClassification ?? {};
  const dep = depClass[target];

  if (kind === "mcp") {
    if (ownedSkills.has(target)) return { ok: true, class: "owned" };
    if (dep?.class === "mcp-bundle") return { ok: true, class: "mcp-bundle" };
    return {
      ok: false,
      reason: `MCP bundle load of "${target}" resolves to neither an owned skill nor an mcp-bundle-classified dependency`,
    };
  }

  // native-skill or slash
  if (kind === "slash" && ownedCommands.has(target)) return { ok: true, class: "owned" };
  if (ownedSkills.has(target)) return { ok: true, class: "owned" };
  if (extAllow.has(target) || dep?.class === "external-allowlisted") {
    return { ok: true, class: "external-allowlisted" };
  }
  if (dep?.class === "mcp-bundle") {
    return {
      ok: false,
      reason: `"${target}" is an mcp-bundle dependency reachable only via flywheel_get_skill, but it is delegated here as a native ${kind} — this is a closure hole (use the MCP bundle load instead)`,
    };
  }
  return {
    ok: false,
    reason: `${kind} delegation to "${target}" resolves to no owned skill/command, no mcp-bundle dependency, and no external-allowlist entry`,
  };
}

// ─── Check 2: dependency closure ────────────────────────────────────────────

/**
 * Verify every delegation in every managed command resolves.
 *
 * @param {object} manifest
 * @param {{ name: string, content: string }[]} commands
 * @returns {{ ok: boolean, findings: object[], resolved: object[] }}
 */
export function checkDelegationClosure(manifest, commands) {
  const findings = [];
  const resolved = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd.content !== "string") continue;
    for (const d of extractDelegations(cmd.content)) {
      const verdict = classifyDelegation(d.target, d.kind, manifest);
      if (verdict.ok) {
        resolved.push({ command: cmd.name, target: d.target, kind: d.kind, class: verdict.class });
      } else {
        findings.push({
          code: FINDING_CODES.DELEGATION_UNRESOLVED,
          command: cmd.name,
          target: d.target,
          delegationKind: d.kind,
          message: `${cmd.name}: ${verdict.reason}`,
        });
      }
    }
  }
  findings.sort(findingSort);
  return { ok: findings.length === 0, findings, resolved };
}

// ─── Check 3: ownership-boundary guard ──────────────────────────────────────

const FORBIDDEN_OWNERSHIP_TARGETS = new Set([
  "",
  ".",
  "/",
  "skills",
  "commands",
  "plugins",
  "opencode",
  "opencode/commands",
  "opencode/plugins",
]);

/**
 * Assert no ownership target is a parent directory or a wildcard. The manifest
 * must own specific files and specific skill/command dirs, never `skills/` or
 * `commands/` wholesale (acceptance #4).
 */
export function checkOwnershipBoundary(manifest) {
  const findings = [];
  const targets = [
    ...(manifest.skills ?? []).map((e) => ({ target: e?.target, from: `skills[${e?.name}]` })),
    ...(manifest.commands ?? []).map((e) => ({ target: e?.target, from: `commands[${e?.name}]` })),
    ...(manifest.commandOverrides ?? []).map((e) => ({ target: e?.target, from: `commandOverrides[${e?.name}]` })),
    ...(manifest.plugin?.target ? [{ target: manifest.plugin.target, from: "plugin" }] : []),
  ];
  for (const { target, from } of targets) {
    if (typeof target !== "string") {
      findings.push({
        code: FINDING_CODES.OWNERSHIP_TOO_BROAD,
        from,
        target,
        message: `${from}: ownership target is not a string`,
      });
      continue;
    }
    const norm = target.replace(/\/+$/, ""); // strip trailing slashes
    if (FORBIDDEN_OWNERSHIP_TARGETS.has(norm) || FORBIDDEN_OWNERSHIP_TARGETS.has(target)) {
      findings.push({
        code: FINDING_CODES.OWNERSHIP_TOO_BROAD,
        from,
        target,
        message: `${from}: "${target}" is a parent directory — ownership targets must be specific files or skill/command dirs`,
      });
      continue;
    }
    if (/[*?]/.test(target)) {
      findings.push({
        code: FINDING_CODES.OWNERSHIP_TOO_BROAD,
        from,
        target,
        message: `${from}: "${target}" contains a glob wildcard — ownership targets must be concrete paths`,
      });
      continue;
    }
    // A skill/command dir target must have at least one path segment beneath
    // its root (e.g. skills/flywheel-x/, not skills/).
    const segs = norm.split("/").filter(Boolean);
    if ((segs[0] === "skills" || segs[0] === "commands") && segs.length < 2) {
      findings.push({
        code: FINDING_CODES.OWNERSHIP_TOO_BROAD,
        from,
        target,
        message: `${from}: "${target}" owns the "${segs[0]}" root wholesale`,
      });
    }
  }
  findings.sort(findingSort);
  return { ok: findings.length === 0, findings };
}

// ─── Managed-command loading ────────────────────────────────────────────────

/**
 * Read the bodies of every managed command source plus every command override
 * so the closure check can scan real content. A listed source that cannot be
 * read is reported as `source_missing` (the inventory check separately covers
 * removed managed commands; this covers override sources).
 *
 * @returns {Promise<{ commands: {name,content,source,kind}[], findings: object[] }>}
 */
export async function loadManagedCommands(repoRoot, manifest) {
  const findings = [];
  const specs = [
    ...(manifest.commands ?? []).map((e) => ({ name: e.name, source: e.source, kind: "command" })),
    ...(manifest.commandOverrides ?? []).map((e) => ({ name: e.name, source: e.source, kind: "command-override" })),
  ];
  const commands = [];
  for (const spec of specs) {
    if (!spec.source) continue;
    const abs = path.join(repoRoot, spec.source);
    try {
      const content = await readFile(abs, "utf8");
      commands.push({ name: spec.name, content, source: spec.source, kind: spec.kind });
    } catch (err) {
      findings.push({
        code: FINDING_CODES.SOURCE_MISSING,
        name: spec.name,
        source: spec.source,
        kind: spec.kind,
        message: `command source not readable at ${spec.source}: ${String(err)}`,
      });
    }
  }
  return { commands, findings };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Run all three checks against the live repo. Loads the manifest from
 * `opencode/manifest.json` unless one is supplied.
 *
 * @returns {Promise<{ ok, findings, checks, discovered }>}
 */
export async function validateManifest(repoRoot, opts = {}) {
  let manifest = opts.manifest;
  const findings = [];
  if (!manifest) {
    const manifestPath = opts.manifestPath ?? path.join(repoRoot, "opencode", "manifest.json");
    const loaded = await loadManifest(manifestPath);
    manifest = loaded.manifest;
    findings.push(...loaded.findings);
  } else {
    findings.push(...shapeCheckManifest(manifest));
  }

  const discovered = await discoverManaged(repoRoot, manifest);
  const inventory = checkInventory(manifest, discovered);
  const ownership = checkOwnershipBoundary(manifest);
  const loadedCommands = await loadManagedCommands(repoRoot, manifest);
  const closure = checkDelegationClosure(manifest, loadedCommands.commands);

  findings.push(
    ...inventory.findings,
    ...ownership.findings,
    ...loadedCommands.findings,
    ...closure.findings,
  );
  findings.sort(findingSort);

  return {
    ok: findings.length === 0,
    findings,
    checks: { inventory, ownership, closure, sourceLoad: loadedCommands },
    discovered,
  };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function findingSort(a, b) {
  return (
    String(a.code).localeCompare(String(b.code)) ||
    String(a.kind ?? a.command ?? a.from ?? "").localeCompare(String(b.kind ?? b.command ?? b.from ?? "")) ||
    String(a.name ?? a.target ?? "").localeCompare(String(b.name ?? b.target ?? ""))
  );
}

// ─── CLI entry (dogfood) ────────────────────────────────────────────────────

async function main(argv) {
  const repoRoot = argv[2]
    ? path.resolve(argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  let result;
  try {
    result = await validateManifest(repoRoot);
  } catch (err) {
    process.stdout.write(`[ERROR] validate: ${String(err)}\n`);
    return 2;
  }
  const { ok, findings, discovered, checks } = result;
  process.stdout.write(
    `[CHECK] repo=${repoRoot} skills=${discovered.skills.length} commands=${discovered.commands.length} delegations-resolved=${checks.closure.resolved.length}\n`,
  );
  if (ok) {
    process.stdout.write("[OK] opencode manifest inventory + ownership + closure valid.\n");
    return 0;
  }
  for (const f of findings) {
    const loc = f.command ? ` (${f.command})` : f.name ? ` (${f.name})` : f.from ? ` (${f.from})` : "";
    process.stdout.write(`[ERROR] ${f.code}${loc}: ${f.message}\n`);
  }
  process.stdout.write(`[ERROR] ${findings.length} finding(s).\n`);
  return 1;
}

// Only run the CLI when executed directly, never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
