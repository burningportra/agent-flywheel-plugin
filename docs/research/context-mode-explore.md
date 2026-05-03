# Context-Mode Research: `ctx upgrade` + `ctx doctor` Patterns

## 1. Repo Overview

**context-mode** is a multi-platform MCP plugin (1.0.103) that reduces context by 98% via sandboxed execution, FTS5 knowledge bases, and intent-driven search. It detects platform at runtime (Claude Code, Gemini CLI, VS Code Copilot, OpenCode, Cursor, JetBrains Copilot) and adapts hooks, configuration, and registry syncing per-platform. The upgrade and doctor commands live in `/src/cli.ts` and are driven by platform-specific adapter interfaces in `/src/adapters/`.

---

## 2. `ctx upgrade` Implementation

**Location:** `/src/cli.ts`, lines ~500–730 (async function `upgrade()`)

### How it Works (Step by Step)

1. **Platform Detection**
   - Calls `detectPlatform()` (from `adapters/detect.ts`) to identify running platform + confidence level + reason
   - Loads adapter via `getAdapter(platform)` for platform-specific behavior

2. **Version Management**
   - **Current version:** `getLocalVersion()` reads `/package.json` in plugin root
   - **Latest version:** `fetchLatestVersion()` makes HTTPS request to `https://registry.npmjs.org/context-mode/latest`, parses response for `data.version`
   - Uses native `node:https` (not global fetch) to avoid Windows libuv assertion race with `process.exit()`

3. **Download via Git Clone**
   - Clones `https://github.com/mksglu/context-mode.git` with `--depth=1` to `/tmp/context-mode-upgrade-{timestamp}`
   - 30s timeout; reads file list from cloned repo's `package.json` for automatic inclusion of new dirs (e.g., `insight/`)

4. **In-Place Installation**
   - Copies cloned files to plugin root (overwrite existing)
   - Writes `.mcp.json` config (MCP server manifest) with correct paths
   - Changes tracked in `changes[]` array

5. **Rebuild & Install Dependencies**
   - Runs `npm install --production` (no audit, no fund) with 60s timeout
   - If not on OpenCode/Kilo: Rebuilds native addon `better-sqlite3` for current Node.js ABI (fixes #131)
     - Fallback: warns user if rebuild fails, suggests manual `npm rebuild better-sqlite3`

6. **Update Global npm**
   - Runs `npm install -g <pluginRoot>` to make `context-mode` command available globally
   - Skips with warning if sudo not available

7. **Platform-Specific Fixes**
   - Calls `adapter.configureAllHooks(pluginRoot)` — each adapter writes hook configs into platform settings
   - Calls `adapter.setHookPermissions(pluginRoot)` — chmod +x hook scripts (Unix)
   - Calls `adapter.updatePluginRegistry(pluginRoot, newVersion)` — syncs plugin registry files (`.claude-plugin/plugin.json`, marketplace files, etc.)

8. **Final: Run Doctor**
   - Spawns child process: `node <cliPath> doctor` to verify upgrade
   - Runs doctor checks as inline output (not captured)

### Output & UX
- Uses `@clack/prompts` for spinners, colored output, step progress
- `picocolors` for ANSI colors: cyan (info), green (pass), yellow (warn), red (fail), magenta (header)
- Clears terminal if TTY on startup
- Shows platform name + detection confidence + reason
- Each step has spinner + success/warn message
- Final outro: green if all steps pass, yellow if warnings

### Failure Handling
- Git clone timeout → error, skip upgrade
- npm install partial → cleans up `node_modules`, prompts retry
- Native rebuild → warns, suggests manual fix
- npm global install → skips with info, suggests manual
- Doctor subprocess → catches error, warns user to restart session

---

## 3. `ctx doctor` Implementation

**Location:** `/src/cli.ts`, lines ~350–495 (async function `doctor(): Promise<number>`)

### Checks Performed (Enumerated)

1. **Platform Detection** — name + confidence + reason
2. **Runtime Detection** (via `detectRuntimes()` from `runtime.ts`)
   - Node.js version + path
   - Bun installed?
   - Python, Ruby, Go, Rust, PHP, Perl, R, Elixir present?
   - Displays as summary note

3. **Performance Tier**
   - ✓ FAST if Bun detected (for JS/TS execution)
   - ⚠ NORMAL if only Node.js (suggests Bun install for 3-5x speedup)

4. **Language Coverage** (critical)
   - Counts available language runtimes across 11 total languages
   - Calc: `(available.length / 11) * 100`
   - Fail (critical) if < 2 languages available
   - Info if >= 2, message lists available languages

5. **MCP Server Test** (critical)
   - Imports the MCP server module to verify it loads
   - Catch MODULE_NOT_FOUND → warn, skip (module missing)
   - Catch other errors → critical fail + message

6. **FTS5 Database** (critical)
   - Checks if FTS5 (better-sqlite3 native addon) is loadable
   - Similar pattern: module check, critical fail if missing

7. **Hooks Configuration** (platform-specific)
   - Calls `adapter.validateHooks(pluginRoot)`
   - Adapter returns array of `DiagnosticResult` (check, status, message, fix hint)
   - Each result logged as PASS/FAIL with colored output
   - Example: "Claude Code hooks" PASS if all pretooluse, posttooluse, sessionstart scripts exist + configured

8. **Hook Script Exists**
   - Checks read access to `/hooks/pretooluse.mjs` specifically
   - PASS if readable, FAIL if missing

9. **Plugin Registration** (adapter-specific)
   - Calls `adapter.checkPluginRegistration()`
   - Returns status + message (e.g., "Claude Code plugin enabled in .claude/settings.json")
   - PASS if installed + enabled, INFO if standalone mode, FAIL if config missing

10. **npm (MCP) Version**
    - Compares `localVersion` vs `latestVersion` from npm registry
    - PASS if equal
    - WARN if differs (suggests `/context-mode:ctx-upgrade`)
    - WARN if can't reach registry

11. **Platform Registry Version** (adapter-specific)
    - Calls `adapter.getInstalledVersion()` for platform-specific registry (e.g., Claude Code's `.claude-plugin/plugin.json`)
    - PASS if up-to-date, WARN if behind, INFO if standalone

### Output Format
- Each check: `[x]` PASS (green), `[ ]` FAIL (red), `[-]` WARN (yellow), `[*]` INFO (dim)
- Severity tracking: `criticalFails++` counter
- Exit code: 1 if critical fails, 0 otherwise
- Outro: green "Diagnostics complete!" if >= 4 languages, yellow "Some checks need attention" otherwise
- Markdown checklist style throughout

### Cross-Reference with Upgrade
- Doctor recommends upgrade when:
  - npm version out-of-date: shows `/context-mode:ctx-upgrade`
  - Platform version out-of-date: shows `/context-mode:ctx-upgrade`
  - Module missing after upgrade: suggests "restart session"
  - Hooks misconfigured: upgrade reconfigures them

---

## 4. Patterns for `/flywheel-doctor` + `/flywheel-setup`

### Pattern A: Platform-Aware Adapter Pattern
**What to borrow:** Multi-platform abstraction layer (`HookAdapter` interface)
- Define contract: `validateHooks()`, `configureAllHooks()`, `checkPluginRegistration()`
- Each platform adapter implements:
  - Settings read/write (Claude Code: `.claude/settings.json`, Gemini: config.json, etc.)
  - Hook config generation (return `HookRegistration` map)
  - Version detection (read from platform registry)
- `detectPlatform()` → `getAdapter(platform)` → dispatch all ops through adapter

**For agent-flywheel:** Create adapters for Claude Code, Gemini CLI, etc. with methods:
- `validateHooks()` → check your hook scripts exist + have correct paths in settings
- `configureAllHooks()` → write agent-mail hooks into platform config
- `getInstalledVersion()` → read flywheel version from platform registry
- `updatePluginRegistry()` → sync `.pi/extensions/agent-flywheel/package.json` and version manifests

### Pattern B: Spinner + Colored Output with @clack/prompts
**What to borrow:** UX for long-running ops
```typescript
import * as p from "@clack/prompts";
import color from "picocolors";

const s = p.spinner();
s.start("Step description");
// ... do work ...
s.stop(color.green("Success"));  // or color.yellow("Warning")

p.log.success(color.green("✓ Check") + " — details");
p.log.error(color.red("✗ Check") + " — details");
p.log.warn(color.yellow("⚠ Check") + " — details");
p.log.info(color.dim("• Info"));
```

### Pattern C: Version Detection Triple
**What to borrow:** How to compare versions (local, npm registry, platform registry)
```typescript
const localVersion = readFileSync(resolve(pluginRoot, "package.json"), "utf-8") |> JSON.parse();
const latestVersion = fetch("https://registry.npmjs.org/<pkg>/latest").then(r => r.json().version);
const installedVersion = adapter.getInstalledVersion();
```
Then compare and warn if diverged.

### Pattern D: Exit Code Discipline
**What to borrow:**
- Doctor returns 0 on success, 1 on critical failure
- Use `criticalFails++` counter throughout
- Gate exit code on number of critical checks, not warnings
- Allow warnings to pass but log them

### Pattern E: Fallback CLI Path Resolution
**What to borrow:** Detect plugin root by introspection
```typescript
function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one; cli.bundle.mjs at root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("/src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}
```

### Pattern F: Timeout + Graceful Degradation
**What to borrow:** All long-running ops (network, subprocess) have timeouts + fallback
```typescript
const req = httpsRequest(url, { timeout: 5000 }, (res) => { /* ... */ });
req.on("error", () => resolve("unknown"));
req.setTimeout(5000, () => { req.destroy(); resolve("unknown"); });
```

---

## 5. What NOT to Borrow

### A. Git Clone as Primary Update Mechanism
context-mode clones from GitHub for each upgrade. For agent-flywheel:
- **Don't do this** — slow, requires internet, tight timeout (30s)
- **Better:** Use npm tarball fetch or plugin marketplace APIs, or git pull if already cloned

### B. Native Addon Rebuilds
context-mode rebuilds `better-sqlite3` after npm install. If agent-flywheel doesn't have native deps:
- **Skip this step** entirely
- If you do: gate on platform (context-mode skips for OpenCode/Kilo for reason)

### C. Global npm Install
context-mode runs `npm install -g <pluginRoot>`. This is:
- **Not portable** across plugin systems (Claude Code doesn't need it)
- **Requires sudo** on some systems
- **Don't force it** — make it optional or platform-specific

### D. Dual-Mode Operation (Standalone vs. Platform)
context-mode can run as:
- Standalone MCP (no hooks)
- Hooked into platform (Claude Code, Gemini, etc.)

If agent-flywheel is always plugin-dependent, don't bake in standalone fallback—simplify.

---

## 6. Cross-Cutting: Install Flow & Hook Registration

### Install Bootstrap (how a user gets `ctx doctor` + `ctx upgrade` working)

**Claude Code:**
1. User installs via marketplace or `npm install -g context-mode`
2. Claude Code detects plugin via `.claude-plugin/plugin.json` manifest
3. Plugin init → MCP server starts → hooks config flows through adapter
4. User can now run `/context-mode:ctx-doctor` slash command

**The bootstrap checklist:**
- [ ] Plugin manifest exists (`.claude-plugin/plugin.json` or equivalent)
- [ ] MCP server entry point in manifest points to bundled CLI
- [ ] Hook entry points registered in platform config (pretooluse, posttooluse, etc.)
- [ ] Hook scripts have correct paths and permissions (+x)

**For agent-flywheel:** Same pattern — ensure `.pi/extensions/agent-flywheel/` has:
- `package.json` with entry point
- Plugin manifest (`.pi/extensions/agent-flywheel/plugin.json` or similar)
- Hook registration in `.pi/extensions/agent-flywheel/hooks.json`

### Version Sync Across Manifests
context-mode syncs version across multiple files during upgrade via `npm run version-sync`:
- `package.json` version
- `.claude-plugin/plugin.json` version
- Marketplace manifest
- OpenClaw plugin manifest
- `.pi/extensions/context-mode/package.json` version

**For agent-flywheel:** Similar structure — `flywheel-setup` should update all manifests at once to avoid drift.

