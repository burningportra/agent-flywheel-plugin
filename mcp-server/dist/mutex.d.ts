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
/**
 * File-lock-aware mutex for `flywheel_remediate`. Uses both an in-process Set
 * and an exclusive `.pi-flywheel/remediate.lock` file (atomic O_EXCL create).
 * Returns the absolute lock-file path on success, or null on contention.
 */
export declare function acquireRemediateLock(cwd: string, checkName: string): Promise<string | null>;
export declare function releaseRemediateLock(checkName: string, lockPath: string | null): Promise<void>;
//# sourceMappingURL=mutex.d.ts.map