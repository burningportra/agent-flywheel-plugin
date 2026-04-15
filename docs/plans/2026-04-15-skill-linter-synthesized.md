# SKILL.md Linter — Synthesized Plan

**Author:** BrightCave (synthesis, deep-plan)
**Date:** 2026-04-15
**Sources:** `2026-04-15-correctness.md` (PurpleWolf), `2026-04-15-ergonomics.md` (ergonomics-planner), `2026-04-15-robustness.md` (PinkCompass)
**Target:** `mcp-server/src/lint/` + `mcp-server/scripts/lint-skill.ts` + Vitest suite + GitHub Actions CI
**Repo:** `agent-flywheel` v2.9.0 (TypeScript/ESM/NodeNext, Vitest 2.x, strict TS)

---

## 1. Context

`skills/flywheel/SKILL.md` is 1438 lines, authored jointly by humans and AI agents over months. It contains ~28–59 `AskUserQuestion` call sites (count varies by measurement; plans disagreed — clarified in §17), ~5 hard-rule callouts, and hundreds of `/slash-skill` references and `<placeholder>` tags. Prior incidents (bead-z9g: `*/` inside nested fences cascading into 100+ TS errors; UBS false-positive floods freezing merges) have made it clear that a linter here must:

1. Enforce the invariants the flywheel skill depends on (Universal Rule 1: every decision goes through `AskUserQuestion` with 2–4 options each carrying a `description`).
2. Produce zero false positives on the current file at HEAD.
3. Never be the thing that blocks an unrelated merge at 3am.

This synthesis picks the strongest answer from each source plan and resolves the places where they genuinely disagree.

---

## 2. Per-plan acknowledgment

### 2.1 What the Correctness plan (PurpleWolf) does better

- **Sharpest rule semantics.** PurpleWolf's rule table is the most precise — `AUQ003` distinguishes "header missing" from "header >12 chars" with the exact unicode-counting rule (`Array.from(s).length`), calling out the Claude Code tool contract. That distinction would be lost in the other two plans.
- **Best false-positive reasoning.** §4 enumerates every FP source (AUQ example inside code fence, quoted "wait for confirmation" as example of bad, Universal Rule 1 definitional region) with an explicit mitigation per row. Both other plans cite FP avoidance but don't enumerate.
- **Honest about IMPL001's exemptions.** The plan spells out that phrases inside UR1 callouts and phrases followed by a real AUQ call within 20 lines must be skipped — without these, the linter would flag the rule's own documentation.
- **Unique insight adopted in the synthesis:** the idea that the AUQ payload is pseudo-JavaScript (not JSON), so the AUQ-block parser must be a tolerant object-literal walker that extracts `question:`, `options:`, `multiSelect:` from a brace-balanced scan. Robustness wanted raw `jsonc-parser`; that works for well-formed examples but not for the JS-ish shapes the actual file uses.

### 2.2 What the Ergonomics plan does better

- **Error message format is the clearest.** Every message quotes the offending text, names the rule ID, and prescribes the fix in one sentence. Robustness and correctness both settle for `{rule_id} {message}`; ergonomics gives a BAD/GOOD template per rule that will save every future reviewer five minutes.
- **Output channels are fully designed.** TTY detection, `GITHUB_ACTIONS` env sniff, `pretty`/`compact`/`gha`/`json`/`sarif` all specified with real sample output. Correctness has only terminal+JSON; robustness has terminal+github+json. Ergonomics covers every realistic consumer.
- **Autofix algorithms are concrete.** The other plans either omit autofix entirely (correctness) or reserve it for "future" (robustness). Ergonomics specifies exact algorithms for AUQ002 (description-from-label), AUQ003 (insert `multiSelect`), SLASH001 (Levenshtein), PLACE001 (stub comment), HARD001 (enforcement ref), IMPL001 (AskUserQuestion template) with safety tiers (`--fix` vs `--fix-review`).
- **"How to add a rule" section.** 30-minute recipe with the `LintRule` interface, register step, Vitest template, and taxonomy update. This is the only plan that treats rule authorship as a first-class user story.
- **Unique insight adopted in the synthesis:** suppression via HTML comments (`<!-- lint-disable-next-line RULE reason: … -->`) is the right Markdown-native primitive and dovetails with markdownlint convention. The reason-annotation requirement turns every suppression into self-documenting tech debt.

### 2.3 What the Robustness plan (PinkCompass) does better

- **Adversarial input handling is unmatched.** §1.1 is a 21-row decision table for file-system edge cases: BOM, CRLF, symlinks, files modified mid-lint, 10 MiB cap, invalid UTF-8, NUL bytes. The bead-z9g scenario (`*/` inside nested code fence) is called out and has a dedicated fixture. Neither other plan addresses these.
- **Parser choice is correct for real-world SKILL.md.** PinkCompass picked `remark-parse` + `unified` + `jsonc-parser` after rejecting regex and micromark. The bead-z9g precedent alone (hand-rolled regex cascaded to 100+ errors) makes this the load-bearing call. Correctness's hand-rolled state machine is intellectually elegant but has not been road-tested against nested quad-backtick fences.
- **Determinism is taken seriously.** §7's non-determinism source table (Date, locale, Map iteration, OS line endings, readdir order) with explicit mitigations is the only reason golden-file tests can work. Correctness and ergonomics both claim deterministic output but don't enumerate the sources.
- **Rule isolation harness.** `runRule()` wraps every rule in try/catch + 5s timeout. One buggy regex cannot freeze CI. This is the single most important defensive pattern for a linter that will evolve rapidly.
- **Recovery hatches.** `--ignore-rule`, `--ignore-finding`, `SKILL_LINT_EMERGENCY=1` (with CI grep guard), and `--reproduce-ci` make the linter survivable on a bad day. Every hatch logs loudly on stderr so abuse is visible.
- **Unique insight adopted in the synthesis:** the `--ci` flag that restricts skill resolution to layers 1–2 (repo-local + checked-in manifest) and ignores `~/.claude/plugins`. This is the clean answer to "passes locally, fails in CI".

---

## 3. Synthesized architecture

### 3.1 File layout

```
mcp-server/
  scripts/
    lint-skill.ts                  # CLI entry (tsx runtime, tsc builds to dist/)
    pre-commit-hook.sh             # installable hook
  src/
    lint/
      index.ts                     # lint(source, opts) -> Result (findings + internal_errors)
      parser.ts                    # remark tokenizer wrapper + AUQ payload walker
      skillRegistry.ts             # loadSkillRegistry(opts)
      logger.ts                    # structured stderr logger (reuses createLogger pattern)
      config.ts                    # zod-validated optional config file
      rules/
        askUserQuestion.ts         # AUQ001-004
        slashReferences.ts         # SLASH001
        placeholders.ts            # PLACE001
        hardRules.ts               # HARD001
        implicitDecisions.ts       # IMPL001
      reporters/
        pretty.ts                  # ANSI terminal (grouped by file)
        compact.ts                 # ESLint-style one-liner (default for non-TTY pipes)
        gha.ts                     # GitHub Actions workflow commands
        json.ts                    # machine-readable, schema-versioned
        sarif.ts                   # SARIF 2.1 (reviewdog + VS Code viewer)
      types.ts                     # Finding, Rule, Severity, Document, Span
    __tests__/
      lint/
        parser.test.ts
        rules/*.test.ts
        reporters/*.test.ts
        fixtures/
          correctness/*.md         # from correctness plan §8
          robustness/*.md          # from robustness plan §10 (adversarial)
          golden-input.md
          golden-output.txt
  .lintskill-allowlist.json        # committed baseline + knownExternalSlashes
  .lintskill-manifest.json         # CI-authoritative skill list
.github/workflows/ci.yml
.nvmrc                             # Node 22 pin
```

**Decision (adopted from correctness §1.1):** lives under `mcp-server/` because strict-TS, Vitest, ESM NodeNext, and `createLogger` are already wired there. Adding a second `package.json` for a root-level `scripts/` would duplicate build config.

**Decision (adopted from robustness §2.4):** one package, one build. The library (`src/lint/index.ts`) is importable so a future MCP tool `orch_lint_skill` can wrap it without shelling out. No second package.

### 3.2 Entry points and exports

Primary CLI: `mcp-server/scripts/lint-skill.ts`, runnable via `tsx` in dev and compiled `dist/scripts/lint-skill.js` in CI.

Exported library API (`mcp-server/src/lint/index.ts`):
```ts
export async function lint(source: string, opts: LintOptions): Promise<LintResult>;
export async function lintFiles(files: { path: string; content: string }[], opts): Promise<LintResult[]>;
export function lintString(source: string, filename: string, opts?: Partial<LintOptions>): Finding[];
export type { Finding, Rule, Severity, LintOptions, LintResult };
```

`lintString` is the fast hermetic helper ergonomics §10 designed for rule-authoring tests. No I/O.

---

## 4. Parser design

### 4.1 Two-layer parser (adopted from robustness + correctness)

**Layer 1 — CommonMark tokenization via `remark-parse` + `unified`.** This is the load-bearing change from the correctness plan's hand-rolled state machine. Rationale:

- The bead-z9g incident is in-repo evidence that hand-rolled regex dies on nested fences. The synthesized plan does not invite that failure mode.
- `remark-parse` handles: fence nesting, quad-backtick fences, tilde fences, indented fenced blocks, unclosed fences, BOM, mixed line endings — all without per-case code.
- Cost: ~100 packages in `devDependencies`. Acceptable because the linter is a dev tool, not a runtime dep.
- `remark-parse` output is a tree of tokens with `position: { start: {line,col,offset}, end: … }`. Every downstream rule gets accurate line/col "for free".

**Layer 2 — AUQ payload parser (adopted from correctness §2.3).** Inside a code fence that contains `AskUserQuestion(`, the text is pseudo-JavaScript, not JSON. The synthesized parser:

1. Receives the code-block contents from remark as a single string with known starting line.
2. Finds `AskUserQuestion\s*\(` anchors.
3. Switches to a brace-balanced scanner that honours `(`, `)`, `{`, `}`, `[`, `]` and string literals (`"…"`, `'…'`, `` `…` ``, escapes `\"`, `\\`).
4. Extracts `questions:` → array span, then for each question object extracts `question:`, `header:`, `options:`, `multiSelect:` via tolerant object-literal walk. Unknown fields are ignored.

**Why not `jsonc-parser` for the AUQ payload?** Robustness suggested it, but the real file uses JS-style unquoted keys (e.g. `question:`, `options:`) which `jsonc-parser` rejects. The tolerant walker is correctness's insight and survives the actual input.

**Parser dependency additions (devDependencies only):**
- `remark-parse@^11`
- `unified@^11`
- `mdast-util-from-markdown` (transitive via remark-parse, pinned)
- `tsx` (for script runtime)
- `fast-check@^3` (property tests — T13)

Exact versions pinned in `package-lock.json`; no `latest` ranges.

### 4.2 Slash-reference disambiguation (adopted from correctness §2.4 + robustness §2.3)

Slash refs are considered outside code fences by default. Exception: AUQ option descriptions (extracted in Layer 2) are scanned for slash refs. Exclusion heuristics, all applied to each line-level match:

- Preceded by `://`, `http:`, `https:`, `file:` — skip (URL).
- Contains `.` or `?` — skip (file extension / query string).
- Contains more than one `/` — skip (path, not a flat skill name).
- Preceded by `~/` or starts with `./` — skip (path).
- Followed by `/` within 80 chars on same line and preceded by an HTTP method token — skip (REST path).
- Matches `scripts/skill-exceptions.json` — skip (literal exception list).

Document every heuristic in `--help` and in `scripts/lint-skill.ts` header comments.

### 4.3 Placeholder disambiguation (adopted from robustness §1.3 + correctness §3)

- Tag extraction on `^<[a-z][a-z0-9_-]*>$` (case-insensitive match, case-preserved for display).
- HTML allowlist: `br`, `em`, `strong`, `code`, `pre`, `a`, `img`, `sup`, `sub`, `kbd`, `summary`, `details`, `div`, `span`, `p`, `ul`, `ol`, `li`, `table`, `tr`, `td`, `th`, `thead`, `tbody`.
- Skip if inside inline code span, link URL, or HTML comment.
- Self-closing (`<foo/>`) treated as `<foo>`.
- Attributes ignored — `<foo bar="x">` matches as `foo`.

---

## 5. Rule definitions

| ID | Severity (v1) | Title | Autofix | Source |
|---|---|---|---|---|
| AUQ001 | error | Option count out of range (must be 2–4) | No (judgment) | correctness + ergonomics |
| AUQ002 | error | Option missing `description` | Yes (safe) | correctness + ergonomics |
| AUQ003 | error | `header` missing or >12 chars (Array.from count) | Yes (safe) | correctness |
| AUQ004 | warn | `multiSelect` not explicit | Yes (safe) | correctness + ergonomics |
| SLASH001 | warn→error (phased) | Slash ref does not resolve | Yes (review) | all three |
| PLACE001 | warn | Placeholder has no referent in enclosing step | Yes (safe) | all three |
| HARD001 | info | Hard-rule callout has no downstream enforcement | Yes (safe) | correctness + ergonomics |
| IMPL001 | error | Implicit-decision phrase found (UR1 violation) | Yes (review) | correctness + ergonomics |
| SKILL-010 | error | Unclosed code fence | No | robustness §1.2 |
| SKILL-021 | warn | AskUserQuestion example is not valid JSON-like | No | robustness §1.2 |

Error message format (adopted from ergonomics §1):
```
[RULE_ID] path/to/file.md:line:col
<One-sentence plain-English description of the problem, quoting the offending text>
<One-sentence fix recommendation>
(autofix available — run with --fix)   ← only if applicable
```

Per-rule sample messages are in `ergonomics.md §1` and carry through verbatim; `AUQ003` gets the unicode-aware header-length wording from `correctness.md §3`.

### 5.1 IMPL001 phrase dictionary (adopted from ergonomics §1 + correctness §3)

Exported constant array in `src/lint/rules/implicitDecisions.ts`. Initial seed:

```
"wait for confirmation", "wait for the user", "ask the user",
"surface this to the user", "propose this to the user",
"check with the user", "only do X if the user confirms",
"confirm with the user", "prompt the user", "get user approval",
"seek user input", "let the user decide", "pause for user feedback"
```

FP defenses (all three from correctness): skip inside UR1 callout region, skip if real `AskUserQuestion(` follows within 20 lines, skip inside backtick-quoted example strings.

### 5.2 HARD001 heuristic (from correctness §3)

Severity info permanently. For each `> **Hard rule**:` line, scan next 50 non-blank, non-fence lines for an AUQ call, a `Do NOT`/`Never` bullet, or a guard that names the same concept verbatim. Otherwise flag. `info` severity means it never blocks CI — the author reads it and decides.

---

## 6. False-positive defenses

Adopted from correctness §4 (enumerated table) with robustness §1 additions:

| FP source | Mitigation |
|---|---|
| AUQ example inside a code fence | Parser validates it — these ARE the canonical form and MUST be correct |
| Slash ref inside non-AUQ code fence | Skip by default; scan only inside AUQ payload |
| Placeholder inside inline code span | Skip (remark tokens distinguish code from text) |
| `/slash` inside URL | Tokeniser exclusion |
| `/path/to/file` in bash | Multi-slash exclusion |
| Quoted "wait for confirmation" as bad example | UR1 callout region exempt; real AUQ within 20 lines exempt |
| Universal Rule definitions themselves | `⚠️ UNIVERSAL RULE` callout text exempt from IMPL001 |
| Known HTML tags | Hardcoded allowlist (PLACE001) |
| Bare-string option `"Launch"` | AUQ002 fires with bare-string hint |
| Multi-question AUQ | Each question validated independently |
| Quad-backtick fence containing triple-backticks | remark tokenizer handles natively |
| `*/` inside nested code (bead-z9g replay) | remark tokenizer — fixture test `nested-fence-with-comment-terminator.md` |
| BOM, CRLF, mixed endings, invalid UTF-8 | Normalize at input per robustness §1.5 |
| File modified mid-lint | SHA-256 hash before rules; warn if changed post-rules |

---

## 7. Output channels

### 7.1 TTY detection + format default (from ergonomics §3)

```ts
const isTTY = process.stdout.isTTY;
const isGHA = Boolean(process.env.GITHUB_ACTIONS);
const format = argv.format ?? (isGHA ? "gha" : isTTY ? "pretty" : "compact");
```

### 7.2 Formats

| Format | Use case |
|---|---|
| `pretty` | TTY terminal (ANSI colors, grouped by file, summary footer) |
| `compact` | Non-TTY pipes, scripting (ESLint-style one-liner) |
| `gha` | GitHub Actions (`::error file=…,line=…,col=…,title=AUQ001::…`) |
| `json` | Programmatic consumers (schema-versioned, see below) |
| `sarif` | reviewdog / VS Code SARIF viewer / future GitHub Code Scanning |

### 7.3 Determinism (adopted from robustness §7)

Findings sorted by `(path, line, col, rule_id, message)`. No `Date.now()`, no timezone-sensitive rendering, no `Math.random()` in stdout. `fs.readdir` results `.sort()`'d before iteration. `Object.keys()` sorted before JSON emission. Golden-file test (`golden-input.md` → `golden-output.txt`) runs in CI and asserts byte-identical output.

### 7.4 JSON schema (v1, merged from correctness §6 + robustness §4)

```json
{
  "schemaVersion": 1,
  "tool": "lint-skill",
  "toolVersion": "<version>",
  "rulesetVersion": 1,
  "files": [
    {
      "path": "skills/flywheel/SKILL.md",
      "diagnostics": [
        {
          "ruleId": "AUQ003",
          "severity": "error",
          "line": 36, "col": 3, "endLine": 36, "endColumn": 45,
          "message": "…",
          "fix": null,
          "sha256_of_snippet": "…"
        }
      ]
    }
  ],
  "internalErrors": [],
  "summary": { "errors": 0, "warnings": 0, "infos": 0, "autofixable": 0, "filesScanned": 1 }
}
```

SARIF 2.1 output is a separate reporter; maps 1:1 from the JSON shape.

---

## 8. Suppression syntax

### 8.1 HTML-comment directives (adopted from ergonomics §5)

```markdown
<!-- lint-disable-next-line RULE_ID reason: why -->
...line to be suppressed...

<!-- lint-disable RULE_ID,RULE_ID2 -->
...block...
<!-- lint-enable RULE_ID,RULE_ID2 -->

<!-- lint-skill-config: disable RULE_ID -->   (first 10 lines of file only)
```

HTML comments were chosen because they (a) do not render in GitHub/Obsidian/VS Code preview, (b) are already the markdownlint/remark-lint convention, (c) require no preprocessor — the linter's parser already sees them.

### 8.2 Reason requirement

A suppression without a `reason:` annotation emits a `[META]` warning: self-documenting tech debt stays readable. The warning does not affect exit code.

### 8.3 Overlap with baseline

Baseline (§13) is for pre-existing findings the team has not yet cleaned up — silent demotion to info. Suppression comments are for intentional, permanent exceptions — visible in source, reason-required. Both mechanisms coexist; baseline fingerprint matching runs after suppression filtering.

---

## 9. Skill-list resolution

### 9.1 Layered resolver (merged)

Priority order; first hit wins; all layers consulted for diagnostics.

1. **Repo-local skills.** `skills/*/SKILL.md` — directory name maps to `/{dirname}`, frontmatter `name:` (if present) overrides.
2. **Checked-in manifest.** `.lintskill-manifest.json` — explicit skill list, authoritative in CI.
3. **User plugin skills.** `~/.claude/plugins/*/skills/*/SKILL.md` — environment-dependent.
4. **User marketplace/global skills.** `~/.claude/skills/*/SKILL.md` — environment-dependent.

**`--ci` flag (from robustness §2.1):** restricts resolution to layers 1–2 only. Solves "passes locally, fails in CI" by making CI resolution deterministic and the manifest the source of truth.

**Allowlist (from correctness §9):** `.lintskill-allowlist.json` has `knownExternalSlashes` (pre-approved CLI built-ins like `/fast`, `/clear`, `/help`) and `acceptedFindings` (explicit per-finding exceptions with `reason`).

### 9.2 Layer failure handling (from robustness §2.2)

- Missing `~/.claude/plugins` → skip layer silently, debug-level log once.
- `HOME` unset → skip layers 3–4 silently.
- Manifest missing → skip; debug-log `run with --update-manifest to generate`.
- Manifest malformed JSON → exit 4 with clear path + offset.
- Manifest entry present on disk missing in CI mode → error SKILL-043 `run --update-manifest`.

### 9.3 Typo suggestions (from all three)

Levenshtein distance ≤ 2, unambiguous (no tie within distance 1). Dry-run output shows the suggested replacement. `--fix-review` accepts it.

---

## 10. Performance and robustness

### 10.1 Budgets

| Metric | Budget | Source |
|---|---|---|
| Lint a 1438-line file | <1 s (target 200 ms) | ergonomics §4 |
| Lint a 10 MiB synthetic file | <30 s | robustness §10.5 |
| Peak heap on 10 MiB | <100 MB | robustness §10.5 |
| RSS on 10 MiB | <250 MB | robustness §10.5 |
| Overall timeout (CLI) | 30 s (`--timeout`) | robustness §3.1 |
| Per-rule timeout | 5 s | robustness §3.1 |

### 10.2 Adversarial input handling (from robustness §1.1 — adopted wholesale)

21-row decision table covering: missing file, empty, whitespace-only, >10 MiB, symlinks (and broken), unreadable (EACCES), UTF-8 BOM (strip), CRLF/mixed endings (normalize, preserve line numbers via offset map), non-UTF-8 (exit 4 with byte offset), trailing NULs (exit 4), very long lines (truncate snippet to 200 chars), file modified mid-lint (warn, continue).

### 10.3 Rule isolation (from robustness §5)

Every rule wrapped in:
```ts
async function runRule(rule, ctx): Promise<RuleResult> {
  const started = performance.now();
  try {
    const findings = await Promise.race([rule.run(ctx), timeout(5000, `rule ${rule.id} exceeded 5s`)]);
    return { ruleId: rule.id, findings, internalError: null, durationMs: performance.now() - started };
  } catch (err) {
    return { ruleId: rule.id, findings: [], internalError: serializeError(err), durationMs: performance.now() - started };
  }
}
```

Internal errors are collected separately; exit code 2 if any rule threw.

### 10.4 Exit codes (from robustness §9)

| Code | Meaning |
|---|---|
| 0 | Clean (no errors; warnings OK unless `--strict`) |
| 1 | One or more error-severity findings, no internal errors |
| 2 | Internal error — rule threw, timeout, parser crashed (precedence over 1) |
| 3 | Invalid CLI args |
| 4 | Input unreadable (missing, size cap exceeded, non-UTF-8, manifest malformed) |
| 5 | Lock contention (reserved for `--fix` — not v1) |
| 130 | SIGINT |
| 143 | SIGTERM |

Precedence: 2 > 4 > 3 > 1 > 0. Signal codes supersede.

### 10.5 Signal and PWD handling (from robustness §3)

- SIGINT/SIGTERM: clean exit 130/143.
- SIGPIPE: catch EPIPE, exit 0 if no findings pending.
- Repo root resolved by walking up from script location to `.git` (cap 10 levels), not `process.cwd()`.
- Node version gate: `engines: { node: ">=22 <23" }` + `.nvmrc`; linter refuses to run under lower, exits 3.

### 10.6 Structured stderr logger (from robustness §8)

Line-per-event, key-value after level tag. Timestamp opt-in (`--log-timestamps`) so tests stay deterministic. Reuses `createLogger` pattern at `mcp-server/src/logger.ts`. **Never `console.log` in linter code except through the single `emitFinding()` writer.** All diagnostics go to stderr.

---

## 11. CI integration

### 11.1 `.github/workflows/ci.yml` (merged from correctness §7 + robustness §4)

```yaml
name: CI
on:
  push: { branches: [master] }
  pull_request: { branches: [master] }

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
          cache-dependency-path: mcp-server/package-lock.json
      - run: npm ci
        working-directory: mcp-server
      - run: npm run build
        working-directory: mcp-server

  test:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: mcp-server/package-lock.json }
      - run: npm ci
        working-directory: mcp-server
      - run: npm test
        working-directory: mcp-server

  lint-skill:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: mcp-server/package-lock.json }
      - run: npm ci
        working-directory: mcp-server
      # This workflow is local-only: no network, no secrets.
      - run: |
          if [ -n "$SKILL_LINT_EMERGENCY" ]; then
            echo "::error::SKILL_LINT_EMERGENCY must not be set in CI"
            exit 1
          fi
          npm run lint:skill:ci
        working-directory: mcp-server
      - run: npm run lint:skill:json > lint-skill-report.json
        working-directory: mcp-server
        if: failure()
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: lint-skill-report
          path: mcp-server/lint-skill-report.json
          retention-days: 14
```

Three separate jobs (build / test / lint-skill) so a failing skill lint does not mask a failing unit test in the PR status UI. All keyed on `.nvmrc` and `package-lock.json`.

### 11.2 `--reproduce-ci` (from robustness §4.5)

Sugar for `--ci --baseline .lintskill-baseline.json --file skills/flywheel/SKILL.md --log-level=info --format pretty`. Documented as the single command for CI repro.

### 11.3 `SKILL_LINT_EMERGENCY=1` guard (from robustness §11.3)

Local-only escape hatch. Workflow greps its own env and fails loudly if set. Emergency cannot silently hide in CI.

---

## 12. npm scripts

Adopted from ergonomics §6 and correctness §1.3, merged:

```json
{
  "scripts": {
    "build": "tsc",
    "lint:skill": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --baseline .lintskill-baseline.json",
    "lint:skill:fix": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --fix",
    "lint:skill:ci": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --ci --baseline .lintskill-baseline.json --format gha",
    "lint:skill:json": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --ci --format json",
    "lint:skill:update-baseline": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --update-baseline",
    "lint:skill:update-manifest": "tsx scripts/lint-skill.ts --update-manifest",
    "test": "vitest run --passWithNoTests && npm run lint:skill"
  },
  "devDependencies": {
    "tsx": "^4",
    "remark-parse": "^11",
    "unified": "^11",
    "fast-check": "^3"
  },
  "engines": { "node": ">=22 <23" }
}
```

`lint:skill` (dev default) uses the baseline so locals see only new findings; `lint:skill:ci` is what the workflow runs.

---

## 13. Migration / rollout

### 13.1 Baseline with content-hash fingerprints (merged)

`.lintskill-baseline.json`:
```json
{
  "schemaVersion": 1,
  "generated": "2026-04-15T02:00:00Z",
  "entries": [
    { "ruleId": "PLACE001", "file": "skills/flywheel/SKILL.md", "line": 573, "sha256": "abc…", "reason": "" }
  ]
}
```

- **Fingerprint = SHA-256 of (line-1 ∪ line ∪ line+1) text** (robustness §4.4 + ergonomics §8). Survives minor line shifts.
- Baselined findings demoted to `info` and rendered `[baselined]`. Never affect exit code.
- `--update-baseline` regenerates from current state. `--show-baseline` lists entries with age.
- CI runs with `--baseline`; dev default also uses baseline.
- Target: reduce to zero within 2 sprints (ergonomics §8 schedule). A dedicated bead `lint-skill: clear baseline violations` addresses findings in batches.

### 13.2 Severity phasing (adopted from correctness §9)

- **Phase 1 (v1.0 of linter):** SLASH001=warn, HARD001=info, IMPL001=error, AUQ001/002/003=error, AUQ004=warn. CI blocks on errors only.
- **Phase 2 (after 2 weeks stability):** SLASH001 → error.
- **Phase 3 (after baseline reaches zero):** consider HARD001 → warn.

Phase transitions gated on "baseline is stable and the team has had 2 weeks to adapt" — not a calendar date.

### 13.3 Allowlist (`.lintskill-allowlist.json`)

Orthogonal to the baseline. Contains `knownExternalSlashes` (pre-approved CLI built-ins and cross-repo skills) and `acceptedFindings` (narrow exceptions with required `reason:` text). Adding an entry requires reviewer approval in the PR (social gate, not technical).

---

## 14. Test plan

### 14.1 Fixtures (merged from all three)

Under `mcp-server/src/__tests__/lint/fixtures/`:

- **Rule fixtures (from correctness §8 + ergonomics §10):** `clean.md`, `auq001-too-few.md`, `auq001-too-many.md`, `auq002-missing-desc.md`, `auq002-bare-string.md`, `auq003-header-missing.md`, `auq003-header-too-long.md`, `auq003-header-emoji.md`, `auq004-implicit.md`, `slash001-typo.md`, `slash001-inside-url.md`, `slash001-http-path.md`, `place001-orphan.md`, `place001-html-tag.md`, `hard001-enforced.md`, `hard001-orphan.md`, `impl001-raw.md`, `impl001-exempt-ur1.md`, `impl001-exempt-followed.md`, `mixed-realistic.md`.
- **Adversarial fixtures (from robustness §10.1):** `empty.md`, `whitespace-only.md`, `unclosed-fence.md`, `nested-fence.md`, `nested-fence-with-comment-terminator.md` (bead-z9g replay), `crlf.md`, `mixed-line-endings.md`, `utf8-bom.md`, `very-long-line.md`, `large.md` (10 MiB), `over-cap.md` (11 MiB), `invalid-utf8.md.binary`, `null-bytes.md.binary`, `malformed-aq-json.md`, `aq-with-comments.md`, `aq-with-trailing-commas.md`, `aq-50-lines.md`, `aq-tab-indented.md`, `placeholder-in-code.md`, `placeholder-html-like.md`, `symlink.md`, `broken-symlink.md`.
- **Live canary (from correctness §8.5):** `live-flywheel.test.ts` runs `lint()` against the real `skills/flywheel/SKILL.md` and asserts zero errors after baseline+allowlist.
- **Golden determinism (from robustness §7.3):** `golden-input.md` + `golden-output.txt`; test asserts byte-identical stdout.

### 14.2 Coverage target

Coverage goal: 100% lines, 95% branches, 100% functions on `mcp-server/src/lint/**` (correctness §8.1). Enforced via `@vitest/coverage-v8` thresholds.

### 14.3 Test categories

- Unit tests per rule, using `lintString()` — no I/O.
- Integration tests (`robustness §10.2`): race-mid-lint, concurrent invocations, missing HOME, missing plugins, `--ci` mode, manifest stale, baseline, rule throws, rule timeout, progress logging, Node version guard, exit code precedence matrix.
- Property tests with `fast-check` (T13): parser round-trip, determinism, line-number range.
- Memory profile test (robustness §10.5): lint 10 MiB, assert heap <100 MB, RSS <250 MB.
- Timer patterns: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` only; never `runAllTimersAsync()` (CASS memory).

---

## 15. Documentation

| Document | Content |
|---|---|
| `AGENTS.md` | Single paragraph: "SKILL.md files must pass `npm run lint:skill`. See `mcp-server/scripts/lint-skill.ts` for rules." |
| `mcp-server/scripts/lint-skill.ts` | Top-of-file header comment: every disambiguation heuristic, every suppression syntax |
| `mcp-server/src/lint/rules/*.ts` | JSDoc per rule (≤1 line): what it catches, autofix algo name |
| `docs/lint-skill-runbook.md` | Break-glass docs: how to read a CI failure, `--reproduce-ci`, when to `--ignore-rule` vs fix, how to regenerate baseline, ownership |
| `lint-skill --help` | Full flag reference + exit code table + rule ID table + suppression syntax (from ergonomics §11) |

No `skills/lint-skill/SKILL.md` created — the linter is a developer tool, not an agent skill.

---

## 16. Dependency graph (beads)

Ready for `br create`. Each task: `Tn: <title> | depends_on: [Tm,...] | files: [...] | acceptance: <criteria>`.

```
T1: Lint module skeleton (types, index stub, options parsing, LintRule interface) | depends_on: [] | files: [mcp-server/src/lint/types.ts, mcp-server/src/lint/index.ts, mcp-server/src/lint/config.ts] | acceptance: exports Finding, Rule, Severity, LintResult, lint() returning empty findings; npm run build passes.

T2: Parser via remark-parse + AUQ payload walker | depends_on: [T1] | files: [mcp-server/src/lint/parser.ts, mcp-server/src/__tests__/lint/parser.test.ts, fixtures for fences+AUQ payloads] | acceptance: emits Document with fences, AskUserQuestion calls, slash refs, placeholders, hard rules, headers with accurate line/col; 100% branch coverage on parser.

T3: Skill registry resolver with CI-mode layer restriction | depends_on: [T1] | files: [mcp-server/src/lint/skillRegistry.ts, mcp-server/src/__tests__/lint/skillRegistry.test.ts] | acceptance: reads skills/, ~/.claude/plugins/, ~/.claude/skills/, honors --ci flag (layers 1-2 only), manifest parse + validation, Levenshtein suggest; AbortSignal timeout.

T4: Structured stderr logger + config file zod schema | depends_on: [T1] | files: [mcp-server/src/lint/logger.ts, mcp-server/src/lint/config.ts] | acceptance: levels error/warn/info/debug, --log-timestamps opt-in, --quiet/--verbose, zero console.log outside emitFinding.

T5: AUQ rules (AUQ001-AUQ004) | depends_on: [T2] | files: [mcp-server/src/lint/rules/askUserQuestion.ts, tests + fixtures] | acceptance: all AUQ fixtures yield expected findings; unicode header length via Array.from; 100% line coverage.

T6: SLASH001 rule + Levenshtein suggest | depends_on: [T2, T3] | files: [mcp-server/src/lint/rules/slashReferences.ts, tests] | acceptance: URL + path + multi-slash exemptions honored; typo suggestion ≤2 distance unambiguous.

T7: PLACE001 rule with HTML allowlist | depends_on: [T2] | files: [mcp-server/src/lint/rules/placeholders.ts, tests] | acceptance: HTML tags and inline-code placeholders skipped; enclosing-step referent resolution.

T8: HARD001 rule (heuristic, severity info) | depends_on: [T2] | files: [mcp-server/src/lint/rules/hardRules.ts, tests] | acceptance: 50-line forward scan for AUQ/"Do NOT"/"Never"; severity permanently info.

T9: IMPL001 rule with phrase dictionary + FP defenses | depends_on: [T2] | files: [mcp-server/src/lint/rules/implicitDecisions.ts, tests] | acceptance: UR1 callout region exempt; AUQ-within-20-lines exempt; backtick-quoted exempt; exported phrase array.

T10: Reporters (pretty, compact, gha, json, sarif) + determinism | depends_on: [T1, T4] | files: [mcp-server/src/lint/reporters/*.ts, reporter tests] | acceptance: sorted output (path,line,col,ruleId); JSON schemaVersion=1; TTY detection; GITHUB_ACTIONS env sniff.

T11: Rule isolation harness + timeout + exit codes | depends_on: [T1] | files: [mcp-server/src/lint/index.ts (runRule), tests for rule-throws, rule-timeout, exit-code precedence] | acceptance: per-rule try/catch + 5s timeout; internal errors separated from findings; exit 2 precedence over 1.

T12: Suppression syntax + baseline (--baseline, --update-baseline, --show-baseline, fingerprints) | depends_on: [T1, T10] | files: [mcp-server/src/lint/suppress.ts, mcp-server/src/lint/baseline.ts, tests] | acceptance: HTML-comment suppressions honored; sha256 fingerprint survives ±line shifts; --update-baseline regenerates.

T13: Autofix pipeline (--fix safe; --fix-review requires user verify; --fix-dry-run) | depends_on: [T5, T6, T7, T8, T9] | files: [mcp-server/src/lint/fix.ts, tests] | acceptance: AUQ002/003, PLACE001, HARD001 safe-autofixable; SLASH001, IMPL001 gated behind --fix-review; atomic tmpfile+rename writes.

T14: CLI entry + all flags + --reproduce-ci + SKILL_LINT_EMERGENCY | depends_on: [T5, T6, T7, T8, T9, T10, T11, T12] | files: [mcp-server/scripts/lint-skill.ts, mcp-server/package.json scripts, .nvmrc] | acceptance: all documented flags work; Node version guard; exit-code table honored; --help shows rule+exit+suppression tables.

T15: Baseline + manifest + allowlist files committed | depends_on: [T14] | files: [mcp-server/.lintskill-baseline.json, mcp-server/.lintskill-manifest.json, mcp-server/.lintskill-allowlist.json] | acceptance: generated from current SKILL.md; lint:skill exits 0 with baseline applied.

T16: Pre-commit hook template | depends_on: [T14] | files: [mcp-server/scripts/pre-commit-hook.sh] | acceptance: shell-only (no husky dep); lints staged SKILL.md files with --format compact.

T17: GitHub Actions CI workflow | depends_on: [T14, T15] | files: [.github/workflows/ci.yml, .nvmrc] | acceptance: three jobs (build, test, lint-skill); node-version-file: .nvmrc; SKILL_LINT_EMERGENCY guard; artifacts uploaded on failure.

T18: Live-file snapshot test (canary) | depends_on: [T14, T15] | files: [mcp-server/src/__tests__/lint/live-flywheel.test.ts] | acceptance: lint real skills/flywheel/SKILL.md with baseline → zero errors.

T19: Adversarial fixture suite + golden-file determinism test | depends_on: [T14] | files: [mcp-server/src/__tests__/lint/fixtures/robustness/*, golden-input.md, golden-output.txt] | acceptance: all fixtures from §14.1 present; golden output byte-identical across runs.

T20: AGENTS.md hard-constraint update + runbook | depends_on: [T17] | files: [AGENTS.md, docs/lint-skill-runbook.md] | acceptance: one-paragraph AGENTS.md entry; runbook covers CI failure reading, --reproduce-ci, --ignore-rule decision tree, baseline regeneration, ownership.

T21 (optional): Property tests with fast-check | depends_on: [T2, T5, T11] | files: [mcp-server/src/__tests__/lint/property/*] | acceptance: parser round-trip invariant on 1000 inputs; determinism property; line-number range property.

T22 (optional): Memory profile test | depends_on: [T14] | files: [mcp-server/src/__tests__/lint/memory-profile.test.ts] | acceptance: lint 10 MiB synthetic; peak heap <100 MB; RSS <250 MB.

T23 (optional, future): MCP tool orch_lint_skill wrapping lint() | depends_on: [T14] | files: [mcp-server/src/tools/orch-lint-skill.ts] | acceptance: callable via MCP; returns same JSON schema as CLI.
```

### 16.1 Parallelisation waves

- **Wave 1:** T1 (blocks everything).
- **Wave 2:** T2, T3, T4 in parallel.
- **Wave 3:** T5, T6, T7, T8, T9, T10, T11 in parallel (all depend on T2 and/or T1).
- **Wave 4:** T12, T13 in parallel.
- **Wave 5:** T14 (CLI assembly).
- **Wave 6:** T15, T16, T18, T19 in parallel; T17 after T15.
- **Wave 7:** T20.
- **Wave 8 (optional):** T21, T22, T23.

Critical path: T1 → T2 → (T5…T11) → T12 → T14 → T15 → T17 → T20. ~8 serial hops.

---

## 17. Open questions for the coordinator

These are load-bearing decisions where the source plans disagreed and reasonable reviewers could pick either side. Surface these at the Step 5.55 alignment check.

1. **Parser choice — `remark-parse` vs hand-rolled state machine.** This synthesis picked `remark-parse` because of bead-z9g precedent. Correctness's hand-rolled approach has zero deps and is intellectually cleaner but has not been stress-tested against nested quad-backtick fences. If the coordinator prefers zero new devDependencies, T2 needs to switch to the hand-rolled machine and T19 grows to cover every fence-nesting edge case manually.
2. **Rollout gating — severity phasing vs baseline-only.** Correctness proposed a 3-phase severity ratchet (SLASH001 warn→error after 2 weeks); ergonomics proposed baseline-only with `--emit-baseline` on day one. Synthesis adopted both, but they can drift: if the baseline is never cleared, Phase 3 (HARD001 demotion) loses meaning. Alternative is to drop severity phasing and rely solely on the baseline.
3. **`npm test` blocking on SKILL.md lint failures.** Ergonomics said yes with baseline softening; correctness appended `lint:skill` to `test`; robustness left CI as the enforcer but did not block local `npm test`. Synthesis adopts ergonomics's "test depends on lint:skill" because it matches `AGENTS.md` muscle memory, but a prose-focused contributor may find this punishing. Alternative: separate `test` from `lint:skill` and rely on CI only.
4. **Autofix breadth in v1.** Ergonomics specified 6 autofixes; robustness deferred `--fix` to post-v1; correctness didn't mention autofix. Synthesis ships safe autofixes (AUQ002, AUQ003, PLACE001, HARD001) in T13 but leaves `--fix-review` for SLASH001/IMPL001. If reviewer wants a leaner v1, drop T13 and add autofix in v1.1.
5. **Whether to lint `commands/*.md` too.** Correctness §12 and robustness §2 both flagged this as "not v1". Confirming that scope bound explicitly.
6. **Manifest vs pure-filesystem skill resolution in CI.** Robustness introduced `.lintskill-manifest.json` as a checked-in source of truth; correctness leaned on filesystem glob + allowlist. Synthesis adopted the manifest because it makes CI deterministic, but it adds a maintenance burden (every new skill requires a manifest update or `--update-manifest` invocation). Alternative: no manifest, glob `skills/` at lint time, and the allowlist covers CLI built-ins.
7. **Parser dep footprint.** `remark-parse` pulls ~100 transitive packages. Robustness accepted this; correctness rejected it for a lean MCP server. If the team runs `npm audit` and gets noise, this is the first thing to revisit.
8. **AUQ call site count.** Correctness says 28, robustness says 59. This is a concrete fact about the file at HEAD and must be verified empirically before T15 (baseline generation) — the number shapes the baseline size and review burden.

---

**End of synthesis.**
