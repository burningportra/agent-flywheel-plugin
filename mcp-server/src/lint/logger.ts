import process from "node:process";

type Level = "error" | "warn" | "info" | "debug";
const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function envLevel(): Level {
  const v = (process.env.LINT_LOG_LEVEL ?? "warn").toLowerCase();
  return (["error", "warn", "info", "debug"] as const).find((l) => l === v) ?? "warn";
}

export interface LintLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLintLogger(
  ctx: string,
  options: { levelOverride?: Level } = {},
): LintLogger {
  const cap = LEVELS[options.levelOverride ?? envLevel()];
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] > cap) return;
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      ctx,
      msg,
      ...(fields ?? {}),
    });
    process.stderr.write(payload + "\n");
  };
  return {
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}
