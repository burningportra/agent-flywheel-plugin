import { z } from "zod";
export declare const BrListRowSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<{
        open: "open";
        in_progress: "in_progress";
        closed: "closed";
        deferred: "deferred";
    }>>;
    priority: z.ZodOptional<z.ZodNumber>;
    labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    template: z.ZodOptional<z.ZodString>;
    created_ts: z.ZodOptional<z.ZodString>;
    closed_ts: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type BrListRow = z.infer<typeof BrListRowSchema>;
export declare function parseBrListArray(rows: unknown[]): {
    rows: BrListRow[];
    rejected: number;
};
export declare function parseBrList(rawJson: string): {
    rows: BrListRow[];
    rejected: number;
};
//# sourceMappingURL=br-parser.d.ts.map