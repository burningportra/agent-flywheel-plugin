import type { FlywheelState } from '../../types.js';
export interface ExecCall {
    cmd: string;
    args: string[];
    result: {
        code: number;
        stdout: string;
        stderr: string;
    };
}
/**
 * Creates a mock ExecFn that returns pre-programmed responses.
 * Unmatched commands return { code: 1, stdout: '', stderr: 'not mocked' }.
 */
export declare function createMockExec(calls?: ExecCall[]): (cmd: string, args: string[], _opts?: unknown) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
export declare function makeState(overrides?: Partial<FlywheelState>): FlywheelState;
//# sourceMappingURL=mocks.d.ts.map