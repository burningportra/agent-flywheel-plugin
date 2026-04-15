# Robustness Plan: SKILL.md Linter (`scripts/lint-skill.ts`)

Date: 2026-04-15
Perspective: Robustness / SRE
Author: PinkCompass (deep-plan session)
Target: `claude-orchestrator` v2.9.0 — pre-merge infrastructure
Companion perspectives: Correctness, Ergonomics (separate plans)

---

## Executive Summary

The SKILL.md linter will sit in the pre-merge blast radius: every PR runs it, and a crash, hang, or nondeterministic failure blocks the entire team. The linter's rules are relatively simple (AskUserQuestion option count, slash-skill existence, `<placeholder>` referents, hard-rule/enforcement pairing), but the **input is a 1438-line hand-authored markdown file** with 59 AskUserQuestion sites today — adversarial by construction. Drift will happen. Parsers will choke. File systems will lie. The linter must survive all of it without false red builds.

This plan is exclusively about **what breaks and what the linter does when it breaks**. It covers 11 robustness concerns in depth: adversarial input handling, skill-list resolution fallbacks, process-level safety, CI failure modes, rule isolation, backwards compatibility, determinism, logging, exit codes, a test plan that proves the above, and recovery hatches. Correctness of individual rules is out of scope for this plan — I assume a correctness-focused plan specifies rule semantics and this plan specifies what happens at the edges.

### Core design choices (for robustness)

1. **Parse via CommonMark tokenizer (remark/micromark), not regex** — hand-rolled regex parsers fail catastrophically on nested/quadruple-fenced code blocks (see CASS bead-z9g incident below). A real tokenizer handles all the fence-nesting cases deterministically.
2. **Two-severity model**: `error` blocks CI, `warn` does not (unless `--strict`). Mirrors the UBS heuristic vs blocker split that already works in this repo.
3. **Rule isolation via try/catch per rule** — one buggy rule cannot crash the linter.
4. **Deterministic output** — byte-identical stdout for the same input bytes, across machines and OS.
5. **Single binary, two entry points**: `scripts/lint-skill.ts` as a standalone Node CLI + `scripts/lint-skill-lib.ts` as a reusable library so an MCP tool or Vitest can import rule engine without shelling out. Decision: **standalone-first**, library-extract when a second consumer materializes. No MCP tool in this iteration — reduces surface area.
6. **Pure TypeScript, no new runtime deps beyond what's already in `mcp-server/package.json`** (`zod` for config validation already present). Parser dep (`micromark` or `remark-parse`) is the one new dep — justified below in §2.1.

---

## Repo Context That Shapes This Plan

- **Target file**: `skills/orchestrate/SKILL.md` — 1438 lines, 59 `AskUserQuestion` call sites, dense with mixed code fences, inline JSON examples, and `<placeholder>`-style tags.
- **21 local skills** already live under `skills/*/SKILL.md`. Plus global user skills under `~/.claude/plugins/`, `~/.claude/skills/`, and marketplace skills. Resolution is non-trivial (see §2).
- **Stack**: TypeScript MCP server at `mcp-server/src/`, Vitest 2.x, NodeNext ESM, strict TS, `.js` import extensions mandated. Scripts currently live at root (no `scripts/` dir yet — must create).
- **AGENTS.md hard constraints** (inherited by this linter since it sits in the same repo):
  - No `console.log` in MCP code — use stderr logger. The linter is a CLI tool so it writes to stdout (findings) + stderr (diagnostics); `console.log` for human-readable stdout is acceptable here, but all diagnostic output MUST go through the structured logger at `mcp-server/src/logger.ts` pattern (see §8).
  - ESM-only, `.js` imports in TS source.
  - Exec timeouts mandatory, signal propagation required — the linter itself should not shell out, but any probe of external tools (e.g., `which br`) must timeout.
- **No `.github/workflows/` directory today** — this plan defines the first CI workflow.
- **No `scripts/` directory today** — create it.
- **CASS reference incidents** (from input context):
  - bead-z9g: `*/` inside a nested code block prematurely closed a comment, cascading into 100+ TS errors. Direct lesson: tokenizer must handle nested fence escapes.
  - UBS: chart math files generated many heuristic warnings; treating heuristics as blockers would have frozen the repo. Severity tiers are not optional.
  - Optional-CLI degradation: `br`, `bv`, `ccc` may be absent; same must apply to external skill discovery.
  - Vitest timers: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` is the safe pattern; `runAllTimersAsync()` causes infinite loops. Relevant if the linter test suite uses timers (it should try not to).

---

## 1. Adversarial Input Handling

The linter reads a markdown file authored by humans and AI agents over months. The input distribution is non-Gaussian: most files are fine, a few are pathological. The linter must treat input as fully untrusted.

### 1.1 Decision table

| Input condition | Behavior | Exit code | Rule that fires |
|---|---|---|---|
| File does not exist | Log error `ENOENT: SKILL.md not found at {path}` | 4 | (pre-rule) |
| File exists but empty (0 bytes) | No findings; log warn `empty SKILL.md, skipping rules` | 0 | (pre-rule) |
| File exists, only whitespace | No findings; same warn as empty | 0 | (pre-rule) |
| File size > 10 MB (configurable via `--max-bytes`) | Refuse to lint; log error `SKILL.md exceeds --max-bytes (10485760)` | 4 | (pre-rule) |
| File is a symlink | Resolve once via `fs.realpath`, lint target. If target is outside repo root, log warn `symlink escapes repo root` and continue | 0 or findings | (pre-rule) |
| File is a broken symlink | Treat as missing | 4 | (pre-rule) |
| File unreadable (EACCES) | Log error with path and uid, exit | 4 | (pre-rule) |
| File owned by other user (readable) | Proceed, no warning (common on shared CI runners) | as-normal | — |
| File has UTF-8 BOM | Strip BOM before parsing; do not flag | as-normal | — |
| File has CRLF line endings | Normalize to LF in memory before parsing; preserve original line numbers in findings (map via offset table) | as-normal | — |
| File has mixed CRLF+LF | Same as CRLF — normalize, line numbers remain original | as-normal | — |
| File has non-UTF-8 bytes | Reject with error `SKILL.md is not valid UTF-8 at byte offset N`; exit | 4 | (pre-rule) |
| File has trailing NUL bytes | Treat as binary, reject same as non-UTF-8 | 4 | (pre-rule) |
| Very long line (>10k chars) | Parse normally; rule engine processes as single token. If line contributes to a finding, truncate the rendered line snippet to 200 chars with `…` marker | as-normal | — |
| File modified mid-lint | Hash file once at start (SHA-256 of bytes); after rules run, re-stat. If mtime or size changed, log warn `SKILL.md changed during lint; re-run for authoritative result` but still emit findings | exit unchanged, warn logged | (pre-rule) |

### 1.2 Parser-level adversarial cases

CommonMark tokenizer handles these natively; hand-rolled regex does not. **This is the single most important parser decision.**

- **Unclosed code fences**: remark treats the rest of the file as code. Linter should detect this (at the tokenizer level, remark emits a "flow" fence without a matching close) and emit `SKILL-010: unclosed code fence opened at line N` as an **error**. Continue processing best-effort — do not crash.
- **Nested code fences** (` ``` ` inside ` ```` `): CommonMark permits longer fences to contain shorter ones. Tokenizer handles this correctly. No special rule needed — but test fixture required.
- **Quad-backtick fences containing triple-backticks with nested `*/`**: the bead-z9g scenario. Tokenizer keeps the inner `*/` inside the code block — no bleed. Test fixture required with this exact shape to catch any regression.
- **Malformed JSON inside AskUserQuestion example blocks**: rule SKILL-020 (AskUserQuestion structure) tries to parse the example. If `JSON.parse` throws, the rule records `SKILL-021: AskUserQuestion example at line N is not valid JSON` as a **warn** (heuristic), not an error — humans often write pseudo-JSON with comments. `--strict` promotes to error.
- **AskUserQuestion examples spanning 50+ lines**: no special handling. Rule reads the whole code block.
- **Tab-indented vs space-indented options arrays**: irrelevant for JSON parse (both valid). For JSON-with-comments parse path, pass through `jsonc-parser` or similar tolerant parser.
- **Comments inside options object (`// recommended`)**: standard JSON rejects. Use `jsonc-parser` (tiny, zero-dep) for the AskUserQuestion block parse. Comments are allowed; `--strict` flags them as SKILL-022 warn.
- **Trailing commas**: same as comments — `jsonc-parser` permits; `--strict` flags as SKILL-023 warn.
- **Inline AskUserQuestion (not in a code block)**: treated as a bare code reference, not linted structurally. Rule notes `SKILL-024: AskUserQuestion mentioned outside a code block at line N — structure not validated` as **info** (not shown unless `--log-level=info`).
- **AskUserQuestion in a ` ~~~ ` tilde fence**: same behavior as backtick fence.

### 1.3 `<placeholder>` tag edge cases

- `<placeholder>` is an angle-bracket pseudo-tag, not HTML. CommonMark may treat some as raw HTML and inline some differently. Linter:
  - Extracts placeholders via a dedicated walk over tokens, matching `/<[a-z][a-z0-9-]*>/i` where the tag is **not** a known HTML element (whitelist: `br`, `em`, `strong`, `code`, `pre`, `a`, `img`, `sup`, `sub`, `kbd`, `summary`, `details`, `div`, `span`, `p`, `ul`, `ol`, `li`, `table`, `tr`, `td`, `th`, `thead`, `tbody`).
  - Unknown tags are candidate placeholders. Rule SKILL-030 requires a referent definition elsewhere in the file (exact lookup rules are a correctness concern).
- Case sensitivity: placeholders are lowercased for matching. Document this in `--help`.
- Self-closing tags (`<foo/>`) treated the same as `<foo>`.
- HTML-style attributes inside placeholder (`<foo bar="x">`) — rare but possible. Treat tag name as `foo`, attributes ignored for matching.
- Placeholder inside an inline code span (`` `<placeholder>` ``) — ignore; not a real placeholder.
- Placeholder inside a link URL — ignore.

### 1.4 Large-input safety

- **Hard cap on input size**: `--max-bytes` default 10 MiB. Reject larger files with exit 4. Rationale: current SKILL.md is ~100 KB; 100x headroom is sufficient, 10 MiB guarantees a bounded-memory linter.
- **Streaming parse**: not required at 10 MiB. Read whole file to `Buffer`, decode once.
- **Token-count cap**: `--max-tokens` default 500000. If remark emits more tokens, abort rule engine with exit 2 (internal error) and log `token count exceeds --max-tokens; file may be pathological`. This is a safety net for tokenizer bugs, not a normal path.
- **Heap profile test**: assert max heap < 100 MB while linting a 10 MiB synthetic fixture (see §10).

### 1.5 Encoding safety

- Read with `fs.readFile(path)` → raw `Buffer`. Check first 3 bytes for UTF-8 BOM `EF BB BF` and strip.
- Decode with `TextDecoder('utf-8', { fatal: true })`. Fatal decoder throws on invalid sequences → we catch, log byte offset, exit 4.
- Normalize line endings: `text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')`. Maintain a line-offset map so reported line numbers match the original file's line numbering (the normalization is 1:1 on line counts for CRLF→LF, and for bare CR the map handles it).

---

## 2. Skill-List Resolution Failures

Rule SKILL-040: every `/slash-skill` reference in SKILL.md must resolve to an existing skill. This is the hardest rule to make robust because skill location is environment-dependent.

### 2.1 Resolution layers (deterministic order)

Defined order; first hit wins; all layers consulted even on hit (for the `--report-skills` diagnostic).

1. **Repo-local skills**: `{repo_root}/skills/*/SKILL.md`. Skill name = directory name. This is the deterministic source — always present in CI.
2. **Pinned manifest**: `{repo_root}/scripts/skill-manifest.json`, a checked-in list of skill names the linter knows about. Maintained manually; CI is authoritative. Updated by `--update-manifest` flag (see §4).
3. **User-global skills**: `~/.claude/skills/*/SKILL.md` (if `HOME` set and dir exists). Flagged `environment-dependent`.
4. **Plugin skills**: `~/.claude/plugins/*/skills/*/SKILL.md` (glob). Flagged `environment-dependent`.
5. **Marketplace skills**: same root, different convention. Flagged `environment-dependent`.

**Resolution rule for rule SKILL-040**:
- Skill name matches a layer-1 or layer-2 entry → PASS silently.
- Skill name matches only a layer-3/4/5 entry → PASS in default mode; in `--ci` mode (deterministic-only), FAIL with SKILL-041 `skill \`/foo\` only found in environment-dependent layer; add to scripts/skill-manifest.json for CI to pass`.
- Skill name matches nothing → FAIL with SKILL-042 `skill \`/foo\` not found in any layer`.

**Why a checked-in manifest?** Without it, `/foo` may resolve on a dev machine but not in CI, producing the exact failure mode `PR author can't reproduce CI`. The manifest is the canonical source for CI; local layers are convenience. CI uses `--ci` which ignores layers 3-5.

### 2.2 Layer failure modes

| Failure | Handling |
|---|---|
| `~/.claude/plugins/` doesn't exist | Skip layer silently; log debug `plugin skills layer unavailable` |
| `~/.claude/` doesn't exist | Skip layers 3-5; log debug once |
| `HOME` env var unset | Skip layers 3-5; log debug once |
| Layer 3 dir exists but has no SKILL.md children | Empty result; no error |
| Plugin SKILL.md malformed (unreadable frontmatter) | Skip that plugin; log warn at `--log-level=warn`; do not fail linter. Collect counts for `--report-skills` |
| Skill names with special chars (`-`, `:`, `_`) | Allow `[a-z0-9][a-z0-9_:-]*` per matching; document in help |
| Skill exists but its `SKILL.md` is missing | Treat skill as non-existent; log warn `skill dir \`{name}\` has no SKILL.md` |
| Two layers define same skill name with different content | Layer 1 wins, no warning. `--report-skills` shows both. |
| Layer 2 manifest file missing | Skip; log debug `no skill-manifest.json; run with --update-manifest to generate` |
| Layer 2 manifest malformed JSON | Log error `scripts/skill-manifest.json is not valid JSON` and exit 4 |
| Layer 2 manifest has stale entry (in manifest but nowhere on disk) | In non-CI mode: log warn. In `--ci` mode: error SKILL-043 `manifest entry \`{name}\` not found on disk; run --update-manifest` |

### 2.3 Distinguishing slash-skills from other slash strings

Critical correctness-for-robustness concern: false positives destroy linter credibility. The linter must not try to resolve `/etc/hosts`, `/api/users`, `/tmp/foo.json`, or URL paths.

Heuristic (applied to any line-level `/[a-zA-Z][...]` match):
- **Skip** if preceded by a URL-ish context: `http://`, `https://`, `://`, `file://` on the same line before the match.
- **Skip** if match contains a `.` or `?` (filesystem extension or query string).
- **Skip** if match contains more than one `/` (path, not a skill name). Skill names are flat — `/foo-bar` yes, `/foo/bar` no.
- **Skip** if match appears inside an inline code span followed by a backtick-enclosed path that starts with `/` AND contains another `/`.
- **Match** if inside an inline code span with a single-segment name: `` `/foo` `` → candidate skill.
- **Match** if at start of a line in prose context: `Use /foo to do X` → candidate skill.
- **Known false positive list** (checked-in at `scripts/skill-exceptions.json`): short list of literal strings to always skip, e.g., `/etc/hosts`, `/usr/local/bin`.

Document every heuristic in `--help` and in a top-of-file comment in `lint-skill.ts`. The heuristics will need to evolve; version them (see §6).

### 2.4 Parser dep choice

Options considered:
- **`remark-parse` + `unified`**: mature, widely tested, handles all CommonMark edge cases. ~120 KB installed. Ecosystem of plugins. **Chosen.**
- **`micromark`**: lower-level, smaller. More work to walk tokens. Reject — bigger implementation burden for linter rules.
- **`marked`**: not AST-first, harder to extract structured findings. Reject.
- **Hand-rolled regex**: rejected above.

Dep additions to `mcp-server/package.json` (since scripts share node_modules with mcp-server):
- `remark-parse@^11` (runtime for linter; fine as devDep since linter is a dev tool, but placing under `dependencies` is also acceptable — decision: devDep to keep runtime small)
- `unified@^11`
- `jsonc-parser@^3` (for AskUserQuestion options)

Lock to exact minor ranges, never `latest`. Vendor-pin by committing `package-lock.json`.

---

## 3. Process-Level Robustness

The linter is a short-lived CLI but may be invoked concurrently (CI matrix, pre-commit hooks, editor integrations). Cover the failure modes that come with being a process on a real OS.

### 3.1 Memory & time bounds

- **Overall timeout**: `--timeout` default 30 seconds. Implementation: `setTimeout` that calls `process.exit(2)` with a logged error. Not using a child process, so cannot be SIGKILL'd from the linter itself — rely on process exit.
- **Per-rule soft timeout**: 5 seconds via `Promise.race` around each rule's execution. If a rule exceeds 5s, record as an internal error, skip it, continue. This protects against a runaway regex.
- **Memory cap**: enforced at OS level (`ulimit -v` if user wants); at app level, monitor `process.memoryUsage().heapUsed` after each rule and log warn if > 150 MB. Do not abort — some rules legitimately allocate.
- **Progress logging**: every 5s of elapsed time, emit a stderr line `linting: {rule_id} on {file}` so a hung CI does not silently burn 30s.

### 3.2 Atomic `--fix` writes

When `--fix` is passed (a later feature, not v1 but plan for it now so rule shape accommodates):
- Write fixed output to `{target}.lint-tmp.{pid}.{rand}`.
- `fs.renameSync(tmp, target)` — POSIX guarantees atomicity within same filesystem.
- If rename fails (e.g., EXDEV cross-device), unlink tmp and error out with SKILL-INT-001.
- On `SIGINT`/`SIGTERM`, best-effort cleanup of tmp files via a process-level handler. Accept the edge case that `SIGKILL` will leave tmp files — document.
- Never open the target file for writing directly.

### 3.3 Concurrent invocations

Two linter processes on the same file:
- **Read-only mode (default)**: harmless. Both read, both produce findings.
- **`--fix` mode**: use `proper-lockfile` or a simple `.lint-skill.lock` in the temp dir (flock semantics not available on all FS; use advisory file lock via exclusive-create then unlink). If lock held, exit 5 `another linter --fix is running`. Simpler: document that `--fix` is not concurrent-safe and don't wire it into CI.

### 3.4 Read-only filesystem (CI caches)

- Linter never writes to the repo in default mode. Safe.
- Logger writes only to stderr (fd 2), not to a file.
- If `--fix` needs a tmp file and `/tmp` is read-only → error out with clear message `cannot create temp file: EROFS`, exit 2.

### 3.5 PWD anchoring

- Never trust `process.cwd()`. Resolve SKILL.md path:
  - If `--file` explicit → use as-is (resolve to absolute).
  - Else default to `{repo_root}/skills/orchestrate/SKILL.md` where `repo_root` = walk up from the linter script location until a `.git` dir is found. Cap walk at 10 levels.
  - Manifest and exceptions path resolved relative to `repo_root`.
- Log the resolved `repo_root` at `--log-level=debug`.

### 3.6 Signal handling

- `SIGINT` (Ctrl-C): exit 130, no cleanup needed in read mode.
- `SIGTERM`: exit 143, same.
- `SIGPIPE` (stdout closed): handle gracefully — some CIs truncate logs. Catch `EPIPE` on write, exit 0 if no findings were pending.
- Do not install uncaughtException/unhandledRejection handlers that swallow errors. Let Node crash with exit 1 for truly unhandled — but surround rule execution with try/catch (§5) so that pathway is never taken in practice.

---

## 4. CI Failure Modes

The linter's worst failure mode is **"passes locally, fails in CI"**. Every design choice here aims to make the CI outcome a deterministic function of the checked-in files.

### 4.1 GitHub Actions workflow shape

Create `.github/workflows/lint-skill.yml`:

- Trigger: `pull_request` on changes to `skills/**/SKILL.md`, `scripts/lint-skill*.ts`, `scripts/skill-manifest.json`, `scripts/skill-exceptions.json`, and `.github/workflows/lint-skill.yml` itself.
- Also trigger on `workflow_dispatch` so it can be run manually.
- Single job, single step. No matrix.
- **Node version pinned to `.nvmrc`** (add `.nvmrc` with `22.x` to match `@types/node@^22`). Prevents the "dev has Node 20, CI has Node 22, subtle behavior differs" class of bugs.
- `actions/checkout@v4` → `actions/setup-node@v4` → `cd mcp-server && npm ci` → `npm run lint:skill -- --ci --file ../skills/orchestrate/SKILL.md`.
- Caching: `actions/setup-node`'s built-in cache keyed on `mcp-server/package-lock.json`. No further caching.
- Fail-fast: default (job fails on first non-zero exit).

### 4.2 Node version drift

- `.nvmrc` at repo root.
- `package.json` engines: `"node": ">=22 <23"`. Linter refuses to run under lower, logs `unsupported node version {v}; requires >=22`, exit 3.
- CI step `actions/setup-node@v4` with `node-version-file: .nvmrc`.

### 4.3 Environment-dependent skill resolution

Already addressed in §2.1: CI uses `--ci` → only layers 1-2 consulted. Layer 2 (manifest) is checked-in and authoritative. Dev can run without `--ci` to use their local skill library.

### 4.4 Baseline-diff mode (unrelated-rule-failure mitigation)

Scenario: dev edits line 100 of SKILL.md; linter fails because of a pre-existing issue on line 800.

Mitigation: `--baseline {path}` flag.
- Baseline is a JSON snapshot: `{ schema_version: 1, findings: [{rule_id, line, col, sha256_of_snippet}] }`.
- `scripts/lint-skill-baseline.json` checked-in.
- On run, findings present in baseline are demoted to `info` (not shown). New findings retain their severity.
- Baseline regenerated by `npm run lint:skill -- --update-baseline`.
- Use `sha256_of_snippet` instead of raw line number to tolerate insertions/deletions shifting lines.
- CI runs with `--baseline scripts/lint-skill-baseline.json`. If CI fails, the failing findings are guaranteed to be new.
- Document: baselines are a technical-debt ledger, not a permanent ignore — every PR that touches SKILL.md should aim to reduce the baseline.

### 4.5 `--reproduce-ci` flag

Purpose: let a dev run exactly what CI ran.
- Implementation: `--reproduce-ci` is sugar for `--ci --baseline scripts/lint-skill-baseline.json --file skills/orchestrate/SKILL.md --log-level=info`.
- Documented in `--help` as the single command for CI repro.

### 4.6 Slow-CI mitigations

- Parallelize independent rules via `Promise.all` inside the rule engine. With 4 rules and a ~10 MB max file, this is <1s overhead but correct by construction.
- Cache remark parse result between rules (build AST once, pass to each rule). Significant saving.
- Caching strategy: no cross-run cache in v1. The linter runs in <5s on a 100 KB file; adding a cache adds invalidation bugs.

### 4.7 CI output format

- Default stdout: human-readable `{path}:{line}:{col} {severity} {rule_id} {message}`.
- `--format=github`: emit GitHub Actions annotation lines `::error file={path},line={line},col={col}::{message}` so findings surface as PR review comments.
- `--format=json`: machine-readable for other integrations.
- `--format=sarif`: (future) for GitHub Code Scanning. Not v1.

### 4.8 Permission & secret concerns

- Linter needs no secrets, no network access. Document this — a reviewer looking at `lint-skill.yml` should see zero network actions.
- Add a top-of-workflow comment `# This workflow is local-only: no network, no secrets.`

---

## 5. Rule Isolation

One rule throwing must not take down the linter. This is enforced at multiple layers.

### 5.1 Isolation harness

```ts
async function runRule(rule: Rule, ctx: RuleContext): Promise<RuleResult> {
  const started = performance.now();
  try {
    const findings = await Promise.race([
      rule.run(ctx),
      timeout(RULE_TIMEOUT_MS, `rule ${rule.id} exceeded ${RULE_TIMEOUT_MS}ms`),
    ]);
    return { rule_id: rule.id, findings, internal_error: null, duration_ms: ... };
  } catch (err) {
    return { rule_id: rule.id, findings: [], internal_error: serializeError(err), duration_ms: ... };
  }
}
```

### 5.2 Aggregation

- Internal errors are collected separately from findings: `{ findings: [...], internal_errors: [...] }`.
- Exit code:
  - Any error-severity finding AND no internal errors → 1.
  - Any internal error (any rule threw) → 2 takes precedence.
  - Findings + internal errors → 2 (internal error is higher priority; fix the linter first).
- Internal errors logged to stderr at `error` level, always, regardless of `--log-level`. These are bugs.

### 5.3 Per-rule kill switches

- `--disable-rule RULE-ID` (repeatable) to turn off a rule. Warning logged (see §11).
- `--only-rule RULE-ID` (repeatable) for debugging a specific rule.
- Mutually exclusive: passing both exits 3.

---

## 6. Backwards Compatibility

SKILL.md grammar will evolve. New callout types, new placeholder conventions, new slash-skill patterns. The linter must not become the bottleneck that blocks grammar evolution.

### 6.1 Unknown-structure tolerance

- Default mode: unknown tokens (unrecognized HTML tags, unknown callout styles, unfamiliar directive syntax) are **ignored**, not flagged.
- `--strict` mode: unknown structures flagged as SKILL-900 `unrecognized structure at line N`.
- Rationale: CI must remain green during grammar evolution. Strict is opt-in.

### 6.2 Rule versioning

- Rule IDs are permanent: `SKILL-010`, `SKILL-020`, etc. Never renumbered.
- Rule behavior can change; when it does, bump a rule-set version (`RULESET_VERSION` const in `scripts/lint-skill-lib.ts`).
- `--rule-set-version` flag pins to a specific version for reproducibility. Defaults to latest.
- Deprecated rules stay compiled-in but default-off; emit a `deprecated: use SKILL-XXX instead` note if invoked.

### 6.3 Configuration file

- Optional `scripts/lint-skill.config.json` (zod-validated) with:
  - `severity_overrides: { "SKILL-021": "error" }`
  - `disabled_rules: ["SKILL-024"]`
  - `file_patterns: ["skills/**/SKILL.md"]` (future — v1 hardcodes one file)
- Config is **additive only** — CLI flags override config. CI ignores config (uses `--ci`) unless `--config` is passed explicitly. Prevents "someone committed a config that turned off rule X and CI silently stopped enforcing it" class of bug. Decision: CI reads config, but passes `--ci-ignore-config` to disable any overrides. Safer.

### 6.4 SKILL.md grammar version

- Frontmatter field `schema_version: 1` (if present) pinned.
- Linter reads frontmatter and warns on unknown schema_version. Default behavior is to lint as schema 1. Never fails on unknown schema — that would block schema evolution.

---

## 7. Determinism

CI output must be byte-identical across machines, OSes, and time zones given the same input bytes.

### 7.1 Ordering

- Findings sorted by: `(path, line, column, rule_id, message)`. Lexicographic on all.
- Tie-breaking deterministic (`rule_id` alphabetical).
- Internal errors sorted by `rule_id`.
- Skill manifest iteration: sort entries alphabetically before any output.
- `Object.keys` iteration in any JSON output: sort first.

### 7.2 Non-deterministic sources to eliminate

| Source | Mitigation |
|---|---|
| `Date.now()` / ISO timestamps in output | Never in stdout. Only in stderr at `--log-level=debug`. |
| Time zone | Never render times (see above). If required, always UTC (`toISOString`). |
| `Math.random()` / `crypto.randomUUID` | Not used in findings output. Only in `--fix` tmpfile suffix (not part of output). |
| Directory iteration order | `fs.readdir` returns in FS-dependent order; always `.sort()` before iterating. |
| `Map` / `Set` iteration | Uses insertion order in JS; safe if insertion order is deterministic. Assert this in tests. |
| Node version differences | Pin via `.nvmrc`. Add a smoke test that runs the linter with a golden-file fixture (§10). |
| OS line endings | Normalize at input (§1.5). Output always LF. |
| Locale-sensitive string comparison | Use `===`, not `localeCompare`. |
| `JSON.stringify` numeric precision | No floats in output. |
| `console.log` order vs `console.error` order | Flush stderr before exit (`process.stderr.write` sync). |

### 7.3 Golden-file test

Fixture: `scripts/__fixtures__/golden-input.md` (hand-crafted, ~500 lines, exercises all rules). Expected output: `scripts/__fixtures__/golden-output.txt`. CI runs linter on fixture, diffs output. Any non-determinism = immediate test failure.

---

## 8. Logging

The linter is pre-merge infrastructure; a 3am pager needs logs that explain what the linter did.

### 8.1 Levels

- `error`: unrecoverable — linter aborting.
- `warn`: recoverable but noteworthy — e.g., fallback path taken, manifest stale.
- `info`: high-signal lifecycle — "linting {file}", "loaded N skills from layer 1".
- `debug`: per-rule timing, resolution layer hits, parser stats.

### 8.2 Format

Structured, line-per-event, to stderr. Example:

```
[2026-04-15T02:30:00Z] [info] lint-skill file=skills/orchestrate/SKILL.md bytes=98234 rules=4
[2026-04-15T02:30:00Z] [debug] repo_root=/Volumes/1tb/Projects/claude-orchestrator
[2026-04-15T02:30:00Z] [debug] rule=SKILL-020 started
[2026-04-15T02:30:00Z] [debug] rule=SKILL-020 done duration_ms=42 findings=0
```

- Key-value log body after level tag. Parse-friendly.
- Timestamp opt-in (`--log-timestamps`) to preserve determinism of stderr in tests. Default: off.
- Colors: default off in CI (detect `CI=true` env), on in TTY (`process.stderr.isTTY`).

### 8.3 Logger impl

- Reuse the pattern from `mcp-server/src/logger.ts` — export a small logger from `scripts/lint-skill-logger.ts`.
- Never `console.log` anywhere in `lint-skill*.ts` except the designated stdout findings writer. Enforce with an eslint rule if lint config is added (out of scope for v1).
- All stdout writes go through a single `emitFinding()` function. All stderr writes go through the logger.

### 8.4 `--quiet` and `--verbose`

- `--quiet`: log level `error` only. Stdout unchanged.
- `--verbose`: log level `debug`. Implies `--log-timestamps`.
- Conflict resolution: later flag wins.

---

## 9. Exit Codes

Precise semantics. Documented in `--help`. Unit-tested.

| Code | Meaning | When |
|---|---|---|
| 0 | Clean | No error-severity findings, no internal errors. Warnings OK unless `--strict`. |
| 1 | Findings | One or more error-severity findings. No internal errors. |
| 2 | Internal error | Rule threw, or linter-internal invariant broken, or timeout. Findings may or may not be present. Precedence over 1. |
| 3 | Invalid CLI args | Unknown flag, conflicting flags, invalid value. `--help` text shown on stderr. |
| 4 | Input unreadable | SKILL.md missing, size cap exceeded, not UTF-8, manifest malformed. |
| 5 | Lock contention | `--fix` running, another instance holds lock. (Future — v1 does not have `--fix`.) |
| 130 | SIGINT | Ctrl-C. |
| 143 | SIGTERM | Killed. |

Exit code precedence: 2 > 4 > 3 > 1 > 0. SIGINT/SIGTERM supersede by being process-level.

`--help` output includes a section with this table verbatim. `--version` prints version + rule-set version.

---

## 10. Test Plan for Robustness

Tests live in `scripts/__tests__/lint-skill.test.ts`. Vitest 2.x, matches existing `mcp-server/src/__tests__/` pattern.

### 10.1 Fixture suite

All fixtures under `scripts/__fixtures__/robustness/`. Each is a standalone `.md` or `.md.binary` file with a note about what it tests.

| Fixture | Tests |
|---|---|
| `empty.md` | 0 bytes. Expect exit 0, warn logged. |
| `whitespace-only.md` | Only spaces/newlines. Expect exit 0. |
| `no-askuserquestion.md` | Valid markdown, no AskUserQuestion calls. Expect exit 0. |
| `unclosed-fence.md` | ` ``` ` with no close. Expect SKILL-010 error. |
| `nested-fence.md` | Quad inside quad-plus. Expect no finding. |
| `nested-fence-with-comment-terminator.md` | bead-z9g replay: `*/` inside nested code. Expect no spurious findings elsewhere. |
| `crlf.md` | All CRLF. Expect findings report original line numbers. |
| `mixed-line-endings.md` | Mixed CRLF/LF/CR. Same. |
| `utf8-bom.md` | BOM-prefixed. Expect BOM stripped silently. |
| `very-long-line.md` | One 20000-char line. Expect truncation in snippet, no crash. |
| `large.md` | 10 MB synthetic. Expect exit 0 or 1 within timeout, heap < 100 MB. |
| `over-cap.md` | 11 MB. Expect exit 4 `exceeds --max-bytes`. |
| `invalid-utf8.md.binary` | Invalid byte sequence. Expect exit 4. |
| `null-bytes.md.binary` | Embedded `\0`. Expect exit 4. |
| `malformed-aq-json.md` | AskUserQuestion with `{ foo: 1 }` (unquoted keys). Expect SKILL-021 warn. |
| `aq-with-comments.md` | Options array with `// recommended`. Expect parse success; SKILL-022 warn under `--strict`. |
| `aq-with-trailing-commas.md` | Trailing comma. Expect parse success; warn under `--strict`. |
| `aq-50-lines.md` | 50-line options block. Expect correct parse. |
| `aq-tab-indented.md` | Tabs instead of spaces. Expect correct parse. |
| `placeholder-in-code.md` | `<placeholder>` inside inline code. Expect ignored. |
| `placeholder-html-like.md` | `<strong>` used. Expect ignored (HTML whitelist). |
| `symlink.md` → `target.md` | Symlink to a valid file. Expect linted, no warning. |
| `broken-symlink.md` | Dangling. Expect exit 4. |
| `unreadable.md` (chmod 000 in test setup) | Expect exit 4. Skip on Windows CI. |
| `golden-input.md` + `golden-output.txt` | All rules exercised, byte-identical stdout. |

### 10.2 Integration tests

- `race-mid-lint.test.ts`: start lint, modify file during, expect warn logged, findings still emitted.
- `concurrent-invocations.test.ts`: spawn 3 linters in read-only mode on same file, all exit 0 with identical output.
- `missing-home.test.ts`: `HOME=''` env, expect layers 3-5 skipped silently.
- `missing-plugins.test.ts`: `HOME` set but no `~/.claude/plugins/`, expect skipped silently.
- `ci-mode.test.ts`: `--ci` with a skill only in layer 3 → expect SKILL-041 failure.
- `manifest-stale.test.ts`: manifest lists `/foo`, disk has nothing → expect SKILL-043 in `--ci`, warn otherwise.
- `baseline.test.ts`: finding present in baseline → demoted. New finding not in baseline → error.
- `rule-throws.test.ts`: inject a rule that throws, expect exit 2, other findings still emitted, internal error logged.
- `rule-timeout.test.ts`: inject a rule that awaits forever, expect rule skipped after 5s, exit 2.
- `progress-logging.test.ts`: mock time, ensure 5s-interval progress lines emitted.
- `node-version-guard.test.ts`: mock `process.versions.node = '20.0.0'`, expect exit 3.
- `exit-code-precedence.test.ts`: matrix of (internal_error, error_finding) → expected exit code.

### 10.3 Property-based tests (lightweight)

Using `fast-check` (add to devDeps, ~50 KB):
- Property: for any random byte sequence ≤ 100 KB, linter exits 0/1/2/4 but never crashes uncaught.
- Property: for any valid markdown, linter produces same output given same input (determinism).
- Property: line numbers in findings are within `[1, total_lines]`.

### 10.4 Mutation tests (manual, not CI)

- Script `scripts/__fixtures__/mutate.ts` that takes SKILL.md, corrupts N bytes at random offsets, runs linter. Expected outcome: linter exits 0/1/2/4 on every mutation, never uncaught crash. Run 1000 iterations periodically; not in CI. Documented in `docs/lint-skill-maintenance.md`.

### 10.5 Memory profile

Use `process.memoryUsage()` sampled before/after each rule in a dedicated test `memory-profile.test.ts`:
- Lint `large.md` (10 MB).
- Assert peak heap < 100 MB.
- Assert RSS < 250 MB.

### 10.6 Timer patterns

Per CASS memory: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`. Never `runAllTimersAsync()`. Applied in `rule-timeout.test.ts` and `progress-logging.test.ts`.

---

## 11. Recovery Hatches

When CI is red at 3am and the on-call needs to ship a hotfix to an unrelated file, the linter must not be the thing blocking the merge.

### 11.1 `--ignore-rule RULE-ID`

- Disables a rule for this invocation.
- **Warning printed to stderr with importance `warn`**: `rule {id} ignored via --ignore-rule; violations will be re-flagged on next run`.
- In CI, if this flag is detected in the workflow invocation: echo the warning in the GitHub Actions summary and add a comment to the PR. (Actual PR-commenting is out of scope for v1; the workflow can at least log it prominently.)
- Not configurable via config file — must be a CLI arg. Prevents a permanent hidden disable.

### 11.2 `--ignore-finding RULE-ID:FILE:LINE`

- Narrower than `--ignore-rule`. Same warning semantics.
- Useful when one line is acceptably bad and rule is still useful elsewhere.

### 11.3 `SKILL_LINT_EMERGENCY=1` env

- Makes all findings `warn`. Exits 0 unless internal error.
- Logs `EMERGENCY MODE: linter is not enforcing rules` to stderr at `error` level every invocation.
- **CI grep**: CI workflow greps for `SKILL_LINT_EMERGENCY` in its own env and fails with a distinct code if set, to prevent anyone from silently using it in CI. Emergency is a local-only hatch.

### 11.4 Baseline (already covered in §4.4)

Reminds: baseline demotes existing findings. Not an ignore, but a gentler ratchet.

### 11.5 Break-glass documentation

Add `docs/lint-skill-runbook.md` (out of scope to write here; flagged) with:
- How to read a linter failure in a PR.
- How to reproduce locally (`npm run lint:skill -- --reproduce-ci`).
- When to use `--ignore-rule` vs fix the issue.
- When to regenerate the baseline.
- Who owns the linter (maintainers list).

---

## Summary of Robustness Design Decisions

| Decision | Why |
|---|---|
| remark-parse tokenizer, not regex | Survives nested fences, unclosed fences, BOM, mixed endings — the bead-z9g class of bugs. |
| Two-severity model (error/warn) | UBS lesson: heuristics as blockers freeze the repo. |
| Per-rule try/catch + timeout | One buggy rule cannot take out CI. |
| Checked-in skill manifest | Deterministic CI; solves "passes locally, fails in CI" for skill resolution. |
| `--ci` flag (layers 1-2 only) | Separates dev convenience from CI correctness. |
| Baseline diff mode | Allows adopting the linter on a legacy SKILL.md without a 100-finding big-bang PR. |
| Deterministic output (sorted, no timestamps) | Golden-file tests possible; CI output diffable. |
| Structured stderr logger | 3am pager-friendly. |
| Exit code precedence 2 > 4 > 3 > 1 > 0 | Internal errors shadow findings — fix the linter first. |
| Default unknown-structure tolerance | Grammar evolution does not block merges. |
| `SKILL_LINT_EMERGENCY` env with CI guard | Emergency hatch exists but cannot silently hide in CI. |
| `.nvmrc` + engines | Eliminate Node-version drift. |
| No network, no secrets in workflow | Minimum privilege; obvious to reviewers. |
| 10 MiB input cap, 30s timeout, 5s rule timeout | Bounded resource usage — linter cannot take out the build agent. |
| Atomic `--fix` via tmpfile + rename | No half-written SKILL.md possible. |

---

## Risks & Open Questions

1. **`remark-parse` transitive dep footprint** — ~100 packages. Acceptable for a dev tool; a correctness reviewer may push for a smaller parser. Mitigation: pin exact versions, audit on upgrade.
2. **Skill manifest maintenance burden** — any new `/slash-skill` reference requires a manifest update. Mitigation: `--update-manifest` flag regenerates from disk; pre-commit hook could auto-run it (explicitly out of scope for v1).
3. **Baseline decay** — if baselines are never reduced, the ratchet rots. Mitigation: add a `--baseline-report` mode that prints age of each baseline entry; ergonomics concern, flagged for that perspective.
4. **Cross-platform CI** — plan assumes Linux runner. Windows runners would need path-separator fixes (`\\` vs `/`). v1: Linux-only, documented.
5. **Pre-commit integration** — nice-to-have, not v1. Would require a fast path (parse cache) to keep commit time under 500ms. Flagged for ergonomics plan.
6. **Interaction with `orchestrate-refine-skill` skill** — that skill modifies SKILL.md in-place. If it runs concurrently with a linter invocation, the mid-lint-modify path (§1.1) kicks in. Document in the runbook.

---

## File-Level Deliverables (for handoff to implementation)

- `scripts/lint-skill.ts` — CLI entry point (~150 LOC expected).
- `scripts/lint-skill-lib.ts` — rule engine, resolution layers, parser wrapper (~600 LOC).
- `scripts/lint-skill-logger.ts` — structured stderr logger (~80 LOC).
- `scripts/skill-manifest.json` — checked-in skill list (generated initially).
- `scripts/skill-exceptions.json` — false-positive exceptions list.
- `scripts/lint-skill.config.json` — optional config (not in v1 unless needed).
- `scripts/lint-skill-baseline.json` — baseline demotion list.
- `scripts/__tests__/lint-skill.test.ts` — test suite.
- `scripts/__fixtures__/robustness/` — fixture directory.
- `.github/workflows/lint-skill.yml` — CI workflow.
- `.nvmrc` — Node pin.
- `docs/lint-skill-runbook.md` — break-glass docs (plan doc, not this plan).
- `mcp-server/package.json` — add `remark-parse`, `unified`, `jsonc-parser`, `fast-check` to devDeps.

End of robustness plan.
