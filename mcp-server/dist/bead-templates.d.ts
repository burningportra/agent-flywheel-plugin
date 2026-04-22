import type { BeadTemplate, ExpandTemplateResult, TemplateExpansionInput } from "./types.js";
export declare const TEMPLATE_INTEGRITY_WARNINGS: string[];
/** Public alias (I8). See `listBeadTemplates` for the legacy name. */
export declare function listTemplates(): BeadTemplate[];
/** Retained legacy name — delegates to `listTemplates`. */
export declare function listBeadTemplates(): BeadTemplate[];
/**
 * Return the matching template, or undefined if no (id, version) tuple matches.
 * When `version` is omitted, returns the highest-versioned entry for `id`.
 */
export declare function getTemplateById(templateId: string, version?: number): BeadTemplate | undefined;
export declare function formatTemplatesForPrompt(): string;
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
export declare function expandTemplate(templateId: string, version: number, input: TemplateExpansionInput): ExpandTemplateResult;
//# sourceMappingURL=bead-templates.d.ts.map