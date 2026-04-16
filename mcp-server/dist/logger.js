/**
 * Structured stderr logger for agent-flywheel MCP server.
 *
 * Writes JSON lines to process.stderr (safe for MCP stdio — never touches stdout).
 * Level filtering via FW_LOG_LEVEL env var (default: "warn").
 * Level order: debug < info < warn < error.
 */
export const LEVELS = ["debug", "info", "warn", "error"];
const MIN_LEVEL = (() => {
    const raw = (process.env.FW_LOG_LEVEL ?? "warn").toLowerCase();
    const idx = LEVELS.indexOf(raw);
    if (idx < 0) {
        process.stderr.write(JSON.stringify({
            ts: new Date().toISOString(), level: "warn", ctx: "logger",
            msg: `Unknown FW_LOG_LEVEL="${raw}", defaulting to "warn"`,
        }) + "\n");
        return 2;
    }
    return idx;
})();
function writeLog(level, ctx, msg, fields) {
    if (LEVELS.indexOf(level) < MIN_LEVEL)
        return;
    const line = {
        ts: new Date().toISOString(),
        level,
        ctx,
        msg,
        ...fields,
    };
    process.stderr.write(JSON.stringify(line) + "\n");
}
/** Create a logger scoped to a context tag (e.g. "beads", "server"). */
export function createLogger(ctx) {
    return {
        debug: (msg, fields) => writeLog("debug", ctx, msg, fields),
        info: (msg, fields) => writeLog("info", ctx, msg, fields),
        warn: (msg, fields) => writeLog("warn", ctx, msg, fields),
        error: (msg, fields) => writeLog("error", ctx, msg, fields),
    };
}
//# sourceMappingURL=logger.js.map