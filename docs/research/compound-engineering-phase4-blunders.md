# Compound Engineering Plugin — Phase 4 Blunder Hunt

**Repository:** https://github.com/EveryInc/compound-engineering-plugin
**Local clone:** `/tmp/research-compound-engineering`
**Investigation Date:** 2026-04-23
**Focus:** Concrete bugs, known pitfalls, design regrets that demonstrably break under real conditions.

---

## Severity Summary
- **P0:** 3
- **P1:** 5
- **P2:** 4
- **Total:** 12

---

## 1. P0 — `sanitizePathName` only strips colons; all other unsafe chars reach filesystem

**File:line:** `src/utils/files.ts:84-86`

```ts
export function sanitizePathName(name: string): string {
  return name.replace(/:/g, "-")
}
```

**Repro/Trigger:** A `ClaudeAgent` with `name: "../../etc/passwd"` or `name: "foo/../../bar"` is loaded (frontmatter-driven; nothing upstream rejects it). `sanitizePathName` returns the string **unchanged** for everything that isn't a colon. `src/targets/codex.ts:68, 82` then calls `path.join(skillsRoot, sanitizePathName(skill.name))` to build the write target, and `src/targets/opencode.ts:102` writes `path.join(openCodePaths.agentsDir, ``${safeName}.md``)`. OpenCode/Codex writers have **no** `validatePathSafe` guard upstream (only `src/targets/kiro.ts:157-161` does).

**Impact:** Install of a hostile/malformed plugin can write or overwrite arbitrary files under the user's home. `copySkillDir` (`src/utils/files.ts:165`) follows into that path without containment check. Full path traversal at install time.

**Lesson for agent-flywheel-plugin:** Any user/author-supplied `name` used to build a filesystem path must be validated at a single chokepoint — not per-target. Reject `..`, `/`, `\`, NUL, absolute paths, and require `resolvedPath.startsWith(baseDir + path.sep)` as defense-in-depth. Only `kiro.ts` got this right here — do it once, centrally.

---

## 2. P0 — Unauthenticated `git clone` over HTTPS with no checksum/signature verification

**File:line:** `src/commands/install.ts:286-329`

```ts
async function cloneGitHubRepo(source: string, destination: string, branch?: string): Promise<void> {
  const args = ["git", "clone", "--depth", "1"]
  if (branch) args.push("--branch", branch)
  ...
  const proc = Bun.spawn(args, { ... })
}
```

**Repro/Trigger:** `compound-plugin install <name>` with no local path triggers a GitHub clone. The default source is hard-coded to `https://github.com/EveryInc/compound-engineering-plugin` (`src/commands/install.ts:310-314`), but `COMPOUND_PLUGIN_GITHUB_SOURCE` env var overrides it with **zero validation**. After cloning, contents are trusted: frontmatter is parsed, skills are copied, MCP configs merged into `~/.codex`, `~/.opencode`, symlinks created under `~/.agents/skills/`. No commit-SHA pinning, no signature, no checksum.

**Impact:** (a) MITM / DNS poisoning / compromised mirror → arbitrary code installed as MCP server or agent prompt with tool-use permissions. (b) Env-var override lets a malicious `.envrc` redirect the install to an attacker-controlled repo. (c) `--branch <untrusted>` is passed straight to `git` — while not a shell injection (args are array-spawned), it accepts any ref including `--upload-pack=...` if Bun.spawn ever flattens args (it doesn't today, but the pattern is fragile).

**Lesson for agent-flywheel-plugin:** Plugin install is a supply-chain event. Pin commit SHAs, verify a signature or `integrity:` hash against the manifest, and make the clone source configurable only via an allow-list, not a raw env var. Log the exact source resolved before any fs writes.

---

## 3. P0 — `forceSymlink` unlinks an existing regular file without checking ownership

**File:line:** `src/utils/symlink.ts:8-28`

```ts
if (stat.isDirectory()) {
  console.warn(...)
  return
} else {
  // Regular file - remove it
  await fs.unlink(target)
}
```

**Repro/Trigger:** Installer calls `forceSymlink(ceSkillDir, "~/.agents/skills/<name>")`. If a user already has a **real file** at `~/.agents/skills/<name>` (e.g., a `README` or a symlink-to-file they created), the code happily `fs.unlink`s it with zero ownership check. The directory branch (`isDirectory()`) is guarded with a warning; the file branch is not. The code comment even says "Regular file - remove it" — that's the bug, stated in prose.

**Impact:** Installing CE can silently delete user-created files in `~/.agents/skills/`. Unlike the symlink branch (which the comment correctly marks "Safe to remove existing symlink"), this destroys data without a backup. Contrast with `src/utils/files.ts:4-15 backupFile` which the writers use elsewhere — this path skips it.

**Lesson for agent-flywheel-plugin:** Before `fs.unlink`, require a positive ownership signal (symlink resolving back to a managed root, or a manifest entry claiming the path). `backupFile()` before destructive ops is cheap — always do it. Treat `~/.agents/` as shared-tenant space, not a CE-owned directory.

---

## 4. P1 — Unclosed YAML frontmatter fence silently swallowed as body

**File:line:** `src/utils/frontmatter.ts:22-25`

```ts
if (endIndex === -1) {
  return { data: {}, body: raw }
}
```

**Repro/Trigger:** Author writes an agent file starting with `---\nname: foo\ndescription: bar` and forgets the closing `---`. Parser finds no end fence, returns `{data: {}, body: raw}` — entire file including the `---\nname: foo...` lines becomes the agent body. The agent installs with **no name, no description, no tools**, and the raw YAML text leaks into the prompt.

**Impact:** Silent data loss at install time. The `name` the converter expects (`src/parsers/claude.ts`) is missing, so downstream some code paths will fail with obscure errors far from the real mistake. `missing fence` is a common authoring bug that deserves a loud error, not "I'll pretend it's prose".

**Lesson for agent-flywheel-plugin:** A `---` on line 1 is a strong intent signal. If the closing fence is missing, **throw** with a helpful hint ("frontmatter started at line 1 but never closed — add `---`"). The current triple-fault-tolerance is too tolerant in exactly one place.

---

## 5. P1 — Skill/command name with `:` produces directory traversal via `path.join(..., name.split(":"))`

**File:line:** `src/targets/opencode.ts:106`, also `:73`

```ts
const dest = path.join(openCodePaths.commandDir, ...commandFile.name.split(":")) + ".md"
```

**Repro/Trigger:** A command with `name: "..:..:etc:passwd"` spreads into `path.join(dir, "..", "..", "etc", "passwd") + ".md"`. No `validatePathSafe` is called on `commandFile.name` before the split. The spread turns colon segments into path segments, so `..` becomes a real traversal component.

**Impact:** Arbitrary file write under the user's config dir (or beyond, depending on how many `..` segments). Kiro's `validatePathSafe` (`src/targets/kiro.ts:157`) exists precisely for this — but opencode's writer forgot to call it on commandFiles.

**Lesson for agent-flywheel-plugin:** Any `split`/`spread` into `path.join` must be preceded by segment-level validation. A per-target defensive check is not a substitute for a central "author-supplied name" validator.

---

## 6. P1 — Concurrent `Promise.all(rootsToClean.map(cleanupX))` races on shared legacy-backup dir

**File:line:** `src/commands/cleanup.ts` (gemini case ~line 610, copilot/windsurf similar)

**Repro/Trigger:** When `cwd === $HOME`, the workspace root `<cwd>/.gemini` and home root `~/.gemini` resolve to the same directory. The authors added `dedupeRoots` specifically because a prior bug ran `cleanupGemini` concurrently on the same directory; both passes tried `fs.rename(file, legacy-backup/<timestamp>/file)` and one got `ENOENT`. The comment at `cleanup.ts:~608` documents the fix. Today: the timestamp format in `pi.ts:archiveLegacyInstallManifestIfOwned` is `new Date().toISOString().replace(/[:.]/g, "-")` — **second-precision**. Two renames in the same second collide.

**Impact:** Reinstall within one wall-clock second (CI scripts, test suites, scripted upgrades) can still hit `ENOENT`/`EEXIST` intermittently. The `dedupeRoots` fix is incomplete — it protects against path-aliasing races but not time-colliding timestamps.

**Lesson for agent-flywheel-plugin:** Any "backup with timestamp" path must include nanosecond precision or a counter/PID. Never use `toISOString()` alone for backup uniqueness — it's second-resolution and WILL collide under test harnesses.

---

## 7. P1 — `readJson` parse failures silently replaced with empty config

**File:line:** `src/targets/kiro.ts:91-96`

```ts
if (await pathExists(mcpPath)) {
  try {
    existingConfig = await readJson<Record<string, unknown>>(mcpPath)
  } catch {
    console.warn("Warning: existing mcp.json could not be parsed and will be replaced.")
  }
}
```

**Repro/Trigger:** User has a valid but unusual `mcp.json` (e.g., with a BOM, comments, or a transient truncation mid-write from another tool). `readJson` throws, bare `catch {}` drops the error, `existingConfig` stays `{}`, and the merged output **overwrites the user's config** with only CE's own servers. The warning goes to stderr only — no prompt, no abort.

**Impact:** User data loss. `mcp.json` can contain auth tokens, custom MCP server definitions, project-specific integrations — all wiped. `backupFile` is called elsewhere but **not here** before the replacement write at `kiro.ts:104`.

**Lesson for agent-flywheel-plugin:** When "merging" user-owned JSON, `catch` on parse failure should either (a) abort with a recovery hint, or (b) `backupFile()` first, then proceed. Writing over unreadable user config is a P0-quality data loss bug that got P1 here only because it's bounded to `mcp.json`.

---

## 8. P1 — Frontmatter regex `/\r?\n/` does not cover classic Mac `\r`-only line endings and CRLF bodies preserve `\r`

**File:line:** `src/utils/frontmatter.ts:9`

```ts
const lines = raw.split(/\r?\n/)
```

**Repro/Trigger:** (a) A file with lone `\r` line endings (unusual but possible for editors that save from Excel, legacy macOS, or web-paste) splits into one line, frontmatter detection fails, entire file becomes body. (b) More common: CRLF input → split OK, but when `body = lines.slice(endIndex + 1).join("\n")`, any `\r` left inside multi-char sequences is preserved, producing mixed-ending output that downstream shell scripts (`skills/*/scripts/*.sh`) choke on with `$'\r': command not found`.

**Impact:** Plugins authored on Windows with CRLF, or hand-edited in odd editors, produce subtly broken installs. The shim-test at `tests/skills/ce-release-notes-helper.test.ts:20-40` writes a shell script — if CRLF leaks into such a script, it fails cryptically.

**Lesson for agent-flywheel-plugin:** Normalize line endings at read time (`raw.replace(/\r\n?/g, "\n")`), not at split time. Lock down to LF-only for anything that will be `chmod +x`'d.

---

## 9. P2 — `pathExists` and `backupFile` return true/null by swallowing all errors including EACCES

**File:line:** `src/utils/files.ts:12-14, 17-23`

```ts
export async function pathExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true }
  catch { return false }   // EACCES, EIO, ELOOP all collapse to "doesn't exist"
}
```

**Repro/Trigger:** A path exists but is not accessible (permissions, too-deep symlink loop, stale NFS handle). `pathExists` returns `false`. `backupFile` also returns `null` on any error — so a backup-intended-then-overwrite sequence may skip the backup silently and proceed to overwrite.

**Impact:** Installer "confidently proceeds" on a pre-existing but unreadable path, potentially triggering write-over-write rather than detect-and-preserve. Diagnostics become nearly impossible ("user says they had a file there, we didn't see it").

**Lesson for agent-flywheel-plugin:** Distinguish "ENOENT" from "all other fs errors". Helper contracts should be `pathExists` → true/false for ENOENT, re-throw everything else. Otherwise bugs surface as silent data corruption.

---

## 10. P2 — `copySkillDir` follows directory entries without symlink check

**File:line:** `src/utils/files.ts:165-193`

**Repro/Trigger:** A malicious/buggy plugin contains `skills/foo/link -> /etc`. `fs.readdir(..., {withFileTypes: true})` returns `link` as a symlink; `entry.isDirectory()` returns `false` for the symlink itself (since `readdir` doesn't follow by default), so the recursion skips it — **but** `entry.isFile()` is also false, meaning the entry is silently dropped. However, if the symlink points to a **file**, `isFile()` returns `false` for the *link*; `fs.copyFile(sourcePath, targetPath)` then **follows** the symlink and copies `/etc/passwd` content into the user's opencode/pi skills tree.

**Impact:** Cross-boundary content exfiltration into tracked/managed directories. Less catastrophic than traversal out of a root, but still surprising: plugin contents leak host files into a managed skill tree that may be shared or committed.

**Lesson for agent-flywheel-plugin:** Always `fs.lstat` before copying, and either refuse symlinks or resolve-and-contain within a source allowlist. `fs.cp` with `dereference: false` in modern Node is simpler than rolling your own walker.

---

## 11. P2 — `Bun.spawn` required for `cloneGitHubRepo`; zero fallback if run under plain Node

**File:line:** `src/commands/install.ts:320`

**Repro/Trigger:** `const proc = Bun.spawn(args, {...})`. `index.ts` has `#!/usr/bin/env bun` so the assumption is "always Bun", but nothing enforces it. If someone `node dist/index.js` or a test runner bypasses the shebang, `Bun is not defined` at runtime with no graceful fallback to `child_process.spawn`.

**Impact:** Hard crash in environments where Bun isn't present — ironic given the target users are polyglot AI-editor authors on assorted stacks (Cursor on Windows, Codex on Linux CI, etc.). Error surfaces mid-install, potentially after tempdir is created.

**Lesson for agent-flywheel-plugin:** Runtime detection + abstraction for `spawn` is a 10-line file that saves a whole class of support issues. If you pick a non-standard runtime primitive, either fail fast at startup ("Bun required: version X+") or abstract it.

---

## 12. P2 — `escapeForRegex` exists but name-sanitization for codex TOML doesn't use it for `ce_platforms` values

**File:line:** `src/targets/codex.ts` (around legacy-marker search) + TOML string formatting via `JSON.stringify`

**Repro/Trigger:** Codex agent/skill metadata containing TOML-special characters is rendered via `formatTomlString(value)` = `JSON.stringify(value)` (codex target near line ~470). This works for strings but if metadata contains **control characters** (e.g., `\x00`, real newlines stored as `\n` sequences from YAML multi-line blocks), JSON-stringify escapes them correctly — but Codex's TOML parser may not match Node's unescape behavior for all TOML edge cases (tab handling, unicode escapes in basic strings). Evidence: the author already wrote `escapeForRegex` defensively for the managed-block stripper — indicating awareness that metadata flows into regex-sensitive contexts. The TOML path relies on JSON==TOML-basic-string equivalence, which is **not a spec guarantee**.

**Impact:** Rare but real: agent descriptions with unusual characters (emoji, ZWNJ, paired surrogates) may produce malformed TOML that Codex silently rejects, dropping the agent from the installed set with no clear error.

**Lesson for agent-flywheel-plugin:** When serializing to format X, use a format-X-specific escaper, not "it happens to look like JSON". Be suspicious of `JSON.stringify(x)` as a shortcut for any non-JSON output.

---

## Cross-cutting patterns

- **Path validation is per-target, not central.** Only `kiro.ts` has `validatePathSafe`. Opencode, codex, pi, gemini all call `sanitizePathName` (which only replaces `:`) and trust the result. One central validator would eliminate items 1 and 5.
- **Bare `catch {}` is rampant** (20+ sites found): `kiro.ts:94`, `opencode.ts:27`, `codex.ts:434,438,447`, `files.ts:12,21`, `legacy-cleanup.ts:340,397,570,602`, `json-config.ts:39`, `cleanup.ts:605,716`, `plugin-path.ts:62`. Each one is a place where a real bug will be silent.
- **"It works on my machine" assumption:** Bun runtime, LF line endings, macOS-style realpath. Comments in code (`src/commands/cleanup.ts` ~608) reveal the author has already been bitten by path-aliasing races.
- **Timestamped backups use second precision** — collisions under automation are guaranteed, not hypothetical.

---

## Files referenced

| Bug # | Primary file:line |
|-------|-------------------|
| 1     | `src/utils/files.ts:84-86` |
| 2     | `src/commands/install.ts:286-329` |
| 3     | `src/utils/symlink.ts:8-28` |
| 4     | `src/utils/frontmatter.ts:22-25` |
| 5     | `src/targets/opencode.ts:106` |
| 6     | `src/commands/cleanup.ts:~608`, `src/targets/pi.ts:~archive` |
| 7     | `src/targets/kiro.ts:91-96` |
| 8     | `src/utils/frontmatter.ts:9` |
| 9     | `src/utils/files.ts:12-23` |
| 10    | `src/utils/files.ts:165-193` |
| 11    | `src/commands/install.ts:320` |
| 12    | `src/targets/codex.ts` (formatTomlString) |
