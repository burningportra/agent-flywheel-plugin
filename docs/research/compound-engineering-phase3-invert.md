# Compound Engineering Plugin — Phase 3 Inversion

**Repository:** `EveryInc/compound-engineering-plugin`
**Investigation date:** 2026-04-23
**Question:** What does this repo do BADLY or UNCONVENTIONALLY that we should avoid?

Phase 1 described the pretty architecture. Phase 3 names the ugly parts. Evidence is cited; file paths are from `/tmp/research-compound-engineering/`.

---

## 1. What they did badly

### 1.1 Orphaned converters for targets that were never registered
`src/converters/claude-to-copilot.ts` (218 LOC) and `src/converters/claude-to-droid.ts` (150+ LOC) are fully written, typed, and exported — but the target registry in `src/targets/index.ts` imports only `opencode, codex, pi, gemini, kiro`. There are no writers at `src/targets/copilot.ts` or `src/targets/droid.ts`. `grep convertClaudeToCopilot` across `src` returns matches only in the converter itself and `cleanup.ts` (i.e. we still know how to delete stuff we can't install). The README and `detect-tools.ts` both list copilot and droid as first-class, but the `targets` registry silently ignores them — `convert --to copilot` throws `Unknown target: copilot` (`src/commands/convert.ts:147`). That's half-shipped surface area pretending to be real.

### 1.2 "Legacy cleanup" is a 1,356-line self-maintained allow-list
`src/utils/legacy-cleanup.ts` (730 LOC) + `src/data/plugin-legacy-artifacts.ts` (626 LOC) contain a giant hand-curated list of historical skill/agent/command names (e.g. `"ce:brainstorm"`, `"andrew-kane-gem-writer"`, `"ce-dspy-ruby"`). Every rename of every skill for all time has to be appended here or the installer leaves ghosts in users' `~/.codex`. The fingerprinting logic (`loadLegacyFingerprints`, `classifyCodexLegacyPromptOwnership`) then hashes body content to decide whether a file is "ce-owned" vs. "foreign". This works, but it is an enormous tax on every rename and is the largest file in `utils/`. It is effectively a schema migration system that was never acknowledged as one.

### 1.3 `codex.ts` writer is 616 lines of tangled policy
`src/targets/codex.ts` is the single largest target file. It mixes bundle writing, TOML serialization (`renderCodexConfig`, `formatTomlKey`, `formatTomlInlineTable` — reimplementing a TOML encoder rather than using a library), legacy-artifact moves, symlink detection, ownership heuristics via real-path resolution (`/var/folders` vs `/private/var/folders` on macOS — see comment at `codex.ts:~400`), and scope expansion. The sibling `pi.ts` is 494 LOC and does the same. There's no seam between "format the bundle" and "reconcile with whatever's already on disk."

### 1.4 Naive regex path-rewriting assumes filesystem literals never appear in prose
Every converter does `body.replace(/~\/\.claude\//g, "~/.<target>/")`. Example `claude-to-opencode.ts:~250`:
```ts
return body.replace(/~\/\.claude\//g, "~/.config/opencode/").replace(/\.claude\//g, ".opencode/")
```
Any skill markdown that documents Claude Code itself ("Claude stores things under `.claude/`") gets silently rewritten into a lie for OpenCode users. No quoting, no code-fence awareness. Kiro's version (`claude-to-kiro.ts:150`) at least uses lookbehind guards (`(?<=^|\s|["'`])\.claude\/`) — the other four converters don't. Inconsistent *and* wrong.

### 1.5 Temperature inference is keyword-matching cosplaying as an algorithm
`claude-to-opencode.ts:321`:
```ts
if (/(review|audit|security|sentinel|oracle|lint|verification|guardian)/.test(sample)) return 0.1
if (/(plan|planning|architecture|strategist|analysis|research)/.test(sample)) return 0.2
if (/(doc|readme|changelog|editor|writer)/.test(sample)) return 0.3
if (/(brainstorm|creative|ideate|design|concept)/.test(sample)) return 0.6
return 0.3
```
Defaulted to `on` (`inferTemperature: true` in `convert.ts`). An agent named "reviewer-concept-ideation" gets 0.1. An agent named "security-brainstormer" gets 0.1. The first regex wins. This ships a behaviourally meaningful parameter based on substring bingo.

### 1.6 Error swallowing is endemic
20 empty `} catch {}` blocks across `src/` (including `legacy-cleanup.ts:340,397,570,602`, `codex.ts:434,438,447`, `kiro.ts:94`, `cleanup.ts:605,716`). Some are deliberate (ENOENT), but most have no narrowing — any failure mode, including permission errors or disk-full, is silently ignored. The `json-config.ts:39` path swallows the parse error and just overwrites the user's config with a warning.

---

## 2. Unconventional choices (list + verdict)

- **Bun as the runtime** (`package.json` requires `bun`, shebang `#!/usr/bin/env bun`). Verdict: defensible for internal tooling speed, but restricts install base and breaks Node-only CI. Our plugin uses portable shell/Python — safer.
- **Citty for CLI** (`src/commands/convert.ts:1`). Verdict: fine, minimal, obscure. Locks them to UnJS ecosystem.
- **Spawn `git clone --depth 1`** to fetch plugins by name (`install.ts:327`). Verdict: workable, but no integrity check, no pinning — a compromised GitHub repo silently rewrites users' config.
- **YAML frontmatter + Markdown body as the canonical AST** (`types/claude.ts`). Verdict: elegant, but encodes a "Claude Code-ish" bias forever. Non-Claude input formats would need adaptors.
- **Two-function target contract `{convert, write}`** (`targets/index.ts:42`). Verdict: clean pattern — worth borrowing. But undermined by `codex.ts` smuggling policy back into `write()`.
- **`ce_platforms: ["codex","kiro"]` opt-in filter on skills.** Verdict: pragmatic escape hatch, but surfaces platform concerns into the source of truth. The canonical format is no longer canonical.
- **`bun:test` native runner, 29 test files, some >1,800 LOC.** `tests/cli.test.ts` is 1,874 lines; `tests/codex-writer.test.ts` is 1,089. Verdict: high raw coverage count masks brittle integration tests that will slow refactors.

---

## 3. What we should NOT copy

1. **Don't let "targets" diverge from "implemented targets."** They have converters for copilot/droid that aren't wired up, and a README that advertises them. Our `targets`/agent registries should fail loudly when something is half-connected. Use a single source of truth and let the type system reject unregistered targets.
2. **Don't build a hand-curated legacy-artifact allow-list.** The 626-line `plugin-legacy-artifacts.ts` is the tax for every rename. Either version skills and let the installer use manifest diffs, or design cleanup to be conservative (leave unknown files alone) rather than omniscient.
3. **Don't run regex `replace` on user-authored prose to translate platform paths.** Prefer templating variables (`{{PLATFORM_HOME}}`) resolved at render time. Any plugin we ship that documents paths should use a platform-agnostic placeholder.
4. **Don't ship behavioural heuristics (like temperature inference) as default-on based on substring matches.** If we need agent-mode inference, require explicit frontmatter and have a `--infer` opt-in flag only.

---

## 4. What we already do better (preserve this in agent-flywheel-plugin)

1. **Single-platform focus.** We target Claude Code only. No converter matrix, no legacy-artifact dictionary, no TOML re-encoder. This is a 5-10x complexity avoidance.
2. **Our skills self-document rather than being remapped.** Our `skills/start`, `skills/doctor`, etc., run as authored — no regex rewrites of `.claude/` to pretend we're OpenCode.
3. **Observability-first recent work** (doctor/hotspot/post-mortem in 3.4.0) — CE has no equivalent of `flywheel-doctor`. Their debugging story is "read the 730-line legacy-cleanup.ts."
4. **Smaller, more cohesive files.** Our largest single file is well under 730 LOC. CE has five files over 450 LOC, three over 600. That's the kind of sprawl that traps refactors.

---

## File references

| Finding | Path | Lines |
|---|---|---|
| Orphan converters | `src/converters/claude-to-{copilot,droid}.ts` vs `src/targets/index.ts` | all / 42–80 |
| Legacy data tax | `src/data/plugin-legacy-artifacts.ts`, `src/utils/legacy-cleanup.ts` | 1–626 / 1–730 |
| Codex writer sprawl | `src/targets/codex.ts` | 1–616 |
| Path-regex rewrites | `src/converters/claude-to-opencode.ts`, `claude-to-kiro.ts` | 250 / 150 |
| Temperature heuristic | `src/converters/claude-to-opencode.ts` | 321–340 |
| Empty catches | `src/utils/legacy-cleanup.ts`, `src/utils/json-config.ts:39` | various |
| CLI god-test | `tests/cli.test.ts` | 1–1874 |
