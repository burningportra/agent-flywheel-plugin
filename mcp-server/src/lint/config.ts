import { z } from "zod";

export const LintConfigSchema = z
  .object({
    /** Future: per-rule severity overrides, etc. T11 expands this. */
    baselinePath: z.string().optional(),
    manifestPath: z.string().optional(),
    allowlistPath: z.string().optional(),
  })
  .strict();

export type LintConfig = z.infer<typeof LintConfigSchema>;
