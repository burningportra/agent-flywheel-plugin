# Compound Engineering Plugin — Phase 2 Deep Dive

**Repository:** `/tmp/research-compound-engineering` (EveryInc/compound-engineering-plugin)
**Date:** 2026-04-23
**Focus:** Three highest-leverage patterns for `agent-flywheel-plugin` (scan → plan → implement → review → learn).

Chosen areas:
1. **Pluggable converter/target registry** — clean seam for many output formats
2. **Frontmatter parser with triple-fault tolerance** — robust metadata at the IO boundary
3. **Subprocess shimming in tests** — fast, network-free tests for CLI-heavy skills

---

## 1. Pluggable Converter / Target Registry

### How it's implemented

A single **record of `TargetHandler`s** (`src/targets/index.ts`) is the only place the CLI needs to know about output formats. Each handler is a two-function contract: `convert()` (pure transform) + `write()` (IO). Scope metadata (`defaultScope`, `supportedScopes`) is declarative.

```ts
// src/targets/index.ts:39-48
export type TargetHandler<TBundle = unknown> = {
  name: string
  implemented: boolean
  defaultScope?: TargetScope
  supportedScopes?: TargetScope[]
  convert: (plugin: ClaudePlugin, options: ClaudeToOpenCodeOptions) => TBundle | null
  write: (outputRoot: string, bundle: TBundle, scope?: TargetScope) => Promise<void>
}
```

```ts
// src/targets/index.ts:50+
export const targets: Record<string, TargetHandler> = {
  opencode: { name: "opencode", implemented: true, convert: convertClaudeToOpenCode, write: writeOpenCodeBundle, ... },
  codex:   { name: "codex",   implemented: true, convert: convertClaudeToCodex,   write: writeCodexBundle, ... },
  pi:      { ... }, gemini: { ... }, kiro: { ... },
}
```

Validation lives next to the registry. `validateScope()` at `src/targets/index.ts:23-37` handles three cases in <15 lines: no flag → default; flag on target without `supportedScopes` → throw; invalid flag → throw with the supported list. The CLI (`src/commands/convert.ts:154`) calls `validateScope()` before `target.convert()`, so unknown targets and bad scopes fail *before* any filesystem work.

A meta-target `"all"` (`convert.ts:96-104`) iterates `targets` and filters by `detectInstalledTools()` — the registry is **iterable**, so auto-detect is a 4-line addition.

### Why that design

- **Bundle-between-steps** lets unit tests exercise pure conversion without touching disk (see `codex-converter.test.ts` vs `codex-writer.test.ts`).
- **Declarative scope matrix** avoids per-target `if (scope === 'global') ...` branches scattered through writers.
- **`implemented: boolean`** is a cheap feature flag — a target can be registered (discoverable via `list`) before writer is finished.
- Alternative rejected: class hierarchy. The two-function struct is trivially tree-shakeable and requires no DI container.

### Where it could break

- The bundle type is `unknown` at the registry level; only the per-target tuple knows the concrete shape. A typo in the writer crashes at runtime, not at compile time. Mitigated by the `convert.ts:166-168` null-bundle guard but not by types.
- `targets` is a module-level `const`. Third-party targets require PR; there is no runtime registration hook.
- Scope semantics differ per target (`resolve-output.ts:14-32` has a giant if-chain) — the registry abstracts *validation* but not *path resolution*. That coupling is why `opencode` needs the dedicated `resolveOpenCodeWriteScope()` helper.

### What we could borrow

The flywheel has distinct phases (scan/plan/implement/review/learn) and a growing set of **output artifacts**: beads, CASS notes, memory entries, swarm dispatches, Agent Mail messages. Model each as a `PhaseHandler` with the same shape:

```ts
type PhaseHandler<TArtifact> = {
  name: "scan" | "plan" | ...
  run: (ctx: FlywheelCtx) => TArtifact | null
  persist: (root: string, artifact: TArtifact) => Promise<void>
  supportedScopes?: ("project" | "worktree")[]
}
```

Concrete payoff: `flywheel doctor` and `flywheel audit` could iterate the registry the same way `convert all` does, instead of the current ad-hoc skill invocations. Also steal the `implemented: boolean` gate for phases under active development.

---

## 2. Frontmatter Parser with Triple-Fault Tolerance

### How it's implemented

37 lines, zero dependencies beyond `js-yaml` (`src/utils/frontmatter.ts:1-37`):

```ts
// src/utils/frontmatter.ts:8-36
export function parseFrontmatter(raw: string, sourcePath?: string): FrontmatterResult {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: {}, body: raw }                     // Fault 1: no opening fence
  }
  let endIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") { endIndex = i; break }
  }
  if (endIndex === -1) return { data: {}, body: raw }  // Fault 2: unclosed fence
  const yamlText = lines.slice(1, endIndex).join("\n")
  const body = lines.slice(endIndex + 1).join("\n")
  try {
    const parsed = load(yamlText)
    const data = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {}
    return { data, body }
  } catch (err) {                                      // Fault 3: bad YAML
    const hint = "Tip: quote frontmatter values containing colons (e.g. description: 'Use for X: Y')"
    throw new Error(`Invalid YAML frontmatter${sourcePath ? ` in ${sourcePath}` : ""}: ${err}\n${hint}`)
  }
}
```

`formatFrontmatter()` (lines 39-71) is the symmetric writer: it auto-quotes values containing colons, `[`, `{`, `*`, and multi-line strings (block literal `|`). This means **round-trip is stable**: the frontmatter test (`tests/frontmatter.test.ts:15-22`) asserts `parse(format(x)) === x`.

The test file also walks every markdown file in the plugin and re-parses it with `js-yaml` directly (`tests/frontmatter.test.ts:30-51`), so any malformed frontmatter in 51 agents + 36 skills breaks CI.

### Why that design

- **Policy at the IO boundary, not the caller.** Every agent/skill/command loader just calls `parseFrontmatter()`; none of them re-implement error handling.
- **"Missing fence" returns empty data, not error.** Agents can be bodies-only (useful for prompt templates). This differs from front-matter libraries like `gray-matter` which are more permissive but also more opaque.
- **Errors include `sourcePath` + a concrete hint.** The `colons-in-values` mistake is the #1 real-world YAML bug; pre-empting it in the error message saves a round-trip to the user.

### Where it could break

- Only matches `---` as delimiter — not `+++` (TOML), not `;;;` (some editors). Fine for the CE scope.
- `load()` returning `null` or a scalar (e.g. frontmatter contains just `foo`) is flattened to `{}`; callers lose the distinction between "empty" and "malformed-but-parseable".
- No size cap on `yamlText`. A 50 MB YAML document would OOM the parser.
- `\r\n` handling happens in the split regex but `formatFrontmatter()` always emits `\n`. Mixed line endings on Windows get normalized silently.

### What we could borrow

The flywheel already parses SKILL.md frontmatter in `flywheel-drift-check`, `flywheel-refine-skill`, and elsewhere. Extract a tiny `parseFrontmatter()` utility with the same three fault modes + `sourcePath` error enrichment, and have **every** flywheel skill route through it. Immediate wins:

1. The `ce_platforms` filter pattern (CE's `src/types/claude.ts`) maps directly onto the flywheel's "skill applies to which phase" concern — add a `flywheel_phases: ["plan", "implement"]` key and a `filterSkillsByPhase()` helper.
2. Reuse the formatter's colon-escape logic in `flywheel-refine-skill` so auto-refined frontmatter never produces YAML that fails to re-parse.
3. Steal the test pattern that walks every markdown file in the plugin and re-parses — catches bad hand-edits in PRs before they ship.

---

## 3. Subprocess Shimming in Tests

### How it's implemented

`tests/skills/ce-release-notes-helper.test.ts` validates a Python helper that shells out to `gh` for GitHub release data. The test **synthesizes a fake `gh` binary on disk** and injects its path through an env var the helper respects.

```ts
// tests/skills/ce-release-notes-helper.test.ts:42-49
async function makeGhShim(stdout: string, exitCode = 0): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ce-rn-gh-"))
  const ghPath = path.join(dir, "gh")
  const script = `#!/usr/bin/env bash\nprintf '%s' ${shellQuote(stdout)}\nexit ${exitCode}\n`
  await fs.writeFile(ghPath, script, { mode: 0o755 })
  return ghPath
}
```

```ts
// tests/skills/ce-release-notes-helper.test.ts:21-40
async function runHelper(args: string[], opts: { ghBin?: string; apiBase?: string } = {}) {
  const env: Record<string, string> = { ...process.env }
  if (opts.ghBin !== undefined) env.CE_RELEASE_NOTES_GH_BIN = opts.ghBin
  const proc = Bun.spawn(["python3", helperPath, ...args], { env, stderr: "pipe", stdout: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
```

Tests mix two strategies: the **gh-present** path uses `makeGhShim(JSON.stringify([...]))`, and the **gh-missing** path sets `ghBin: "/nonexistent/gh-binary"` plus an HTTP fixture server (`setHandler(() => Response.json(...))`) to exercise the anon-API fallback. Both paths run in the same test file against the *real* Python helper — the production code is unchanged.

### Why that design

- **No mocking framework, no patching.** Just a real child process with a real PATH hook. This isolates the test from the helper's internals; refactoring the Python is safe.
- **Env-var override is a production feature**, not a test-only backdoor. `CE_RELEASE_NOTES_GH_BIN` is also useful for users who have `gh` at a non-standard path. Shim via public API.
- **Bash heredoc sidestep.** The inline comment (`// Use printf to avoid heredoc quoting issues with arbitrary JSON content`) shows they hit and fixed the obvious bug: JSON with newlines blows up naive heredocs; `printf '%s'` with a `shellQuote`d argument is robust.
- Alternative rejected: stubbing `gh` via `sinon`/`mock` in Python. That requires test-only imports in production code.

### Where it could break

- `chmod 0o755` + bash shebang fails on Windows. The CE test suite implicitly assumes POSIX.
- `Bun.spawn` inherits the full `process.env`. If CI sets `GH_TOKEN`, the shim is bypassed *only* if the production helper respects `CE_RELEASE_NOTES_GH_BIN` first. A regression in priority order silently re-introduces network calls.
- `mkdtemp` leaves directories around if the test crashes mid-assertion — there is no `afterEach` cleanup visible. Accumulates over hundreds of runs.
- The `shellQuote` helper must be bulletproof; one escape bug and tests become flaky in ways that look like production bugs.

### What we could borrow

The flywheel's swarm, beads, and NTM skills all shell out to CLIs (`bd`, `gh`, `ntm`, `codex`). Today the integration tests either skip, use real network, or mock at the Node layer. Adopt this pattern directly:

1. Introduce `FLYWHEEL_BD_BIN`, `FLYWHEEL_GH_BIN`, `FLYWHEEL_NTM_BIN` env vars that every skill reads via a tiny `resolveBin('bd')` helper. Default to `$PATH` lookup; tests override.
2. Provide a `makeShim(name, stdout, exitCode)` util in `tests/helpers/` and a matching `withShim(name, stdout, () => ...)` async wrapper that handles cleanup.
3. For HTTP fallbacks (e.g. bead sync, Agent Mail), copy the `startServer() + setHandler()` pattern — a single local HTTP server reset per-test, no port conflicts because Bun can bind `:0`.

Pairs especially well with the **flywheel-doctor** skill: doctor can detect when a shim is active and warn, preventing stale shims in dev from masking real breakage.

---

## Summary

Three ideas to steal, in rough order of payoff for `agent-flywheel-plugin`:

1. **Registry-driven phase handlers** (biggest architectural win; unifies `doctor`, `audit`, `cleanup`).
2. **Subprocess shim helper + `_BIN` env var convention** (unblocks real integration tests for bd/gh/ntm).
3. **Shared `parseFrontmatter` + round-trip formatter** (small refactor, immediate robustness gain across all skills).
