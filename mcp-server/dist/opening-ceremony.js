import { VERSION } from "./version.js";
import { errMsg } from "./errors.js";
const DEFAULT_MAX_DURATION_MS = 900;
const MIN_TERMINAL_WIDTH_FOR_ANIMATION = 56;
const DEFAULT_RUNTIME = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
function buildCeremonyFrames() {
    return [
        {
            text: `░▒▓ CLAUDE // AGENT-FLYWHEEL v${VERSION} ▓▒░\n` +
                "> boot sequence .......... [warm]\n" +
                "> scanning the void ...... [linking]",
            delayMs: 120,
        },
        {
            text: `░▒▓ CLAUDE // AGENT-FLYWHEEL v${VERSION} ▓▒░\n` +
                "> boot sequence .......... [online]\n" +
                "> scanning the void ...... [mapped]\n" +
                "> summoning bead engine .. [spinning]",
            delayMs: 180,
        },
        {
            text: `░▒▓ CLAUDE // AGENT-FLYWHEEL v${VERSION} ▓▒░\n` +
                "> repo sigil ............. [bound]\n" +
                "> bead engine ............ [ready]\n" +
                "> ceremony complete ...... [ignite /start]",
            delayMs: 220,
        },
    ];
}
function buildStaticFallback() {
    return (`░▒▓ CLAUDE // AGENT-FLYWHEEL v${VERSION} ▓▒░\n` +
        "> ceremony complete ...... [ignite /start]");
}
export function getOpeningCeremonyFrames() {
    return buildCeremonyFrames().map((frame) => ({ ...frame }));
}
export function resolveOpeningCeremonyMode(options = {}) {
    if (options.enabled === false || options.quiet === true) {
        return "skip";
    }
    if (options.interactive === false || options.reducedMotion === true) {
        return "static";
    }
    if (typeof options.terminalWidth === "number" &&
        options.terminalWidth > 0 &&
        options.terminalWidth < MIN_TERMINAL_WIDTH_FOR_ANIMATION) {
        return "static";
    }
    return "animated";
}
function normalizeDurationCap(maxDurationMs) {
    if (typeof maxDurationMs !== "number" || Number.isNaN(maxDurationMs)) {
        return DEFAULT_MAX_DURATION_MS;
    }
    return Math.max(0, maxDurationMs);
}
function getSleepDuration(delayMs, remainingMs) {
    if (remainingMs <= 0)
        return 0;
    return Math.max(0, Math.min(delayMs, remainingMs));
}
async function writeFrame(writer, text) {
    await writer.write(`${text}\n`);
}
export async function runOpeningCeremony(writer, options = {}) {
    const runtime = options.runtime ?? DEFAULT_RUNTIME;
    const startedAt = runtime.now();
    const maxDurationMs = normalizeDurationCap(options.maxDurationMs);
    const mode = resolveOpeningCeremonyMode(options);
    try {
        if (mode === "skip") {
            return {
                rendered: false,
                mode,
                frameCount: 0,
                durationMs: Math.max(0, runtime.now() - startedAt),
            };
        }
        if (mode === "static") {
            await writeFrame(writer, buildStaticFallback());
            return {
                rendered: true,
                mode,
                frameCount: 1,
                durationMs: Math.max(0, runtime.now() - startedAt),
            };
        }
        const frames = getOpeningCeremonyFrames();
        let remainingMs = maxDurationMs;
        for (let index = 0; index < frames.length; index += 1) {
            const frame = frames[index];
            await writeFrame(writer, frame.text);
            const isLastFrame = index === frames.length - 1;
            if (isLastFrame) {
                continue;
            }
            const sleepFor = getSleepDuration(frame.delayMs, remainingMs);
            remainingMs = Math.max(0, remainingMs - sleepFor);
            if (sleepFor > 0) {
                await runtime.sleep(sleepFor);
            }
        }
        return {
            rendered: true,
            mode,
            frameCount: frames.length,
            durationMs: Math.min(maxDurationMs, Math.max(0, runtime.now() - startedAt)),
        };
    }
    catch (error) {
        return {
            rendered: false,
            mode,
            frameCount: 0,
            durationMs: Math.min(maxDurationMs, Math.max(0, runtime.now() - startedAt)),
            error: errMsg(error),
        };
    }
}
//# sourceMappingURL=opening-ceremony.js.map