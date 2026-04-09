import type { BeadTemplate, ExpandTemplateResult } from "./types.js";

const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

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

function validateTemplateIntegrity(templates: BeadTemplate[]): string[] {
  const warnings: string[] = [];
  const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
  const seenIds = new Set<string>();

  for (const template of templates) {
    if (seenIds.has(template.id)) {
      warnings.push(`Duplicate template ID: "${template.id}"`);
    }
    seenIds.add(template.id);

    if (!ID_PATTERN.test(template.id)) {
      warnings.push(`Invalid template ID format: "${template.id}" (must match /^[a-z][a-z0-9-]*$/)`);
    }

    if (template.descriptionTemplate.length < 50) {
      warnings.push(`Template "${template.id}" has a short descriptionTemplate (${template.descriptionTemplate.length} chars, minimum recommended: 50)`);
    }

    if (!template.acceptanceCriteria || template.acceptanceCriteria.length === 0) {
      warnings.push(`Template "${template.id}" has no acceptanceCriteria`);
    }

    const usedNames = new Set(
      Array.from(template.descriptionTemplate.matchAll(PLACEHOLDER_PATTERN)).map(m => m[1])
    );

    for (const p of template.placeholders) {
      if (p.required && !usedNames.has(p.name)) {
        warnings.push(`Template "${template.id}": required placeholder "${p.name}" not used in descriptionTemplate`);
      }
    }

    for (const p of template.placeholders) {
      if (!p.required && usedNames.has(p.name)) {
        warnings.push(`Template "${template.id}": non-required placeholder "${p.name}" is used in descriptionTemplate (omission would leave raw markers)`);
      }
    }
  }

  for (const warning of warnings) {
    console.warn(warning);
  }

  return warnings;
}

/**
 * Built-in bead templates for common, repeatable work units.
 *
 * ## The five-block `descriptionTemplate` pattern
 *
 * Every template description follows this structure:
 *
 * ```
 * {{leadSentence — what is being done and where}}
 *
 * Why this bead exists:
 * - {{rationale line 1}}
 * - {{rationale line 2}}
 *
 * Acceptance criteria:
 * - [ ] {{criterion 1}}
 * - [ ] {{criterion 2}}
 * - [ ] {{criterion 3}}
 *
 * ### Files:
 * - {{primaryFile}}
 * - {{secondaryFile}}
 * ```
 *
 * **Why this pattern matters:**
 * - `validateBeads()` scans for `### Files:` to verify file scope and for
 *   `- [ ]` markers to count acceptance criteria; descriptions missing
 *   either trigger template-hygiene warnings.
 * - The lead sentence maps to the one-line `summary` shown when
 *   `formatTemplatesForPrompt()` lists available templates.
 * - The "Why this bead exists" block gives the executing agent rationale
 *   so it can make better judgment calls at the edges.
 *
 * ## Placeholder naming conventions
 *
 * - Use **camelCase** names that describe the semantic role, not the format.
 * - Good: `implementationFile`, `testFile`, `bugSummary`, `endpointPurpose`
 * - Bad: `file`, `desc`, `impl`, `f1`
 * - Placeholder `description` fields should explain the *role* the value
 *   plays ("Primary source file to edit or create"), not the format
 *   ("a string").
 *
 * ## `acceptanceCriteria` vs template `- [ ]` lines
 *
 * These serve different audiences and are not required to be identical:
 *
 * - **Template `- [ ]` lines** (inside `descriptionTemplate`) are
 *   *bead-facing*: filled with placeholder values at expansion time and
 *   read by the executing agent as concrete, contextual checkboxes.
 * - **`acceptanceCriteria` array** (on the template object) is
 *   *template-level metadata*: used by validation tooling, template
 *   listings, and audit checks. These are generic descriptions of what
 *   any bead from this template must achieve.
 *
 * Both must exist. The template-level criteria provide a stable contract;
 * the expanded `- [ ]` lines provide the agent-specific, filled-in version.
 *
 * ## How to add a new bead template
 *
 * 1. Pick a `verb-noun` ID in kebab-case matching `/^[a-z][a-z0-9-]*$/`
 *    (e.g., `fix-bug`, `add-migration`, `write-docs`).
 * 2. Write `descriptionTemplate` following the five-block pattern above.
 * 3. Define one placeholder per `{{marker}}` used in the template — all
 *    placeholders that appear in the template text must have `required: true`.
 * 4. Populate `acceptanceCriteria` with >= 3 specific, verifiable items.
 * 5. Set `filePatterns` to the narrowest globs covering the typical file
 *    scope (e.g., `["src/api/*.ts"]` not `["**/*.ts"]`).
 * 6. Write `dependencyHints` naming what this bead typically unblocks
 *    and what it depends on.
 * 7. Add at least one `examples` entry using a different domain than the
 *    placeholder examples to show the template in a realistic context.
 * 8. Wrap the template object with `defineTemplate()` — it catches
 *    placeholder mismatches (used-but-not-defined, defined-but-not-used)
 *    at load time so errors surface immediately, not at expansion time.
 * 9. Run `npm run build` — zero TypeScript errors required.
 *
 * ## When to create a template vs use custom descriptions
 *
 * - **Create a template** when the bead shape occurs 3+ times per typical
 *   session — the repetition justifies the upfront cost of defining
 *   placeholders and examples.
 * - **Use custom descriptions** for rare, project-specific, or highly
 *   variable work where a template would be too generic to add value.
 */
const BUILTIN_TEMPLATES: BeadTemplate[] = [
  defineTemplate({
    id: "add-api-endpoint",
    label: "Add API endpoint",
    summary: "Create a new endpoint with validation, error handling, and tests.",
    descriptionTemplate: `Implement a new API endpoint for {{endpointPath}} in the {{moduleName}} area. Add request validation, success/error responses, and any supporting wiring needed so the endpoint behaves consistently with the existing API surface.

Why this bead exists:
- The feature needs a concrete endpoint for {{endpointPurpose}}.
- The work should land with validation, error handling, and test coverage instead of a stub.

Acceptance criteria:
- [ ] Add the {{httpMethod}} {{endpointPath}} endpoint with validation for the expected inputs.
- [ ] Return clear success and failure responses for the main path and obvious edge cases.
- [ ] Add tests covering the happy path and at least one error path.

### Files:
- {{implementationFile}}
- {{testFile}}`,
    placeholders: [
      { name: "endpointPath", description: "Route or RPC path to implement", example: "/users", required: true },
      { name: "moduleName", description: "Owning module or feature area", example: "user-management", required: true },
      { name: "endpointPurpose", description: "Why the endpoint is being added", example: "return a filtered user list", required: true },
      { name: "httpMethod", description: "HTTP method or action name", example: "GET", required: true },
      { name: "implementationFile", description: "Primary source file to edit or create", example: "src/api/users.ts", required: true },
      { name: "testFile", description: "Test file covering the endpoint", example: "src/api/users.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Add request validation and explicit error handling for invalid inputs.",
      "Implement the endpoint behavior in the named module without leaving TODO stubs.",
      "Cover the endpoint with automated tests for success and failure paths.",
    ],
    filePatterns: ["src/api/*.ts", "src/**/*.test.ts"],
    dependencyHints: "Other beads that depend on this endpoint should list it as a dependency. If test coverage is split into a separate bead, that bead depends on this one.",
    examples: [
      {
        description: `Implement a new API endpoint for /users in the user-management area. Add request validation, success/error responses, and any supporting wiring needed so the endpoint behaves consistently with the existing API surface.

Why this bead exists:
- The feature needs a concrete endpoint for return a filtered user list.
- The work should land with validation, error handling, and test coverage instead of a stub.

Acceptance criteria:
- [ ] Add the GET /users endpoint with validation for the expected inputs.
- [ ] Return clear success and failure responses for the main path and obvious edge cases.
- [ ] Add tests covering the happy path and at least one error path.

### Files:
- src/api/users.ts
- src/api/users.test.ts`,
      },
    ],
  }),
  defineTemplate({
    id: "refactor-module",
    label: "Refactor module",
    summary: "Restructure an existing module while preserving behavior and tests.",
    descriptionTemplate: `Refactor the {{moduleName}} module to improve {{refactorGoal}} while preserving existing behavior. Reorganize the code, update any touched call sites, and keep the resulting structure easier for future agents to extend.

Why this bead exists:
- The current module has pain around {{currentPain}}.
- The refactor should reduce maintenance cost without changing outward behavior.

Acceptance criteria:
- [ ] Reorganize {{moduleName}} to improve {{refactorGoal}} without changing intended behavior.
- [ ] Update affected call sites or imports if the internal structure changes.
- [ ] Add or update regression tests covering the preserved behavior.

### Files:
- {{moduleFile}}
- {{testFile}}`,
    placeholders: [
      { name: "moduleName", description: "Module or subsystem being refactored", example: "scan pipeline", required: true },
      { name: "refactorGoal", description: "Desired improvement from the refactor", example: "separation of parsing from UI formatting", required: true },
      { name: "currentPain", description: "Current maintenance or correctness pain", example: "logic and rendering are tightly coupled", required: true },
      { name: "moduleFile", description: "Primary implementation file", example: "src/scan.ts", required: true },
      { name: "testFile", description: "Regression test file to update", example: "src/scan.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Improve module structure without regressing the externally visible behavior.",
      "Keep imports, naming, and seams understandable for future edits.",
      "Add or update regression tests to lock in the preserved behavior.",
    ],
    filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
    dependencyHints: "Refactor beads often unblock documentation or follow-up cleanup beads after the structural work lands.",
    examples: [
      {
        description: `Refactor the scan pipeline module to improve separation of parsing from UI formatting while preserving existing behavior. Reorganize the code, update any touched call sites, and keep the resulting structure easier for future agents to extend.

Why this bead exists:
- The current module has pain around logic and rendering are tightly coupled.
- The refactor should reduce maintenance cost without changing outward behavior.

Acceptance criteria:
- [ ] Reorganize scan pipeline to improve separation of parsing from UI formatting without changing intended behavior.
- [ ] Update affected call sites or imports if the internal structure changes.
- [ ] Add or update regression tests covering the preserved behavior.

### Files:
- src/scan.ts
- src/scan.test.ts`,
      },
    ],
  }),
  defineTemplate({
    id: "add-tests",
    label: "Add tests",
    summary: "Add missing unit or integration coverage for existing behavior.",
    descriptionTemplate: `Add automated tests for {{featureName}} so the current behavior is covered before future changes land. Focus on the highest-risk paths, document the expected behavior in assertions, and avoid relying on manual verification.

Why this bead exists:
- {{featureName}} currently has insufficient automated coverage around {{riskArea}}.
- The goal is to lock in behavior before follow-up changes expand the feature.

Acceptance criteria:
- [ ] Add automated tests covering the primary behavior of {{featureName}}.
- [ ] Include at least one edge case or failure-path assertion for {{riskArea}}.
- [ ] Keep the tests readable enough that they document the intended behavior.

### Files:
- {{implementationFile}}
- {{testFile}}`,
    placeholders: [
      { name: "featureName", description: "Feature or function needing coverage", example: "plan-to-bead audit warnings", required: true },
      { name: "riskArea", description: "High-risk behavior or regression area", example: "empty sections and weak mappings", required: true },
      { name: "implementationFile", description: "Referenced source file", example: "src/prompts.ts", required: true },
      { name: "testFile", description: "Test file to create or extend", example: "src/flywheel.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Cover the main behavior with stable automated tests.",
      "Add at least one edge-case or failure-path assertion.",
      "Keep tests focused and descriptive rather than snapshotting vague output.",
    ],
    filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
    dependencyHints: "add-tests usually depends on an implementation bead when the tested feature is still being built.",
    examples: [
      {
        description: `Add automated tests for plan-to-bead audit warnings so the current behavior is covered before future changes land. Focus on the highest-risk paths, document the expected behavior in assertions, and avoid relying on manual verification.

Why this bead exists:
- plan-to-bead audit warnings currently has insufficient automated coverage around empty sections and weak mappings.
- The goal is to lock in behavior before follow-up changes expand the feature.

Acceptance criteria:
- [ ] Add automated tests covering the primary behavior of plan-to-bead audit warnings.
- [ ] Include at least one edge case or failure-path assertion for empty sections and weak mappings.
- [ ] Keep the tests readable enough that they document the intended behavior.

### Files:
- src/prompts.ts
- src/flywheel.test.ts`,
      },
    ],
  }),
];

export const TEMPLATE_INTEGRITY_WARNINGS = validateTemplateIntegrity(BUILTIN_TEMPLATES);

const INVALID_VALUE_PATTERN = /[\r\0]/;
const MAX_PLACEHOLDER_VALUE_LENGTH = 2000;

function cloneTemplate(template: BeadTemplate): BeadTemplate {
  return {
    ...template,
    placeholders: template.placeholders.map((placeholder) => ({ ...placeholder })),
    acceptanceCriteria: [...template.acceptanceCriteria],
    filePatterns: [...template.filePatterns],
    examples: template.examples.map((example) => ({ ...example })),
  };
}

export function listBeadTemplates(): BeadTemplate[] {
  return BUILTIN_TEMPLATES.map(cloneTemplate);
}

export function getTemplateById(templateId: string): BeadTemplate | undefined {
  const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === templateId);
  return template ? cloneTemplate(template) : undefined;
}

export function formatTemplatesForPrompt(): string {
  if (BUILTIN_TEMPLATES.length === 0) {
    return "(No bead templates available — write custom bead descriptions.)";
  }
  return BUILTIN_TEMPLATES.map((template) => {
    const placeholderNames = template.placeholders.map((placeholder) => placeholder.name).join(", ");
    return `- ${template.id}: ${template.summary} Placeholders: ${placeholderNames}`;
  }).join("\n");
}

function validatePlaceholderValues(placeholders: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(placeholders)) {
    if (INVALID_VALUE_PATTERN.test(value)) {
      return `Invalid placeholder value for ${name}. Values must not contain carriage returns or null bytes.`;
    }
    if (value.length > MAX_PLACEHOLDER_VALUE_LENGTH) {
      return `Placeholder value for "${name}" is too long (${value.length} chars, max ${MAX_PLACEHOLDER_VALUE_LENGTH}).`;
    }
  }
  return undefined;
}

export function expandTemplate(templateId: string, placeholders: Record<string, string>): ExpandTemplateResult {
  const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    return { success: false, error: `Unknown bead template: ${templateId}` };
  }

  const invalidValueError = validatePlaceholderValues(placeholders);
  if (invalidValueError) {
    return { success: false, error: invalidValueError };
  }

  const missingRequired = template.placeholders
    .filter((placeholder) => placeholder.required && !placeholders[placeholder.name]?.trim())
    .map((placeholder) => placeholder.name);
  if (missingRequired.length > 0) {
    const knownNames = new Set(template.placeholders.map((p) => p.name));
    const extraKeys = Object.keys(placeholders).filter((k) => !knownNames.has(k));
    const hint = extraKeys.length > 0 ? ` (unrecognized keys: ${extraKeys.join(", ")})` : "";
    return {
      success: false,
      error: `Missing required placeholders for ${templateId}: ${missingRequired.join(", ")}${hint}`,
    };
  }

  const description = template.descriptionTemplate.replace(PLACEHOLDER_PATTERN, (_match, placeholderName: string) => {
    return placeholders[placeholderName] ?? `{{${placeholderName}}}`;
  });

  const unresolved = Array.from(description.matchAll(PLACEHOLDER_PATTERN)).map((match) => match[1]);
  if (unresolved.length > 0) {
    return {
      success: false,
      error: `Unresolved placeholders for ${templateId}: ${Array.from(new Set(unresolved)).join(", ")}`,
    };
  }

  return { success: true, description };
}
