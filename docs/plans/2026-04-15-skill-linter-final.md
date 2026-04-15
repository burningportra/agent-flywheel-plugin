# SKILL.md Linter — Final Plan (post-alignment v1.0)

**Author:** PinkRidge (coordinator, post-Step-5.55 alignment)
**Date:** 2026-04-15
**Sources:**
- Synthesis: `2026-04-15-skill-linter-synthesized.md` (BrightCave, 676 lines, 23 beads)
- Codex 2nd opinion: `2026-04-15-codex-second-opinion.md` (IndigoCreek, 107 lines)
- Triangulation report: `2026-04-15-triangulation-report.md`
**User alignment answers (Step 5.55):**
1. Scope: **12-bead v1.0** (defer autofix, SARIF, severity phasing, pre-commit, runbook, property tests)
2. Parser: **`remark-parse` + `unified`**
3. `npm test` blocking: **CI-only enforcement** (lint stays a separate script)
4. Rollout: **Baseline-only** (drop severity phasing)

**Target:** `mcp-server/src/lint/` + `mcp-server/scripts/lint-skill.ts` + Vitest suite + GitHub Actions CI

---

## 1. Context

`skills/flywheel/SKILL.md` is **1438 lines** with **38 real `AskUserQuestion` call sites** (verified empirically via `grep -cE 'AskUserQuestion\s*\('`), ~5 hard-rule callouts, hundreds of `/slash-skill` refs, and 53+ `<placeholder>` tags. Prior incidents (bead-z9g: nested fences cascading to 100+ TS errors; UBS heuristic floods freezing merges) make the case for a linter that:

1. Enforces invariants the flywheel skill depends on (Universal Rule 1 = every decision goes through `AskUserQuestion` with 2–4 options each carrying a `description`).
2. Produces zero false positives on HEAD (after baseline).
3. Never blocks an unrelated merge at 3am.

This v1.0 ships the **core spine**: parser + 5 rules + 4 reporters + baseline + CI + canary. Autofix, SARIF, severity phasing, pre-commit hook, and the full adversarial fixture suite are deferred to v1.1 once the detection surface is stable.

---

## 2. Architecture

### 2.1 File layout

```
mcp-server/
  scripts/
    lint-skill.ts                  # CLI entry (compiled to dist/scripts/ for CI)
  src/
    lint/
      index.ts                     # lint(source, opts) -> LintResult; logger lives here too
      parser.ts                    # remark-parse wrapper + AUQ payload walker
      skillRegistry.ts             # loadSkillRegistry({ ci?, plugins?, manifest? })
      config.ts                    # zod-validated optional config
      rules/
        askUserQuestion.ts         # AUQ001-004
        slashReferences.ts         # SLASH001
        placeholders.ts            # PLACE001
        implicitDecisions.ts       # IMPL001
      reporters/
        pretty.ts                  # ANSI terminal (default in TTY)
        compact.ts                 # ESLint-style one-liner (default for non-TTY pipes)
        gha.ts                     # GitHub Actions workflow commands
        json.ts                    # machine-readable, schema-versioned
      types.ts                     # Finding, Rule, Severity, Document, Span
    __tests__/
      lint/
        parser.test.ts
        rules/*.test.ts
        reporters/*.test.ts
        fixtures/                  # rule fixtures + minimum adversarial set
        live-flywheel.test.ts   # canary against real SKILL.md
  .lintskill-baseline.json         # committed baseline (sha256 fingerprints)
  .lintskill-manifest.json         # committed CI-authoritative skill list
  .lintskill-allowlist.json        # knownExternalSlashes + acceptedFindings
.github/workflows/ci.yml
.nvmrc                             # Node 22 pin
```

**Decisions:**
- Linter lives under `mcp-server/` — reuses strict-TS, Vitest, ESM NodeNext, `createLogger` pattern. No second `package.json`.
- Library API (`src/lint/index.ts`) is importable so a future MCP tool can wrap it without shelling out. **No MCP tool in v1.0.**
- HARD001 rule: **deferred to v1.1**. Severity `info` was never going to block CI; shipping it day-one only adds noise to the baseline.

### 2.2 Entry points

Primary CLI: `mcp-server/scripts/lint-skill.ts`. Dev runs via `tsx`; **CI runs the compiled `dist/scripts/lint-skill.js` via `node`** (per Codex: removes `tsx` from the CI hot path, eliminates an attack surface, faster cold-start).

```ts
// src/lint/index.ts exports
export async function lint(source: string, opts: LintOptions): Promise<LintResult>;
export function lintString(source: string, filename: string, opts?: Partial<LintOptions>): Finding[];
export type { Finding, Rule, Severity, LintOptions, LintResult };
```

`lintString` is the hermetic helper for rule-author tests. No I/O.

---

## 3. Parser design

### 3.1 Two-layer parser

**Layer 1 — `remark-parse` + `unified`** (~42 packages / 3.1 MB devDep cost, verified via test install). Reasons:
- bead-z9g precedent: hand-rolled regex died on nested `*/` fences. CommonMark tokenizer handles all fence-nesting cases natively.
- Free accurate `position: { start, end }` per token.
- Pin exact versions in `package-lock.json`; never `^` for these.

Add `npm audit` CI gate that fails if `remark-parse` ever graduates to a runtime dep (devDep only).

**Layer 2 — AUQ payload walker (tolerant JS-literal scanner).**
The text inside an AUQ block is pseudo-JavaScript (unquoted keys, JS string syntax), not JSON. `jsonc-parser` would reject it. Walk:
1. Receive code-block contents from remark with known starting line.
2. Find `AskUserQuestion\s*\(` anchors. **Acceptance lock for T2:** "a token matching `AskUserQuestion\s*\(`". Empirical count on current SKILL.md: 38.
3. Brace-balanced scanner honours `(` `)` `{` `}` `[` `]` and string literals (`"…"` `'…'` `` `…` `` with escapes).
4. Extract `questions:` array; per question, extract `question:`, `header:`, `options:`, `multiSelect:` via tolerant object-literal walk. Unknown fields ignored.

### 3.2 Slash-reference disambiguation

Slash refs considered outside code fences by default; AUQ option descriptions (extracted in Layer 2) are also scanned. Exclusions per match:
- Preceded by `://`, `http:`, `https:`, `file:` → skip (URL).
- Contains `.` or `?` → skip.
- Contains more than one `/` → skip (path).
- Preceded by `~/` or starts with `./` → skip (path).
- Followed by `/` within 80 chars on same line and preceded by HTTP method token → skip (REST path).
- Matches `.lintskill-allowlist.json` `knownExternalSlashes` → skip.

Document every heuristic in `--help` and the script header.

### 3.3 Placeholder disambiguation

- Tag extraction on `^<[a-z][a-z0-9_-]*>$` (case-insensitive, case-preserved for display).
- HTML allowlist: `br em strong code pre a img sup sub kbd summary details div span p ul ol li table tr td th thead tbody`.
- Skip if inside inline code span, link URL, or HTML comment.
- Self-closing `<foo/>` treated as `<foo>`.
- Attributes ignored.

---

## 4. Rule definitions (5 rules in v1.0)

| ID | Severity (v1.0) | Title | Source |
|---|---|---|---|
| AUQ001 | error | Option count out of range (must be 2–4) | correctness §3 |
| AUQ002 | error | Option missing `description` | correctness §3 |
| AUQ003 | error | `header` missing or >12 chars (Array.from count) | correctness §3 |
| AUQ004 | warn | `multiSelect` not explicit | correctness §3 |
| SLASH001 | warn | Slash ref does not resolve | all three plans |
| PLACE001 | warn | Placeholder has no referent in enclosing step | all three plans |
| IMPL001 | error | Implicit-decision phrase found (UR1 violation) | correctness §3 |

**Deferred to v1.1:** HARD001 (info-only, adds baseline noise). SKILL-010 (unclosed code fence) implemented inside parser as parse-error, not a separate rule.

**Severities are permanent for v1.0** — no severity phasing. Baseline handles drift suppression instead.

### 4.1 IMPL001 phrase dictionary

Exported constant array in `src/lint/rules/implicitDecisions.ts`. Initial seed:
```
"wait for confirmation", "wait for the user", "ask the user",
"surface this to the user", "propose this to the user",
"check with the user", "only do X if the user confirms",
"confirm with the user", "prompt the user", "get user approval",
"seek user input", "let the user decide", "pause for user feedback"
```

FP defenses: skip inside UR1 callout region; skip if real `AskUserQuestion(` follows within 20 lines; skip inside backtick-quoted example strings.

### 4.2 Error message format

```
[RULE_ID] path/to/file.md:line:col
<One-sentence plain-English description quoting offending text>
<One-sentence fix recommendation>
```

(No "autofix available" line — autofix deferred to v1.1.)

---

## 5. False-positive defenses

| FP source | Mitigation |
|---|---|
| AUQ example inside code fence | Parser validates — these ARE the canonical form and MUST be correct |
| Slash ref inside non-AUQ code fence | Skip by default; scan only inside AUQ payload |
| Placeholder inside inline code span | Skip (remark tokens distinguish code from text) |
| `/slash` inside URL | Tokeniser exclusion |
| `/path/to/file` in bash | Multi-slash exclusion |
| Quoted "wait for confirmation" as bad example | UR1 callout region exempt; real AUQ within 20 lines exempt |
| Universal Rule definitions themselves | `⚠️ UNIVERSAL RULE` callout text exempt from IMPL001 |
| Known HTML tags | Hardcoded allowlist (PLACE001) |
| Bare-string option `"Launch"` | AUQ002 fires with bare-string hint |
| Multi-question AUQ | Each question validated independently |
| `*/` inside nested code (bead-z9g replay) | remark tokenizer handles natively; mandatory fixture `nested-fence-with-comment-terminator.md` |
| BOM, CRLF, mixed endings, invalid UTF-8 | Normalize at input BEFORE fingerprint computation (per Codex) |
| File modified mid-lint | SHA-256 hash before rules; warn if changed post-rules |

---

## 6. Output channels

TTY detection at startup:
```ts
const isTTY = process.stdout.isTTY;
const isGHA = Boolean(process.env.GITHUB_ACTIONS);
const format = args['--format'] ?? (isGHA ? 'gha' : isTTY ? 'pretty' : 'compact');
```

Four reporters (SARIF deferred):
- `pretty` — ANSI colors, grouped by file, sorted by line. Default in TTY.
- `compact` — ESLint-style one-line-per-diagnostic. Default for non-TTY pipes.
- `gha` — `::error file=...,line=...,col=...,title=RULE_ID::message` for PR annotations.
- `json` — schema-versioned (`schemaVersion: 1`); sorted by file/line/col/ruleId.

Each finding in JSON output carries `rulesetVersion` so future rule changes don't silently drift in stored baselines (per Codex).

---

## 7. Suppression syntax (v1.0)

**Baseline only in v1.0.** Per-line `<!-- lint-disable-next-line -->` comments **deferred to v1.1** — baseline + fingerprints cover all current cases. If a real per-line case appears, add the suppression handler then.

---

## 8. Skill-list resolution

Layered resolver:

1. **Repo-local skills:** `skills/*/SKILL.md` (authoritative for flywheel-family).
2. **`.lintskill-manifest.json`:** committed CI-authoritative source of truth. Contains `{ schemaVersion, skills: ["idea-wizard", "ubs-workflow", ...] }`. Generated by `--update-manifest`; required in CI.
3. **`.lintskill-allowlist.json`:** `knownExternalSlashes` (CLI built-ins like `/fast`, `/clear`, `/help`) and `acceptedFindings` (rare narrow exceptions with required `reason:`).
4. **(Local dev only)** `~/.claude/plugins/*/skills/*/SKILL.md` glob — provides extra signal in dev. **Disabled by `--ci` flag.**

**`--ci` flag behavior:** restricts resolution to layers 1–3. Acceptance criterion (locked into T3): integration test runs with `HOME=/nonexistent` and asserts layer 4 is silently skipped.

**Manifest drift CI guard:**
```yaml
- run: diff <(ls skills/ | sort) <(jq -r '.skills[]' .lintskill-manifest.json | sort)
  name: manifest in sync with skills/
```
Catches "forgot to update manifest" before it bites in CI.

---

## 9. Performance + robustness

- Single forward pass; no regex backtracking across full doc.
- File size cap: `--max-bytes` default 10 MiB; reject larger with exit 4.
- BOM stripped; CRLF normalized to LF in memory before parsing AND **before fingerprint computation** (per Codex — otherwise different machines get different baselines).
- Each rule wrapped in try/catch + 5s timeout (rule isolation merged into T9 acceptance). One buggy rule cannot freeze CI.
- Determinism: sorted findings (file/line/col/ruleId); `LANG=C` forced in golden test; no timestamps in output (behind `--verbose`).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean (no findings at severity ≥ error) |
| 1 | At least one error |
| 2 | Internal error (parser crashed, rule timeout) — distinct from "found bugs" |
| 3 | Invalid CLI args |
| 4 | SKILL.md not found / unreadable |

---

## 10. CI integration

### 10.1 `.github/workflows/ci.yml`

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
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: mcp-server/package-lock.json }
      - run: npm ci
        working-directory: mcp-server
      - run: npm run build
        working-directory: mcp-server
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: mcp-server/dist, retention-days: 1 }

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

  manifest-drift:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: actions/checkout@v4
      - run: |
          set -e
          A=$(ls skills/ | sort)
          B=$(jq -r '.skills[]' mcp-server/.lintskill-manifest.json | sort)
          diff <(echo "$A") <(echo "$B") || { echo "::error::manifest out of sync; run npm run lint:skill:update-manifest"; exit 1; }

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
      - run: npm run build
        working-directory: mcp-server
      - run: node dist/scripts/lint-skill.js --file ../skills/flywheel/SKILL.md --ci --baseline .lintskill-baseline.json --format gha
        working-directory: mcp-server
      - run: node dist/scripts/lint-skill.js --file ../skills/flywheel/SKILL.md --ci --format json > lint-skill-report.json
        working-directory: mcp-server
        if: failure()
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: lint-skill-report, path: mcp-server/lint-skill-report.json, retention-days: 14 }
```

Four jobs: `build`, `test`, `manifest-drift`, `lint-skill`. **CI runs compiled `node dist/scripts/lint-skill.js`, not `tsx`** (per Codex: removes tsx from CI hot path).

---

## 11. npm scripts

```json
{
  "scripts": {
    "build": "tsc",
    "lint:skill": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --baseline .lintskill-baseline.json",
    "lint:skill:json": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --ci --format json",
    "lint:skill:update-baseline": "tsx scripts/lint-skill.ts --file ../skills/flywheel/SKILL.md --update-baseline",
    "lint:skill:update-manifest": "tsx scripts/lint-skill.ts --update-manifest",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "tsx": "^4",
    "remark-parse": "^11",
    "unified": "^11"
  },
  "engines": { "node": ">=22 <23" }
}
```

**`test` does NOT depend on `lint:skill`** (per user alignment). CI is the enforcer. Pre-commit hook deferred to v1.1.

`tsx` used for dev convenience; `node dist/...` used in CI.

`fast-check` removed (no property tests in v1.0).

---

## 12. Migration / rollout

### 12.1 Baseline-only (no severity phasing)

Per user alignment: the baseline + sha256 fingerprints handle all transitions. Severity phasing was a pre-baseline hedge and creates 3-state confusion (warn/error/info per rule) that reviewers won't model correctly.

`.lintskill-baseline.json`:
```json
{
  "schemaVersion": 1,
  "rulesetVersion": 1,
  "generated": "2026-04-15T...",
  "entries": [
    { "ruleId": "PLACE001", "rulesetVersion": 1, "file": "skills/flywheel/SKILL.md", "line": 573, "fingerprint": "sha256:abc…", "reason": "" }
  ]
}
```

- **Fingerprint = sha256 of `(trimmed(line-1), trimmed(line), trimmed(line+1))` joined by `\n`** — survives whitespace-only edits in adjacent lines, breaks (correctly) on substantive content edits.
- **Line-ending normalization runs BEFORE fingerprint computation** (per Codex — non-negotiable T12 acceptance).
- **`rulesetVersion` per entry** — when AUQ003 tightens in v1.1, old baselines warn loudly instead of silently drifting.
- Baselined findings demoted to `info` and rendered `[baselined]`. Never affect exit code.
- `--update-baseline` regenerates from current state (developer-only; CI never regenerates).
- Target: reduce baseline to zero within 2 sprints (separate cleanup beads).

### 12.2 Allowlist (`.lintskill-allowlist.json`)

Orthogonal to baseline. Contains `knownExternalSlashes` (pre-approved CLI built-ins like `/fast`, `/clear`, `/help`, plus `/flywheel-*` family which lives in `skills/`) and `acceptedFindings` (narrow exceptions with required `reason:`). Adding entries needs reviewer approval (social gate).

---

## 13. Test plan

### 13.1 Fixtures

Under `mcp-server/src/__tests__/lint/fixtures/`:

**Rule fixtures (v1.0):** `clean.md`, `auq001-too-few.md`, `auq001-too-many.md`, `auq002-missing-desc.md`, `auq002-bare-string.md`, `auq003-header-missing.md`, `auq003-header-too-long.md`, `auq003-header-emoji.md`, `auq004-implicit.md`, `slash001-typo.md`, `slash001-inside-url.md`, `slash001-http-path.md`, `place001-orphan.md`, `place001-html-tag.md`, `impl001-raw.md`, `impl001-exempt-ur1.md`, `impl001-exempt-followed.md`, `mixed-realistic.md`.

**Mandatory adversarial fixtures inline with parser tests (NOT the full robustness suite):**
- `nested-fence-with-comment-terminator.md` — bead-z9g replay. Non-negotiable.
- `unclosed-fence.md` — parser must emit SKILL-010 without crashing.
- `crlf.md`, `utf8-bom.md` — normalization sanity.

(Full 22-fixture adversarial suite from robustness §10.1 deferred to v1.1.)

**Live canary:** `live-flywheel.test.ts` runs `lint()` against real `skills/flywheel/SKILL.md` and asserts zero errors after baseline+allowlist. Catches regressions instantly.

### 13.2 Coverage target

100% lines, 95% branches, 100% functions on `mcp-server/src/lint/**`. Enforced via `@vitest/coverage-v8` thresholds (the dep is already installed; just needs threshold config).

### 13.3 Test categories

- Unit tests per rule, using `lintString()` — no I/O.
- Integration tests: `--ci` mode with `HOME=/nonexistent` (locked into T3); manifest drift detection; baseline; rule throws (rule-isolation harness); rule timeout.
- Live canary against actual SKILL.md.

### 13.4 Deferred test categories (v1.1)

- Property tests with `fast-check` (T21 deferred).
- Memory-profile test (T22 deferred — single SKILL.md is ~120 KB; memory is not the bottleneck).
- Full adversarial fixture suite (~22 robustness fixtures from robustness §10.1).
- Golden-file determinism test (deferred — sorted output gives effective determinism without the maintenance cost).

---

## 14. Documentation

| Document | v1.0 content |
|---|---|
| `AGENTS.md` | One-paragraph addition: "SKILL.md changes must pass `npm run lint:skill`. CI enforces; see `mcp-server/scripts/lint-skill.ts`." |
| `mcp-server/scripts/lint-skill.ts` | Top-of-file header documenting every disambiguation heuristic |
| `mcp-server/src/lint/rules/*.ts` | One-line JSDoc per rule |
| `lint-skill --help` | Full flag reference + exit code table + rule ID table |

(Full runbook `docs/lint-skill-runbook.md` deferred to v1.1 — write it once there's an actual CI failure to reference.)

---

## 15. Dependency graph (12 beads, v1.0)

```
T1: Lint module skeleton + types + logger | depends_on: [] | files: [mcp-server/src/lint/types.ts, mcp-server/src/lint/index.ts, mcp-server/src/lint/config.ts] | acceptance: exports Finding/Rule/Severity/LintResult/lint() (returns []); structured stderr logger (createLogger pattern, no console.log); npm run build passes; logger merge from old T4 included here.

T2: Parser via remark-parse + AUQ payload walker | depends_on: [T1] | files: [mcp-server/src/lint/parser.ts, mcp-server/src/__tests__/lint/parser.test.ts, fixtures/nested-fence-with-comment-terminator.md, fixtures/unclosed-fence.md, fixtures/crlf.md, fixtures/utf8-bom.md] | acceptance: emits Document with fences, AskUserQuestion calls, slash refs, placeholders, headers with accurate line/col; AUQ token regex locked as `AskUserQuestion\s*\(`; bead-z9g replay fixture passes; SKILL-010 emitted on unclosed fence without crash; 100% branch coverage on parser.

T3: Skill registry resolver with --ci layer restriction | depends_on: [T1] | files: [mcp-server/src/lint/skillRegistry.ts, mcp-server/src/__tests__/lint/skillRegistry.test.ts] | acceptance: reads skills/ + .lintskill-manifest.json + .lintskill-allowlist.json + (optional) ~/.claude/plugins; --ci flag restricts to layers 1-3; integration test runs with HOME=/nonexistent and asserts layer 4 silently skipped (NON-NEGOTIABLE per Codex); Levenshtein suggest; AbortSignal timeout per AGENTS.md.

T4: AUQ rules (AUQ001-AUQ004) | depends_on: [T2] | files: [mcp-server/src/lint/rules/askUserQuestion.ts, tests + fixtures auq*.md] | acceptance: all AUQ fixtures yield expected findings; unicode header length via Array.from; multi-question AUQ validated per-question; 100% line coverage.

T5: SLASH001 rule + Levenshtein suggest | depends_on: [T2, T3] | files: [mcp-server/src/lint/rules/slashReferences.ts, tests + slash001-*.md fixtures] | acceptance: URL/path/multi-slash exemptions honored; allowlist applied; typo suggestion ≤2 distance unambiguous; FP rate zero on real SKILL.md after allowlist.

T6: PLACE001 rule with HTML allowlist | depends_on: [T2] | files: [mcp-server/src/lint/rules/placeholders.ts, tests + place001-*.md fixtures] | acceptance: HTML tags/inline-code/comment placeholders skipped; enclosing-step referent resolution; FP rate zero on real SKILL.md.

T7: IMPL001 rule with phrase dictionary + FP defenses | depends_on: [T2] | files: [mcp-server/src/lint/rules/implicitDecisions.ts, tests + impl001-*.md fixtures] | acceptance: UR1 callout region exempt; AUQ-within-20-lines exempt; backtick-quoted exempt; phrase array exported as constant.

T8: Reporters (pretty, compact, gha, json) + determinism | depends_on: [T1] | files: [mcp-server/src/lint/reporters/*.ts, reporter tests] | acceptance: sorted output (file,line,col,ruleId); JSON schemaVersion=1; rulesetVersion per finding; TTY detection; GITHUB_ACTIONS env sniff; no SARIF.

T9: Rule isolation harness + exit codes | depends_on: [T1] | files: [mcp-server/src/lint/index.ts (runRule wrapper), tests for rule-throws/rule-timeout/exit-code precedence] | acceptance: per-rule try/catch + 5s timeout; internal errors aggregated separately; exit-code precedence honored (0/1/2/3/4 per §9).

T10: Baseline + manifest + suppression-via-baseline | depends_on: [T1, T8] | files: [mcp-server/src/lint/baseline.ts, mcp-server/src/lint/manifest.ts, tests] | acceptance: sha256 fingerprint = hash of trimmed(line-1, line, line+1); CRLF normalization runs BEFORE fingerprint (NON-NEGOTIABLE per Codex); rulesetVersion per entry; --update-baseline / --update-manifest regenerate; CI never regenerates.

T11: CLI entry + all flags + tsc-compiled output | depends_on: [T4, T5, T6, T7, T8, T9, T10] | files: [mcp-server/scripts/lint-skill.ts, mcp-server/package.json scripts, .nvmrc] | acceptance: all flags work (--file --ci --baseline --format --max-bytes --update-baseline --update-manifest --rule); compiled to dist/scripts/lint-skill.js by tsc (NOT just tsx); --help shows rule + exit table; npm test does NOT depend on lint:skill (CI-only enforcement per user).

T12: GitHub Actions CI workflow + manifest-drift guard + live canary + initial baseline | depends_on: [T11] | files: [.github/workflows/ci.yml, .nvmrc, mcp-server/.lintskill-baseline.json, mcp-server/.lintskill-manifest.json, mcp-server/.lintskill-allowlist.json, mcp-server/src/__tests__/lint/live-flywheel.test.ts, AGENTS.md (one-para addition)] | acceptance: 4 jobs (build/test/manifest-drift/lint-skill); CI runs node dist/... (NOT tsx); manifest-drift catches missing entries; live canary asserts zero errors with baseline; AGENTS.md updated.
```

### 15.1 Parallelization waves (capped at 3 concurrent per Codex)

- **Wave 1:** T1 (blocks everything).
- **Wave 2:** T2, T3 in parallel (both depend only on T1).
- **Wave 3:** T4, T5, T6 in parallel (T5 also needs T3).
- **Wave 4:** T7, T8, T9 in parallel.
- **Wave 5:** T10.
- **Wave 6:** T11.
- **Wave 7:** T12.

7 serial waves, 5 hops on the critical path (T1 → T2 → T4 → T11 → T12). **Agent Mail file reservations mandatory** for any bead touching `index.ts`, `types.ts`, or `rules/index.ts` — these are shared across waves.

---

## 16. Deferred to v1.1 (explicit)

- HARD001 rule (info-only; baseline noise without value)
- Autofix pipeline (`--fix`, `--fix-review`, `--fix-dry-run`)
- SARIF reporter (no current consumer)
- Severity phasing (conflicts with baseline)
- Pre-commit hook template
- Per-line `<!-- lint-disable-next-line -->` suppression syntax
- Full 22-fixture adversarial suite (only 4 mandatory inline in T2)
- Golden-file determinism test
- Property tests via `fast-check`
- Memory-profile test
- MCP wrapper (`flywheel_lint_skill`)
- `docs/lint-skill-runbook.md`
- `SKILL_LINT_EMERGENCY=1` escape hatch
- `--reproduce-ci` flag

Each becomes a v1.1 bead once v1.0 ships and we have lived with the linter for a sprint.

---

## 17. Verification

End-to-end checks once T12 ships:
1. **Local:** `cd mcp-server && npm run build && npm run lint:skill` → exits 0 (baseline applied).
2. **Local strict:** `cd mcp-server && npm run lint:skill -- --ci --baseline .lintskill-baseline.json` → exits 0 (CI mode works without `~/.claude/plugins`).
3. **Manifest drift:** rename a skill in `skills/`, run the manifest-drift workflow locally → fails.
4. **CI:** push branch with deliberate AUQ001 violation in SKILL.md → CI fails on lint-skill job, succeeds on test job (CI-only enforcement isolates failures).
5. **Live canary:** `cd mcp-server && npm test` → live-flywheel.test.ts asserts zero errors on real SKILL.md.

---

**End of final plan.**
