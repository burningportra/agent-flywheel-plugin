type Level = "error" | "warn" | "info" | "debug";
export interface LintLogger {
    error(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    debug(msg: string, fields?: Record<string, unknown>): void;
}
export declare function createLintLogger(ctx: string, options?: {
    levelOverride?: Level;
}): LintLogger;
export {};
//# sourceMappingURL=logger.d.ts.map