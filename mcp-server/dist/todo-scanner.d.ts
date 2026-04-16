import type { ExecFn } from "./exec.js";
import type { TodoItem } from "./types.js";
/**
 * Pluggable TODO scanner interface.
 *
 * Each scanner produces a list of TodoItems for a repo at `cwd`.
 * Scanners receive an `exec` function (so tests can mock subprocess calls)
 * and must return identical TodoItem shapes regardless of implementation.
 *
 * The default is `grepScanner` (subprocess-based), which preserves the
 * pre-refactor behavior. Bead 5w3 adds `tsAstScanner` (TS/JS AST-aware)
 * and `pythonTodoScanner` (Python regex-tuned) on top.
 */
export interface TodoScanner {
    name: string;
    scan(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]>;
}
/**
 * Legacy grep-based TODO scanner. Spawns `grep -rnE "(TODO|FIXME|HACK|XXX):"`
 * scoped to common source extensions and directories.
 */
export declare const grepScanner: TodoScanner;
/** Reset cached lazy-load. Exported for test isolation. */
export declare function _resetTsModuleCache(): void;
export declare const tsAstScanner: TodoScanner;
export declare const pythonTodoScanner: TodoScanner;
/**
 * Merge and dedupe TodoItems by (file, line). First occurrence wins so that
 * grep-based results (which run first in the default scanner list) are
 * preserved over AST-scanner finds on the same line.
 */
export declare function mergeAndDedup(items: TodoItem[]): TodoItem[];
/**
 * Choose which scanners to run based on env configuration.
 *
 * Default: `[grepScanner, tsAstScanner, pythonTodoScanner]`.
 * `FLYWHEEL_PROFILE_SCANNER=grep` forces only grep (legacy rollback).
 */
export declare function selectScanners(env?: NodeJS.ProcessEnv): TodoScanner[];
//# sourceMappingURL=todo-scanner.d.ts.map