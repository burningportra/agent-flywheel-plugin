import process from "node:process";
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function envLevel() {
    const v = (process.env.LINT_LOG_LEVEL ?? "warn").toLowerCase();
    return ["error", "warn", "info", "debug"].find((l) => l === v) ?? "warn";
}
export function createLintLogger(ctx, options = {}) {
    const cap = LEVELS[options.levelOverride ?? envLevel()];
    const emit = (lvl, msg, fields) => {
        if (LEVELS[lvl] > cap)
            return;
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
//# sourceMappingURL=logger.js.map