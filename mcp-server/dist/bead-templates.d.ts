import type { BeadTemplate, ExpandTemplateResult } from "./types.js";
export declare const TEMPLATE_INTEGRITY_WARNINGS: string[];
export declare function listBeadTemplates(): BeadTemplate[];
export declare function getTemplateById(templateId: string): BeadTemplate | undefined;
export declare function formatTemplatesForPrompt(): string;
export declare function expandTemplate(templateId: string, placeholders: Record<string, string>): ExpandTemplateResult;
//# sourceMappingURL=bead-templates.d.ts.map