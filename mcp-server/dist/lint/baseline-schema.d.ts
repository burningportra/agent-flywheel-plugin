import { z } from "zod";
export declare const BaselineFileSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    rulesetVersion: z.ZodNumber;
    generated: z.ZodString;
    entries: z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        rulesetVersion: z.ZodNumber;
        file: z.ZodString;
        line: z.ZodNumber;
        fingerprint: z.ZodString;
        reason: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
//# sourceMappingURL=baseline-schema.d.ts.map