# Compound Engineering Plugin — Phase 1 Research Exploration

**Repository:** https://github.com/EveryInc/compound-engineering-plugin  
**Investigation Date:** 2026-04-23  
**Focus:** Architecture, abstractions, entry points, testing, and elegant patterns.

---

## 1. Architecture Overview

**Compound Engineering** is a **plugin-to-plugin converter and installer system** that unifies 36 skills and 51 agents written for Claude Code into multiple AI editor formats (Copilot, Codex, OpenCode, Pi, Kiro, Gemini, Factory Droid). Its purpose is to encode once, target many—avoiding duplication across fragmented AI tooling ecosystems.

### Core Loop
The project embodies a **compound learning workflow**:
1. **Brainstorm** (`/ce-brainstorm`) — interactive Q&A to shape requirements
2. **Plan** (`/ce-plan`) — turn ideas into detailed implementation
3. **Work** (`/ce-work`) — execute with worktrees and task tracking
4. **Review** (`/ce-code-review`) — multi-agent code review
5. **Compound** (`/ce-compound`) — document learnings for future cycles

### Directory Structure
```
plugins/compound-engineering/        # Main 2.3 MB plugin
  agents/                            # 51 agents (*.agent.md files)
  skills/                            # Skills with internal scripts/tests
  .cursor-plugin/
    plugin.json                      # Cursor/Codex plugin manifest
src/                                 # CLI for conversion & installation
  commands/                          # convert, install, list, cleanup
  parsers/claude.ts                  # Load Claude Code plugins
  types/                             # Type definitions for 7 editor formats
  converters/                        # claude-to-*.ts (7 converters)
  targets/                           # Writers for each format
  utils/                             # Frontmatter, path resolution, etc.
tests/                               # ~30 unit tests + fixtures
docs/                                # Plans (1.4M), brainstorms, specs, solutions
```

---

## 2. Key Abstractions and Patterns

### Source Format: Claude Code Plugin
**File:** `src/types/claude.ts` (lines 1–100)

The system treats Claude Code plugin format as the **canonical source**:

```typescript
type ClaudePlugin = {
  root: string                           // Plugin directory
  manifest: ClaudeManifest               // .claude-plugin/plugin.json
  agents: ClaudeAgent[]                  // *.agent.md with frontmatter
  commands: ClaudeCommand[]              // *.md with model invocation
  skills: ClaudeSkill[]                  // Directories with SKILL.md
  hooks?: ClaudeHooks                    // Editor lifecycle hooks
  mcpServers?: Record<string, ...>       // MCP server config
}

type ClaudeAgent = {
  name: string
  description?: string
  model?: string
  body: string                           // Markdown prompt body
  sourcePath: string                     // Absolute path to *.agent.md
}

type ClaudeCommand = {
  name: string
  allowedTools?: string[]                // Tool whitelist
  disableModelInvocation?: boolean       // Template vs. invokable
  body: string
  sourcePath: string
}

type ClaudeSkill = {
  name: string
  ce_platforms?: string[]                // Platform availability filter
  sourceDir: string
  skillPath: string
}
```

**Design pattern:** Metadata in **YAML frontmatter**, body in **Markdown**. This decouples presentation (prose, examples) from data structure, enabling lossless round-tripping across editors.

### Plugin Loader
**File:** `src/parsers/claude.ts` (lines 40–100)

Key insight: **Lazy loading by walking the filesystem**. Agents, commands, skills are discovered by scanning directories, not pre-enumerated in a list.

```typescript
export async function loadClaudePlugin(inputPath: string): Promise<ClaudePlugin> {
  const root = await resolveClaudeRoot(inputPath)     // Find .claude-plugin/plugin.json
  const manifest = await readJson(manifestPath)
  const agents = await loadAgents(resolveComponentDirs(root, "agents", manifest.agents))
  const commands = await loadCommands(...)
  const skills = await loadSkills(...)
  const hooks = await loadHooks(root, manifest.hooks)
  const mcpServers = await loadMcpServers(root, manifest)
  return { root, manifest, agents, commands, skills, hooks, mcpServers }
}
```

Frontmatter parsing handles **missing frontmatter gracefully**—returns empty `{}` and treats entire file as body.

### Converter Registry Pattern
**File:** `src/targets/index.ts` (lines 42–80)

Abstract converter/writer pattern:

```typescript
type TargetHandler<TBundle = unknown> = {
  name: string
  implemented: boolean
  defaultScope?: "global" | "workspace"
  supportedScopes?: ("global" | "workspace")[]
  convert: (plugin: ClaudePlugin, options: ClaudeToOpenCodeOptions) => TBundle | null
  write: (outputRoot: string, bundle: TBundle, scope?: TargetScope) => Promise<void>
}

const targets: Record<string, TargetHandler> = {
  opencode: { name: "opencode", implemented: true, convert: convertClaudeToOpenCode, write: writeOpenCodeBundle },
  codex: { ... },
  pi: { ... },
  // ... 4 more
}
```

Each target maps to **two functions**: `convert()` (format translation) and `write()` (filesystem I/O). This **separation of concerns** enables testing conversion logic independently of file writes.

### CLI Architecture
**File:** `src/index.ts` (lines 1–20), `src/commands/convert.ts`

Uses **Citty** (minimal CLI framework):

```typescript
defineCommand({
  meta: { name: "compound-plugin", version: "...", description: "..." },
  subCommands: {
    cleanup: () => cleanup,
    convert: () => convert,
    install: () => install,
    list: () => listCommand,
    "plugin-path": () => pluginPath,
  },
})
```

Entry point: `/src/index.ts` (shebang: `#!/usr/bin/env bun`) for fast bootstrap. Main pipeline in `convert.ts`:
1. Load Claude plugin via `loadClaudePlugin()`
2. Validate target and scope
3. Call `target.convert()` to produce language-specific bundle
4. Call `target.write()` to persist
5. Optionally run post-install hooks (e.g., `codex plugin install`)

---

## 3. Entry Points and Data Flows

### Command-Driven Pipeline
**File:** `src/commands/convert.ts` (lines 1–80)

```
User: bun src/index.ts convert ./plugins/compound-engineering --to codex
  ↓
parseArgs() → { source, to, output, scope, permissions, ... }
  ↓
loadClaudePlugin(source)
  → ClaudePlugin { agents[], commands[], skills[], hooks, mcpServers }
  ↓
validateScope(targetName, target, scopeArg)
  ↓
target.convert(plugin, options: { agentMode, permissions, inferTemperature, ... })
  → Format-specific bundle (CodexBundle, OpenCodeBundle, etc.)
  ↓
target.write(outputRoot, bundle, scope)
  → Write to ~/.codex, ~/.opencode, ./.pi, etc.
  ↓
[Optional] Run hooks: codex plugin install, npm rebuild, etc.
```

### Tool Name Translation
**File:** `src/converters/claude-to-kiro.ts` (lines 20–30)

Different editors have different tool names. Kiro uses a **mapping table**:

```typescript
const CLAUDE_TO_KIRO_TOOLS: Record<string, string> = {
  Bash: "shell",
  Write: "write",
  Read: "read",
  Edit: "write",        // Lossy: Kiro doesn't have surgical edit
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  Task: "use_subagent",
}
```

**Elegant pattern:** Stateful translation during conversion—agents reference tools by their source names; converter rewrites references during output.

### Scope Resolution
**File:** `src/utils/resolve-output.ts`

Two scopes:
- **`global`** — Install to user home (`~/.codex`, `~/.opencode`, etc.)
- **`workspace`** — Install to project directory (`./.codex`, `./.pi`, etc.)

Each target defines `defaultScope` and `supportedScopes`. Scope determines output path and installation visibility (project-local vs. user-wide).

---

## 4. Testing Approach

**Framework:** Bun's native test runner (`bun:test`)  
**Coverage:** ~30 unit tests in `/tests`  
**Fixtures:** Real-world examples in `/tests/fixtures` (invalid paths, MCP config, session history)

### Key Test Categories

1. **Parser tests** — `claude-parser.test.ts`
   - Load agents, commands, skills with and without frontmatter
   - Invalid YAML graceful error handling
   - Path resolution (relative, absolute, `~` expansion)

2. **Converter tests** — `codex-converter.test.ts`, `pi-converter.test.ts`, etc.
   - Test each converter in isolation
   - Verify tool name mapping (e.g., Bash → shell)
   - Validate output shape matches target format

3. **Writer tests** — `codex-writer.test.ts`, `opencode-writer.test.ts`
   - Verify file output structure
   - Test scope resolution (global vs. workspace)
   - Cleanup logic for stale artifacts

4. **Skill tests** — `/tests/skills/`
   - Inline Python/shell scripts used by compound-engineering skills
   - Example: `ce-release-notes-helper.test.ts` spawns subprocess and mocks `gh` CLI

5. **Integration tests** — `converter.test.ts`, `cli.test.ts`
   - Full end-to-end: load plugin → convert → write
   - Test `install` and `cleanup` commands

### Clever Test Technique
**File:** `tests/skills/ce-release-notes-helper.test.ts` (lines 20–40)

Testing CLI-heavy skills by shimming external tools:

```typescript
async function makeGhShim(stdout: string, exitCode = 0): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ce-rn-gh-"))
  const ghPath = path.join(dir, "gh")
  const script = `#!/usr/bin/env bash\nprintf '%s' ${shellQuote(stdout)}\nexit ${exitCode}\n`
  await fs.writeFile(ghPath, script, { mode: 0o755 })
  return ghPath
}

// Test: runHelper(["--list-releases", "..."], { ghBin: ghShim })
```

Avoids network calls; injects fake `gh` binary via env var. **Reproducible, fast, testable.**

---

## 5. Notable Implementation Techniques

### Frontmatter Parser with Graceful Fallback
**File:** `src/utils/frontmatter.ts` (lines 20–50)

```typescript
export function parseFrontmatter(raw: string): FrontmatterResult {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: {}, body: raw }  // ← No frontmatter? Return all as body
  }

  // ... find closing `---` ...
  if (endIndex === -1) {
    return { data: {}, body: raw }  // ← Unclosed fence? Treat as plain text
  }

  const yamlText = lines.slice(1, endIndex).join("\n")
  const body = lines.slice(endIndex + 1).join("\n")
  try {
    const parsed = load(yamlText)
    return { data, body }
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter in ${sourcePath}...\n${hint}`)
  }
}
```

**Elegance:** Triple-fault tolerance (no delimiter, unclosed fence, bad YAML), plus **helpful error hints** for common mistakes (e.g., "Tip: quote values containing colons").

### Lazy File Walking with Glob
**File:** `src/utils/files.ts`

Instead of enumerating agents/commands/skills in a config, walk the directory tree. Skills directories are auto-discovered by presence of `SKILL.md`. This **scales without config bloat** and enables adding new skills without touching manifests.

### Platform-Conditional Skills
**File:** `src/types/claude.ts`, converter logic

Skills can declare `ce_platforms: ["codex", "kiro"]` to opt out of other targets:

```typescript
export function filterSkillsByPlatform(skills: ClaudeSkill[], platform: string): ClaudeSkill[] {
  return skills.filter((skill) => !skill.ce_platforms || skill.ce_platforms.includes(platform))
}
```

Used during conversion to **skip incompatible content** without modifying source files.

### Agent Invocation Mode Inference
**File:** `src/converters/claude-to-opencode.ts` (temperature inference)

Some agents are deterministic templates (e.g., "design token generator"), others need creativity. The converter reads agent `name` and `description` to infer:

```typescript
inferTemperature: boolean  // Option to guess temperature from metadata
```

**Pragmatic heuristic:** Names like "code-reviewer" → low temp (consistent, careful); "ideation-agent" → high temp (creative, exploratory).

### Symlink Management for Codex
**File:** `src/utils/symlink.ts`

Codex skills install globally (`~/.codex/skills/compound-engineering/`), but old CE versions created symlinks in `~/.agents`. The installer:
1. Detects stale symlinks pointing to old CE paths
2. Removes them safely (only if they point back to CE, not user code)
3. Prevents shadowing native Codex plugins

**Defensive:** Avoids leaving dangling symlinks or accidentally deleting user files.

### Scope-Driven Installation
**File:** `src/targets/codex.ts`, `opencode.ts`

Global scope expands `~` to user home; workspace scope uses project-relative paths. Each target's `write()` function handles scope-specific paths:

```typescript
const outputRoot = scopeArg === "global"
  ? expandHome(codexHome || "~/.codex")
  : resolvePath(output || ".")
```

Enables **same skills, different visibility levels** (useful for testing in local projects before promoting to user global config).

---

## Summary

**Compound Engineering** elegantly solves the AI editor fragmentation problem through:

- **Canonical source format** (Claude Code plugin + YAML frontmatter + Markdown body)
- **Pluggable converter/writer architecture** (7 targets, 2 functions each)
- **Graceful metadata parsing** (no frontmatter? works fine)
- **Lazy filesystem discovery** (no config needed for new agents/skills)
- **Defensive symlink management** (Codex integration without side effects)
- **Subprocess shimming in tests** (fast, deterministic, reproducible)

The workflow compounds learning: each brainstorm refines the next plan, each review catches more issues, patterns get documented in `docs/` for future cycles.

---

## File References for Follow-Up

| Component | Key Files | Lines |
|-----------|-----------|-------|
| Source type system | `src/types/claude.ts` | 1–100 |
| Plugin loader | `src/parsers/claude.ts` | 1–100 |
| Target registry | `src/targets/index.ts` | 1–80 |
| Conversion pipeline | `src/commands/convert.ts` | 1–100 |
| Converter examples | `src/converters/claude-to-*.ts` | Various |
| Frontmatter parser | `src/utils/frontmatter.ts` | 1–60 |
| Scope resolution | `src/utils/resolve-output.ts` | All |
| Tests | `tests/*.test.ts` | ~30 files |
| Skill tests (subprocess) | `tests/skills/ce-release-notes-helper.test.ts` | 20–40 |

---

