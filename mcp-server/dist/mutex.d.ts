import type { FlywheelToolName, FlywheelPhase } from './types.js';
export declare function acquireBeadMutex(key: string): boolean;
export declare function releaseBeadMutex(key: string): void;
export declare function makeConcurrentWriteError(tool: FlywheelToolName, phase: FlywheelPhase, key: string): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: true;
    structuredContent: import("./errors.js").FlywheelStructuredError;
};
export declare function _resetForTest(): void;
//# sourceMappingURL=mutex.d.ts.map