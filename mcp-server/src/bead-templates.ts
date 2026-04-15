import type { BeadTemplate, ExpandTemplateResult } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("bead-templates");
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
    log.warn(warning);
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
 * 5. Set `filePatterns` to the narrowest globs that cover the typical
 *    file scope — prefer specific directory globs over broad wildcards.
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
      "Implement the endpoint behavior in the named module without leaving stub methods.",
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
  defineTemplate({
    id: "fix-bug",
    label: "Fix bug",
    summary: "Diagnose and fix a specific defect with a regression test.",
    descriptionTemplate: `Fix the {{bugSummary}} bug in {{moduleName}}. Write a regression test first, then apply the minimal code change that resolves the defect without breaking existing behavior.

Why this bead exists:
- {{bugSymptom}}
- The fix must include a regression test so this defect cannot silently return.

Acceptance criteria:
- [ ] Write a failing test that reproduces the {{bugSummary}} bug before changing implementation code.
- [ ] Apply the minimal code change in {{implementationFile}} that makes the test pass without regressing other tests.
- [ ] Leave a comment in {{testFile}} explaining what scenario the regression test covers.

### Files:
- {{implementationFile}}
- {{testFile}}`,
    placeholders: [
      { name: "bugSummary", description: "Short name for the bug, used in commit messages and test names", example: "crash when user list is empty", required: true },
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
    examples: [
      {
        description: `Fix the null reference in payment total calculation bug in payment gateway charge handler. Write a regression test first, then apply the minimal code change that resolves the defect without breaking existing behavior.

Why this bead exists:
- Charges with a zero-item cart throw a TypeError: Cannot read properties of null (reading 'reduce') because the line items array is null instead of empty when the cart is cleared before checkout completes.
- The fix must include a regression test so this defect cannot silently return.

Acceptance criteria:
- [ ] Write a failing test that reproduces the null reference in payment total calculation bug before changing implementation code.
- [ ] Apply the minimal code change in src/payments/charge-handler.ts that makes the test pass without regressing other tests.
- [ ] Leave a comment in src/payments/charge-handler.test.ts explaining what scenario the regression test covers.

### Files:
- src/payments/charge-handler.ts
- src/payments/charge-handler.test.ts`,
      },
    ],
  }),
  defineTemplate({
    id: "add-documentation",
    label: "Add documentation",
    summary: "Write or update documentation for a feature or API.",
    descriptionTemplate: `Write documentation for {{docTopic}} targeting {{targetAudience}}. Cross-reference the source implementation to ensure accuracy, include at least one usage example, and avoid assuming context that is not documented elsewhere.

Why this bead exists:
- {{docTopic}} lacks documentation suitable for {{targetAudience}}.
- The docs should be written alongside or immediately after the implementation to capture accurate details.

Acceptance criteria:
- [ ] Document {{docTopic}} in {{docFile}}, accurately reflecting the current implementation in {{primarySourceFile}}.
- [ ] Include at least one usage example or code snippet demonstrating the documented feature.
- [ ] Write for {{targetAudience}} without assuming undocumented context.

### Files:
- {{docFile}}
- {{primarySourceFile}}`,
    placeholders: [
      { name: "docTopic", description: "What is being documented", example: "bead template expansion API", required: true },
      { name: "targetAudience", description: "Who will read this documentation", example: "developers adding new bead templates", required: true },
      { name: "docFile", description: "Primary documentation file to create or update", example: "docs/templates.md", required: true },
      { name: "primarySourceFile", description: "Source code file being documented", example: "src/bead-templates.ts", required: true },
    ],
    acceptanceCriteria: [
      "Documentation accurately reflects the current implementation.",
      "Include at least one usage example or code snippet.",
      "Write for the specified target audience without assuming undocumented context.",
    ],
    filePatterns: ["docs/**/*.md", "*.md", "src/**/*.ts"],
    dependencyHints: "Documentation beads usually depend on the implementation bead they document. Create the implementation first, then the documentation.",
    examples: [
      {
        description: `Write documentation for the payment processing webhook lifecycle targeting new backend engineers joining the payments team. Cross-reference the source implementation to ensure accuracy, include at least one usage example, and avoid assuming context that is not documented elsewhere.

Why this bead exists:
- The payment processing webhook lifecycle lacks documentation suitable for new backend engineers joining the payments team.
- The docs should be written alongside or immediately after the implementation to capture accurate details.

Acceptance criteria:
- [ ] Document the payment processing webhook lifecycle in docs/payments/webhooks.md, accurately reflecting the current implementation in src/payments/webhook-handler.ts.
- [ ] Include at least one usage example or code snippet demonstrating the documented feature.
- [ ] Write for new backend engineers joining the payments team without assuming undocumented context.

### Files:
- docs/payments/webhooks.md
- src/payments/webhook-handler.ts`,
      },
    ],
  }),
  defineTemplate({
    id: "add-integration",
    label: "Add integration",
    summary: "Connect two subsystems or services with error handling at the boundary.",
    descriptionTemplate: `Integrate {{sourceSystem}} with {{targetSystem}} to {{integrationPurpose}}. Implement the connection following the agreed interface contract, add error handling at the integration boundary, and cover the integration with automated tests.

Why this bead exists:
- {{sourceSystem}} and {{targetSystem}} need to communicate to {{integrationPurpose}}.
- The integration must follow the {{interfaceContract}} contract and handle failures gracefully at the boundary.

Acceptance criteria:
- [ ] Implement the integration between {{sourceSystem}} and {{targetSystem}} following the {{interfaceContract}} contract.
- [ ] Handle errors at the integration boundary with clear, actionable error messages.
- [ ] Add an integration test covering the happy path and at least one failure mode.

### Files:
- {{implementationFile}}
- {{testFile}}`,
    placeholders: [
      { name: "sourceSystem", description: "System or module initiating the integration", example: "flywheel planning phase", required: true },
      { name: "targetSystem", description: "System or module being integrated with", example: "MCP tool server", required: true },
      { name: "integrationPurpose", description: "Why these systems need to communicate", example: "pass approved beads to the tool server for agent execution", required: true },
      { name: "interfaceContract", description: "Expected interface or data contract between the systems", example: "BeadPayload JSON with id, description, and acceptanceCriteria fields", required: true },
      { name: "implementationFile", description: "Primary file where the integration is implemented", example: "src/server.ts", required: true },
      { name: "testFile", description: "Integration test file", example: "src/server.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Implement the integration following the specified interface contract.",
      "Handle errors at the integration boundary with clear error messages.",
      "Add an integration test covering the happy path and at least one failure mode.",
    ],
    filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
    dependencyHints: "Integration beads depend on the beads that implement both the source and target systems. They should be among the last beads to execute.",
    examples: [
      {
        description: `Integrate the payment processing service with the fraud detection API to validate transactions before settlement. Implement the connection following the agreed interface contract, add error handling at the integration boundary, and cover the integration with automated tests.

Why this bead exists:
- The payment processing service and the fraud detection API need to communicate to validate transactions before settlement.
- The integration must follow the FraudCheckRequest JSON with transactionId, amount, currency, and merchantId fields contract and handle failures gracefully at the boundary.

Acceptance criteria:
- [ ] Implement the integration between the payment processing service and the fraud detection API following the FraudCheckRequest JSON with transactionId, amount, currency, and merchantId fields contract.
- [ ] Handle errors at the integration boundary with clear, actionable error messages.
- [ ] Add an integration test covering the happy path and at least one failure mode.

### Files:
- src/payments/fraud-check.ts
- src/payments/fraud-check.test.ts`,
      },
    ],
  }),
  defineTemplate({
    id: "improve-performance",
    label: "Improve performance",
    summary: "Optimize a slow path with measurable before/after evidence.",
    descriptionTemplate: `Optimize {{targetArea}} to meet a measurable performance target. The current baseline is: {{currentBehavior}}. The goal is to {{performanceGoal}} by applying the approach described below while preserving all existing behavior.

Why this bead exists:
- The current performance of {{targetArea}} is insufficient: {{currentBehavior}}.
- A concrete optimization approach has been identified: {{optimizationApproach}}.

Acceptance criteria:
- [ ] Improve {{targetArea}} from the current baseline ({{currentBehavior}}) to meet the goal: {{performanceGoal}}.
- [ ] Implement the optimization using the planned approach: {{optimizationApproach}}.
- [ ] Add a benchmark or performance test to prevent future regressions.
- [ ] Verify that all existing tests continue to pass with no behavior changes.

### Files:
- {{implementationFile}}
- {{testFile}}`,
    placeholders: [
      { name: "targetArea", description: "Module or function being optimized", example: "plan-to-bead token overlap scoring", required: true },
      { name: "currentBehavior", description: "Current performance baseline with measurable detail", example: "scoring 50 beads against a 20-section plan takes 4s", required: true },
      { name: "performanceGoal", description: "Target improvement with measurable threshold", example: "complete scoring in under 500ms", required: true },
      { name: "optimizationApproach", description: "Planned optimization strategy", example: "pre-compute section token sets and use set intersection", required: true },
      { name: "implementationFile", description: "Primary source file to optimize", example: "src/beads.ts", required: true },
      { name: "testFile", description: "Benchmark or test file for performance verification", example: "src/beads.bench.ts", required: true },
    ],
    acceptanceCriteria: [
      "Achieve the stated performance goal with measurable evidence.",
      "Add a benchmark or performance test to prevent future regressions.",
      "Preserve all existing behavior and passing tests.",
    ],
    filePatterns: ["src/**/*.ts", "src/**/*.test.ts", "src/**/*.bench.ts"],
    dependencyHints: "Performance beads should depend on the implementation bead that creates the code being optimized. Avoid parallelizing with beads that modify the same hot path.",
    examples: [
      {
        description: `Optimize the product search query builder to meet a measurable performance target. The current baseline is: searching 10,000 products with 3 filter facets takes 2.8s average response time. The goal is to return filtered results in under 200ms at p95 by applying the approach described below while preserving all existing behavior.

Why this bead exists:
- The current performance of the product search query builder is insufficient: searching 10,000 products with 3 filter facets takes 2.8s average response time.
- A concrete optimization approach has been identified: add composite database indexes for common filter combinations and cache parsed filter ASTs.

Acceptance criteria:
- [ ] Improve the product search query builder from the current baseline (searching 10,000 products with 3 filter facets takes 2.8s average response time) to meet the goal: return filtered results in under 200ms at p95.
- [ ] Implement the optimization using the planned approach: add composite database indexes for common filter combinations and cache parsed filter ASTs.
- [ ] Add a benchmark or performance test to prevent future regressions.
- [ ] Verify that all existing tests continue to pass with no behavior changes.

### Files:
- src/search/query-builder.ts
- src/search/query-builder.bench.ts`,
      },
    ],
  }),
  defineTemplate({
    id: "update-configuration",
    label: "Update configuration",
    summary: "Add or modify configuration with validation and migration notes.",
    descriptionTemplate: `Update the {{configArea}} configuration in {{configFile}} to {{changeReason}}. Add input validation for the new values, document migration steps, and ensure existing environments are not broken by the change.

Why this bead exists:
- The {{configArea}} configuration needs to change to {{changeReason}}.
- Configuration changes without migration notes risk breaking existing deployments silently.

Migration notes:
{{migrationNotes}}

Acceptance criteria:
- [ ] Add or update the {{configArea}} configuration in {{configFile}} with input validation for new values.
- [ ] Document migration steps so existing environments can adapt without downtime or data loss.
- [ ] Add validation tests in {{validationFile}} covering valid inputs, invalid inputs, and backwards-compatible defaults.

### Files:
- {{configFile}}
- {{validationFile}}`,
    placeholders: [
      { name: "configArea", description: "What configuration is being changed", example: "MCP server transport settings", required: true },
      { name: "changeReason", description: "Why the configuration needs to change", example: "support both stdio and SSE transports", required: true },
      { name: "migrationNotes", description: "How existing environments should adapt", example: "existing stdio-only setups continue to work with no changes; SSE requires setting TRANSPORT=sse", required: true },
      { name: "configFile", description: "Primary configuration file", example: "src/config.ts", required: true },
      { name: "validationFile", description: "File where config validation lives", example: "src/config.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Add or update configuration with input validation for the new values.",
      "Document migration steps for existing environments.",
      "Ensure backwards compatibility or document breaking changes explicitly.",
    ],
    filePatterns: ["*.config.*", "*.json", "*.yaml", "*.yml", "*.toml", "src/**/*.ts"],
    dependencyHints: "Configuration beads are often prerequisites for feature beads that consume the new config. Other beads should depend on this one if they read the changed config.",
    examples: [
      {
        description: `Update the database connection pool configuration in src/db/config.ts to support environment-based pool sizing for production, staging, and development. Add input validation for the new values, document migration steps, and ensure existing environments are not broken by the change.

Why this bead exists:
- The database connection pool configuration needs to change to support environment-based pool sizing for production, staging, and development.
- Configuration changes without migration notes risk breaking existing deployments silently.

Migration notes:
Existing deployments using the default pool size of 10 continue to work unchanged. To opt in to environment-based sizing, set DB_POOL_MIN and DB_POOL_MAX environment variables. Production defaults to min=5, max=20; staging defaults to min=2, max=10; development defaults to min=1, max=5. If neither variable is set, the legacy default of 10 is preserved.

Acceptance criteria:
- [ ] Add or update the database connection pool configuration in src/db/config.ts with input validation for new values.
- [ ] Document migration steps so existing environments can adapt without downtime or data loss.
- [ ] Add validation tests in src/db/config.test.ts covering valid inputs, invalid inputs, and backwards-compatible defaults.

### Files:
- src/db/config.ts
- src/db/config.test.ts`,
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
