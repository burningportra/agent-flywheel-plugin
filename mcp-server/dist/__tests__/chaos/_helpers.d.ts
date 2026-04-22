/**
 * Shared test utilities for the T13 chaos + regression harness.
 * Prefixed with underscore so vitest does not collect this as a test file.
 */
import type { ExecFn } from '../../exec.js';
/**
 * Create a temp directory that looks like an agent-flywheel project root.
 * Includes a minimal mcp-server/dist/server.js so doctor's dist_drift
 * check stays green when using allGreenExec.
 */
export declare function makeTmpCwd(): string;
export declare function cleanupTmpCwd(dir: string): void;
export type ExecStubRespond = {
    result: {
        code: number;
        stdout: string;
        stderr: string;
    };
} | {
    throws: Error;
} | {
    hangMs: number;
    result?: undefined;
};
export interface ExecStub {
    match: (cmd: string, args: readonly string[]) => boolean;
    respond: ExecStubRespond;
}
/**
 * Build an ExecFn from an array of stubs. Unmatched commands return
 * `{ code: 1, stdout: '', stderr: 'not mocked: <cmd>' }` — surfaces
 * unexpected calls in test output without throwing.
 */
export declare function makeExecFn(stubs: ExecStub[]): ExecFn;
/** Returns a stub set where every exec-based check resolves green. */
export declare function allGreenStubs(): ExecStub[];
/**
 * Merge two stub arrays. Stubs in `overrides` take precedence over `base`
 * for any command that both match.
 */
export declare function mergeStubs(base: ExecStub[], overrides: ExecStub[]): ExecStub[];
//# sourceMappingURL=_helpers.d.ts.map