# Robustness Plan: Complete Bead Template Stubs

**Perspective:** Robustness -- error propagation, graceful degradation, type safety, defensive programming, preventing silent failures.

**Date:** 2026-04-08

---

## 1. Problem Statement

`mcp-server/src/bead-templates.ts` currently has **only 3 built-in templates** (`add-api-endpoint`, `refactor-module`, `add-tests`). The codebase references additional bead types -- `"task"`, `"feature"`, `"bug"`, `"docs"`, `"config"`, `"chore"` (see `types.ts:166`) -- and idea categories including `"dx"`, `"performance"`, `"reliability"`, `"security"` (see `server.ts:54`, `ideation-funnel.ts:306`). These common bead shapes lack template coverage, which means:

1. **Agents producing these bead types get no structural guidance**, leading to inconsistently shaped descriptions that fail quality checks in `validateBeads()` and `qualityCheckBeads()` (beads.ts:372-524).
2. **`formatTemplatesForPrompt()`** (bead-templates.ts:181-186) returns a sparse library that doesn't cover the most common bead shapes, so the "Template Library" section in prompts.ts planning prompts (lines 295-321, 414-419) is under-representative.
3. **The `expandTemplate()` function** (bead-templates.ts:197-234) is well-defended with validation, but several robustness gaps exist in the broader template pipeline that could cause silent failures or confusing error messages.

### What's currently broken or risky

- Missing templates for `fix-bug`, `add-docs`, `add-config`, `performance-optimization`, and `security-hardening` bead types -- agents fall back to freeform descriptions that often lack `### Files:` sections and acceptance criteria.
- `expandTemplate()` returns `{ success: false, error }` for unknown template IDs but nothing enforces that callers check this result. If a caller ignores the discriminated union and reads `.description` from a failure result, they get `undefined` silently.
- `formatTemplatesForPrompt()` does not signal when the template list is empty (defensive edge case if BUILTIN_TEMPLATES were accidentally cleared).
- `cloneTemplate()` does a shallow clone of placeholder objects -- if a `BeadTemplatePlaceholder` ever gains nested objects (e.g., validation rules), the clone would share references.
- `validatePlaceholderValues()` only checks for `\r` and `\0` but does not guard against excessively long values that could blow up description output or cause downstream truncation.
- No runtime validation that `BUILTIN_TEMPLATES` entries conform to `BeadTemplate` invariants (e.g., `descriptionTemplate` must contain all required placeholder names, `id` must be unique, `acceptanceCriteria` must be non-empty).

---

## 2. Failure Mode Analysis

### FM-1: Unknown template ID passed to `expandTemplate()`
- **Current handling:** Returns `{ success: false, error }` -- adequate.
- **Risk:** Callers that destructure `{ description }` without checking `success` get `undefined`. TypeScript narrows this at compile time if callers use the discriminated union correctly, but at the MCP JSON boundary, the error string may be swallowed.
- **Severity:** Medium. Could produce a bead with no description.

### FM-2: Missing required placeholders
- **Current handling:** Returns error listing missing names + unrecognized keys hint -- well done.
- **Risk:** If placeholder names in `descriptionTemplate` don't match `placeholders[].name` (template authoring bug), the template will always fail or leave `{{name}}` markers. No build-time or startup-time check catches this.
- **Severity:** High for new templates. A typo in a placeholder name silently produces a broken template that only fails at runtime.

### FM-3: Excessive placeholder values
- **Current handling:** Only `\r` and `\0` are rejected.
- **Risk:** A 100KB placeholder value produces a 100KB+ description that may exceed `br create -d` shell argument limits or MCP response size limits.
- **Severity:** Low-medium. Unlikely in normal use but possible with adversarial or automated input.

### FM-4: Template hygiene checker misses new template shapes
- **Current handling:** `validateBeads()` in beads.ts checks for `raw-template-marker`, `template-shorthand`, `unresolved-placeholder`, and `template-missing-structure`.
- **Risk:** When new templates are added, their expanded descriptions must still pass these hygiene checks. If a new template's `descriptionTemplate` accidentally contains `{{` in a literal code block, the hygiene checker will flag it as `unresolved-placeholder`.
- **Severity:** Medium. False positives in validation would block bead approval.

### FM-5: `formatTemplatesForPrompt()` returns empty or truncated output
- **Current handling:** No guard. If `BUILTIN_TEMPLATES` is empty, returns `""`.
- **Risk:** The planning prompt in prompts.ts injects this directly into `## Template Library\n${formatTemplatesForPrompt()}`. An empty string produces a confusing prompt with an empty section header.
- **Severity:** Low. Would only happen if templates array is accidentally emptied.

### FM-6: Duplicate template IDs
- **Current handling:** `getTemplateById()` uses `.find()` which returns the first match. If two templates share an ID, the second is silently unreachable.
- **Risk:** As more templates are added, accidental ID collisions become more likely.
- **Severity:** Medium. Silent data loss -- one template completely shadows another.

### FM-7: Template examples don't match their description templates
- **Current handling:** Examples are static strings. No validation that they match what `expandTemplate()` would produce.
- **Risk:** Stale examples mislead agents into producing incorrectly shaped beads.
- **Severity:** Low. Cosmetic but could cause downstream quality check failures.

### FM-8: `cloneTemplate()` shallow-clones nested objects
- **Current handling:** Spreads `placeholders` array items but doesn't deep-clone.
- **Risk:** Currently safe because `BeadTemplatePlaceholder` has only primitive fields. If the interface gains nested fields, mutations to cloned templates would corrupt the originals.
- **Severity:** Low. Latent bug, not currently exploitable.

---

## 3. Implementation Steps

### T1: Add startup-time template self-validation
**File:** `mcp-server/src/bead-templates.ts`

Add a `validateTemplateIntegrity()` function that runs once when the module loads (or is called explicitly). It checks:

1. All template IDs are unique (no duplicates in `BUILTIN_TEMPLATES`).
2. Every required placeholder in `placeholders[]` appears at least once in `descriptionTemplate` as `{{name}}`.
3. Every `{{name}}` in `descriptionTemplate` has a matching entry in `placeholders[]`.
4. `acceptanceCriteria` is non-empty.
5. `id` matches `/^[a-z][a-z0-9-]*$/` (safe for CLI args and URLs).
6. `descriptionTemplate` is non-empty and >= 50 chars.

On failure, log a warning with the specific template ID and issue. Do NOT throw -- the server should still start with the valid templates.

```typescript
function validateTemplateIntegrity(templates: BeadTemplate[]): string[] {
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  
  for (const t of templates) {
    // Duplicate ID check
    if (seenIds.has(t.id)) {
      warnings.push(`Duplicate template ID: ${t.id}`);
    }
    seenIds.add(t.id);
    
    // ID format check
    if (!/^[a-z][a-z0-9-]*$/.test(t.id)) {
      warnings.push(`Template ID "${t.id}" contains invalid characters`);
    }
    
    // Description template minimum length
    if (t.descriptionTemplate.length < 50) {
      warnings.push(`Template "${t.id}" has a very short descriptionTemplate (${t.descriptionTemplate.length} chars)`);
    }
    
    // Acceptance criteria present
    if (t.acceptanceCriteria.length === 0) {
      warnings.push(`Template "${t.id}" has no acceptanceCriteria`);
    }
    
    // Cross-check placeholders vs template
    const templatePlaceholders = new Set(
      Array.from(t.descriptionTemplate.matchAll(PLACEHOLDER_PATTERN)).map(m => m[1])
    );
    const declaredRequired = new Set(
      t.placeholders.filter(p => p.required).map(p => p.name)
    );
    const declaredAll = new Set(t.placeholders.map(p => p.name));
    
    for (const name of declaredRequired) {
      if (!templatePlaceholders.has(name)) {
        warnings.push(`Template "${t.id}": required placeholder "${name}" not found in descriptionTemplate`);
      }
    }
    for (const name of templatePlaceholders) {
      if (!declaredAll.has(name)) {
        warnings.push(`Template "${t.id}": descriptionTemplate uses "{{${name}}}" but no placeholder declared`);
      }
    }
  }
  
  return warnings;
}
```

Call at module level:
```typescript
const TEMPLATE_INTEGRITY_WARNINGS = validateTemplateIntegrity(BUILTIN_TEMPLATES);
if (TEMPLATE_INTEGRITY_WARNINGS.length > 0) {
  console.warn(`[bead-templates] integrity warnings:\n${TEMPLATE_INTEGRITY_WARNINGS.join('\n')}`);
}
```

**Error handling approach:** Log warnings, do not throw. Export the warnings array for test assertions.

### T2: Add placeholder value length guard
**File:** `mcp-server/src/bead-templates.ts`

Extend `validatePlaceholderValues()` to reject values exceeding a reasonable max length (e.g., 2000 chars). This prevents shell argument overflow when the expanded description is passed to `br create -d`.

```typescript
const MAX_PLACEHOLDER_VALUE_LENGTH = 2000;

function validatePlaceholderValues(placeholders: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(placeholders)) {
    if (INVALID_VALUE_PATTERN.test(value)) {
      return `Invalid placeholder value for ${name}. Values must not contain carriage returns or null bytes.`;
    }
    if (value.length > MAX_PLACEHOLDER_VALUE_LENGTH) {
      return `Placeholder value for ${name} is too long (${value.length} chars, max ${MAX_PLACEHOLDER_VALUE_LENGTH}).`;
    }
  }
  return undefined;
}
```

### T3: Add new templates for missing bead types
**File:** `mcp-server/src/bead-templates.ts`

Add templates for the most common bead types that currently lack coverage:

1. **`fix-bug`** -- Fix an existing bug with regression test. Placeholders: `bugSummary`, `affectedModule`, `reproSteps`, `implementationFile`, `testFile`.
2. **`add-docs`** -- Add or improve documentation. Placeholders: `docTarget`, `docPurpose`, `docFile`, `relatedSourceFile`.
3. **`add-config`** -- Add configuration, environment variable, or feature flag. Placeholders: `configName`, `configPurpose`, `configFile`, `validationFile`.
4. **`performance-optimization`** -- Optimize a known performance bottleneck. Placeholders: `bottleneckArea`, `currentPain`, `targetMetric`, `implementationFile`, `benchmarkFile`.
5. **`security-hardening`** -- Harden a security-sensitive area. Placeholders: `securityArea`, `threatModel`, `mitigationApproach`, `implementationFile`, `testFile`.

Each template must follow the same structural pattern as existing templates:
- `descriptionTemplate` with `Why this bead exists:` and `Acceptance criteria:` sections
- `### Files:` section referencing placeholder file paths
- At least 3 acceptance criteria
- `filePatterns`, `dependencyHints`, and at least one `example`

**Robustness constraint:** Every new template must pass `validateTemplateIntegrity()` from T1 at startup. Add each template to `BUILTIN_TEMPLATES` and verify the integrity check passes.

### T4: Harden `formatTemplatesForPrompt()` with empty-list guard
**File:** `mcp-server/src/bead-templates.ts`

```typescript
export function formatTemplatesForPrompt(): string {
  if (BUILTIN_TEMPLATES.length === 0) {
    return "(No bead templates available — write custom bead descriptions.)";
  }
  return BUILTIN_TEMPLATES.map((template) => {
    const placeholderNames = template.placeholders.map((p) => p.name).join(", ");
    return `- ${template.id}: ${template.summary} Placeholders: ${placeholderNames}`;
  }).join("\n");
}
```

### T5: Add `expandTemplateStrict()` wrapper for callers that must not ignore errors
**File:** `mcp-server/src/bead-templates.ts`

The existing `expandTemplate()` returns a discriminated union which is good for type safety. Add a strict variant that throws on failure, for internal callers where a template error is a programming bug rather than user input error:

```typescript
export function expandTemplateStrict(
  templateId: string,
  placeholders: Record<string, string>
): string {
  const result = expandTemplate(templateId, placeholders);
  if (!result.success) {
    throw new Error(`Template expansion failed for "${templateId}": ${result.error}`);
  }
  return result.description;
}
```

This gives callers a clear choice: use `expandTemplate()` for user-facing flows with graceful error handling, or `expandTemplateStrict()` for internal template-driven code paths where failure indicates a bug.

### T6: Add template hygiene pre-flight for new templates
**File:** `mcp-server/src/bead-templates.ts`

Add a function that validates a template's expanded output against the same hygiene checks used by `validateBeads()` in beads.ts. This ensures new templates don't produce descriptions that trip the hygiene checker:

```typescript
export function preflightTemplate(template: BeadTemplate): string[] {
  const issues: string[] = [];
  
  // Expand with example values
  const exampleValues: Record<string, string> = {};
  for (const p of template.placeholders) {
    exampleValues[p.name] = p.example;
  }
  
  const result = expandTemplate(template.id, exampleValues);
  if (!result.success) {
    issues.push(`Expansion with example values failed: ${result.error}`);
    return issues;
  }
  
  const desc = result.description;
  
  // Check for accidental unresolved placeholders
  const unresolvedMatches = Array.from(desc.matchAll(/{{\s*\w+\s*}}/g));
  if (unresolvedMatches.length > 0) {
    issues.push(`Expanded description contains unresolved placeholders: ${unresolvedMatches.map(m => m[0]).join(', ')}`);
  }
  
  // Check for required structural elements
  if (!desc.includes('### Files:') && !/^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc)) {
    issues.push('Expanded description missing ### Files: section');
  }
  
  const checkboxCount = (desc.match(/- \[ \]/g) || []).length;
  if (checkboxCount < 2) {
    issues.push(`Expanded description has only ${checkboxCount} acceptance criteria checkboxes (need >= 2)`);
  }
  
  if (desc.length < 100) {
    issues.push(`Expanded description too short (${desc.length} chars, need >= 100)`);
  }
  
  return issues;
}
```

Integrate into startup validation: after `validateTemplateIntegrity()`, run `preflightTemplate()` on each template and log any issues.

### T7: Add fallback template for unknown bead types
**File:** `mcp-server/src/bead-templates.ts`

Add a `getTemplateForBeadType()` function that maps common bead type strings to template IDs, with a fallback:

```typescript
const BEAD_TYPE_TO_TEMPLATE: Record<string, string> = {
  feature: 'add-api-endpoint',
  bug: 'fix-bug',
  fix: 'fix-bug',
  task: 'add-api-endpoint',  // generic task uses endpoint shape
  refactor: 'refactor-module',
  test: 'add-tests',
  testing: 'add-tests',
  docs: 'add-docs',
  documentation: 'add-docs',
  config: 'add-config',
  performance: 'performance-optimization',
  security: 'security-hardening',
};

export function getTemplateForBeadType(beadType: string): BeadTemplate | undefined {
  const templateId = BEAD_TYPE_TO_TEMPLATE[beadType.toLowerCase()];
  if (!templateId) return undefined;
  return getTemplateById(templateId);
}
```

This is explicitly advisory -- returns `undefined` for unknown types rather than throwing. Callers use this to suggest templates, not enforce them.

---

## 4. Validation & Guards

### Runtime checks

| Check | Location | Behavior on failure |
|-------|----------|-------------------|
| Template ID uniqueness | T1, module load | Log warning, skip duplicate |
| Placeholder cross-reference | T1, module load | Log warning, template still usable |
| Placeholder value length | T2, `expandTemplate()` | Return `{ success: false, error }` |
| Placeholder value chars | Existing, `expandTemplate()` | Return `{ success: false, error }` |
| Template pre-flight (hygiene) | T6, module load | Log warning, template still usable |
| Empty template list | T4, `formatTemplatesForPrompt()` | Return fallback string |

### TypeScript type guards

The existing `ExpandTemplateResult` discriminated union is well-typed. T5 adds `expandTemplateStrict()` for callers that want a throw-on-error API. No additional type guards needed -- the existing types enforce correctness at compile time.

### Fallback behavior

- **Unknown template ID:** `expandTemplate()` returns error; `getTemplateForBeadType()` returns `undefined`. Neither throws.
- **Template integrity failure at startup:** Warnings logged; server starts normally with whatever templates are valid.
- **Pre-flight failure:** Warnings logged; template is still registered (the issue may be cosmetic).

---

## 5. Edge Cases

### EC-1: Empty placeholders object
- `expandTemplate("add-api-endpoint", {})` should return a clear error listing all missing required placeholders.
- **Current behavior:** Correct. The `missingRequired` check handles this.

### EC-2: Extra placeholders not in template
- `expandTemplate("add-api-endpoint", { endpointPath: "/foo", ..., extraField: "bar" })` should succeed (extra fields are ignored) but the error message for missing fields should hint about unrecognized keys.
- **Current behavior:** Correct. The `extraKeys` hint is already implemented.

### EC-3: Placeholder value containing `{{` braces
- A placeholder value like `endpointPath = "{{dynamic}}"` could produce unresolved-placeholder false positives in the hygiene checker.
- **Mitigation:** Document that placeholder values should not contain `{{ }}` syntax. The `INVALID_VALUE_PATTERN` could be extended to reject this, but that would be overly restrictive. Better to document the constraint.

### EC-4: Very long template list in prompt
- With 8 templates, `formatTemplatesForPrompt()` output grows. At 8 templates, each ~100 chars, the output is ~800 chars -- well within prompt limits.
- **No action needed** at current scale. Monitor if template count grows past 15+.

### EC-5: Concurrent template expansion
- Templates are read-only static data. `expandTemplate()` is stateless and safe for concurrent calls.
- **No action needed.**

### EC-6: Template with no optional placeholders used in descriptionTemplate
- If `descriptionTemplate` references a placeholder marked `required: false` and the caller omits it, the output will contain a raw `{{name}}` marker.
- **Current behavior:** The unresolved-placeholder check after expansion catches this and returns an error. This is correct -- all placeholders used in the template should either be required or have the expansion tolerate their absence.
- **Robustness improvement:** The integrity check (T1) should warn if a non-required placeholder appears in `descriptionTemplate` since the expansion will fail if it's omitted.

### EC-7: Template ID collision with future br CLI reserved words
- Template IDs like `"list"`, `"show"`, `"create"` would collide with br subcommands.
- **Mitigation:** The ID format check in T1 (`/^[a-z][a-z0-9-]*$/`) allows these. Consider adding a blocklist of br CLI subcommands, or requiring IDs to contain at least one hyphen.

---

## 6. Dependency Graph

```
T1 (startup validation)
  depends_on: []

T2 (placeholder length guard)
  depends_on: []

T3 (new templates)
  depends_on: [T1]   -- new templates must pass integrity check

T4 (empty-list guard)
  depends_on: []

T5 (expandTemplateStrict)
  depends_on: []

T6 (pre-flight hygiene)
  depends_on: [T1, T3]  -- pre-flight runs on all templates including new ones

T7 (bead type mapping)
  depends_on: [T3]  -- mapping references new template IDs
```

### Parallelization

- **Wave 1 (independent):** T1, T2, T4, T5
- **Wave 2 (depends on T1):** T3
- **Wave 3 (depends on T1 + T3):** T6, T7

### Build verification

After all tasks: `cd mcp-server && npm run build` must succeed with zero TypeScript errors.

---

## Summary of Robustness Improvements

1. **Prevent silent template authoring bugs** via startup integrity validation (T1)
2. **Prevent oversized descriptions** via placeholder length limits (T2)
3. **Expand template coverage** to reduce freeform bead descriptions that fail quality checks (T3)
4. **Handle degenerate states** like empty template lists (T4)
5. **Give callers clear error-or-throw API choice** (T5)
6. **Catch template-to-hygiene mismatches** before they reach production (T6)
7. **Provide advisory type-to-template mapping** with explicit fallback (T7)
