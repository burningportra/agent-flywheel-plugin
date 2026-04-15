# SKILL.md Linter — Correctness Plan

**Author:** PurpleWolf (correctness perspective, deep-plan)
**Date:** 2026-04-15
**Target:** `scripts/lint-skill.ts` + Vitest suite + GitHub Actions CI
**Repo:** claude-orchestrator v2.9.0 (TypeScript/ESM/NodeNext, Vitest 2.x, strict TS)

---

## 0. Goals and non-goals

**Goal:** A provably-correct linter that parses `skills/orchestrate/SKILL.md` (1438 lines, ~28 `AskUserQuestion` call sites) and enforces:

1. Every `AskUserQuestion` call site has 2–4 options, each with a `description`.
2. Every `/slash-name` reference resolves to an installed skill.
3. Every `<placeholder>` tag has a referent in the same step.
4. Every `> **Hard rule**:` callout has downstream enforcement evidence (heuristic).
5. Implicit-decision red-flag phrases are bugs (Universal Rule 1 enforcement).

**Non-goals:**
- Markdown prettification, typo checking, or spell-checking.
- Validating non-orchestrate skills (out of initial scope; generalisable later).
- Natural-language linting beyond hard red-flag phrases.

**Correctness contract:** Zero false positives on the existing `skills/orchestrate/SKILL.md` at HEAD after one round of allowlist curation (see §9). All rule logic is deterministic, idempotent, and side-effect-free.

---

## 1. Architecture

### 1.1 Layout

```
mcp-server/
  scripts/
    lint-skill.ts            # CLI entry (invoked via tsx or compiled to dist/)
  src/
    lint/
      index.ts               # Linter::lint(source, options) -> Finding[]
      parser.ts              # parse() -> Document AST
      rules/
        askUserQuestion.ts   # AUQ001–AUQ004
        slashReferences.ts   # SLASH001
        placeholders.ts      # PLACE001
        hardRules.ts         # HARD001
        implicitDecisions.ts # IMPL001
      skillRegistry.ts       # resolveInstalledSkills()
      reporters/
        terminal.ts          # pretty ANSI output
        json.ts              # machine-readable
      types.ts               # Finding, Rule, Severity, Document, Span
    __tests__/
      lint/
        parser.test.ts
        rules/*.test.ts
        fixtures/*.md
```

**Decision:** Linter lives under `mcp-server/` because it shares TypeScript config, Vitest, ESM resolution, and `createLogger` conventions. Keeping it in-tree avoids a second `package.json` and reuses the existing strict-TS + NodeNext build.

**Rationale vs `scripts/` at repo root:** the repo-root `scripts/` directory would require its own `tsconfig.json`, its own `package.json`, and duplicate Vitest setup. Re-using `mcp-server/` costs nothing and keeps all TS under one build.

### 1.2 Entry points

**Primary:** standalone CLI at `mcp-server/scripts/lint-skill.ts`, invoked via tsx for dev (`npx tsx scripts/lint-skill.ts`) and compiled via existing `tsc` to `mcp-server/dist/scripts/lint-skill.js` for CI.

```
Usage: lint-skill [options] [paths...]
Options:
  --json                 Emit JSON findings on stdout
  --fix-allowlist FILE   Path to baseline allowlist (default: .lintskill-allowlist.json)
  --update-allowlist     Regenerate allowlist from current findings (CI forbids this)
  --severity LEVEL       Minimum severity to emit (error|warn|info). Default: info.
  --rule RULE_ID         Only run this rule (repeatable).
  --skills-root DIR      Override skill registry root (default: repo skills/ + ~/.claude/plugins)
```

Exit codes: `0` = clean, `1` = findings at severity ≥ error, `2` = internal/parse error (distinguishes lint failure from tool failure — CI parses this).

**Secondary (deferred, out of first-bead scope):** an MCP tool `orch_lint_skill` wrapping the same library. Skipped in v1 to keep the surface small; mentioned in §10.

### 1.3 npm wiring

Add to `mcp-server/package.json` scripts:

```json
{
  "scripts": {
    "lint:skill": "tsx scripts/lint-skill.ts ../skills/orchestrate/SKILL.md",
    "lint:skill:json": "tsx scripts/lint-skill.ts --json ../skills/orchestrate/SKILL.md",
    "test": "vitest run --passWithNoTests && npm run lint:skill"
  }
}
```

`lint:skill` is appended to `test` so the default flywheel test gate runs it. Rationale: matches AGENTS.md instruction "Run tests with `cd mcp-server && npm test`" — the existing muscle memory catches regressions automatically.

Add `tsx` to `devDependencies` (no new runtime dep in the MCP server itself).

---

## 2. Parser design

### 2.1 Decision: hand-rolled line-aware state machine (NOT regex-over-whole-file; NOT markdown AST library)

**Rejected option A — single regex over the full file.** Rejected because AUQ call sites span multiple lines, nest braces, and contain commas inside string literals. Regex cannot count braces reliably. Source: GitHub comment tables already pair characters — we need a real tokenizer.

**Rejected option B — `remark`/`unified` markdown AST.** Rejected because:
- Adds a ~5 MB dep tree with many transitive packages to a lean MCP server (current deps: zod, execa, typebox, MCP SDK — that's it).
- `AskUserQuestion(...)` blocks live inside fenced code blocks, which `remark` returns as opaque `code` nodes. We'd still parse the code payload ourselves.
- Hard-rule callouts (`> **Hard rule**:`) are blockquotes, but our matcher cares about the literal prefix — simpler to grep line-by-line.

**Chosen option C — line-aware state machine + focused regex for tokens.** Justification:
- SKILL.md is 1438 lines; single pass is O(n).
- We track two orthogonal states: `inFence` (triple-backtick code fence, current fence language) and `callStack` (AUQ parenthesis/brace depth while inside an AUQ call).
- Keeps the whole linter inside `mcp-server/src/lint/` with zero new deps.
- Easy to unit-test per state transition.

### 2.2 Grammar elements the parser must recognise

| Token | Pattern | Notes |
|---|---|---|
| Fence open/close | `^(\s*)(```+)(\S*)\s*$` | Captures indent, length, language. Fence closes only at same or longer backticks with matching indent. |
| Header | `^(#{1,6})\s+(.+)$` | Outside fences only. Used to define "step scopes" for PLACE001. |
| Hard rule callout | `^>\s*\*\*Hard rule\*\*\s*:` | Case-sensitive; case-insensitive variant warned. |
| Universal rule callout | `^>\s*##\s*⚠️\s*UNIVERSAL RULE` | Anchors for meta-rule IMPL001 reference. |
| AUQ call start | `AskUserQuestion\s*\(` | When matched, enter `callStack` and capture start line/col. Inside AND outside fences — both are validated. |
| Slash reference | `(^|[^\w/])(/[a-z][a-z0-9-]*(?:-[a-z0-9]+)*)\b` | Must not be preceded by `http:`, `https:`, `file:`, or a path char. See §2.4. |
| Placeholder | `<([a-z][a-z0-9_-]*)>` | Only inside prose (outside fences and outside HTML tags that look like tags). |
| Bold section | `\*\*([^*]+)\*\*` | Used to detect section labels inside placeholders. |

### 2.3 AUQ call payload parser

Once the regex fires on `AskUserQuestion(`, the parser switches to a brace-balanced scanner:

- Track `(`, `)`, `{`, `}`, `[`, `]` balance.
- Honour string literals: `"..."`, `'...'`, and backtick (within JS-ish payload — the orchestrator SKILL uses JS-style argument syntax). Escape sequences: `\"`, `\'`, `\\`.
- The call ends when outer `(` is closed.
- Capture the full text of the call + absolute line/col of opening and closing parens.

The payload is then parsed as a pseudo-JavaScript literal. **We do NOT eval it.** Instead we extract fields with a small tolerant object-literal parser:

- `questions:` followed by `[` ... `]` — capture the array span.
- For each question object (delimited by matching `{`...`}` at depth 1 of the array), extract:
  - `question:` → string literal value (unwrap quotes).
  - `header:` → string literal value.
  - `options:` → array of option objects.
  - `multiSelect:` → literal `true`/`false`/missing.
- For each option object, extract `label:` and `description:` string literals.

The parser is deliberately permissive (unrecognised fields are ignored) and conservative (if it cannot unambiguously find a field, the rule emits `AUQ_PARSE` info and skips — never a false error).

### 2.4 Slash-reference disambiguation

Slash references are ONLY considered outside code fences by default. Exception: AUQ option descriptions often mention skills (e.g. `"Invoke /brainstorming"`), and those live inside code fences. Therefore slash references **are** considered inside AUQ payloads (we already parse those) but NOT inside non-AUQ fenced code blocks.

Additional exclusions:
- URLs: preceded by `://` → skip.
- File paths: preceded by `./`, `/` (repeated slash), or followed by `/` → skip.
- HTTP methods: `GET /api/...` → skip when followed by another `/` within 80 chars on same line.
- Anonymised examples in prose: wrapped in backticks with a leading `/` that looks like a command fragment are OK (we strip backticks then apply the exclusion list).

The heuristic matches tokens like `/idea-wizard`, `/orchestrate-fix`, `/brainstorming` (these DO resolve to installed skills per the skill list in the system reminder) but avoids `/api/users`, `http://example.com`, and `~/.claude/plugins/foo`.

---

## 3. Rule definitions

Each rule exports:

```ts
export interface Rule {
  id: string;
  description: string;
  severity: "error" | "warn" | "info";
  check(doc: Document, ctx: RuleContext): Finding[];
}
```

`Finding` carries `{ ruleId, severity, file, line, column, endLine?, endColumn?, message, hint? }`.

### AUQ001 — option count 2–4

- **Severity:** error
- **Message:** `` `AskUserQuestion` at {file}:{line}: question "{header}" has {n} options; expected 2–4. ``
- **Offending:** `options: []` or `options: [{ label: "Only one" }]` or a list of 5+.
- **Correct:** `options: [{ label: "A", description: "..." }, { label: "B", description: "..." }]`
- **Edge case:** AUQ with multiple `questions`; check each question independently.
- **Derivation:** Universal Rule 1 mandates 2–4 options per question.

### AUQ002 — every option has a `description`

- **Severity:** error
- **Message:** `` `AskUserQuestion` at {file}:{line}: option "{label}" is missing `description`. ``
- **Offending:** `{ label: "Launch" }`
- **Correct:** `{ label: "Launch", description: "Start the wave" }`
- **Edge case:** option is a bare string `"Launch"` instead of object → emit `AUQ002` with the bare-string context in the hint.

### AUQ003 — `header` present and ≤12 chars

- **Severity:** error
- **Message:** `` Question header "{header}" is {n} chars; AskUserQuestion header must be ≤12. ``
- **Rationale:** The Claude Code AskUserQuestion tool renders `header` as a short column label. Exceeding 12 truncates visually. Hard cap is taken from the tool contract (documented in every Claude Code agent system prompt).
- **Missing header** → emit `AUQ003_MISSING`, severity error, different message.
- **Allowed unicode:** chars counted by `Array.from(s).length` (handles 2-byte emoji and surrogate pairs).

### AUQ004 — `multiSelect` explicit

- **Severity:** warn (not error — many call sites omit and default works)
- **Message:** `` Question "{header}": `multiSelect` is not explicitly set. Add `multiSelect: false` for single-choice. ``
- **Offending:** question object with no `multiSelect` key.
- **Correct:** explicit `multiSelect: true` or `multiSelect: false`.

### SLASH001 — slash references resolve to installed skills

- **Severity:** error (warn in phase-1 rollout; see §9)
- **Message:** `` Slash reference "{slash}" at {file}:{line}:{col} does not resolve to any installed skill. ``
- **Hint:** nearest skill by Levenshtein distance ≤3. `"Did you mean /{nearest}?"`
- **Source of truth:** see §5.
- **Exemptions:**
  - Explicit allowlist: `.lintskill-allowlist.json` → `knownExternalSlashes: ["/fast", "/clear", "/help", "/orchestrate", "/orchestrate-fix", ...]`. The allowlist ships with `/orchestrate-*` plus Claude Code built-ins; `/orchestrate-*` are local to this repo and not in `~/.claude/plugins/` but ARE in `skills/`.
  - Anything matching the local `skills/*/SKILL.md` set.

### PLACE001 — placeholder tags have a referent

- **Severity:** warn
- **Message:** `` Placeholder "<{name}>" at {file}:{line} has no referent in enclosing step "{stepHeader}". ``
- **Algorithm:**
  1. Identify enclosing step = nearest preceding `##` or `###` header (outside code fences).
  2. A "referent" is found if the placeholder `<name>` appears as a definition marker: either a line matching `^\s*[-*]\s*\*\*{name}\*\*:` (bullet definition), or `\*\*{name}\*\*` used textually, or a bash/JS assignment `{name}=` in a code fence within the same step.
  3. `<tab>`, `<table>`, `<br>`, `<em>`, `<strong>`, `<details>`, `<summary>`, `<sub>`, `<sup>`, `<kbd>`, `<!-- -->`, HTML entities (`&lt;`) are on a hardcoded HTML-tag exemption list.
- **Rationale:** SKILL.md uses `<USER_INPUT>`, `<bead-id>`, `<goal-slug>`, `<first 60 chars>` — each is referenced by its enclosing step. False-positives come from actual HTML tags in prose.

### HARD001 — Hard rule callouts have downstream enforcement (heuristic)

- **Severity:** info (never block CI on this in v1)
- **Message:** `` Hard rule at {file}:{line} ("{firstSentence}…") has no matching enforcement within 50 lines. ``
- **Heuristic:** For each `> **Hard rule**:` line:
  1. Extract the callout text (the full blockquote until first blank line).
  2. Scan the next 50 non-blank, non-fence lines for one of:
     - An `AskUserQuestion` call.
     - A `if ...` / `when ...` guard that names the same concept (verbatim noun from the callout's first sentence).
     - A bullet starting with `Do NOT` or `Never`.
  3. If none found, flag.
- **This rule is genuinely heuristic.** It's marked info to encourage review, not fail CI. The existing SKILL.md has 5 hard-rule callouts — the lint fixture is the baseline (see §9).

### IMPL001 — implicit-decision red-flag phrases

- **Severity:** error
- **Message:** `` Implicit decision phrase "{phrase}" at {file}:{line}. Replace with explicit AskUserQuestion call (Universal Rule 1). ``
- **Trigger phrases (case-insensitive):**
  - `wait for confirmation`
  - `wait for the user'?s? (next|response|reply)`
  - `ask the user` (when NOT inside a callout that explicitly uses AskUserQuestion in the next 10 lines)
  - `surface (this|it) to the user`
  - `propose (this|it) to the user`
  - `check with the user`
  - `only do .+ if the user confirms`
- **False-positive defenses:**
  1. Skip if the phrase appears inside the Universal Rule 1 callout itself (lines 10–14). This is the definition, not a violation.
  2. Skip if followed within 20 lines by an actual `AskUserQuestion(` call (treat as legitimate lead-in).
  3. Skip if inside a quoted string literal (e.g. backticks) used as an *example of what not to write*.
- Exact phrase list lives in `mcp-server/src/lint/rules/implicitDecisions.ts` and is the source of truth; regexes are compiled once.

---

## 4. False-positive defenses (explicit reasoning)

Every source of FP identified and mitigated:

| FP source | Detection | Mitigation |
|---|---|---|
| AUQ example inside code fence | `inFence` state true at call | Parser still validates — these ARE the canonical form and MUST be correct. |
| Slash reference inside code fence | `inFence` state true | Skip by default; include only when inside an AUQ payload (already parsed). |
| Placeholder inside example JSON / code fence | `inFence` state true | Skip in PLACE001. |
| `/slash` inside URL | pattern match on `://` | Excluded in tokeniser. |
| `/path/to/file` in bash blocks | `inFence` state true | Already excluded. |
| Quoted "wait for confirmation" as example of bad | Universal Rule 1 region | Hard-coded exemption for lines 10–14 (auto-located by scanning for the UR1 marker, not fixed line numbers). |
| Universal Rule definitions themselves | Text inside `⚠️ UNIVERSAL RULE N` callouts | Entire Universal Rule callouts exempt from IMPL001. |
| HTML tags (`<br>`, `<sub>`, etc.) | Hardcoded list | Exempt from PLACE001. |
| Bare-string option `"Launch"` | Parser yields option with no `description` | AUQ002 explicit bare-string hint so author sees the upgrade path. |
| Multi-question AUQ | Parse loop over array | Each question validated independently. |
| AUQ in indented fenced block (` ``` `) | Fence indent tracking | Parser honours indent, so payload is still parsed. |

Sanity-check pass (done mentally against the existing SKILL.md):
- 28 `AskUserQuestion(` occurrences — all inside fenced `` ``` `` blocks with explicit `header` (≤12 chars looks OK by eye), 2–4 options each, all have descriptions. Expected pass count: 28/28 on AUQ001/AUQ002/AUQ003 after allowlist.
- 5 `> **Hard rule**:` callouts — each followed within 10 lines by explicit guard text ("Do NOT", "Never") or an AUQ call. Expected pass: 5/5 on HARD001.
- Slash refs count is dominated by `/orchestrate-*` variants (all in `commands/`, `skills/`) and specialist skills (`/idea-wizard`, `/ubs-workflow`, `/caam`, `/ui-polish`, `/docs-de-slopify`, `/brainstorming`, `/multi-model-triangulation`, `/xf`, `/orchestrate-research`, `/orchestrate-setup`, `/orchestrate-fix`, `/orchestrate-audit`, `/orchestrate-drift-check`) — all present in the installed skill list (visible in session system reminders). Expected pass: 100%.

---

## 5. Skill-list resolution

**Decision:** layered resolution with explicit, overrideable priorities.

### 5.1 Resolver sources (in priority order)

1. **Repo-local skills:** `skills/*/SKILL.md` (authoritative for this repo's orchestrate-family skills). Maps directory name to slash name (`skills/orchestrate-fix/SKILL.md` → `/orchestrate-fix`).
2. **User-installed plugin skills:** `~/.claude/plugins/*/skills/*/SKILL.md` glob. Each directory name under `skills/` becomes `/{dirname}`. A SKILL.md's frontmatter `name:` field, if present, takes precedence over the directory name.
3. **Allowlist file:** `.lintskill-allowlist.json` key `knownExternalSlashes`. For skills you know exist but aren't discoverable locally (e.g. Claude Code CLI built-ins like `/fast`, `/clear`, `/help`).

### 5.2 Defence of this choice

**Why not hardcoded?** Skills change per-user and per-session. A hardcoded list rots within a sprint.

**Why not env var?** Too easy to run CI with an outdated value. Filesystem glob is self-healing.

**Why not MCP lookup?** The linter should run with zero network / zero MCP server dependency — it's a static check.

**Why include `~/.claude/plugins`?** Because the orchestrate skill references user-wide skills (`/idea-wizard`, `/brainstorming`, `/xf`, etc.) that live in the plugins directory, not this repo. The system-reminder skill catalog lists 200+ of these.

**CI override:** In GitHub Actions, `~/.claude/plugins` won't exist. The CI job runs with `LINT_SKILL_PLUGIN_ROOT=/tmp/fake-plugins` and a committed `.lintskill-allowlist.json` that covers all externally-referenced slashes. The allowlist is the CI source of truth; local devs get extra signal from their real plugin dir.

### 5.3 Resolver implementation

```ts
// mcp-server/src/lint/skillRegistry.ts
export interface SkillRegistry {
  has(slashName: string): boolean;
  suggest(slashName: string): string[]; // nearest matches
  size: number;
}

export async function loadSkillRegistry(opts: {
  repoSkillsRoot?: string;           // default: join(repoRoot, "skills")
  pluginsRoot?: string | null;       // default: ~/.claude/plugins; null to skip
  allowlist?: AllowlistConfig;
  exec: ExecFn;                       // for `find` fallback if fast-glob not available
}): Promise<SkillRegistry> { ... }
```

Uses `fs.readdir` recursively (no new glob dep). Timeout enforced via `AbortSignal` passed from CLI (matches AGENTS.md exec rule 7/8).

---

## 6. Output format

### 6.1 Terminal (default)

```
skills/orchestrate/SKILL.md:36:3  error  AUQ003  Question header "Plan input" OK, but header missing on question at line 56.
skills/orchestrate/SKILL.md:56:3  warn   AUQ004  Question "Goal input": multiSelect not explicitly set.
skills/orchestrate/SKILL.md:340:76 error SLASH001 Slash reference "/idea-wizrd" not resolved. Did you mean /idea-wizard?
skills/orchestrate/SKILL.md:115:9 error  IMPL001 Implicit decision phrase "wait for confirmation" - use AskUserQuestion.

  3 errors, 1 warning in skills/orchestrate/SKILL.md
```

Colour via ANSI escapes gated on `process.stdout.isTTY`; CI gets plain output.

### 6.2 JSON (`--json`)

Stable schema, versioned:

```json
{
  "version": 1,
  "tool": "lint-skill",
  "toolVersion": "2.9.0",
  "findings": [
    {
      "ruleId": "AUQ003",
      "severity": "error",
      "file": "skills/orchestrate/SKILL.md",
      "line": 36,
      "column": 3,
      "endLine": 36,
      "endColumn": 45,
      "message": "Header missing on question.",
      "hint": null
    }
  ],
  "summary": { "errors": 3, "warnings": 1, "infos": 0, "filesScanned": 1 }
}
```

Not SARIF — SARIF is overkill for a single-file linter and adds JSON Schema weight. If GitHub code-scanning integration is needed later, add a second reporter; the JSON shape maps cleanly.

### 6.3 Exit codes

- `0` — no findings at severity ≥ error (warn/info OK).
- `1` — at least one error.
- `2` — internal error (parser crashed, file not found). Distinct so CI can tell "lint worked, found bugs" from "lint itself broke".

---

## 7. CI integration

### 7.1 New file: `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
          cache-dependency-path: mcp-server/package-lock.json
      - run: npm ci
        working-directory: mcp-server
      - run: npm run build
        working-directory: mcp-server
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: mcp-server/dist
          retention-days: 1

  test:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
          cache-dependency-path: mcp-server/package-lock.json
      - run: npm ci
        working-directory: mcp-server
      - run: npm test
        working-directory: mcp-server
        env:
          LINT_SKILL_PLUGIN_ROOT: ""   # disables ~/.claude/plugins lookup; relies on allowlist

  lint-skill:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
          cache-dependency-path: mcp-server/package-lock.json
      - run: npm ci
        working-directory: mcp-server
      - run: npm run lint:skill:json > lint-skill-report.json
        working-directory: mcp-server
        env:
          LINT_SKILL_PLUGIN_ROOT: ""
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: lint-skill-report
          path: mcp-server/lint-skill-report.json
          retention-days: 14
```

Three jobs: `build`, `test`, `lint-skill`. `test` and `lint-skill` both depend on `build` but run in parallel to each other. Cache keyed on lockfile. Node 22 matches current dev standard for ESM NodeNext.

### 7.2 Why separate `lint-skill` job

Separation means a failing skill lint doesn't obscure a failing unit test in the PR status UI — each lights up independently. Also keeps the matrix small if we later expand to multi-OS.

---

## 8. Test plan

### 8.1 Coverage goal

100% line + branch coverage on `mcp-server/src/lint/**`. Enforced via `@vitest/coverage-v8`:

```json
// mcp-server/vitest.config.ts (new or extended)
{
  test: {
    coverage: {
      include: ["src/lint/**/*.ts"],
      thresholds: { lines: 100, branches: 95, functions: 100 }
    }
  }
}
```

Branches at 95% allows for defensive `throw new Error("unreachable")` paths.

### 8.2 Fixture strategy

Location: `mcp-server/src/__tests__/lint/fixtures/`.

| Fixture | Purpose | Expected findings |
|---|---|---|
| `clean.md` | Minimal valid SKILL.md with one AUQ call | 0 |
| `auq001-too-few.md` | AUQ with 1 option | 1 × AUQ001 |
| `auq001-too-many.md` | AUQ with 5 options | 1 × AUQ001 |
| `auq002-missing-desc.md` | Option missing `description` | 1 × AUQ002 |
| `auq002-bare-string.md` | Options as bare strings `["A","B"]` | 2 × AUQ002 (one per bare string) |
| `auq003-header-missing.md` | No `header:` field | 1 × AUQ003_MISSING |
| `auq003-header-too-long.md` | `header: "This is way too long to render"` | 1 × AUQ003 |
| `auq003-header-emoji.md` | `header: "Plan ✅ OK"` (counting test) | 0 (under 12 chars by `Array.from`) |
| `auq004-implicit.md` | No `multiSelect` | 1 × AUQ004 |
| `slash001-typo.md` | `/idea-wizrd` reference | 1 × SLASH001 with suggestion |
| `slash001-inside-url.md` | `https://example.com/orchestrate` | 0 (URL exemption) |
| `slash001-http-path.md` | `GET /api/users` | 0 (path exemption) |
| `place001-orphan.md` | `<FOO>` placeholder, no referent | 1 × PLACE001 |
| `place001-html-tag.md` | `<br>`, `<details>` | 0 (HTML exemption) |
| `hard001-enforced.md` | Hard rule + matching "Do NOT" | 0 |
| `hard001-orphan.md` | Hard rule with no downstream enforcement | 1 × HARD001 info |
| `impl001-raw.md` | Contains "wait for confirmation" as prose | 1 × IMPL001 |
| `impl001-exempt-ur1.md` | Phrase inside Universal Rule 1 callout | 0 |
| `impl001-exempt-followed.md` | Phrase followed by AUQ within 20 lines | 0 |
| `mixed-realistic.md` | 200-line file, 3 AUQ calls, 2 hard rules, ~10 slash refs | Baseline list (snapshot) |
| `live-orchestrate.md` | Copy of actual `skills/orchestrate/SKILL.md` | Baseline from allowlist (see §9) — must be 0 after allowlist applied |

### 8.3 Test layout

```ts
// mcp-server/src/__tests__/lint/rules/askUserQuestion.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { lint } from "../../../lint/index.js";

describe("AUQ001: option count", () => {
  it("flags 1-option question as error", async () => {
    const src = await readFile("src/__tests__/lint/fixtures/auq001-too-few.md", "utf8");
    const findings = await lint(src, { skillRegistry: stubRegistry });
    expect(findings.filter(f => f.ruleId === "AUQ001")).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
  });
  it("flags 5-option question as error", ...);
  it("accepts 2-option question", ...);
  it("accepts 4-option question", ...);
  it("flags per-question in multi-question AUQ", ...);
});
```

Test helper `stubRegistry` wraps a fake `SkillRegistry` with a known slash list to avoid disk access during unit tests. A separate integration test exercises the real `loadSkillRegistry` against a temp dir.

### 8.4 Property tests (optional, add in follow-up bead)

Use `fast-check` for:
- Parser invariance: `parse(source).nodes.map(n => source.slice(n.span.start, n.span.end)).join("")` reconstructs source. (Catches tokenizer off-by-ones.)
- AUQ002: for any random options array, the linter reports one finding per option missing `description`.

Not a v1 blocker; placed in a separate bead (`T9`).

### 8.5 Snapshot test for the live file

One snapshot test runs `lint` against the actual `skills/orchestrate/SKILL.md` and asserts zero findings (after allowlist). This is the production canary — it catches regressions the instant someone edits SKILL.md in a way that violates a rule.

---

## 9. Incremental adoption (rollout)

**Risk:** Running the linter against the existing `skills/orchestrate/SKILL.md` for the first time might surface legitimate historical findings. We need a path that (a) doesn't block day 1 merges and (b) doesn't let new drift accumulate.

### 9.1 Baseline + allowlist strategy

1. **Day 0 (first merge):** Run linter against current SKILL.md with full severity. Capture all findings to `mcp-server/.lintskill-allowlist.json`:

   ```json
   {
     "version": 1,
     "createdAt": "2026-04-15",
     "knownExternalSlashes": [
       "/fast", "/clear", "/help",
       "/orchestrate", "/orchestrate-fix", "/orchestrate-audit",
       "/orchestrate-research", "/orchestrate-setup", "/orchestrate-drift-check",
       "/idea-wizard", "/brainstorming", "/ubs-workflow", "/caam",
       "/ui-polish", "/docs-de-slopify", "/multi-model-triangulation", "/xf"
     ],
     "acceptedFindings": [
       { "file": "skills/orchestrate/SKILL.md", "ruleId": "HARD001", "line": 745, "reason": "Nested hard rule — manually verified" }
     ]
   }
   ```

   `knownExternalSlashes` = pre-approved references (not bugs). `acceptedFindings` = explicit exceptions, one per line, each with a human `reason`. The linter reads this and subtracts matches from its output before reporting.

2. **Rule severity rollout:**
   - **Phase 1 (v1.0 of linter):** SLASH001 = warn, HARD001 = info, IMPL001 = error, AUQ001/002/003 = error, AUQ004 = warn. CI blocks on errors only.
   - **Phase 2 (after 2 weeks):** SLASH001 → error.
   - **Phase 3 (after baseline stable):** HARD001 → warn.

3. **Allowlist hygiene:** adding entries requires a reason; removing entries is encouraged. A follow-up bead prunes `acceptedFindings` quarterly.

### 9.2 Why not "just fix everything on day 1"?

The existing SKILL.md passes eyeball review. If the linter flags something, the odds are ~50/50 it's a linter bug vs a real finding. An allowlist lets us land the tool now, then triage findings deliberately without blocking unrelated PRs.

### 9.3 Regeneration rules

- `--update-allowlist` is developer-only; CI's `npm run lint:skill:json` fails if it would need allowlist changes.
- Adding to `knownExternalSlashes` requires reviewer approval in the PR (enforced socially — no technical gate).

---

## 10. Dependency graph (beads)

Format: each bead has `id`, `title`, `depends_on: [ids]`, `files touched`, `acceptance criteria`. Ordered topologically.

### T1 — Lint module skeleton + types
- **depends_on:** []
- **files:** `mcp-server/src/lint/types.ts`, `mcp-server/src/lint/index.ts` (stub)
- **acceptance:** exports `Finding`, `Rule`, `Severity`, `Document`, `lint(source, opts)` returning `[]`. `npm run build` passes.

### T2 — Parser (state machine)
- **depends_on:** [T1]
- **files:** `mcp-server/src/lint/parser.ts`, `mcp-server/src/__tests__/lint/parser.test.ts`, fixtures `fence-*.md`, `auq-payload-*.md`.
- **acceptance:** emits `{ fences, askUserQuestionCalls, slashReferences, placeholders, hardRules, headers }` with accurate spans. 100% branch coverage on parser.

### T3 — Skill registry resolver
- **depends_on:** [T1]
- **files:** `mcp-server/src/lint/skillRegistry.ts`, integration test.
- **acceptance:** reads `skills/` + `~/.claude/plugins/*/skills/`, honours `LINT_SKILL_PLUGIN_ROOT=""`, respects allowlist. Timeout via `AbortSignal`.

### T4 — AUQ rules (AUQ001–AUQ004)
- **depends_on:** [T2]
- **files:** `mcp-server/src/lint/rules/askUserQuestion.ts`, unit tests + fixtures.
- **acceptance:** all AUQ fixtures yield expected findings; 100% line coverage.

### T5 — SLASH001
- **depends_on:** [T2, T3]
- **files:** `mcp-server/src/lint/rules/slashReferences.ts`, unit tests + fixtures.
- **acceptance:** URL and path exemptions pass; typo suggests via Levenshtein.

### T6 — PLACE001 + HARD001 + IMPL001
- **depends_on:** [T2]
- **files:** three rule files + tests. Can be parallelised into three sub-beads T6a/T6b/T6c if capacity exists.
- **acceptance:** each rule's fixture matrix passes; FP exemptions (HTML tags, UR1 callout region) honoured.

### T7 — Reporters (terminal + JSON)
- **depends_on:** [T1]
- **files:** `mcp-server/src/lint/reporters/*.ts`, unit tests with fake findings.
- **acceptance:** exit code contract honoured; TTY detection stubbable.

### T8 — CLI entry + npm scripts
- **depends_on:** [T4, T5, T6, T7]
- **files:** `mcp-server/scripts/lint-skill.ts`, `mcp-server/package.json` scripts, `mcp-server/.lintskill-allowlist.json` (baseline committed).
- **acceptance:** `npm run lint:skill` exits 0 on current SKILL.md with allowlist applied; `npm run lint:skill:json` emits stable schema.

### T9 — CI workflow
- **depends_on:** [T8]
- **files:** `.github/workflows/ci.yml`.
- **acceptance:** PR status shows three jobs (`build`, `test`, `lint-skill`); artifacts uploaded on failure.

### T10 — Live-file snapshot test
- **depends_on:** [T8]
- **files:** `mcp-server/src/__tests__/lint/live-orchestrate.test.ts`.
- **acceptance:** asserts lint against real `skills/orchestrate/SKILL.md` returns 0 errors. Regressions caught by unit test, not CI artifact.

### T11 (optional, follow-up) — Property tests with fast-check
- **depends_on:** [T2, T4]
- **files:** property tests under `mcp-server/src/__tests__/lint/property/`.
- **acceptance:** 1000 random inputs; parser round-trip invariant; AUQ002 count invariant.

### T12 (optional, follow-up) — MCP tool `orch_lint_skill`
- **depends_on:** [T8]
- **files:** `mcp-server/src/tools/orch-lint-skill.ts`, registration in `server.ts`.
- **acceptance:** callable via MCP, returns same JSON schema as CLI.

### Parallelisation

Critical path: T1 → T2 → T4 → T8 → T9. ~5 beads in serial.

Parallel branches from T2:
- T3 independent of T2 (runs off T1); can fire parallel with T2.
- T5, T6 parallel after T2 (T5 also needs T3).
- T7 parallel with all rules (needs only T1).

Swarm wave plan:
1. **Wave 1:** T1 (alone — blocks everything).
2. **Wave 2:** T2, T3, T7 in parallel.
3. **Wave 3:** T4, T5, T6 in parallel.
4. **Wave 4:** T8.
5. **Wave 5:** T9, T10 in parallel.
6. **Wave 6 (optional):** T11, T12.

---

## 11. Correctness self-audit

Final checks the reviewer should run against this plan:

1. **Parser determinism.** State machine is pure-functional over input string; no RNG, no filesystem, no date. ✓
2. **Rule idempotency.** Each rule is `(Document, Context) → Finding[]`; no mutation. ✓
3. **FP coverage.** Every FP source enumerated in §4 with explicit mitigation. ✓
4. **Skill list freshness.** Filesystem glob + allowlist means adding a new skill to `skills/` auto-whitelists it; no manual linter update needed. ✓
5. **CI reproducibility.** `LINT_SKILL_PLUGIN_ROOT=""` forces CI to use allowlist only; local devs get stricter validation. ✓
6. **AGENTS.md compliance.** No `console.log` (use `createLogger`). All `.js` extensions in imports. All `exec` calls have `timeout`. No CommonJS. ✓
7. **Exit codes distinguish failure modes.** 0/1/2 semantics are well-defined so CI can diagnose. ✓
8. **Rollout is reversible.** Allowlist + severity-phasing means we can back off any rule without deleting code. ✓

---

## 12. Open questions for the coordinator

1. Should the linter also validate `commands/*.md` files? They reference slash skills too. Recommendation: **no in v1** (out of scope), yes in a later bead.
2. Should AUQ004 ever become an error? Recommendation: **no** — some call sites are legitimate `multiSelect: true` that default to false; being explicit is good hygiene, not a correctness bug.
3. Is `fast-check` an acceptable new devDependency? Recommendation: **yes, in T11**, but defer until core rules stable.

---

**End of plan.**
