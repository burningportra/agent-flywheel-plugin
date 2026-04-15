# Ergonomics Plan: SKILL.md Linter Developer Experience

Date: 2026-04-15
Perspective: Ergonomics
Scope: `scripts/lint-skill.ts`, npm integration, CI, pre-commit hook, suppression, migration

---

## Executive Summary

The SKILL.md linter must be something developers want to run, not something they dread or disable. That means every error message is a complete sentence that names the problem, quotes the offending text, and tells the developer exactly what to change. Every channel — terminal, CI, IDE — gets the format it was designed to consume. Autofixes make low-cost mistakes disappear automatically. Suppressions give developers an escape hatch without breaking the contract. And a baseline file means the very first `npm test` run never blocks the team.

---

## 1. Error Message Format

### Design principles

- **Code first.** Every diagnostic begins with a stable rule ID (`AUQ001`) so grep, CI annotations, and suppression comments all use the same token.
- **Location is precise.** `file:line:col` — not "somewhere in step 5".
- **Quote the offending text.** Developers should not have to hunt.
- **One actionable sentence.** Tell them what to do, not just what went wrong.
- **BAD vs GOOD examples** (the "before" helps the rule stick).

### Rule taxonomy

| ID | Category | What it catches |
|----|----------|-----------------|
| AUQ001 | AskUserQuestion count | Question has <2 or >4 options |
| AUQ002 | AskUserQuestion desc | An option is missing a `description` field |
| AUQ003 | AskUserQuestion multi | `multiSelect` is absent or not a boolean |
| AUQ004 | AskUserQuestion batch | >4 questions in one `AskUserQuestion` call |
| SLASH001 | Slash reference | `/slash-name` does not resolve to an installed skill |
| PLACE001 | Placeholder | `<PLACEHOLDER>` tag has no referent definition in the same step |
| HARD001 | Hard-rule callout | A `> ## ⚠️` hard-rule block has no enforcement comment in later steps |
| IMPL001 | Implicit decision | Free-text decision phrase found ("check with the user", "wait for confirmation", etc.) instead of AskUserQuestion |

### Message templates

**AUQ001 — option count out of range**

```
BAD:
  error  AskUserQuestion at line 47 has invalid option count

GOOD:
  [AUQ001] skills/orchestrate/SKILL.md:47:7
  Question "How deep should discovery go?" has 5 options; AskUserQuestion accepts 2–4.
  Drop or merge one option, or split into two questions.
```

**AUQ002 — missing description**

```
BAD:
  warning: option missing description at line 133

GOOD:
  [AUQ002] skills/orchestrate/SKILL.md:133:9
  Option { label: "Quick fix" } has no description field.
  Add: description: "Apply a targeted patch without the full flywheel"
  (autofix available — run with --fix)
```

**AUQ003 — missing multiSelect**

```
[AUQ003] skills/orchestrate/SKILL.md:160:5
Question block starting at line 160 is missing the `multiSelect` field.
Add `multiSelect: false` (or `true` for multi-choice) before the closing `}])`.
(autofix available — run with --fix)
```

**AUQ004 — too many questions in one call**

```
[AUQ004] skills/orchestrate/SKILL.md:531:1
AskUserQuestion call at line 531 passes 5 questions; the tool accepts at most 4.
Split into two calls or merge the least critical questions.
```

**SLASH001 — unresolved slash reference**

```
[SLASH001] skills/orchestrate/SKILL.md:349:12
Slash reference `/idea-wizzard` does not match any installed skill.
Did you mean `/idea-wizard`? (edit-distance 1)
Installed skills: idea-wizard, ubs-workflow, brainstorming, ...
(autofix available — run with --fix to accept the nearest match)
```

**PLACE001 — placeholder without referent**

```
[PLACE001] skills/orchestrate/SKILL.md:573:27
Placeholder <N> appears in an Agent() call but has no definition in this step.
Either replace it with a literal value or add a comment like:
  <!-- N: the current refinement round counter, starts at 1 -->
(autofix available — inserts a stub comment)
```

**HARD001 — hard-rule callout without enforcement**

```
[HARD001] skills/orchestrate/SKILL.md:12:1
Hard-rule block "UNIVERSAL RULE 1 — AskUserQuestion is the only way..." has no
enforcement reference in later steps. Add a `<!-- enforced by: AUQ001,IMPL001 -->`
comment on the same block to close the loop.
```

**IMPL001 — implicit decision phrase**

```
[IMPL001] skills/orchestrate/SKILL.md:892:3
Implicit-decision phrase "check with the user before proceeding" found.
Replace with an AskUserQuestion call:
  AskUserQuestion(questions: [{
    question: "<insert decision question here>",
    options: [
      { label: "Proceed", description: "Continue as planned" },
      { label: "Abort", description: "Stop and return to the previous step" }
    ],
    multiSelect: false
  }])
```

### Implicit-decision phrase dictionary

The linter maintains a dictionary of trigger phrases for IMPL001. Initial set:

```
"check with the user"
"wait for confirmation"
"wait for the user"
"ask the user"
"surface this to the user"
"propose this to the user"
"only do X if the user confirms"
"confirm with the user"
"prompt the user"
"get user approval"
"seek user input"
"let the user decide"
"pause for user feedback"
```

The dictionary is exported as a constant array so rule authors can extend it via a simple array push.

---

## 2. Autofix Suggestions

### Which rules are autofixable?

| Rule | Autofix? | Safety | Algorithm |
|------|----------|--------|-----------|
| AUQ001 | No | — | Requires human judgment (which option to drop/merge) |
| AUQ002 | Yes (safe) | Low risk | Derives description from label text |
| AUQ003 | Yes (safe) | Low risk | Inserts `multiSelect: false` after the last option |
| AUQ004 | No | — | Requires human judgment (which questions to split) |
| SLASH001 | Yes (review) | Review required | Replaces with nearest edit-distance match |
| PLACE001 | Yes (safe) | Low risk | Inserts stub comment after the placeholder |
| HARD001 | Yes (safe) | Low risk | Appends `<!-- enforced by: ... -->` comment |
| IMPL001 | Yes (template) | Review required | Inserts AskUserQuestion template stub |

### Autofix algorithms in detail

**AUQ002 — description derived from label**

```
label: "Quick fix"
→ description: "Quick fix"   // lowercase first word, strip quotes
```

For a label like `"Deep (idea-wizard)"`, derive: `"Run the deep idea-wizard pipeline"`. The algorithm tokenizes the label and expands parenthetical skill names into a `"Run the X pipeline"` template. Output is always wrapped in a `TODO:` prefix: `description: "TODO: Quick fix"` to signal the developer must review before committing.

**AUQ003 — insert multiSelect**

Find the closing `}])` of the question object and insert `multiSelect: false` on the line before it. Preserves indentation by copying the indent level of the options array.

**SLASH001 — nearest edit-distance match**

1. Collect all installed skill names from `skills/` directory at lint time.
2. Compute Levenshtein distance between the unresolved name and each installed skill name.
3. Accept the match only if distance ≤ 2 and the match is unambiguous (no tie within distance 1).
4. Dry-run output:
   ```
   Would replace `/idea-wizzard` → `/idea-wizard` at line 349:12
   ```
5. If distance > 2 or ambiguous: report the top-3 candidates and require manual fix.

**PLACE001 — stub comment**

Insert immediately after the line containing the placeholder:
```markdown
<!-- <PLACEHOLDER_NAME>: TODO — define this value (e.g. the current round counter) -->
```

**HARD001 — enforcement comment**

Append to the hard-rule `> ## ⚠️` block:
```markdown
<!-- enforced by: RULE_ID[,RULE_ID...] -->
```
The linter infers candidate rule IDs by scanning the rule block text for known rule keywords.

**IMPL001 — AskUserQuestion template stub**

Replace the implicit phrase line with:
```markdown
<!-- TODO: replace this with AskUserQuestion -->
AskUserQuestion(questions: [{
  question: "TODO: <insert decision question here>",
  options: [
    { label: "Proceed", description: "TODO: describe the proceed action" },
    { label: "Abort", description: "Return to the previous step" }
  ],
  multiSelect: false
}])
```

### CLI flags

```
--fix            Apply all safe autofixes (AUQ002, AUQ003, PLACE001, HARD001) without prompting.
--fix-review     Apply all fixes including review-required ones (SLASH001, IMPL001).
--fix-dry-run    Print what would change; do not write files.
```

The `--fix` flag never applies `--fix-review`-class fixes. This distinction is intentional: safe fixes are truly mechanical; review fixes require the developer to verify the suggestion is correct.

---

## 3. Output Channels

### TTY detection

The linter detects the output channel at startup:

```ts
const isTTY = process.stdout.isTTY;
const isGHA = Boolean(process.env.GITHUB_ACTIONS);
const format = args['--format'] ?? (isGHA ? 'gha' : isTTY ? 'pretty' : 'compact');
```

### Format: `pretty` (default in terminal)

- ANSI colors: rule ID in cyan bold, file path underlined, offending text in yellow, fix hint in green.
- Diagnostics grouped by file, sorted by line number within each group.
- Summary footer: `3 errors, 2 warnings (2 autofixable — run with --fix)`

Example terminal output:
```
skills/orchestrate/SKILL.md
  47:7  error  [AUQ001] Question "How deep should discovery go?" has 5 options …
 133:9  warn   [AUQ002] Option { label: "Quick fix" } has no description  (autofix)
 349:12 error  [SLASH001] Slash ref `/idea-wizzard` not found  (autofix: /idea-wizard)

3 errors, 1 warning  ·  2 autofixable  ·  run with --fix to apply safe fixes
```

### Format: `gha` (GitHub Actions)

Uses the [workflow commands](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions) annotation format:

```
::error file=skills/orchestrate/SKILL.md,line=47,col=7,title=AUQ001::Question "How deep should discovery go?" has 5 options; AskUserQuestion accepts 2–4. Drop or merge one.
::warning file=skills/orchestrate/SKILL.md,line=133,col=9,title=AUQ002::Option { label: "Quick fix" } has no description. Autofix: run npm run lint:skill -- --fix
```

GitHub renders these as inline PR annotations and check-run entries with no additional tooling.

### Format: `compact` (piped, non-TTY)

ESLint-style one-line-per-diagnostic for scripting:
```
skills/orchestrate/SKILL.md:47:7: error AUQ001: Question "How deep should discovery go?" has 5 options; accepts 2-4.
skills/orchestrate/SKILL.md:133:9: warning AUQ002: Option missing description (autofix with --fix)
```

### Format: `json`

```json
{
  "version": 1,
  "files": [
    {
      "path": "skills/orchestrate/SKILL.md",
      "diagnostics": [
        {
          "ruleId": "AUQ001",
          "severity": "error",
          "line": 47,
          "col": 7,
          "message": "Question \"How deep should discovery go?\" has 5 options; AskUserQuestion accepts 2–4.",
          "fix": null
        },
        {
          "ruleId": "AUQ002",
          "severity": "warning",
          "line": 133,
          "col": 9,
          "message": "Option { label: \"Quick fix\" } has no description.",
          "fix": { "type": "insert", "text": "description: \"TODO: Quick fix\"" }
        }
      ]
    }
  ],
  "summary": { "errors": 1, "warnings": 1, "autofixable": 1 }
}
```

### Format: `sarif`

SARIF 2.1 output for reviewdog, CodeQL dashboard, and VS Code SARIF Viewer integration. Enables inline PR review comments via `reviewdog -f=sarif`.

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": { "driver": { "name": "lint-skill", "version": "1.0.0", "rules": [...] } },
    "results": [{
      "ruleId": "AUQ001",
      "level": "error",
      "message": { "text": "Question has 5 options; AskUserQuestion accepts 2–4." },
      "locations": [{ "physicalLocation": {
        "artifactLocation": { "uri": "skills/orchestrate/SKILL.md" },
        "region": { "startLine": 47, "startColumn": 7 }
      }}]
    }]
  }]
}
```

### Format selection summary

| Environment | Default format | Rationale |
|-------------|---------------|-----------|
| TTY terminal | `pretty` | Human-readable, colorized, grouped |
| GitHub Actions CI | `gha` | Native PR annotations, no plugins needed |
| Non-TTY pipe | `compact` | ESLint-compatible for scripting |
| `--format json` | `json` | Programmatic consumers |
| `--format sarif` | `sarif` | reviewdog, VS Code SARIF viewer |

---

## 4. Performance

The linter must run in <1 second on the 1438-line SKILL.md. Target budget: 200ms.

### Single-pass streaming parser

The file is read once with `fs.readFileSync` (synchronous, no stream overhead for <5MB files). The parser walks lines in one forward pass, maintaining state for:
- current AskUserQuestion block (open/closed, option count)
- current step heading (for PLACE001 scoping)
- active suppress directives

No AST, no regex backtracking across the full document. Each line is evaluated in O(1) against the current rule set.

### Lazy rule execution

Rules are organized by trigger. The parser only invokes a rule's `check(line, ctx)` function when the line's first token matches a rule trigger prefix:

```ts
const TRIGGERS = {
  'AskUserQuestion': [auq001, auq002, auq003, auq004],
  '/':              [slash001],
  '<':              [place001],
  '> ##':           [hard001],
};
```

Lines that match no trigger are skipped in O(string comparison) time.

### Rule-level skip via comment

Developers can annotate a line to skip a specific rule:
```markdown
<!-- lint-skip:SLASH001 -->
```
The parser checks for this comment before invoking the rule's check function.

### Benchmark target

| File size | Expected time |
|-----------|--------------|
| 1438 lines (current) | <200ms |
| 5000 lines | <500ms |
| 10000 lines | <1s |

A performance test in the Vitest suite asserts the linter completes within 2× the target on CI.

---

## 5. Suppression / Waivers

### Chosen syntax: HTML comments (justified)

HTML comments are the correct choice for Markdown files because:
1. They are invisible in rendered output (GitHub, Obsidian, VS Code preview).
2. They do not require a custom preprocessor — the linter's line scanner already reads raw Markdown.
3. They are the convention used by markdownlint, remark-lint, and similar tools — developers already know the pattern.
4. They survive copy-paste between files without losing meaning.

### Supported suppression forms

**Inline (current line only)**
```markdown
Invoke `/orchestrate-fix`.  <!-- lint-disable-next-line SLASH001 -->
```
Note: the `lint-disable-next-line` applies to the NEXT line after the comment line, matching ESLint convention. This avoids ambiguity about "which" line the comment is on.

**Block (a range of lines)**
```markdown
<!-- lint-disable AUQ001,IMPL001 -->
... content that deliberately violates these rules ...
<!-- lint-enable AUQ001,IMPL001 -->
```
Nested disable blocks for the same rule ID are an error (reported as a linter meta-warning, not a hard failure).

**File-level (top of file)**
```markdown
<!-- lint-skill-config: disable AUQ004 -->
```
Must appear within the first 10 lines of the file.

**Baseline suppression (see Section 8)**
Existing violations captured in `.lint-skill-baseline.json` are silently suppressed until the baseline is explicitly cleaned up.

### Waiver documentation requirement

The linter emits a `meta-warning` if a suppression comment does not include a `reason:` annotation:
```
[META] skills/orchestrate/SKILL.md:349
Suppression comment `<!-- lint-disable-next-line SLASH001 -->` has no reason.
Add: <!-- lint-disable-next-line SLASH001 reason: external skill loaded at runtime -->
```
This is a warning, not an error, and is excluded from baseline calculations. It encourages self-documenting exceptions.

---

## 6. Wiring into npm test

### Exact `package.json` scripts

```json
{
  "scripts": {
    "lint:skill": "tsx scripts/lint-skill.ts skills/orchestrate/SKILL.md",
    "lint:skill:fix": "tsx scripts/lint-skill.ts skills/orchestrate/SKILL.md --fix",
    "lint:skill:ci": "tsx scripts/lint-skill.ts skills/orchestrate/SKILL.md --format gha",
    "test": "npm run lint:skill && vitest run --passWithNoTests"
  }
}
```

`tsx` is used to run the TypeScript linter script directly without a separate compilation step. Add it as a devDependency: `npm install --save-dev tsx`.

### Should `npm test` block on lint failures?

**Yes, with a grace period during migration.**

Arguments for blocking:
- The linter validates invariants (AskUserQuestion required for all decisions) that are as fundamental as unit tests. Letting tests pass while SKILL.md violates them creates a false green signal.
- CI becomes the source of truth. Developers who run `npm test` locally get the same signal as CI.
- The baseline mechanism (Section 8) makes blocking non-disruptive during rollout.

Arguments against:
- SKILL.md edits are authored in natural language, not code; lint failures can feel punishing for prose-focused contributors.
- A linter bug could block all tests unexpectedly.

**Decision**: Block `npm test` on errors (not warnings). Warnings are shown but do not fail the exit code. The `--baseline` flag (Section 8) ensures the first run is non-blocking. Linter bugs fail loudly with a clear stack trace so contributors can report them quickly.

---

## 7. Pre-commit Hook

### Recommended approach: `.git/hooks/pre-commit` template

Using a plain shell hook (not husky/lefthook) keeps the dependency count at zero and works for all contributors without additional setup.

```sh
#!/usr/bin/env sh
# .git/hooks/pre-commit
# Lint only SKILL.md files that are staged for commit.

set -e

# Collect staged SKILL.md paths
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep 'SKILL\.md$' || true)

if [ -z "$STAGED" ]; then
  exit 0
fi

echo "lint-skill: checking staged SKILL.md files..."

for file in $STAGED; do
  node --loader ts-node/esm scripts/lint-skill.ts "$file" --format compact
done
```

Install by copying to `.git/hooks/pre-commit` and making it executable:
```bash
cp scripts/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Provide `scripts/pre-commit-hook.sh` in the repo so contributors can reinstall after a fresh clone.

### Optional: lefthook (if the team uses it)

```yaml
# lefthook.yml
pre-commit:
  commands:
    lint-skill:
      glob: "**SKILL.md"
      run: tsx scripts/lint-skill.ts {staged_files} --format compact
```

---

## 8. Migration Plan for Existing SKILL.md

### Problem

The first run of the linter against the current 1438-line SKILL.md will produce findings. Blocking the team on day one causes friction and delays adoption.

### Solution: baseline file

**Step 1 — Generate the baseline on introduction**

```bash
npm run lint:skill -- --emit-baseline
```

This creates `.lint-skill-baseline.json`:
```json
{
  "generated": "2026-04-15T02:00:00Z",
  "version": 1,
  "suppressions": [
    { "ruleId": "AUQ002", "file": "skills/orchestrate/SKILL.md", "line": 133, "fingerprint": "sha256:abc123" },
    { "ruleId": "IMPL001", "file": "skills/orchestrate/SKILL.md", "line": 892, "fingerprint": "sha256:def456" }
  ]
}
```

The `fingerprint` is a hash of the surrounding 3 lines (line-1, line, line+1) so the suppression survives minor line-number shifts.

**Step 2 — Linter only fails on new violations**

```bash
npm run lint:skill -- --baseline .lint-skill-baseline.json
```

Any violation whose fingerprint matches a baseline entry is shown as a `[baselined]` info note (never an error). New violations not in the baseline are errors as usual.

**Step 3 — Schedule baseline cleanup**

Create a dedicated bead `"lint-skill: clear baseline violations"` that addresses the existing findings in batches. The target is zero baseline entries within 2 sprints. The linter prints a reminder:

```
20 baselined violations remain. Run `npm run lint:skill -- --show-baseline` to review.
```

**Step 4 — CI enforcement**

The GitHub Actions workflow runs without `--baseline` on the main branch after the baseline cleanup bead is merged. Until then, it runs with `--baseline`.

### `.lint-skill-baseline.json` is committed to the repo

It is a deliberate artifact that records technical debt. It must be updated when baseline violations are fixed (the linter auto-removes matched entries when `--fix` is applied to a baselined finding).

---

## 9. Documentation

### Where the linter is documented

| Document | What goes there |
|----------|----------------|
| `AGENTS.md` | Hard constraint: "SKILL.md files must pass `npm run lint:skill`." One sentence + link to `scripts/lint-skill.ts`. |
| `scripts/lint-skill.ts` | Inline JSDoc on each rule class: what it catches, why it matters, autofix algorithm. No multi-line blocks — one-line summary per rule. |
| `docs/plans/2026-04-15-ergonomics.md` | This file — the design record for the linter's ergonomics decisions. |
| `skills/lint-skill/SKILL.md` | Not created. The linter is a developer tool, not an agent skill. Agents should not invoke the linter themselves. |

### AGENTS.md addition

Add a single paragraph to the "Hard Constraints" section:

```markdown
9. **SKILL.md files must pass the linter.** Before submitting changes to any `SKILL.md`, run
   `npm run lint:skill` from the repo root. All errors must be resolved. Warnings may remain
   but should be reviewed. See `scripts/lint-skill.ts` for rule details and `--fix` for autofixes.
```

---

## 10. How to Add a Rule

Target: <30 minutes from idea to passing test and documented rule.

### Step-by-step

**Step 1 — Define the rule in `scripts/lint-skill.ts`**

Each rule implements the `LintRule` interface:

```ts
interface LintRule {
  id: string;            // e.g. "AUQ001"
  severity: "error" | "warning";
  trigger: string[];     // line-start prefixes that activate this rule
  check(line: string, lineNum: number, col: number, ctx: LintContext): Diagnostic | null;
  autofix?(line: string, ctx: LintContext): string | null;
}
```

Example minimal rule:

```ts
const auq001: LintRule = {
  id: "AUQ001",
  severity: "error",
  trigger: ["AskUserQuestion"],
  check(line, lineNum, col, ctx) {
    const count = ctx.currentAuqBlock?.optionCount ?? 0;
    if (ctx.currentAuqBlock?.closed && (count < 2 || count > 4)) {
      return {
        ruleId: "AUQ001",
        line: ctx.currentAuqBlock.startLine,
        col: 1,
        message: `Question "${ctx.currentAuqBlock.question}" has ${count} options; AskUserQuestion accepts 2–4.`,
        fix: null,
      };
    }
    return null;
  },
};
```

**Step 2 — Register the rule**

```ts
const RULES: LintRule[] = [auq001, auq002, /* ... */ myNewRule];
```

Add the rule ID to the `TRIGGERS` map if the trigger prefix is new.

**Step 3 — Write a Vitest test**

Create `scripts/__tests__/lint-skill.test.ts` (or add a describe block):

```ts
import { describe, it, expect } from "vitest";
import { lintString } from "../lint-skill.js";

describe("AUQ001", () => {
  it("errors when question has 5 options", () => {
    const md = `
AskUserQuestion(questions: [{
  question: "Test?",
  options: [
    { label: "A" }, { label: "B" }, { label: "C" },
    { label: "D" }, { label: "E" }
  ],
  multiSelect: false
}])`;
    const diags = lintString(md, "test.md");
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("AUQ001");
    expect(diags[0].message).toContain("5 options");
  });

  it("passes when question has 3 options", () => {
    // ... valid markdown
    const diags = lintString(validMd, "test.md");
    expect(diags.filter(d => d.ruleId === "AUQ001")).toHaveLength(0);
  });
});
```

**Step 4 — Add the rule to the rule taxonomy table** in this document (Section 1).

**Step 5 — Run tests**

```bash
npm test
```

### Fixture helpers

The `lintString(md: string, filename: string): Diagnostic[]` helper is exported from `lint-skill.ts` for use in tests. It wraps the full parse-and-check pipeline and returns diagnostics without any I/O, making tests fast and hermetic.

For multi-file scenarios, use `lintFiles([{ path, content }])`.

### Total time estimate

| Step | Time |
|------|------|
| Write rule (with template) | 10 min |
| Write 2 test cases | 10 min |
| Update documentation | 5 min |
| Run tests and fix | 5 min |
| **Total** | **~30 min** |

---

## 11. Help Text

### `lint-skill --help` output

```
Usage: lint-skill [options] <file> [<file>...]

Validate SKILL.md files against CASS conventions.

Arguments:
  <file>          One or more SKILL.md paths to lint (glob patterns accepted)

Options:
  --fix           Apply safe autofixes (AUQ002, AUQ003, PLACE001, HARD001)
  --fix-review    Apply all autofixes including review-required (SLASH001, IMPL001)
  --fix-dry-run   Preview fixes without writing files
  --format        Output format: pretty | compact | gha | json | sarif
                  (default: pretty in TTY, gha in GitHub Actions, compact otherwise)
  --baseline      Path to baseline file; suppress pre-existing violations
                  Example: --baseline .lint-skill-baseline.json
  --emit-baseline Generate or update the baseline file with current violations
  --show-baseline List all baselined violations and their line fingerprints
  --rules         Comma-separated list of rule IDs to run (default: all)
  --ignore-rules  Comma-separated list of rule IDs to skip
  --skills-dir    Path to skills directory for SLASH001 resolution
                  (default: ./skills relative to cwd)
  --max-warnings  Exit with error if warning count exceeds N (default: unlimited)
  --quiet         Only print errors, suppress warnings and info
  -h, --help      Show this help text
  -V, --version   Print version

Examples:
  lint-skill skills/orchestrate/SKILL.md
  lint-skill skills/**/*.md --format json | jq '.summary'
  lint-skill skills/orchestrate/SKILL.md --fix --fix-dry-run
  lint-skill skills/orchestrate/SKILL.md --baseline .lint-skill-baseline.json
  lint-skill skills/orchestrate/SKILL.md --rules AUQ001,SLASH001

Exit codes:
  0   No errors (warnings do not affect exit code unless --max-warnings exceeded)
  1   One or more errors found
  2   Linter internal error (bug — please report)

Rule IDs:
  AUQ001  AskUserQuestion option count out of range (2–4 required)
  AUQ002  AskUserQuestion option missing description
  AUQ003  AskUserQuestion missing multiSelect field
  AUQ004  AskUserQuestion call exceeds 4 questions
  SLASH001 Slash reference resolves to no installed skill
  PLACE001 Placeholder tag has no referent in the same step
  HARD001  Hard-rule callout block has no enforcement reference
  IMPL001  Implicit-decision phrase found (must use AskUserQuestion)

Suppression:
  Inline:   <!-- lint-disable-next-line RULE_ID reason: why -->
  Block:    <!-- lint-disable RULE_ID --> ... <!-- lint-enable RULE_ID -->
  File:     <!-- lint-skill-config: disable RULE_ID --> (first 10 lines only)

Documentation:
  Rule reference and autofix details: scripts/lint-skill.ts
  Ergonomics design: docs/plans/2026-04-15-ergonomics.md
```

---

## Dependency Graph

```
T1: Define LintRule interface + lintString() + lintFiles() in scripts/lint-skill.ts
    depends_on: []

T2: Implement TTY/GHA/compact/json/sarif output formatters
    depends_on: [T1]

T3: Implement AUQ001–AUQ004 rules
    depends_on: [T1]

T4: Implement SLASH001 rule + edit-distance resolution
    depends_on: [T1]

T5: Implement PLACE001 rule
    depends_on: [T1]

T6: Implement HARD001 rule
    depends_on: [T1]

T7: Implement IMPL001 rule + phrase dictionary
    depends_on: [T1]

T8: Implement --fix / --fix-dry-run / --fix-review flag handling
    depends_on: [T3, T4, T5, T6, T7]

T9: Implement --baseline / --emit-baseline / --show-baseline
    depends_on: [T1, T2]

T10: Write Vitest tests for all rules (fixtures via lintString())
     depends_on: [T3, T4, T5, T6, T7]

T11: Add npm scripts to mcp-server/package.json
     depends_on: [T1]

T12: Add .git/hooks/pre-commit template at scripts/pre-commit-hook.sh
     depends_on: [T1]

T13: Add GitHub Actions CI step
     depends_on: [T11]

T14: Generate .lint-skill-baseline.json from current SKILL.md
     depends_on: [T3, T4, T5, T6, T7, T9]

T15: Update AGENTS.md with hard constraint #9
     depends_on: [T11]
```

---

## What the Developer Sees on First `npm test`

```
> claude-orchestrator@2.9.0 test
> npm run lint:skill && vitest run --passWithNoTests

lint-skill v1.0.0 — skills/orchestrate/SKILL.md (1438 lines)

skills/orchestrate/SKILL.md
   47:7  error   [AUQ001]  Question "How deep should discovery go?" has 5 options; …
  133:9  warn    [AUQ002]  Option { label: "Quick fix" } has no description  (autofix)
  349:12 error   [SLASH001] Slash ref `/idea-wizzard` not found  (did you mean /idea-wizard?)  (autofix)

3 errors, 1 warning  ·  2 autofixable

Next steps:
  → Run `npm run lint:skill -- --fix` to apply 2 safe autofixes
  → Fix AUQ001 manually at line 47 (merge or drop an option)
  → Re-run `npm test` to verify

20 baselined violations suppressed — run `npm run lint:skill -- --show-baseline` to review
```

The key ergonomic decisions embedded in this output:
1. **Banner with file and line count** — developer immediately knows what was scanned.
2. **Errors before warnings** — most urgent items first.
3. **Autofix hint on the same line** — no hunting for the flag.
4. **"Next steps" block** — one ordered to-do list, not a dump of errors.
5. **Baseline count** — visible but not noisy; the escape hatch is one command away.
