const DEFAULT_MAX_DURATION_MS = 900;
const MIN_TERMINAL_WIDTH_FOR_ANIMATION = 56;
const DEFAULT_RUNTIME = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const CEREMONY_FRAMES = [
    {
        text: "░▒▓ CLAUDE // AGENT-FLYWHEEL ▓▒░\n" +
            "> boot sequence .......... [warm]\n" +
            "> scanning the void ...... [linking]",
        delayMs: 120,
    },
    {
        text: "░▒▓ CLAUDE // AGENT-FLYWHEEL ▓▒░\n" +
            "> boot sequence .......... [online]\n" +
            "> scanning the void ...... [mapped]\n" +
            "> summoning bead engine .. [spinning]",
        delayMs: 180,
    },
    {
        text: "░▒▓ CLAUDE // AGENT-FLYWHEEL ▓▒░\n" +
            "> repo sigil ............. [bound]\n" +
            "> bead engine ............ [ready]\n" +
            "> ceremony complete ...... [ignite /start]",
        delayMs: 220,
    },
];
const STATIC_FALLBACK_FRAME = "░▒▓ CLAUDE // AGENT-FLYWHEEL ▓▒░\n" +
    "> ceremony complete ...... [ignite /start]";
export function getOpeningCeremonyFrames() {
    return CEREMONY_FRAMES.map((frame) => ({ ...frame }));
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
            await writeFrame(writer, STATIC_FALLBACK_FRAME);
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
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
//# sourceMappingURL=opening-ceremony.js.map