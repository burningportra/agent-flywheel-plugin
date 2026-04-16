import { z } from "zod";
declare const ManifestFileSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    generated: z.ZodString;
    skills: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;
export declare function loadManifest(filepath: string): Promise<ManifestFile | null>;
export declare function saveManifest(filepath: string, manifest: ManifestFile): Promise<void>;
export declare function discoverRepoSkills(repoRoot: string): Promise<string[]>;
export declare function generateManifest(repoRoot: string): Promise<ManifestFile>;
export {};
//# sourceMappingURL=manifest.d.ts.map