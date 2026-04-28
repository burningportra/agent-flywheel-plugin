import { z } from "zod";
export declare const BrListRowSchema: z.ZodPipe<z.ZodObject<{
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
    description: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    created_ts: z.ZodOptional<z.ZodString>;
    closed_ts: z.ZodOptional<z.ZodString>;
    created_at: z.ZodOptional<z.ZodString>;
    closed_at: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodTransform<{
    template: string | undefined;
    created_ts: string | undefined;
    closed_ts: string | undefined;
    id: string;
    title: string;
    status: "open" | "in_progress" | "closed" | "deferred";
    priority?: number | undefined;
    labels?: string[] | undefined;
    description?: string | undefined;
    created_at?: string | undefined;
    closed_at?: string | undefined;
}, {
    [x: string]: unknown;
    id: string;
    title: string;
    status: "open" | "in_progress" | "closed" | "deferred";
    priority?: number | undefined;
    labels?: string[] | undefined;
    description?: string | undefined;
    template?: string | undefined;
    created_ts?: string | undefined;
    closed_ts?: string | undefined;
    created_at?: string | undefined;
    closed_at?: string | undefined;
}>>;
export type BrListRow = z.output<typeof BrListRowSchema>;
export declare function parseBrListArray(rows: unknown[]): {
    rows: BrListRow[];
    rejected: number;
};
export declare function parseBrList(rawJson: string): {
    rows: BrListRow[];
    rejected: number;
};
//# sourceMappingURL=br-parser.d.ts.map