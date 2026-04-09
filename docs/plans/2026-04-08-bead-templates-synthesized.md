# Synthesized Plan: Complete Bead Template Stubs

**Date:** 2026-04-08
**Synthesized from:** Correctness, Ergonomics, and Robustness perspectives

---

## 1. Executive Summary

The `mcp-server/src/bead-templates.ts` module ships only 3 built-in templates (`add-api-endpoint`, `refactor-module`, `add-tests`), leaving the most common bead types -- bug fixes, documentation, performance work, configuration changes, and integrations -- without structural guidance. Agents producing these bead types must improvise descriptions from scratch, leading to inconsistent quality and frequent failures in the `validateBeads()` hygiene checks.

This plan adds **5 new templates**, a **startup integrity validator**, and targeted **robustness guards** to the template pipeline. The template set grows from 3 to 8, covering the core `IdeaCategory` taxonomy and the most common `Bead.type` values.

### Key Decisions

1. **5 templates, not 9.** The ergonomics plan proposed 9 new templates; the correctness plan proposed 5. We go with 5. Templates for `add-migration`, `upgrade-dependency`, `add-cli-command`, `add-type-definitions`, and `extract-module` are deferred -- they are either too project-specific (migrations), overlap heavily with existing templates (extract-module ~ refactor-module), or occur infrequently enough that custom bead descriptions serve well. This keeps the template list scannable in `formatTemplatesForPrompt()` output and avoids template sprawl.

2. **`defineTemplate()` wrapper adopted.** The ergonomics plan's `defineTemplate()` factory function catches placeholder mismatches at module-load time. This is strictly better than relying on runtime `expandTemplate()` calls to surface authoring bugs. Combined with the robustness plan's `validateTemplateIntegrity()`, this gives us two layers: compile-time type checking via `BeadTemplate` interface + load-time cross-reference validation via `defineTemplate()`.

3. **No `security-hardening` template.** The correctness plan argued (correctly) that security fixes overlap with `fix-bug` and a dedicated template risks giving agents false confidence about security completeness. Security work should use `fix-bug` with security-specific acceptance criteria, or custom bead descriptions.

4. **No `formatTemplatesForPrompt()` format change.** The ergonomics plan proposed a two-line format. The current one-line format is adequate for 8 templates and changing it would touch `prompts.ts` consumers unnecessarily. Revisit if the template count exceeds 12.

5. **Startup validation: warn, don't throw.** The robustness plan's approach is correct -- log warnings so the server always starts, even if a template has issues. This is the right trade-off for a development tool.

6. **No `expandTemplateStrict()`.** The robustness plan proposed a throwing wrapper. Current callers all use the discriminated union correctly, and TypeScript enforces checking at compile time. Adding a throwing variant creates two APIs to maintain with no current consumer. Deferred.

7. **No bead-type-to-template mapping (`getTemplateForBeadType()`).** The robustness plan proposed this advisory function. Templates are presented to agents via `formatTemplatesForPrompt()` and agents choose based on context. A hardcoded mapping (e.g., `task -> add-api-endpoint`) would encode assumptions that don't generalize. Deferred.

---

## 2. Bead Type Taxonomy

### Current Coverage

| Template ID | Bead Types Covered | IdeaCategory |
|---|---|---|
| `add-api-endpoint` | feature (narrow: API endpoints) | feature |
| `refactor-module` | refactor | refactor |
| `add-tests` | testing | testing |

### New Templates

| Template ID | Bead Types Covered | IdeaCategory | Why Needed |
|---|---|---|---|
| `fix-bug` | bug, fix | reliability | Most common bead type. Agents need structure for: reproduction, root cause, regression test. |
| `add-documentation` | docs | docs | Documentation beads need audience, location, and source-file cross-reference. |
| `improve-performance` | performance | performance | Performance work needs measurable baselines, goals, and benchmark artifacts. |
| `add-integration` | feature (integration) | feature | Integration beads need both systems identified, interface contract, error handling at boundary. |
| `update-configuration` | config, dx | dx | Configuration changes need validation, migration notes, and rollback awareness. |

### Templates Explicitly Deferred

| Candidate | Reason for Deferral |
|---|---|
| `add-migration` | Too project-specific; migration tooling varies widely. Custom descriptions serve better. |
| `upgrade-dependency` | Low frequency per orchestration session; semver bump shape is simple enough for custom descriptions. |
| `add-cli-command` | This orchestrator's CLI commands are a specialized concern; a generic CLI template wouldn't generalize. |
| `add-type-definitions` | Type-only work is usually part of a broader feature/refactor bead, not standalone. |
| `extract-module` | Overlaps 80%+ with `refactor-module`; the different acceptance criteria don't justify a separate template. |
| `security-hardening` | Overlaps with `fix-bug`; a dedicated template risks false confidence about security completeness. |
| `add-feature` (generic) | Too generic to template usefully. `add-api-endpoint` covers the most common concrete feature shape. |

---

## 3. Template Design

### Canonical `descriptionTemplate` Structure

All templates (existing and new) follow this five-block narrative pattern:

```
{{leadSentence — what is being done and where}}

Why this bead exists:
- {{rationale line 1}}
- {{rationale line 2}}

Acceptance criteria:
- [ ] {{criterion 1}}
- [ ] {{criterion 2}}
- [ ] {{criterion 3}}

### Files:
- {{primaryFile}}
- {{secondaryFile}}
```

**Why this pattern:**
- `validateBeads()` scans for `### Files:` and `- [ ]` -- the template bakes both in.
- "Why this bead exists" gives a fresh agent context without consulting the original goal.
- The lead sentence maps to the `summary` field shown in `formatTemplatesForPrompt()`.

### Placeholder Conventions

- **Names:** camelCase, descriptive of semantic role, no abbreviations. Good: `implementationFile`, `testFile`, `bugSummary`. Bad: `file`, `desc`, `impl`.
- **Descriptions:** Explain the *role*, not the *format*. "File containing the defect" not "A string path".
- **Examples:** Concrete and domain-specific. "crash when user list is empty" not "bug description".
- **Required:** All placeholders used in `descriptionTemplate` must be `required: true`. Optional placeholders that appear in the template would leave `{{name}}` markers if omitted, which fails hygiene checks.

### `examples` Array Contract

Each template must have at least one example. The example's `description` must:
1. Be fully expanded (zero `{{...}}` tokens)
2. Use a **different domain** than the placeholder examples to demonstrate transferability
3. Include `### Files:` with paths using recognized prefixes (`src/`, `lib/`, `test/`, `tests/`, `docs/`)
4. Include >= 3 `- [ ]` acceptance criteria lines

### `acceptanceCriteria` vs Template `- [ ]` Lines

These serve different consumers:
- `descriptionTemplate` `- [ ]` lines are **bead-facing**: filled with placeholder values, read by the executing agent
- `acceptanceCriteria` array is **template-level**: used by validation tooling and shown in template metadata

Both must exist and be aligned in intent, but they are not required to be identical text.

---

## 4. Implementation Tasks

### T1: Add `defineTemplate()` factory and startup validation

**Description:** Introduce a `defineTemplate()` wrapper function that validates placeholder cross-references at module-load time, and a `validateTemplateIntegrity()` function that checks for duplicate IDs, ID format, description length, and acceptance criteria presence. Wrap all existing templates with `defineTemplate()`. Log warnings on integrity failures; never throw.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**What to implement:**

```typescript
function defineTemplate(template: BeadTemplate): BeadTemplate {
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

Also add `validateTemplateIntegrity()` that checks:
1. All IDs unique
2. IDs match `/^[a-z][a-z0-9-]*$/`
3. `descriptionTemplate` >= 50 chars
4. `acceptanceCriteria` non-empty
5. Required placeholders appear in `descriptionTemplate`
6. `descriptionTemplate` placeholders have matching entries in `placeholders[]`
7. Non-required placeholders used in `descriptionTemplate` produce a warning (since omission would leave raw markers)

Call at module level, log warnings, export the warnings array for test assertions.

Wrap all 3 existing templates with `defineTemplate()`.

**Acceptance criteria:**
- `defineTemplate()` throws at load time if any placeholder name mismatch exists
- `validateTemplateIntegrity()` returns warnings array; warnings are logged to console.warn
- All 3 existing templates pass both checks without warnings
- Exported `TEMPLATE_INTEGRITY_WARNINGS` array is available for test assertions

`depends_on: []`

---

### T2: Add `fix-bug` template

**Description:** Add the `fix-bug` template to `BUILTIN_TEMPLATES`, covering the most common bead type. The template requires root cause analysis and a regression test, not just symptom description.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**Template specification:**

- **id:** `fix-bug`
- **label:** `Fix bug`
- **summary:** `Diagnose and fix a specific defect with a regression test.`
- **Placeholders (all required):**
  - `bugSummary` -- Short name for the bug (used in commit messages and test names). Example: `"crash when user list is empty"`
  - `moduleName` -- Module or function where the defect lives. Example: `"readyBeads filter logic"`
  - `bugSymptom` -- Observable symptom: what the user or system experiences. Example: `"br ready crashes with TypeError on repos with no open beads"`
  - `implementationFile` -- File containing the defect. Example: `"src/beads.ts"`
  - `testFile` -- Test file for the regression test. Example: `"src/beads.test.ts"`
- **acceptanceCriteria:**
  - `"Write a failing test that reproduces the bug before changing implementation code."`
  - `"Apply the minimal code change that makes the test pass without regressing other tests."`
  - `"Leave a comment in the test explaining what scenario it covers."`
- **filePatterns:** `["src/**/*.ts", "src/**/*.test.ts"]`
- **dependencyHints:** `"fix-bug beads are usually independent. If the bug is in shared infrastructure, other beads that use that infrastructure should depend on this one."`
- **examples:** One fully-expanded example using a *different domain* than placeholders (e.g., a payment processing null-check bug)

**Acceptance criteria:**
- Template passes `defineTemplate()` without throwing
- Template passes `validateTemplateIntegrity()` without warnings
- Example description contains zero `{{...}}` tokens
- Example includes `### Files:` and >= 3 `- [ ]` lines

`depends_on: [T1]`

---

### T3: Add `add-documentation` template

**Description:** Add the `add-documentation` template covering docs-type beads. Requires target audience and source-file cross-reference.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**Template specification:**

- **id:** `add-documentation`
- **label:** `Add documentation`
- **summary:** `Write or update documentation for a feature or API.`
- **Placeholders (all required):**
  - `docTopic` -- What is being documented. Example: `"bead template expansion API"`
  - `targetAudience` -- Who will read this. Example: `"developers adding new bead templates"`
  - `docFile` -- Primary documentation file. Example: `"docs/templates.md"`
  - `primarySourceFile` -- Source code being documented. Example: `"src/bead-templates.ts"`
- **acceptanceCriteria:**
  - `"Documentation accurately reflects the current implementation."`
  - `"Include at least one usage example or code snippet."`
  - `"Write for the specified target audience without assuming undocumented context."`
- **filePatterns:** `["docs/**/*.md", "*.md", "src/**/*.ts"]`
- **dependencyHints:** `"Documentation beads usually depend on the implementation bead they document. Create the implementation first, then the documentation."`
- **examples:** Fully-expanded example from a different domain (e.g., documenting the scan pipeline for new contributors)

**Acceptance criteria:**
- Template passes `defineTemplate()` and `validateTemplateIntegrity()`
- `filePatterns` includes both docs and source directories
- Example uses a different domain than placeholder examples

`depends_on: [T1]`

---

### T4: Add `improve-performance` template

**Description:** Add the `improve-performance` template for performance-type beads. Requires measurable baseline, target, and approach.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**Template specification:**

- **id:** `improve-performance`
- **label:** `Improve performance`
- **summary:** `Optimize a slow path with measurable before/after evidence.`
- **Placeholders (all required):**
  - `targetArea` -- Module or function being optimized. Example: `"plan-to-bead token overlap scoring"`
  - `currentBehavior` -- Current performance baseline. Example: `"scoring 50 beads against a 20-section plan takes 4s"`
  - `performanceGoal` -- Target improvement. Example: `"complete scoring in under 500ms"`
  - `optimizationApproach` -- Planned approach. Example: `"pre-compute section token sets and use set intersection"`
  - `implementationFile` -- Primary source file. Example: `"src/beads.ts"`
  - `testFile` -- Test or benchmark file. Example: `"src/beads.bench.ts"`
- **acceptanceCriteria:**
  - `"Achieve the stated performance goal with measurable evidence."`
  - `"Add a benchmark or performance test to prevent future regressions."`
  - `"Preserve all existing behavior and passing tests."`
- **filePatterns:** `["src/**/*.ts", "src/**/*.test.ts", "src/**/*.bench.ts"]`
- **dependencyHints:** `"Performance beads should depend on the implementation bead that creates the code being optimized. Avoid parallelizing with beads that modify the same hot path."`
- **examples:** Fully-expanded example from a different domain

**Acceptance criteria:**
- Template requires both `currentBehavior` and `performanceGoal` (prevents vague "make it faster" beads)
- Template passes all validation checks

`depends_on: [T1]`

---

### T5: Add `add-integration` template

**Description:** Add the `add-integration` template for beads connecting two subsystems. Requires both systems identified, interface contract, and error handling.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**Template specification:**

- **id:** `add-integration`
- **label:** `Add integration`
- **summary:** `Connect two subsystems or services with error handling at the boundary.`
- **Placeholders (all required):**
  - `sourceSystem` -- System or module initiating the integration. Example: `"orchestrator planning phase"`
  - `targetSystem` -- System or module being integrated with. Example: `"MCP tool server"`
  - `integrationPurpose` -- Why these systems need to communicate. Example: `"pass approved beads to the tool server for agent execution"`
  - `interfaceContract` -- Expected interface or data contract. Example: `"BeadPayload JSON with id, description, and acceptanceCriteria fields"`
  - `implementationFile` -- Primary integration file. Example: `"src/server.ts"`
  - `testFile` -- Integration test file. Example: `"src/server.test.ts"`
- **acceptanceCriteria:**
  - `"Implement the integration following the specified interface contract."`
  - `"Handle errors at the integration boundary with clear error messages."`
  - `"Add an integration test covering the happy path and at least one failure mode."`
- **filePatterns:** `["src/**/*.ts", "src/**/*.test.ts"]`
- **dependencyHints:** `"Integration beads depend on the beads that implement both the source and target systems. They should be among the last beads to execute."`
- **examples:** Fully-expanded example from a different domain

**Acceptance criteria:**
- Template requires both `sourceSystem` and `targetSystem` (prevents one-sided integration descriptions)
- Template requires `interfaceContract` (prevents agents from inventing APIs)
- Template passes all validation checks

`depends_on: [T1]`

---

### T6: Add `update-configuration` template

**Description:** Add the `update-configuration` template for config/DX beads. Requires migration notes and validation.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**Template specification:**

- **id:** `update-configuration`
- **label:** `Update configuration`
- **summary:** `Add or modify configuration with validation and migration notes.`
- **Placeholders (all required):**
  - `configArea` -- What configuration is being changed. Example: `"MCP server transport settings"`
  - `changeReason` -- Why the configuration needs to change. Example: `"support both stdio and SSE transports"`
  - `migrationNotes` -- How existing environments should adapt. Example: `"existing stdio-only setups continue to work with no changes; SSE requires setting TRANSPORT=sse"`
  - `configFile` -- Primary configuration file. Example: `"src/config.ts"`
  - `validationFile` -- File where config validation lives. Example: `"src/config.test.ts"`
- **acceptanceCriteria:**
  - `"Add or update configuration with input validation for the new values."`
  - `"Document migration steps for existing environments."`
  - `"Ensure backwards compatibility or document breaking changes explicitly."`
- **filePatterns:** `["*.config.*", "*.json", "*.yaml", "*.yml", "*.toml", "src/**/*.ts"]`
- **dependencyHints:** `"Configuration beads are often prerequisites for feature beads that consume the new config. Other beads should depend on this one if they read the changed config."`
- **examples:** Fully-expanded example from a different domain

**Acceptance criteria:**
- Template requires `migrationNotes` (prevents breaking existing deployments silently)
- Template passes all validation checks

`depends_on: [T1]`

---

### T7: Harden `formatTemplatesForPrompt()` with empty-list guard

**Description:** Add a guard to `formatTemplatesForPrompt()` that returns a meaningful fallback string if `BUILTIN_TEMPLATES` is accidentally empty. Also add a placeholder value max-length guard to `validatePlaceholderValues()`.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**What to implement:**

1. Empty-list guard in `formatTemplatesForPrompt()`:
```typescript
if (BUILTIN_TEMPLATES.length === 0) {
  return "(No bead templates available — write custom bead descriptions.)";
}
```

2. Max-length guard in `validatePlaceholderValues()`:
```typescript
const MAX_PLACEHOLDER_VALUE_LENGTH = 2000;
// Add length check after the existing INVALID_VALUE_PATTERN check
if (value.length > MAX_PLACEHOLDER_VALUE_LENGTH) {
  return `Placeholder value for ${name} is too long (${value.length} chars, max ${MAX_PLACEHOLDER_VALUE_LENGTH}).`;
}
```

**Acceptance criteria:**
- `formatTemplatesForPrompt()` returns a fallback string when template list is empty
- `validatePlaceholderValues()` rejects values exceeding 2000 characters
- Both changes are minimal and do not alter happy-path behavior

`depends_on: []`

---

### T8: Add inline documentation for template authoring

**Description:** Add a JSDoc block comment above `BUILTIN_TEMPLATES` explaining the five-block `descriptionTemplate` pattern, placeholder naming conventions, the contract between `descriptionTemplate` and `formatTemplatesForPrompt()`, and a checklist for adding a new template.

**Files to modify:**
- `mcp-server/src/bead-templates.ts`

**Acceptance criteria:**
- Comment documents the five-block narrative pattern
- Comment includes a "How to add a new template" checklist
- Comment explains `acceptanceCriteria` vs `descriptionTemplate` `- [ ]` lines distinction

`depends_on: []`

---

### T9: Build verification and consistency check

**Description:** Run `cd mcp-server && npm run build` and verify:
1. Zero TypeScript compilation errors
2. `BUILTIN_TEMPLATES` contains exactly 8 templates (3 existing + 5 new)
3. All templates pass `defineTemplate()` without throwing
4. All templates pass `validateTemplateIntegrity()` with zero warnings
5. Every example description contains zero `{{...}}` tokens
6. Every example includes `### Files:` and >= 3 `- [ ]` lines
7. `formatTemplatesForPrompt()` produces 8 coherent one-line entries

**Files to modify:** None (verification only)

**Acceptance criteria:**
- `npm run build` exits 0
- All consistency checks pass

`depends_on: [T1, T2, T3, T4, T5, T6, T7, T8]`

---

## 5. Robustness Guards

### Startup Validation (T1)

| Check | Behavior on Failure |
|---|---|
| Duplicate template ID | Log warning, both templates remain (first wins in `getTemplateById`) |
| Invalid ID format | Log warning, template still usable |
| Placeholder cross-reference mismatch (in `defineTemplate`) | **Throw** -- this is a programming bug that must be fixed before the server can start |
| Short `descriptionTemplate` | Log warning |
| Empty `acceptanceCriteria` | Log warning |
| Non-required placeholder in `descriptionTemplate` | Log warning (expansion will fail if omitted) |

### Runtime Validation (T7)

| Check | Behavior on Failure |
|---|---|
| Placeholder value contains `\r` or `\0` | Return `{ success: false, error }` |
| Placeholder value exceeds 2000 chars | Return `{ success: false, error }` |
| Unknown template ID | Return `{ success: false, error }` |
| Missing required placeholders | Return `{ success: false, error }` with hint about extra keys |
| Unresolved placeholders after expansion | Return `{ success: false, error }` |

### Degenerate State Handling (T7)

| State | Handling |
|---|---|
| Empty `BUILTIN_TEMPLATES` | `formatTemplatesForPrompt()` returns fallback string |
| Template with no examples | Allowed by type system; no special handling needed |

### Deferred Robustness Items

These were proposed in the robustness plan but deferred for complexity/value reasons:

- **`expandTemplateStrict()`:** No current caller needs it. TypeScript's discriminated union already prevents misuse at compile time.
- **`getTemplateForBeadType()` mapping:** Encodes assumptions that don't generalize. Templates are presented to agents who choose based on context.
- **`preflightTemplate()` hygiene pre-flight:** Valuable but can be added later as a test-time assertion rather than a runtime check. The `defineTemplate()` cross-reference check catches the most common authoring bugs.
- **Deep clone in `cloneTemplate()`:** Not needed until `BeadTemplatePlaceholder` gains nested objects. Current shallow spread is correct.

---

## 6. Ergonomic Guidelines

### Naming Conventions

- **Template IDs:** `verb-noun` kebab-case. Examples: `fix-bug`, `add-documentation`, `improve-performance`. Match `/^[a-z][a-z0-9-]*$/`.
- **Placeholder names:** camelCase, semantic role, no abbreviations. `implementationFile` not `implFile`.
- **Placeholder descriptions:** Explain the role, not the format. "File containing the defect" not "A path string".

### How to Add a New Bead Template

1. Pick a `verb-noun` ID following existing conventions
2. Write the `descriptionTemplate` following the five-block pattern (lead sentence, why, acceptance criteria, files)
3. Define one placeholder per `{{marker}}` in the template; all must be `required: true` if used in the template
4. Populate `acceptanceCriteria` with at least 3 specific, verifiable items
5. Set `filePatterns` to the narrowest globs that cover the typical file scope
6. Write `dependencyHints` naming what this bead typically unblocks and depends on
7. Add one example using a different domain than the placeholder examples
8. Wrap with `defineTemplate()` -- catches placeholder mismatches at load time
9. Run `npm run build` -- zero errors required

### When to Create a Template vs Use Custom Descriptions

- **Create a template** when the bead shape occurs 3+ times per typical orchestration session and has consistent structural requirements
- **Use custom descriptions** for rare, project-specific, or highly variable work
- **Do not** create a template that would be too vague to provide meaningful structure (e.g., a generic "add feature" template)

---

## 7. Trade-off Notes

### Template Count: 5 vs 9

**Conflict:** Ergonomics plan proposed 9 templates; correctness plan proposed 5.

**Resolution:** 5 templates. The additional 4 from the ergonomics plan (`add-migration`, `upgrade-dependency`, `add-cli-command`, `add-type-definitions`) are either too project-specific or low-frequency. The ergonomics plan's `extract-module` overlaps with `refactor-module`. Template sprawl works against the ergonomic goal of a scannable template list.

**Trade-off:** Slightly less coverage for niche bead types, but agents can always write custom descriptions. The 5 chosen templates cover the highest-frequency bead types.

### `defineTemplate()` + `validateTemplateIntegrity()` vs Just One

**Conflict:** Ergonomics plan proposed `defineTemplate()` (throw on mismatch); robustness plan proposed `validateTemplateIntegrity()` (warn on all issues).

**Resolution:** Both. They serve complementary roles. `defineTemplate()` catches the highest-severity bug (placeholder mismatch) with a hard throw at load time -- this is a programming error that must be fixed. `validateTemplateIntegrity()` catches softer issues (duplicate IDs, short descriptions, empty criteria) with warnings that don't prevent the server from starting.

### `security-hardening` Template

**Conflict:** Robustness plan included it; correctness plan explicitly rejected it.

**Resolution:** Rejected, per the correctness plan's reasoning. A security template gives agents false confidence about security completeness. Security work should use `fix-bug` with security-specific acceptance criteria, or custom descriptions reviewed by a human.

### `formatTemplatesForPrompt()` Format

**Conflict:** Ergonomics plan proposed two-line format; correctness and robustness plans used existing one-line format.

**Resolution:** Keep one-line format. At 8 templates, the list is still scannable. A format change would require updating prompts.ts integration tests and is unnecessary churn.

### Template ID: `add-docs` vs `add-documentation`

**Conflict:** Robustness plan used `add-docs`; correctness and ergonomics plans used `add-documentation`.

**Resolution:** `add-documentation`. Consistency with existing `verb-noun` pattern (full nouns, not abbreviations). Matches `IdeaCategory` value `"docs"` closely enough while being more descriptive.

### Template ID: `update-config` vs `update-configuration`

**Conflict:** Ergonomics plan used `update-config`; correctness plan used `update-configuration`.

**Resolution:** `update-configuration`. Same reasoning as above -- full nouns for clarity.

---

## 8. Dependency Graph

```
T1  defineTemplate() + startup validation       depends_on: []
T7  Robustness guards (empty-list, max-length)  depends_on: []
T8  Inline documentation                        depends_on: []

T2  Add fix-bug template                        depends_on: [T1]
T3  Add add-documentation template              depends_on: [T1]
T4  Add improve-performance template            depends_on: [T1]
T5  Add add-integration template                depends_on: [T1]
T6  Add update-configuration template           depends_on: [T1]

T9  Build verification + consistency check      depends_on: [T1, T2, T3, T4, T5, T6, T7, T8]
```

### Execution Waves

```
Wave 1 (parallel):  T1, T7, T8
Wave 2 (parallel):  T2, T3, T4, T5, T6  (all depend only on T1)
Wave 3 (serial):    T9                    (depends on everything)
```

### Critical Path

```
T1 → T2 (or any of T2-T6) → T9
```

3 hops. T2-T6 are fully parallel after T1. T7 and T8 are independent and can run in Wave 1 alongside T1.
