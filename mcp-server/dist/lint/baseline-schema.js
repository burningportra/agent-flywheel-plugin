import { z } from "zod";
// Only loaded when a baseline fails the zod-free check in baseline.ts, so zod
// stays off the lint startup path and a bad file still gets zod's error.
const BaselineEntrySchema = z.object({
    ruleId: z.string(),
    rulesetVersion: z.number().int().nonnegative(),
    file: z.string(),
    line: z.number().int().positive(),
    fingerprint: z.string(),
    reason: z.string().default(""),
});
export const BaselineFileSchema = z.object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.number().int().nonnegative(),
    generated: z.string(),
    entries: z.array(BaselineEntrySchema),
});
//# sourceMappingURL=baseline-schema.js.map