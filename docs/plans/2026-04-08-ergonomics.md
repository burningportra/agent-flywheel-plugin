# Ergonomics Plan: Complete Bead Template Stubs

**Date:** 2026-04-08
**Perspective:** Ergonomics — developer experience, template clarity, discoverability, ease of extension

---

## 1. Problem Statement

`mcp-server/src/bead-templates.ts` ships only 3 built-in templates: `add-api-endpoint`, `refactor-module`, and `add-tests`. This sparse library creates two classes of ergonomic friction:

1. **Agent friction:** Sub-agents must invent bead structure from scratch for common work types (bug fixes, documentation, data migrations, config changes, dependency upgrades, etc.). The prompt in `prompts.ts` shows the template list via `formatTemplatesForPrompt()` — with only 3 templates, agents miss the scaffolding that helps them produce consistent, quality beads.

2. **Maintainer friction:** The three existing templates each have a slightly different internal structure in their `descriptionTemplate` — there is no enforced narrative pattern (header sentence, "Why this bead exists" block, acceptance criteria, files section). A new contributor adding a fourth template must reverse-engineer the pattern from reading all three.

**Concrete impact measured by the quality-check code in `beads.ts`:**
- Beads must have `### Files:`, `- [ ]` acceptance criteria, and ≥ 100-char descriptions or they fail quality checks.
- Templates that don't model this structure by default train agents to produce non-compliant beads.

---

## 2. Template Structure Design

### 2.1 Canonical `descriptionTemplate` Narrative Pattern

All templates must follow this five-block pattern (already present in the existing three, but not documented):

```
{{leadSentence}}                          ← one focused sentence: what is being done and where

Why this bead exists:
- {{rationale1}}
- {{rationale2}}

Acceptance criteria:
- [ ] {{criterion1}}
- [ ] {{criterion2}}
- [ ] {{criterion3}}

### Files:
- {{primaryFile}}
- {{secondaryFile}}
```

**Why this pattern:**
- `beads.ts:validateBeads` scans for `### Files:` and `- [ ]` — the template bakes both in.
- "Why this bead exists" gives a fresh agent the context they need without consulting the original goal.
- Lead sentence is what appears in `formatTemplatesForPrompt()` (summary field) — it trains agents to write tight summaries.

### 2.2 New Templates to Add

The following 9 templates cover the most common bead shapes seen in real orchestration sessions and missing from the current library. Each is specified with its intended `id`, narrative coverage, and required placeholders.

| id | Label | Gap Filled |
|----|-------|------------|
| `fix-bug` | Fix bug | No template exists for the most common bead type |
| `add-migration` | Add data migration | DB/schema migrations need special structure (up/down, rollback) |
| `update-config` | Update configuration | Env var, flag, and settings changes have a consistent shape |
| `add-documentation` | Add documentation | Docs beads need audience and location specified |
| `upgrade-dependency` | Upgrade dependency | Dep upgrades need breaking-change and test validation steps |
| `add-cli-command` | Add CLI command | CLI work needs flag spec, help text, and integration test steps |
| `add-type-definitions` | Add type definitions | Type-only work is common in TS repos and needs its own template |
| `extract-module` | Extract module | Split/extract is distinct from refactor — different acceptance criteria |
| `add-integration` | Add integration | Third-party service integrations need credentials, error handling, and mock spec |

### 2.3 Template Metadata Ergonomics

Each template's `placeholders` array is the primary API surface that agents use. Every placeholder must have:
- A `name` that is camelCase and self-explanatory without reading the description
- A `description` that explains the *role* not just the *format* (e.g., "Why the endpoint is being added" not "The purpose")
- An `example` that is concrete and domain-specific, not abstract (`"Fix the crash when user list is empty"` not `"bug description"`)
- `required: true` for all placeholders that affect the structural skeleton; `required: false` only for genuinely optional elaboration

### 2.4 `filePatterns` Coverage

`filePatterns` is used by `extractArtifacts` (indirectly via the quality checker) to find file scope. Templates should set `filePatterns` to the actual glob patterns relevant to the work type, not generic wildcards. This helps the `file-overlap` quality check identify parallel execution conflicts.

### 2.5 `dependencyHints` as Agent Guide

Currently `dependencyHints` is only present on `add-api-endpoint` and `refactor-module`. All templates should include this field. The hint should name:
- What beads this template typically **blocks** (depends on nothing)
- What beads typically **depend on** this template
- When to split the work into a separate `add-tests` bead

---

## 3. Implementation Steps

### Step 1 — Document the canonical template pattern (T1)

Add a JSDoc block above `BUILTIN_TEMPLATES` in `bead-templates.ts` explaining the five-block `descriptionTemplate` pattern, placeholder naming conventions, and the contract between `descriptionTemplate` and `formatTemplatesForPrompt`. This is the single place a new template author looks.

**File:** `mcp-server/src/bead-templates.ts`

### Step 2 — Add `fix-bug` template (T2, depends_on: [T1])

```typescript
{
  id: "fix-bug",
  label: "Fix bug",
  summary: "Diagnose and fix a specific defect with a regression test.",
  descriptionTemplate: `Fix the {{bugSummary}} bug in {{moduleName}}.
Reproduce the issue, identify the root cause, apply the minimal fix, and add a regression test to prevent recurrence.

Why this bead exists:
- {{bugSymptom}} — the current behavior is incorrect.
- A regression test is required so this exact failure cannot silently reappear.

Acceptance criteria:
- [ ] Reproduce {{bugSummary}} in a test before fixing it (red-green).
- [ ] Apply the minimal fix in {{moduleName}} without changing unrelated behavior.
- [ ] Add a regression test that fails before the fix and passes after.

### Files:
- {{implementationFile}}
- {{testFile}}`,
  placeholders: [
    { name: "bugSummary", description: "Short name for the bug (used in commit messages and test names)", example: "crash when user list is empty", required: true },
    { name: "moduleName", description: "Module or function where the defect lives", example: "readyBeads filter logic", required: true },
    { name: "bugSymptom", description: "Observable symptom: what the user or system experiences", example: "br ready crashes with TypeError on repos with no open beads", required: true },
    { name: "implementationFile", description: "File containing the defect", example: "src/beads.ts", required: true },
    { name: "testFile", description: "Test file for the regression test", example: "src/beads.test.ts", required: true },
  ],
  acceptanceCriteria: [
    "Write a failing test that reproduces the bug before changing implementation code.",
    "Apply the minimal code change that makes the test pass without regressing other tests.",
    "Leave a comment in the test explaining what scenario it covers.",
  ],
  filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
  dependencyHints: "fix-bug beads are usually independent. If the bug is in shared infrastructure, other beads that use that infrastructure should depend on this one.",
}
```

### Step 3 — Add `add-migration` template (T3, depends_on: [T1])

Covers DB schema migrations (up + down), data transforms, and rollback safety. Key placeholders: `migrationName`, `changeDescription`, `rollbackPlan`, `migrationFile`, `rollbackFile`.

Acceptance criteria pattern must include: schema validates after migration, rollback returns schema to prior state, migration runs idempotently.

### Step 4 — Add `update-config` template (T4, depends_on: [T1])

Covers env var additions, feature flag introductions, settings file changes. Key placeholders: `configKey`, `configPurpose`, `defaultValue`, `configFile`, `docsFile`.

Acceptance criteria must include: config has a documented default, missing config produces a clear error (not a silent undefined), docs updated.

### Step 5 — Add `add-documentation` template (T5, depends_on: [T1])

Covers README updates, inline JSDoc, architecture docs, runbooks. Key placeholders: `docTopic`, `targetAudience`, `docFile`, `primarySourceFile`.

Acceptance criteria must include: accurate (verified against current code), audience-appropriate (no undefined jargon for target reader), discoverable (linked from the right index).

### Step 6 — Add `upgrade-dependency` template (T6, depends_on: [T1])

Covers semver bumps, major version migrations. Key placeholders: `packageName`, `fromVersion`, `toVersion`, `breakingChanges`, `packageJsonFile`, `testCommand`.

Acceptance criteria: no breaking import paths, all existing tests pass, lock file committed.

### Step 7 — Add `add-cli-command` template (T7, depends_on: [T1])

Covers new subcommands in CLI tools. Key placeholders: `commandName`, `commandPurpose`, `flagSpec`, `implementationFile`, `testFile`.

Acceptance criteria: `--help` output is correct, all flags validate, integration test covers the primary invocation path.

### Step 8 — Add `add-type-definitions` template (T8, depends_on: [T1])

Covers TypeScript interface/type additions in shared type files. Key placeholders: `typeName`, `typeRole`, `typeFile`, `consumerFile`.

Acceptance criteria: type is exported from the right barrel, no `any` usage in the new types, consumer file compiles without changes.

### Step 9 — Add `extract-module` template (T9, depends_on: [T1])

Covers splitting a large file or class into a focused module. Key placeholders: `sourceModule`, `extractedName`, `extractionReason`, `sourceFile`, `newFile`.

Acceptance criteria: external API of `sourceModule` unchanged, new module has its own tests, no circular imports introduced.

### Step 10 — Add `add-integration` template (T10, depends_on: [T1])

Covers third-party API integrations. Key placeholders: `serviceName`, `integrationPurpose`, `authMechanism`, `implementationFile`, `mockFile`.

Acceptance criteria: auth errors produce clear messages, mock used in tests (not live API), integration is feature-flagged or gracefully degraded when service is unavailable.

### Step 11 — Update `formatTemplatesForPrompt` for richer agent guidance (T11, depends_on: [T2..T10])

The current implementation formats each template as a single line:
```
- add-api-endpoint: Create a new endpoint... Placeholders: endpointPath, moduleName, ...
```

Upgrade to a two-line format per template:
```
- add-api-endpoint: Create a new endpoint with validation, error handling, and tests.
  Placeholders: endpointPath (required), moduleName (required), httpMethod (required), implementationFile (required), testFile (required)
```

This gives agents enough to match a template without reading the full template definition, while still showing required vs optional.

**File:** `mcp-server/src/bead-templates.ts:181`

### Step 12 — Build verification (T12, depends_on: [T11])

Run `cd mcp-server && npm run build` and confirm zero TypeScript errors. All new templates must satisfy the `BeadTemplate` interface in `types.ts:237`.

---

## 4. Ergonomic Improvements

### 4.1 Naming Conventions

**Template IDs** should follow `verb-noun` pattern: `add-*`, `fix-*`, `update-*`, `extract-*`, `upgrade-*`. This is consistent with existing IDs and makes the list naturally sorted and scannable.

**Placeholder names** must be camelCase and describe the semantic role, not the syntax:
- Bad: `file` — is this the source? the test? the output?
- Good: `implementationFile`, `testFile`, `migrationFile`

**Placeholder descriptions** must answer "what does this value represent in the generated bead?" not "what format does this value take?"

### 4.2 Inline Documentation

Add a block comment above `BUILTIN_TEMPLATES` with:
1. The five-block narrative pattern all `descriptionTemplate` strings must follow
2. How `formatTemplatesForPrompt` uses the `summary` and `placeholders` fields
3. How `expandTemplate` validates required placeholders and resolves `{{name}}` markers
4. A checklist for adding a new template (the "contributing a template" guide)

### 4.3 Helper Function: `defineTemplate`

Introduce a typed factory function to validate template shape at definition time:

```typescript
function defineTemplate(template: BeadTemplate): BeadTemplate {
  // Validate that descriptionTemplate references exactly the placeholders defined
  const usedNames = new Set(
    Array.from(template.descriptionTemplate.matchAll(PLACEHOLDER_PATTERN)).map(m => m[1])
  );
  const definedNames = new Set(template.placeholders.map(p => p.name));
  const orphaned = [...usedNames].filter(n => !definedNames.has(n));
  const unused = [...definedNames].filter(n => !usedNames.has(n));
  if (orphaned.length > 0 || unused.length > 0) {
    throw new Error(
      `Template "${template.id}" has mismatched placeholders.\n` +
      (orphaned.length > 0 ? `  Used but not defined: ${orphaned.join(', ')}\n` : '') +
      (unused.length > 0 ? `  Defined but not used: ${unused.join(', ')}\n` : '')
    );
  }
  return template;
}
```

This runs at module load time and catches template authoring errors immediately — before any agent call reaches `expandTemplate`. It is the ergonomic equivalent of a compile-time check for template consistency.

### 4.4 Pattern Consistency: `acceptanceCriteria` vs `descriptionTemplate` Criteria

Currently the `acceptanceCriteria` array and the `- [ ]` lines in `descriptionTemplate` are separate and can drift. The ergonomic contract should be:
- `descriptionTemplate` `- [ ]` lines are the *bead-facing* criteria (filled with placeholder values, agent-readable)
- `acceptanceCriteria` is the *template-level* summary used for validation tooling

Both must exist, but they serve different consumers. Document this distinction in the inline docs added in T1.

### 4.5 `examples` Array Population

Currently `add-tests` has an example but it mirrors the template description almost verbatim. Examples should show a *different domain* than the placeholders to demonstrate transferability. Each new template must include at least one example from a domain different from the placeholder examples (e.g., if placeholder examples use `users`, the `examples` entry should use `payments` or `notifications`).

---

## 5. Maintenance Guidelines

### How to Add a New Bead Type

1. **Pick an ID** following `verb-noun` (e.g., `send-notification`, `archive-records`)
2. **Write the `descriptionTemplate`** following the five-block pattern (lead sentence → why → acceptance criteria → files)
3. **Define placeholders** — one per `{{marker}}` in the template, required unless the marker has a sensible omission behavior
4. **Populate `acceptanceCriteria`** — at least 3 items, each independently verifiable
5. **Set `filePatterns`** — use the narrowest glob that covers the typical file scope for this bead type
6. **Write `dependencyHints`** — name what this bead typically unblocks and what it typically depends on
7. **Add one `examples` entry** — pick a domain different from the placeholder examples
8. **Wrap with `defineTemplate()`** — catches placeholder mismatches at load time
9. **Run `npm run build`** — zero errors required before commit

### Quality Checklist for Template PRs

- [ ] Template ID follows `verb-noun` convention
- [ ] `descriptionTemplate` contains `### Files:` and `- [ ]` acceptance criteria blocks
- [ ] All `{{markers}}` in `descriptionTemplate` have a matching entry in `placeholders`
- [ ] No `{{marker}}` in `placeholders` is absent from `descriptionTemplate`
- [ ] `examples[0].description` uses a different domain than the placeholder examples
- [ ] `dependencyHints` is populated
- [ ] `defineTemplate()` wrapper used
- [ ] Build passes

### When to Split a Template vs Extend an Existing One

- **Split** when the new bead type has a fundamentally different acceptance pattern (e.g., a migration bead needs rollback criteria; an API endpoint bead does not)
- **Extend** (add optional placeholders) when the variant is 80%+ the same and the difference is additive (e.g., adding an optional `authMiddleware` placeholder to `add-api-endpoint`)
- **Do not** create a template for work that happens fewer than ~3 times per typical orchestration session — custom beads are fine for rare work

---

## 6. Dependency Graph

```
T1  Document canonical pattern       depends_on: []
T2  Add fix-bug template             depends_on: [T1]
T3  Add add-migration template       depends_on: [T1]
T4  Add update-config template       depends_on: [T1]
T5  Add add-documentation template   depends_on: [T1]
T6  Add upgrade-dependency template  depends_on: [T1]
T7  Add add-cli-command template     depends_on: [T1]
T8  Add add-type-definitions template depends_on: [T1]
T9  Add extract-module template      depends_on: [T1]
T10 Add add-integration template     depends_on: [T1]
T11 Upgrade formatTemplatesForPrompt depends_on: [T2, T3, T4, T5, T6, T7, T8, T9, T10]
T12 Build verification               depends_on: [T11]
```

T2–T10 are all parallelizable once T1 is complete. T11 depends on all of T2–T10 (to include all templates in the prompt formatter). T12 gates the entire implementation.

**Critical path:** T1 → T2 (or any of T2–T10) → T11 → T12 (4 hops, but T2–T10 can all run in parallel after T1)
