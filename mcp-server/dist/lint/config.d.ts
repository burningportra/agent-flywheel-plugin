import { z } from "zod";
export declare const LintConfigSchema: z.ZodObject<{
    baselinePath: z.ZodOptional<z.ZodString>;
    manifestPath: z.ZodOptional<z.ZodString>;
    allowlistPath: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type LintConfig = z.infer<typeof LintConfigSchema>;
//# sourceMappingURL=config.d.ts.map