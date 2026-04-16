import type { ExecFn } from "./exec.js";
import type { RepoProfile, ScanCodebaseAnalysis, ScanErrorInfo, ScanResult, ScanSource } from "./types.js";
/**
 * Scan the repository through the shared scan contract.
 *
 * Downstream code should keep reading `result.profile` for the legacy
 * `RepoProfile` fields. When available, `codebaseAnalysis` carries richer
 * ccc-derived context that later workflow stages can prioritize.
 */
export declare function scanRepo(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<ScanResult>;
export declare function createBuiltinScanResult(profile: RepoProfile): ScanResult;
export declare function createFallbackScanResult(profile: RepoProfile, source: Exclude<ScanSource, "builtin">, error?: ScanErrorInfo): ScanResult;
export declare function createEmptyCodebaseAnalysis(): ScanCodebaseAnalysis;
//# sourceMappingURL=scan.d.ts.map