/**
 * skills-bundle: runtime loader for the skills bundle produced by T12's
 * `build-skills-bundle` script. Implements 4-layer drift defense for the
 * `flywheel_get_skill` MCP tool (T13):
 *
 *   1. Build-time CI gate (check:skills-bundle, T12).
 *   2. Runtime manifestSha256 integrity check — on mismatch, log a warn
 *      with code `bundle_integrity_failed` and fall back to disk reads.
 *   3. Per-entry srcSha256 stale-warn — bundle is still served, but the
 *      result carries `staleWarn: true`.
 *   4. `FW_SKILL_BUNDLE=off` env-bypass — short-circuits to disk reads
 *      so contributors editing skills/*.md see live changes.
 *
 * The bundle is cached in module scope after the first successful load.
 * On integrity failure, the cache is invalidated so callers retry from
 * disk on every call until the bundle is rebuilt.
 */
interface Frontmatter {
    name?: string;
    description?: string;
    [k: string]: unknown;
}
export interface SkillBundleEntry {
    name: string;
    path: string;
    frontmatter: Frontmatter;
    body: string;
    srcSha256: string;
    sizeBytes: number;
    bundledAt: string;
}
export interface SkillsBundle {
    bundleVersion: 1;
    generatedAt: string;
    generator: string;
    manifestSha256: string;
    entries: SkillBundleEntry[];
}
export interface GetSkillResult {
    name: string;
    frontmatter: Record<string, unknown>;
    body: string;
    source: "bundle" | "disk";
    staleWarn?: boolean;
}
/**
 * Load + verify the skills bundle. Returns null on integrity failure or any
 * IO error so the caller can transparently fall back to disk reads.
 *
 * Cached across calls keyed by bundle path. Cache is invalidated on
 * integrity failure.
 */
export declare function loadSkillsBundle(bundlePath?: string): SkillsBundle | null;
/** Reset the module-scope cache. Test-only. */
export declare function _resetSkillsBundleCache(): void;
/**
 * Resolve a skill by name. Honors:
 *   - FW_SKILL_BUNDLE=off → always disk
 *   - bundle integrity → falls back to disk on mismatch
 *   - per-entry srcSha256 → adds staleWarn flag (still serves bundle)
 *
 * Throws FlywheelError(code: "not_found") when the name doesn't resolve in
 * either the bundle or on disk.
 */
export declare function getSkill(name: string, opts?: {
    repoRoot?: string;
    bundlePath?: string;
}): Promise<GetSkillResult>;
export {};
//# sourceMappingURL=skills-bundle.d.ts.map