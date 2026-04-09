/**
 * Structured stderr logger for claude-orchestrator MCP server.
 *
 * Writes JSON lines to process.stderr (safe for MCP stdio — never touches stdout).
 * Level filtering via ORCH_LOG_LEVEL env var (default: "warn").
 * Level order: debug < info < warn < error.
 */

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

const MIN_LEVEL: number = (() => {
  const raw = (process.env.ORCH_LOG_LEVEL ?? "warn").toLowerCase();
  const idx = LEVELS.indexOf(raw as Level);
  if (idx < 0) {
    process.stderr.write(JSON.stringify({
      ts: new Date().toISOString(), level: "warn", ctx: "logger",
      msg: `Unknown ORCH_LOG_LEVEL="${raw}", defaulting to "warn"`,
    }) + "\n");
    return 2;
  }
  return idx;
})();

function writeLog(
  level: Level,
  ctx: string,
  msg: string,
  fields?: Record<string, unknown>
): void {
  if (LEVELS.indexOf(level) < MIN_LEVEL) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ctx,
    msg,
    ...fields,
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Create a logger scoped to a context tag (e.g. "beads", "server"). */
export function createLogger(ctx: string): Logger {
  return {
    debug: (msg, fields) => writeLog("debug", ctx, msg, fields),
    info: (msg, fields) => writeLog("info", ctx, msg, fields),
    warn: (msg, fields) => writeLog("warn", ctx, msg, fields),
    error: (msg, fields) => writeLog("error", ctx, msg, fields),
  };
}
