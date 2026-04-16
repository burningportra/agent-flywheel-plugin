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
 * pre-refactor behavior. Future scanners (TS AST, Python AST, etc.) can
 * be added via `selectScanners` without touching the grep path.
 */
export interface TodoScanner {
  name: string;
  scan(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]>;
}

/**
 * Legacy grep-based TODO scanner. Spawns `grep -rnE "(TODO|FIXME|HACK|XXX):"`
 * scoped to common source extensions and directories.
 *
 * Behavior must remain identical to the original inline implementation in
 * profiler.ts so bead 5w3 can layer additional scanners on top without
 * regressing existing users.
 */
export const grepScanner: TodoScanner = {
  name: "grep",
  async scan(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<TodoItem[]> {
    const result = await exec(
      "grep",
      [
        "-rn",
        "--include=*.ts", "--include=*.js", "--include=*.tsx", "--include=*.jsx",
        "--include=*.py", "--include=*.rs", "--include=*.go", "--include=*.rb",
        "--include=*.java", "--include=*.kt", "--include=*.swift",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=build",
        "--exclude-dir=vendor",
        "--exclude-dir=target",
        "--exclude-dir=__pycache__",
        "--exclude-dir=.venv",
        "--exclude-dir=.pi-flywheel",
        "-E", "(TODO|FIXME|HACK|XXX):",
        ".",
      ],
      { timeout: 10000, cwd, signal }
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 50)
      .map((line) => {
        const match = line.match(
          /^\.\/(.+?):(\d+):\s*.*?(TODO|FIXME|HACK|XXX):\s*(.*)$/
        );
        if (!match) return null;
        return {
          file: match[1],
          line: parseInt(match[2], 10),
          type: match[3] as TodoItem["type"],
          text: match[4].trim(),
        };
      })
      .filter((t): t is TodoItem => t !== null);
  },
};

/**
 * Choose which scanners to run based on env configuration.
 *
 * Today this always returns `[grepScanner]`. Once bead 5w3 lands AST-based
 * scanners, the default will include those too. Setting
 * `FLYWHEEL_PROFILE_SCANNER=grep` is the explicit legacy rollback path that
 * forces only the grep scanner regardless of future defaults.
 */
export function selectScanners(env: NodeJS.ProcessEnv = process.env): TodoScanner[] {
  if (env.FLYWHEEL_PROFILE_SCANNER === "grep") {
    return [grepScanner];
  }
  return [grepScanner];
}
