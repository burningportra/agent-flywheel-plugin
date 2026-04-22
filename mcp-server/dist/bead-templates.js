import { createLogger } from "./logger.js";
const log = createLogger("bead-templates");
const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
function defineTemplate(template) {
    const usedNames = new Set(Array.from(template.descriptionTemplate.matchAll(PLACEHOLDER_PATTERN)).map(m => m[1]));
    const definedNames = new Set(template.placeholders.map(p => p.name));
    const orphaned = [...usedNames].filter(n => !definedNames.has(n));
    const unused = [...definedNames].filter(n => !usedNames.has(n));
    if (orphaned.length > 0 || unused.length > 0) {
        throw new Error(`Template "${template.id}@${template.version}" has mismatched placeholders.\n` +
            (orphaned.length > 0 ? `  Used but not defined: ${orphaned.join(', ')}\n` : '') +
            (unused.length > 0 ? `  Defined but not used: ${unused.join(', ')}\n` : ''));
    }
    return template;
}
function validateTemplateIntegrity(templates) {
    const warnings = [];
    const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
    const seenVersionedIds = new Set();
    for (const template of templates) {
        const key = `${template.id}@${template.version}`;
        if (seenVersionedIds.has(key)) {
            warnings.push(`Duplicate template id/version tuple: "${key}"`);
        }
        seenVersionedIds.add(key);
        if (!ID_PATTERN.test(template.id)) {
            warnings.push(`Invalid template ID format: "${template.id}" (must match /^[a-z][a-z0-9-]*$/)`);
        }
        if (!Number.isInteger(template.version) || template.version < 1) {
            warnings.push(`Template "${template.id}" has invalid version "${template.version}" — must be a positive integer`);
        }
        if (template.descriptionTemplate.length < 50) {
            warnings.push(`Template "${template.id}@${template.version}" has a short descriptionTemplate (${template.descriptionTemplate.length} chars, minimum recommended: 50)`);
        }
        if (!template.acceptanceCriteria || template.acceptanceCriteria.length === 0) {
            warnings.push(`Template "${template.id}@${template.version}" has no acceptanceCriteria`);
        }
        const usedNames = new Set(Array.from(template.descriptionTemplate.matchAll(PLACEHOLDER_PATTERN)).map(m => m[1]));
        for (const p of template.placeholders) {
            if (p.required && !usedNames.has(p.name)) {
                warnings.push(`Template "${template.id}@${template.version}": required placeholder "${p.name}" not used in descriptionTemplate`);
            }
        }
        for (const p of template.placeholders) {
            if (!p.required && usedNames.has(p.name)) {
                warnings.push(`Template "${template.id}@${template.version}": non-required placeholder "${p.name}" is used in descriptionTemplate (omission would leave raw markers)`);
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
 * ## Versioning (v3.4.0, I8)
 *
 * Every template is pinned at a `version: number` (positive integer). The
 * library API is keyed by `(id, version)` tuples — `getTemplateById(id)`
 * resolves to the highest version by default, but synthesizer-emitted plans
 * carry an explicit `template: "<id>@<version>"` hint so the approve-time
 * expansion stays stable even as new versions are added. Never mutate a
 * shipped template's body or placeholder set — bump to `version + 1` instead.
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
 * ## Placeholder naming conventions
 *
 * - Use camelCase semantic names (`implementationFile`, `bugSummary`).
 * - Placeholder `description` explains the *role*, not the format.
 *
 * ## I8 template IDs (synthesizer-emitted, v3.4.0)
 *
 * `foundation-with-fresh-eyes-gate`, `test-coverage`, `doc-update`,
 * `refactor-carve`, `refactor-module`, `inter-wave-fixup`, `new-mcp-tool`,
 * `new-skill`, `add-feature`. Synthesizer hints point at these by id@version.
 *
 * Legacy (pre-3.4.0) templates `add-api-endpoint`, `add-tests`, `fix-bug`,
 * `add-documentation`, `add-integration`, `improve-performance`,
 * `update-configuration` are kept at v1 for backwards compat with tests and
 * prompt output from earlier versions.
 */
const BUILTIN_TEMPLATES = [
    // ── Legacy v1 templates (pre-I8) ──────────────────────────────
    defineTemplate({
        id: "add-api-endpoint",
        version: 1,
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
        version: 1,
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
                description: `Refactor the scan pipeline module to improve separation of parsing from UI formatting while preserving existing behavior.`,
            },
        ],
    }),
    defineTemplate({
        id: "add-tests",
        version: 1,
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
        examples: [{ description: `Add automated tests for plan-to-bead audit warnings.` }],
    }),
    defineTemplate({
        id: "fix-bug",
        version: 1,
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
        dependencyHints: "fix-bug beads are usually independent.",
        examples: [{ description: `Fix the null reference in payment total calculation bug.` }],
    }),
    defineTemplate({
        id: "add-documentation",
        version: 1,
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
        dependencyHints: "Documentation beads usually depend on the implementation bead they document.",
        examples: [{ description: `Write documentation for the payment processing webhook lifecycle.` }],
    }),
    defineTemplate({
        id: "add-integration",
        version: 1,
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
            { name: "interfaceContract", description: "Expected interface or data contract between the systems", example: "BeadPayload JSON", required: true },
            { name: "implementationFile", description: "Primary file where the integration is implemented", example: "src/server.ts", required: true },
            { name: "testFile", description: "Integration test file", example: "src/server.test.ts", required: true },
        ],
        acceptanceCriteria: [
            "Implement the integration following the specified interface contract.",
            "Handle errors at the integration boundary with clear error messages.",
            "Add an integration test covering the happy path and at least one failure mode.",
        ],
        filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
        dependencyHints: "Integration beads depend on the beads that implement both the source and target systems.",
        examples: [{ description: `Integrate payment with fraud-check API.` }],
    }),
    defineTemplate({
        id: "improve-performance",
        version: 1,
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
        dependencyHints: "Performance beads should depend on the implementation bead that creates the code being optimized.",
        examples: [{ description: `Optimize product search query builder.` }],
    }),
    defineTemplate({
        id: "update-configuration",
        version: 1,
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
            { name: "migrationNotes", description: "How existing environments should adapt", example: "existing stdio-only setups continue to work with no changes", required: true },
            { name: "configFile", description: "Primary configuration file", example: "src/config.ts", required: true },
            { name: "validationFile", description: "File where config validation lives", example: "src/config.test.ts", required: true },
        ],
        acceptanceCriteria: [
            "Add or update configuration with input validation for the new values.",
            "Document migration steps for existing environments.",
            "Ensure backwards compatibility or document breaking changes explicitly.",
        ],
        filePatterns: ["*.config.*", "*.json", "*.yaml", "*.yml", "*.toml", "src/**/*.ts"],
        dependencyHints: "Configuration beads are often prerequisites for feature beads that consume the new config.",
        examples: [{ description: `Update the database connection pool configuration.` }],
    }),
    // ── I8 templates (v3.4.0 synthesizer-emitted) ────────────────
    defineTemplate({
        id: "foundation-with-fresh-eyes-gate",
        version: 1,
        label: "Foundation with fresh-eyes gate",
        summary: "Foundation bead guarded by a 5-reviewer cold-read before dependents may run.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- Downstream beads {{PARENT_WAVE_BEADS}} depend on these interfaces being stable before parallel work begins.
- A fresh-eyes gate catches contract drift that single-author review consistently misses.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] Five independent cold-read reviewers confirm the exported surface is unambiguous.
- [ ] No dependent wave may start until the gate clears with zero P1 findings.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "One-line lead sentence describing the foundation change", example: "Introduce BeadTemplateContract at the MCP boundary.", required: true },
            { name: "SCOPE", description: "Exact files, types, and public surface touched", example: "Add BeadTemplateContract to types.ts and export it alongside legacy BeadTemplate.", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Contract is exported and consumed by two downstream beads without reshaping.", required: true },
            { name: "TEST_PLAN", description: "How the foundation work is verified", example: "Contract-tests assert schema round-trip; snapshot-tests lock the exported shape.", required: true },
            { name: "PARENT_WAVE_BEADS", description: "IDs of beads that depend on this foundation clearing its gate", example: "I8, I9", required: true },
            { name: "TARGET_FILE", description: "Primary file introducing the foundational surface", example: "mcp-server/src/types.ts", required: true },
        ],
        acceptanceCriteria: [
            "The foundational surface is reviewable as a standalone contract.",
            "A fresh-eyes reviewer cohort of five has cleared the bead with zero P1 findings.",
            "Downstream beads do not begin until the gate clears.",
        ],
        filePatterns: ["**/*.ts"],
        dependencyHints: "Every parent-wave bead in PARENT_WAVE_BEADS must list this bead as a dependency.",
        examples: [{ description: `Foundation bead: Introduce BeadTemplateContract with 5-reviewer gate; dependents I8, I9.` }],
    }),
    defineTemplate({
        id: "test-coverage",
        version: 1,
        label: "Test coverage",
        summary: "Companion test bead that covers an adjacent implementation bead's public surface.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- {{PARENT_WAVE_BEADS}} introduced behavior that currently lacks directed coverage.
- A companion test bead keeps test authorship out of the feature bead's git diff for easier review.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] At least one happy-path and one failure-path assertion per new public export.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming the surface being covered", example: "Add test-coverage for expandTemplate error branches.", required: true },
            { name: "SCOPE", description: "Which behaviors and public exports are covered", example: "All three error branches of expandTemplate plus one success case.", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Tests prove every FlywheelErrorCode branch fires at least once.", required: true },
            { name: "TEST_PLAN", description: "How the tests are structured", example: "Vitest per-branch cases; snapshot bodies where rendering is load-bearing.", required: true },
            { name: "PARENT_WAVE_BEADS", description: "Bead IDs this test bead is a companion to", example: "I8", required: true },
            { name: "TARGET_FILE", description: "Test file being created or extended", example: "mcp-server/src/__tests__/bead-templates.test.ts", required: true },
        ],
        acceptanceCriteria: [
            "Cover every newly public surface with at least one happy-path and one failure-path test.",
            "Prefer branch-per-test cases over broad snapshots for error paths.",
            "Keep tests independent of each other and free of shared mutable state.",
        ],
        filePatterns: ["**/__tests__/**/*.test.ts"],
        dependencyHints: "test-coverage beads depend on their parent-wave implementation bead.",
        examples: [{ description: `Test-coverage companion for I8 expandTemplate error branches.` }],
    }),
    defineTemplate({
        id: "doc-update",
        version: 1,
        label: "Documentation update",
        summary: "README / AGENTS.md / SKILL.md update accompanying behavior changes.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- Behavior introduced by {{PARENT_WAVE_BEADS}} is not yet reflected in operator-facing documentation.
- Agents reading the outdated docs would follow stale instructions.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] {{TARGET_FILE}} mentions every new public command, env var, or tool name introduced.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming what docs are being updated", example: "Update SKILL.md for flywheel v3.4.0 error codes.", required: true },
            { name: "SCOPE", description: "Which docs and which sections change", example: "SKILL.md §error-branches; AGENTS.md §Hard Constraints.", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Doc mentions every new error code and gives one actionable remediation per code.", required: true },
            { name: "TEST_PLAN", description: "How the doc update is verified", example: "lint:skill clean; manual spot-check of new examples rendering in GitHub.", required: true },
            { name: "PARENT_WAVE_BEADS", description: "Bead IDs driving the doc update", example: "F1, I8", required: true },
            { name: "TARGET_FILE", description: "Doc file being edited", example: "skills/start/SKILL.md", required: true },
        ],
        acceptanceCriteria: [
            "Doc accurately reflects the current behavior after the parent beads land.",
            "Every newly public surface is mentioned at least once.",
            "Lint (e.g. lint:skill) passes cleanly when applicable.",
        ],
        filePatterns: ["**/*.md"],
        dependencyHints: "doc-update beads usually depend on the behavior-change beads they document.",
        examples: [{ description: `Update AGENTS.md §Logging after introducing the new createLogger option.` }],
    }),
    defineTemplate({
        id: "refactor-carve",
        version: 1,
        label: "Refactor — carve module",
        summary: "Carve a large file into smaller domain submodules without behavior change.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- {{TARGET_FILE}} has grown large enough that it is causing reviewer fatigue and merge conflicts.
- Carving into domain submodules improves locality without changing behavior.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] Every external import of {{TARGET_FILE}} continues to resolve (public exports preserved or re-exported).
- [ ] Zero behavioral drift — test suite passes unchanged.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}
- {{CARVED_DIR}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming the carve", example: "Carve topstepx-client.ts into domain submodules.", required: true },
            { name: "SCOPE", description: "Which file is carved and what the target layout looks like", example: "topstepx-client.ts → topstepx/{rest,websocket,auth,types}.ts", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "File size drops by ≥60% and every public export is preserved.", required: true },
            { name: "TEST_PLAN", description: "How behavior preservation is verified", example: "Run the existing test suite green; diff public-export barrel.", required: true },
            { name: "TARGET_FILE", description: "File being carved up", example: "src/topstepx-client.ts", required: true },
            { name: "CARVED_DIR", description: "Directory receiving the carved modules", example: "src/topstepx/", required: true },
        ],
        acceptanceCriteria: [
            "Source file is carved into named domain submodules.",
            "Every external import resolves via the preserved or re-exported public barrel.",
            "Full test suite remains green.",
        ],
        filePatterns: ["src/**/*.ts"],
        dependencyHints: "refactor-carve beads typically block downstream feature beads that touch the same file.",
        examples: [{ description: `Carve topstepx-client.ts into domain submodules with preserved barrel.` }],
    }),
    defineTemplate({
        id: "inter-wave-fixup",
        version: 1,
        label: "Inter-wave fixup",
        summary: "Small fixup between waves once fresh-eyes review surfaces a P1.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- Fresh-eyes review between waves surfaced a P1 issue that will not wait for the next scheduled wave.
- Bead is deliberately small so it can land and clear before the next wave unblocks.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] Total diff stays under ~150 lines; otherwise split into its own wave.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming the fixup", example: "Inter-wave fixup: tighten BeadTemplate placeholder validation.", required: true },
            { name: "SCOPE", description: "What is changing and why it's scoped tight", example: "Tighten module-load warnings; no public-surface change.", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Warning fires once per duplicate (id,version) tuple.", required: true },
            { name: "TEST_PLAN", description: "Minimal regression coverage", example: "Add one regression test in bead-templates.test.ts.", required: true },
            { name: "TARGET_FILE", description: "Primary file receiving the fixup", example: "src/bead-templates.ts", required: true },
        ],
        acceptanceCriteria: [
            "Stay within ~150 lines of diff.",
            "Add a regression test covering the P1 behavior.",
            "Cite the fresh-eyes finding in the commit message.",
        ],
        filePatterns: ["src/**/*.ts"],
        dependencyHints: "inter-wave-fixup beads usually depend on the wave that triggered the review.",
        examples: [{ description: `Inter-wave fixup after P1 finding in Wave 4 review.` }],
    }),
    defineTemplate({
        id: "new-mcp-tool",
        version: 1,
        label: "New MCP tool",
        summary: "Register a new flywheel_* MCP tool end-to-end (schema, handler, tests, docs).",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- The flywheel needs a new tool named {{TOOL_NAME}} to expose {{TOOL_PURPOSE}}.
- Registering the tool in one bead keeps schema, handler, and tests consistent.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] Tool is registered in server.ts with a Zod input schema.
- [ ] Handler returns a structured envelope (success + every FlywheelErrorCode branch documented).

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}
- {{TEST_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming the new tool", example: "Register flywheel_expand_template MCP tool.", required: true },
            { name: "SCOPE", description: "Input schema, output envelope, edge cases", example: "Accepts id+version+input; emits FlywheelErrorCode envelopes for three error branches.", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Tool returns the expanded body and every error branch is tested.", required: true },
            { name: "TEST_PLAN", description: "How the tool is verified", example: "Vitest handler tests + schema round-trip test + smoke test via the CLI.", required: true },
            { name: "TOOL_NAME", description: "Tool name, must start with flywheel_", example: "flywheel_expand_template", required: true },
            { name: "TOOL_PURPOSE", description: "What the tool does for the operator", example: "render a bead template body from a synthesizer hint", required: true },
            { name: "TARGET_FILE", description: "Handler file for the new tool", example: "mcp-server/src/tools/expand-template.ts", required: true },
            { name: "TEST_FILE", description: "Test file for the new tool", example: "mcp-server/src/__tests__/tools/expand-template.test.ts", required: true },
        ],
        acceptanceCriteria: [
            "Tool name starts with flywheel_ and is registered in server.ts.",
            "Handler returns a structured envelope for success and every error branch.",
            "Tests cover happy path and each FlywheelErrorCode branch.",
        ],
        filePatterns: ["mcp-server/src/tools/**/*.ts", "mcp-server/src/server.ts", "mcp-server/src/__tests__/tools/**/*.test.ts"],
        dependencyHints: "new-mcp-tool beads often depend on a foundation-with-fresh-eyes-gate bead that pins the tool's contract.",
        examples: [{ description: `Register flywheel_expand_template tool with three error branches.` }],
    }),
    defineTemplate({
        id: "new-skill",
        version: 1,
        label: "New skill",
        summary: "Add a new skills/<name>/SKILL.md plus matching commands/<name>.md.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- A new capability is being exposed to agents and needs a discoverable skill entry.
- Pairing SKILL.md with commands/<name>.md keeps slash-commands and skill docs in sync.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] skills/{{SKILL_NAME}}/SKILL.md exists and passes lint:skill.
- [ ] commands/{{SKILL_NAME}}.md exists and references the SKILL.md.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}
- {{COMMAND_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming the new skill", example: "Add flywheel-expand-template skill and command.", required: true },
            { name: "SCOPE", description: "What the skill teaches and when it is triggered", example: "Teaches agents to call flywheel_expand_template with (id, version, input).", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Both files exist, reference each other, and clear lint:skill.", required: true },
            { name: "TEST_PLAN", description: "How the skill is verified", example: "Run npm run lint:skill; invoke the slash command in a dry-run agent.", required: true },
            { name: "SKILL_NAME", description: "Directory/command name (lowercase with hyphens)", example: "flywheel-expand-template", required: true },
            { name: "TARGET_FILE", description: "SKILL.md path for the new skill", example: "skills/flywheel-expand-template/SKILL.md", required: true },
            { name: "COMMAND_FILE", description: "commands/<name>.md path", example: "commands/flywheel-expand-template.md", required: true },
        ],
        acceptanceCriteria: [
            "Both SKILL.md and commands/<name>.md exist and cross-reference each other.",
            "lint:skill passes cleanly.",
            "A dry-run of the slash command produces the expected agent guidance.",
        ],
        filePatterns: ["skills/**/SKILL.md", "commands/**/*.md"],
        dependencyHints: "new-skill beads usually depend on the new-mcp-tool bead whose behavior they teach.",
        examples: [{ description: `Add flywheel-expand-template skill plus slash command.` }],
    }),
    defineTemplate({
        id: "add-feature",
        version: 1,
        label: "Add feature",
        summary: "Generic small-feature bead for behavior additions that don't match a dedicated template.",
        descriptionTemplate: `{{TITLE}}

Scope:
{{SCOPE}}

Why this bead exists:
- The feature is small enough to ship in a single bead without a dedicated template.
- Keeping it in one bead gives the reviewer a complete picture of the change.

Acceptance criteria:
- [ ] {{ACCEPTANCE}}
- [ ] Behavior is covered by at least one new or extended test.

Test plan:
{{TEST_PLAN}}

### Files:
- {{TARGET_FILE}}`,
        placeholders: [
            { name: "TITLE", description: "Lead sentence naming the feature", example: "Add --verbose flag to flywheel_status output.", required: true },
            { name: "SCOPE", description: "What is changing and what's intentionally out of scope", example: "Adds opt-in verbose JSON; does not change default output.", required: true },
            { name: "ACCEPTANCE", description: "Primary acceptance criterion", example: "Passing --verbose adds the five documented fields.", required: true },
            { name: "TEST_PLAN", description: "How the feature is verified", example: "One test for default output, one for --verbose.", required: true },
            { name: "TARGET_FILE", description: "Primary file receiving the feature", example: "mcp-server/src/tools/status.ts", required: true },
        ],
        acceptanceCriteria: [
            "Feature is small and behind an opt-in flag or clearly scoped call site.",
            "At least one test covers the new behavior.",
            "Default behavior is unchanged for existing callers.",
        ],
        filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
        dependencyHints: "add-feature beads are usually independent; dependents are flagged case-by-case.",
        examples: [{ description: `Add --verbose flag to flywheel_status.` }],
    }),
];
export const TEMPLATE_INTEGRITY_WARNINGS = validateTemplateIntegrity(BUILTIN_TEMPLATES);
const INVALID_VALUE_PATTERN = /[\r\0]/;
const MAX_PLACEHOLDER_VALUE_LENGTH = 2000;
function cloneTemplate(template) {
    return {
        ...template,
        placeholders: template.placeholders.map((placeholder) => ({ ...placeholder })),
        acceptanceCriteria: [...template.acceptanceCriteria],
        filePatterns: [...template.filePatterns],
        examples: template.examples.map((example) => ({ ...example })),
    };
}
/** Public alias (I8). See `listBeadTemplates` for the legacy name. */
export function listTemplates() {
    return BUILTIN_TEMPLATES.map(cloneTemplate);
}
/** Retained legacy name — delegates to `listTemplates`. */
export function listBeadTemplates() {
    return listTemplates();
}
/**
 * Return the matching template, or undefined if no (id, version) tuple matches.
 * When `version` is omitted, returns the highest-versioned entry for `id`.
 */
export function getTemplateById(templateId, version) {
    const matches = BUILTIN_TEMPLATES.filter((candidate) => candidate.id === templateId);
    if (matches.length === 0)
        return undefined;
    const resolved = version === undefined
        ? matches.reduce((acc, candidate) => candidate.version > acc.version ? candidate : acc)
        : matches.find((candidate) => candidate.version === version);
    return resolved ? cloneTemplate(resolved) : undefined;
}
export function formatTemplatesForPrompt() {
    if (BUILTIN_TEMPLATES.length === 0) {
        return "(No bead templates available — write custom bead descriptions.)";
    }
    return BUILTIN_TEMPLATES.map((template) => {
        const placeholderNames = template.placeholders.map((placeholder) => placeholder.name).join(", ");
        return `- ${template.id}@${template.version}: ${template.summary} Placeholders: ${placeholderNames}`;
    }).join("\n");
}
function validatePlaceholderValues(placeholders) {
    for (const [name, value] of Object.entries(placeholders)) {
        if (INVALID_VALUE_PATTERN.test(value)) {
            return `Invalid placeholder value for ${name}: values must not contain carriage returns or null bytes.`;
        }
        if (value.length > MAX_PLACEHOLDER_VALUE_LENGTH) {
            return `Placeholder value for "${name}" is too long (${value.length} chars, max ${MAX_PLACEHOLDER_VALUE_LENGTH}).`;
        }
    }
    return undefined;
}
/**
 * Normalise `TemplateExpansionInput` — drop undefined entries so downstream
 * required-placeholder checks can treat a `{ title: undefined }` input the
 * same as omitting `title` entirely.
 */
function inputToPlaceholders(input) {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string")
            out[key] = value;
    }
    return out;
}
/**
 * Expand a bead template into its rendered markdown body.
 *
 * @param templateId id portion of the synthesizer hint (`"<id>@<version>"`)
 * @param version    numeric version (must match a registered template)
 * @param input      `TemplateExpansionInput`-shaped placeholder values
 *
 * Error branches (all surface through `FlywheelErrorCode` at the tool edge):
 * - `template_not_found`           — no `(id, version)` tuple matched
 * - `template_placeholder_missing` — a `required: true` placeholder was absent
 * - `template_expansion_failed`    — regex/IO threw, or unresolved markers
 */
export function expandTemplate(templateId, version, input) {
    try {
        const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === templateId && candidate.version === version);
        if (!template) {
            return {
                success: false,
                error: "template_not_found",
                detail: `Unknown bead template: ${templateId}@${version}`,
            };
        }
        const placeholders = inputToPlaceholders(input);
        const invalidValueError = validatePlaceholderValues(placeholders);
        if (invalidValueError) {
            return {
                success: false,
                error: "template_expansion_failed",
                detail: invalidValueError,
            };
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
                error: "template_placeholder_missing",
                detail: `Missing required placeholders for ${templateId}@${version}: ${missingRequired.join(", ")}${hint}`,
            };
        }
        const description = template.descriptionTemplate.replace(PLACEHOLDER_PATTERN, (_match, placeholderName) => {
            return placeholders[placeholderName] ?? `{{${placeholderName}}}`;
        });
        const unresolved = Array.from(description.matchAll(PLACEHOLDER_PATTERN)).map((match) => match[1]);
        if (unresolved.length > 0) {
            return {
                success: false,
                error: "template_expansion_failed",
                detail: `Unresolved placeholders for ${templateId}@${version}: ${Array.from(new Set(unresolved)).join(", ")}`,
            };
        }
        return { success: true, description };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            error: "template_expansion_failed",
            detail: `Unexpected expansion failure for ${templateId}@${version}: ${msg}`,
        };
    }
}
//# sourceMappingURL=bead-templates.js.map