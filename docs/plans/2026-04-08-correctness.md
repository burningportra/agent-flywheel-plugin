# Correctness Plan: Complete Bead Template Stubs

## 1. Problem Statement

`mcp-server/src/bead-templates.ts` defines a `BUILTIN_TEMPLATES` array that currently contains only **3 templates**:

| ID | Covers |
|---|---|
| `add-api-endpoint` | Creating a new API endpoint with validation and tests |
| `refactor-module` | Restructuring an existing module while preserving behavior |
| `add-tests` | Adding missing test coverage for existing behavior |

The `Bead.type` field (`types.ts:166`) is a free-form string documented as `"task" | "feature" | "bug" etc.`, and the `IdeaCategory` type (`types.ts:283-291`) enumerates eight categories: `feature`, `refactor`, `docs`, `dx`, `performance`, `reliability`, `security`, `testing`.

The orchestrator's bead-creation prompts (`prompts.ts:295-321`, `prompts.ts:414-419`) present the template library via `formatTemplatesForPrompt()` as **optional shortcuts** for common bead shapes. Templates are never required -- agents can always write custom bead descriptions -- but having templates for common patterns:

1. **Reduces hallucination risk**: agents follow a proven structure instead of improvising field names and acceptance criteria.
2. **Enables template hygiene enforcement**: `beads.ts:454-519` already validates that beads don't contain raw template markers, unresolved `{{placeholders}}`, or `[Use template: ...]` shorthand. More templates give agents more structural starting points, reducing the likelihood of shallow/underspecified beads.
3. **Improves plan-to-bead audit quality**: `auditPlanToBeads()` (`beads.ts:80-116`) scores section-to-bead token overlap. Templates with well-chosen keywords improve matching.

The gap: the 3 existing templates cover only `add-api-endpoint` (a narrow feature type), `refactor-module`, and `add-tests`. There are no templates for:
- **Bug fixes** (the most common bead type in practice)
- **Documentation** changes
- **Configuration/infrastructure** changes
- **Data migration** or schema changes
- **Performance** improvements
- **Integration** work (connecting two subsystems)

This plan addresses completing the template library with correctness as the primary lens.

## 2. Bead Type Taxonomy

### 2.1 Type System Constraints

The `BeadTemplate` interface (`types.ts:237-247`) requires:

```typescript
interface BeadTemplate {
  id: string;                           // kebab-case identifier
  label: string;                        // human-readable label
  summary: string;                      // one-line description
  descriptionTemplate: string;          // mustache-style {{placeholder}} template
  placeholders: BeadTemplatePlaceholder[]; // each: name, description, example, required
  acceptanceCriteria: string[];         // array of criteria strings
  filePatterns: string[];               // glob patterns for relevant files
  dependencyHints?: string;            // optional guidance on inter-bead deps
  examples: BeadTemplateExample[];     // each: { description: string }
}
```

Key constraints from the type system:
- `placeholders[].name` must match `{{name}}` tokens in `descriptionTemplate` (enforced by `expandTemplate()` at `bead-templates.ts:197-233`)
- `placeholders[].required` controls validation -- required placeholders that are empty/missing cause `expandTemplate()` to return `{ success: false, error: ... }`
- The `PLACEHOLDER_PATTERN` (`bead-templates.ts:159`) is `/{{\s*([a-zA-Z0-9_]+)\s*}}/g` -- placeholder names must be alphanumeric + underscores only
- The `INVALID_VALUE_PATTERN` (`bead-templates.ts:160`) rejects values containing `\r` or `\0`
- `examples[].description` must be a fully-expanded version of `descriptionTemplate` with all placeholders resolved -- this is what `prompts.ts` shows as the canonical expanded form

### 2.2 Consumption Points

Templates are consumed in three ways:

1. **`formatTemplatesForPrompt()`** (`bead-templates.ts:181-185`): Renders a one-line summary per template: `- {id}: {summary} Placeholders: {names}`. Used in `beadCreationPrompt()` and `planToBeadsPrompt()` in `prompts.ts`.

2. **`expandTemplate()`** (`bead-templates.ts:197-233`): Takes a template ID + placeholder values, validates required fields, substitutes all `{{name}}` tokens, and checks for unresolved placeholders. Returns `{ success: true, description }` or `{ success: false, error }`.

3. **`listBeadTemplates()` / `getTemplateById()`**: Return cloned template objects for programmatic access. Used for potential future tooling (not currently called from MCP tools, but part of the public API).

### 2.3 Template Hygiene Validation

`validateBeads()` (`beads.ts:371-525`) checks open beads for:
- `raw-template-marker`: lines starting with `[use template:` (case-insensitive)
- `template-shorthand`: lines like `see template` or `use the template`
- `unresolved-placeholder`: `{{word}}` or `<UPPER_CASE_WORD>` patterns
- `template-missing-structure`: template artifacts present but missing `### Files:` or < 2 acceptance criteria

These checks mean every template we add must produce descriptions that **pass** these hygiene checks when fully expanded.

### 2.4 Templates to Add

Based on the `IdeaCategory` taxonomy, `Bead.type` conventions, and the patterns seen in `beadCreationPrompt()` / `planToBeadsPrompt()`, the following templates should be added:

| Template ID | Maps to | Why Needed |
|---|---|---|
| `fix-bug` | bug fixes | Most common bead type. Agents need structure for: reproduction steps, root cause, fix description, regression test. |
| `add-documentation` | docs changes | IdeaCategory "docs". Documentation beads need different structure: what to document, audience, location. |
| `improve-performance` | performance work | IdeaCategory "performance". Needs: baseline metric, target, approach, measurement plan. |
| `add-integration` | connecting subsystems | Common in multi-bead plans. Needs: systems being connected, interface contract, error handling at boundary. |
| `update-configuration` | infra/config changes | DX/reliability work. Needs: what config, why, migration path, rollback plan. |

Templates **NOT** recommended (correctness rationale):
- **`add-feature`**: Too generic. The existing `add-api-endpoint` is a concrete feature template; other features are too varied to template without hallucinating structure. Custom bead descriptions serve better.
- **`security-fix`**: Overlaps heavily with `fix-bug`. Security-specific templates risk giving agents false confidence about security completeness. Better handled as a `fix-bug` with security-specific acceptance criteria.
- **`data-migration`**: Very project-specific. A template would either be too vague or impose assumptions about migration tooling.

## 3. Implementation Steps

### T1: Define `fix-bug` template

**File:** `mcp-server/src/bead-templates.ts`
**What:** Add a `fix-bug` entry to `BUILTIN_TEMPLATES` array (after the `add-tests` entry, before the closing `]`).

**Template structure:**

```
id: "fix-bug"
label: "Fix bug"
summary: "Diagnose and fix a bug with a regression test."
```

**Placeholders (all required):**
- `bugSummary`: One-line description of the bug
- `reproductionSteps`: How to reproduce the issue
- `affectedArea`: Module or feature area where the bug manifests
- `rootCause`: Known or suspected root cause
- `implementationFile`: Primary source file to fix
- `testFile`: Test file for the regression test

**descriptionTemplate must include:**
- Bug summary and reproduction steps (critical for agent context)
- Root cause section (prevents agents from applying surface-level patches)
- Acceptance criteria: fix the root cause, add regression test, verify no regressions
- `### Files:` section

**acceptanceCriteria:**
- "Fix the root cause described above, not just the symptom."
- "Add a regression test that fails before the fix and passes after."
- "Verify no existing tests are broken by the change."

**filePatterns:** `["src/**/*.ts", "src/**/*.test.ts"]`

**dependencyHints:** "Bug fix beads are usually independent unless they touch shared modules. If a fix changes a shared interface, downstream beads should depend on this one."

**examples:** One fully expanded example using concrete values (e.g., a null reference bug in a user lookup).

**Correctness constraints:**
- Every `{{placeholder}}` in the description template must have a matching entry in `placeholders[]`
- The example `description` must contain zero `{{...}}` tokens
- The example must include `### Files:` and at least 3 `- [ ]` acceptance criteria items (to pass template hygiene in `validateBeads`)

`depends_on: []`

---

### T2: Define `add-documentation` template

**File:** `mcp-server/src/bead-templates.ts`

**Template structure:**

```
id: "add-documentation"
label: "Add documentation"
summary: "Write or update documentation for a feature or API."
```

**Placeholders (all required):**
- `documentationSubject`: What is being documented
- `targetAudience`: Who will read this (e.g., "developers integrating the API", "end users")
- `documentationType`: Type of docs (e.g., "API reference", "getting started guide", "architecture overview")
- `documentationFile`: Primary documentation file to create or update
- `sourceFile`: Source code file being documented (for reference)

**descriptionTemplate must include:**
- What to document and why
- Target audience context (so the agent writes at the right level)
- Acceptance criteria: accuracy, completeness, examples
- `### Files:` section

**acceptanceCriteria:**
- "Documentation accurately reflects the current implementation."
- "Include at least one usage example or code snippet."
- "Write for the specified target audience without assuming undocumented context."

**filePatterns:** `["docs/**/*.md", "*.md", "src/**/*.ts"]`

**dependencyHints:** "Documentation beads usually depend on the implementation bead they document. Create the implementation first, then the documentation."

**Correctness constraints:**
- Same placeholder/expansion constraints as T1
- The `filePatterns` must include both docs and source directories since documentation beads reference source files

`depends_on: []`

---

### T3: Define `improve-performance` template

**File:** `mcp-server/src/bead-templates.ts`

**Template structure:**

```
id: "improve-performance"
label: "Improve performance"
summary: "Optimize a slow path with measurable before/after evidence."
```

**Placeholders (all required):**
- `targetArea`: Module or function being optimized
- `currentBehavior`: What the current performance looks like (e.g., "list rendering takes 3s for 1000 items")
- `performanceGoal`: Target improvement (e.g., "render in under 500ms")
- `optimizationApproach`: Planned approach (e.g., "add pagination and virtual scrolling")
- `implementationFile`: Primary source file to optimize
- `testFile`: Test or benchmark file

**descriptionTemplate must include:**
- Current baseline behavior (prevents agents from optimizing blindly)
- Measurable goal (prevents vague "make it faster" beads)
- Approach section
- Acceptance criteria: measurable improvement, no regression, benchmark
- `### Files:` section

**acceptanceCriteria:**
- "Achieve the stated performance goal with measurable evidence."
- "Add a benchmark or performance test to prevent future regressions."
- "Preserve all existing behavior and passing tests."

**filePatterns:** `["src/**/*.ts", "src/**/*.test.ts", "src/**/*.bench.ts"]`

**dependencyHints:** "Performance beads should depend on the implementation bead that creates the code being optimized. Avoid parallelizing with beads that modify the same hot path."

`depends_on: []`

---

### T4: Define `add-integration` template

**File:** `mcp-server/src/bead-templates.ts`

**Template structure:**

```
id: "add-integration"
label: "Add integration"
summary: "Connect two subsystems or services with error handling at the boundary."
```

**Placeholders (all required):**
- `sourceSystem`: System or module initiating the integration
- `targetSystem`: System or module being integrated with
- `integrationPurpose`: Why these systems need to communicate
- `interfaceContract`: Expected interface or data contract between systems
- `implementationFile`: Primary integration file
- `testFile`: Integration test file

**descriptionTemplate must include:**
- Both systems identified with their roles
- Interface contract (prevents agents from inventing APIs)
- Error handling at the boundary (integration points are where failures happen)
- Acceptance criteria: connectivity, error handling, integration test
- `### Files:` section

**acceptanceCriteria:**
- "Implement the integration following the specified interface contract."
- "Handle errors at the integration boundary with clear error messages."
- "Add an integration test covering the happy path and at least one failure mode."

**filePatterns:** `["src/**/*.ts", "src/**/*.test.ts"]`

**dependencyHints:** "Integration beads depend on the beads that implement both the source and target systems. They should be among the last beads to execute."

`depends_on: []`

---

### T5: Define `update-configuration` template

**File:** `mcp-server/src/bead-templates.ts`

**Template structure:**

```
id: "update-configuration"
label: "Update configuration"
summary: "Add or modify configuration with validation and migration notes."
```

**Placeholders (all required):**
- `configArea`: What configuration is being changed (e.g., "database connection settings")
- `changeReason`: Why the configuration needs to change
- `migrationNotes`: How existing users/environments should adapt
- `configFile`: Primary configuration file
- `validationFile`: File where config validation lives

**descriptionTemplate must include:**
- What config is changing and why
- Migration notes (critical for not breaking existing deployments)
- Acceptance criteria: validation, backwards compatibility, documentation
- `### Files:` section

**acceptanceCriteria:**
- "Add or update configuration with input validation for the new values."
- "Document migration steps for existing environments."
- "Ensure backwards compatibility or document breaking changes explicitly."

**filePatterns:** `["*.config.*", "*.json", "*.yaml", "*.yml", "*.toml", "src/**/*.ts"]`

**dependencyHints:** "Configuration beads are often prerequisites for feature beads that consume the new config. Other beads should depend on this one if they read the changed config."

`depends_on: []`

---

### T6: Verify all templates pass internal consistency checks

**File:** N/A (verification step)
**What:** After adding all 5 templates, verify:

1. **Build succeeds**: `cd mcp-server && npm run build` -- TypeScript compilation must pass, proving all templates satisfy the `BeadTemplate` interface.
2. **Placeholder consistency**: For each new template, manually verify that every `{{name}}` in `descriptionTemplate` has a matching entry in `placeholders[]` and vice versa.
3. **Example expansion**: For each new template, verify the `examples[].description` string contains zero `{{...}}` tokens.
4. **Hygiene pass**: Verify that expanded examples would pass the template hygiene checks in `validateBeads()`:
   - No `[Use template: ...]` markers
   - No `see template` or `use the template` lines
   - No `{{word}}` or `<UPPER_CASE>` tokens
   - Has `### Files:` section
   - Has >= 2 `- [ ]` acceptance criteria lines
5. **`formatTemplatesForPrompt()` output**: Verify the one-line summary for each template is useful for agent decision-making (includes meaningful placeholder names).

`depends_on: [T1, T2, T3, T4, T5]`

---

### T7: Build verification

**File:** N/A
**What:** Run `cd mcp-server && npm run build` and confirm zero errors.

`depends_on: [T6]`

## 4. Correctness Risks

### Risk 1: Placeholder name mismatch between descriptionTemplate and placeholders array

**Severity:** High (causes `expandTemplate()` to return unresolved placeholders or miss required validation)

**How it goes wrong:** A template has `{{implementationFile}}` in the description but lists the placeholder as `implFile` in the array, or vice versa.

**Mitigation:** 
- Use a consistent naming convention across all templates: camelCase, descriptive, no abbreviations
- T6 includes a manual cross-reference check
- The `expandTemplate()` function already catches unresolved placeholders at runtime, but catching at implementation time is better

### Risk 2: Example descriptions containing unresolved placeholders

**Severity:** Medium (examples are shown in prompts; unresolved placeholders confuse agents)

**How it goes wrong:** Copy-pasting the template and forgetting to substitute one placeholder in the example.

**Mitigation:**
- Write examples by hand from the expanded form, not by copy-pasting the template
- T6 includes a regex check for `{{...}}` in example descriptions

### Risk 3: Templates that fail hygiene validation when expanded

**Severity:** Medium (beads created from these templates would be flagged by `validateBeads()`)

**How it goes wrong:** A template produces a description that matches the `raw-template-marker`, `template-shorthand`, or `unresolved-placeholder` patterns in `beads.ts:474-509`.

**Mitigation:**
- Avoid any text in templates containing `[use template:`, `see template`, `use the template`
- Ensure `### Files:` section uses the exact heading format expected by `extractArtifacts()` (`beads.ts:292-316`): `### Files:` on its own line, followed by `- path/to/file` bullet lines
- Include >= 2 `- [ ]` acceptance criteria to avoid `template-missing-structure`

### Risk 4: Acceptance criteria that are vague or untestable

**Severity:** Medium (undermines the purpose of templates)

**How it goes wrong:** Criteria like "Code is clean" or "Everything works" -- not actionable for a sub-agent.

**Mitigation:**
- Each criterion must reference a concrete, verifiable action (run tests, measure performance, check file exists)
- Review each criterion against the question: "Could a CI check verify this?"

### Risk 5: `filePatterns` that don't match the `extractArtifacts()` regex

**Severity:** Low (filePatterns are informational, not used by extractArtifacts)

**How it goes wrong:** `extractArtifacts()` (`beads.ts:292-316`) only detects paths starting with `src/`, `lib/`, `test/`, `tests/`, `dist/`, `docs/`. If a template's `### Files:` section lists files outside these prefixes, they won't be detected for file-overlap checks.

**Mitigation:**
- All template examples should use paths starting with recognized prefixes
- Document in the template's `dependencyHints` if files outside standard prefixes are expected

### Risk 6: Template IDs colliding with future br CLI conventions

**Severity:** Low

**Mitigation:** Use descriptive kebab-case IDs that clearly describe the bead shape. The current convention (`add-api-endpoint`, `refactor-module`, `add-tests`) uses verb-noun patterns. New templates follow the same pattern.

## 5. Acceptance Criteria

For the overall task:

- [ ] `BUILTIN_TEMPLATES` array contains exactly 8 templates (3 existing + 5 new)
- [ ] All 5 new templates conform to the `BeadTemplate` TypeScript interface
- [ ] `npm run build` in `mcp-server/` succeeds with zero errors
- [ ] Every `{{placeholder}}` in each template's `descriptionTemplate` has a corresponding entry in `placeholders[]` with `name`, `description`, `example`, and `required: true`
- [ ] Every entry in `placeholders[]` is referenced at least once in `descriptionTemplate`
- [ ] Each template has exactly one entry in `examples[]` with a fully-expanded `description` (zero `{{...}}` tokens)
- [ ] Each template's example `description` includes a `### Files:` section with at least one file path
- [ ] Each template's example `description` includes at least 3 `- [ ]` acceptance criteria lines
- [ ] No template description or example contains text matching `validateBeads()` hygiene patterns: `[use template:`, `see template`, `use the template`, `{{word}}`
- [ ] `formatTemplatesForPrompt()` produces a coherent one-line entry for each of the 8 templates
- [ ] Each template's `acceptanceCriteria` array has at least 3 entries that are specific and verifiable
- [ ] Each template's `dependencyHints` field is present and provides actionable guidance

Per-template acceptance:

| Template | Key correctness check |
|---|---|
| `fix-bug` | Description requires root cause and regression test, not just symptom description |
| `add-documentation` | Description requires target audience and source file reference |
| `improve-performance` | Description requires measurable baseline and goal |
| `add-integration` | Description requires both systems and interface contract |
| `update-configuration` | Description requires migration notes and validation |

## 6. Dependency Graph

```
T1 (fix-bug)           depends_on: []
T2 (add-documentation) depends_on: []
T3 (improve-performance) depends_on: []
T4 (add-integration)   depends_on: []
T5 (update-configuration) depends_on: []
T6 (consistency verification) depends_on: [T1, T2, T3, T4, T5]
T7 (build verification) depends_on: [T6]
```

T1-T5 are fully parallel -- each template is an independent addition to the `BUILTIN_TEMPLATES` array. T6 verifies all templates together. T7 confirms the build.

## Appendix: Template Field Inventory

For reference, here is every field that must be present on each template, with the source constraint:

| Field | Source | Constraint |
|---|---|---|
| `id` | `BeadTemplate.id` | Unique string, kebab-case, used as lookup key in `getTemplateById()` and `expandTemplate()` |
| `label` | `BeadTemplate.label` | Human-readable, shown in UI |
| `summary` | `BeadTemplate.summary` | One line, used by `formatTemplatesForPrompt()` |
| `descriptionTemplate` | `BeadTemplate.descriptionTemplate` | Contains `{{placeholder}}` tokens matching `PLACEHOLDER_PATTERN` |
| `placeholders` | `BeadTemplate.placeholders` | Array of `{ name, description, example, required }` |
| `acceptanceCriteria` | `BeadTemplate.acceptanceCriteria` | `string[]`, >= 3 entries recommended |
| `filePatterns` | `BeadTemplate.filePatterns` | Glob patterns, informational |
| `dependencyHints` | `BeadTemplate.dependencyHints` | Optional string, but should be present |
| `examples` | `BeadTemplate.examples` | Array of `{ description }`, >= 1 entry, fully expanded |
