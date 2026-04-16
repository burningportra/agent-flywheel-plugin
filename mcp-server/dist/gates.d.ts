import type { ExecFn } from "./exec.js";
import type { FlywheelState } from "./types.js";
export declare function runGuidedGates(exec: ExecFn, cwd: string, st: FlywheelState, extraInfo: string, saveState: () => void): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    details: any;
}>;
//# sourceMappingURL=gates.d.ts.map