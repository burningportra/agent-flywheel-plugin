/**
 * Structured stderr logger for agent-flywheel MCP server.
 *
 * Writes JSON lines to process.stderr (safe for MCP stdio — never touches stdout).
 * Level filtering via FW_LOG_LEVEL env var (default: "warn").
 * Level order: debug < info < warn < error.
 */
export declare const LEVELS: readonly ["debug", "info", "warn", "error"];
export type Level = (typeof LEVELS)[number];
export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}
/** Create a logger scoped to a context tag (e.g. "beads", "server"). */
export declare function createLogger(ctx: string): Logger;
//# sourceMappingURL=logger.d.ts.map