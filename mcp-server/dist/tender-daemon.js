import { exec as execCb } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fetchInbox } from "./agent-mail.js";
import { makeExec } from "./exec.js";
import { DEFAULT_TENDER_DAEMON_AGENT, DEFAULT_TENDER_DAEMON_INTERVAL_MS, makeTenderDaemonStoppedEvent, runTenderDaemonOnce, } from "./tender.js";
import { createLogger } from "./logger.js";
const execAsync = promisify(execCb);
const DEFAULT_LOGFILE = ".pi-flywheel/tender-events.log";
const DEFAULT_NTM_TIMEOUT_MS = 5_000;
const ROBOT_STATES = new Set(["working", "idle", "rate_limited", "error", "context_low"]);
export function usageText() {
    return [
        "Usage:",
        "  tender-daemon --session=<tmux-name> [--project=<cwd>] [--interval=30000] [--logfile=.pi-flywheel/tender-events.log] [--agent=FlywheelAgent]",
        "",
        "Required:",
        "  --session  NTM session name",
        "",
        "Optional:",
        "  --project  Project path used for fetch_inbox and ntm cwd (default: process.cwd())",
        "  --interval Poll interval in milliseconds (default 30000)",
        "  --logfile  NDJSON event log path (default .pi-flywheel/tender-events.log)",
        "  --agent    Agent-mail identity for inbox polling (default FlywheelAgent)",
    ].join("\n");
}
function parsePositiveInt(raw, flag) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${flag} must be a positive integer, got '${raw}'`);
    }
    return value;
}
export function parseTenderDaemonArgs(argv) {
    const parsed = {
        interval: DEFAULT_TENDER_DAEMON_INTERVAL_MS,
        logfile: DEFAULT_LOGFILE,
        agent: DEFAULT_TENDER_DAEMON_AGENT,
        ntmTimeoutMs: DEFAULT_NTM_TIMEOUT_MS,
    };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) {
            return { ok: false, error: `unexpected positional argument '${token}'` };
        }
        const eq = token.indexOf("=");
        const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
        const value = eq >= 0 ? token.slice(eq + 1) : argv[i + 1];
        const consumedNext = eq < 0 && value !== undefined && !value.startsWith("--");
        if (value === undefined || value.length === 0) {
            return { ok: false, error: `--${key} requires a value` };
        }
        switch (key) {
            case "session":
                parsed.session = value;
                break;
            case "project":
                parsed.project = value;
                break;
            case "interval":
                try {
                    parsed.interval = parsePositiveInt(value, "--interval");
                }
                catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
                break;
            case "logfile":
                parsed.logfile = value;
                break;
            case "agent":
                parsed.agent = value;
                break;
            case "ntm-timeout":
                try {
                    parsed.ntmTimeoutMs = parsePositiveInt(value, "--ntm-timeout");
                }
                catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
                break;
            default:
                return { ok: false, error: `unknown flag '--${key}'` };
        }
        if (consumedNext)
            i++;
    }
    if (!parsed.session)
        return { ok: false, error: "missing required --session" };
    return {
        ok: true,
        args: {
            session: parsed.session,
            project: parsed.project ?? process.cwd(),
            interval: parsed.interval ?? DEFAULT_TENDER_DAEMON_INTERVAL_MS,
            logfile: parsed.logfile ?? DEFAULT_LOGFILE,
            agent: parsed.agent ?? DEFAULT_TENDER_DAEMON_AGENT,
            ntmTimeoutMs: parsed.ntmTimeoutMs ?? DEFAULT_NTM_TIMEOUT_MS,
        },
    };
}
function normalizeState(value) {
    return value?.trim().toLowerCase() ?? "";
}
function parseRobotState(raw) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0)
        return null;
    const compact = normalized.split(/\s+/);
    for (const token of compact) {
        const cleaned = token.replace(/[^a-z_]/g, "");
        if (ROBOT_STATES.has(cleaned))
            return cleaned;
    }
    return compact[0] ?? null;
}
function collectPaneStates(value, out) {
    if (Array.isArray(value)) {
        for (const item of value)
            collectPaneStates(item, out);
        return;
    }
    if (!value || typeof value !== "object")
        return;
    const obj = value;
    const pane = (typeof obj.pane === "string" && obj.pane) ||
        (typeof obj.name === "string" && obj.name) ||
        (typeof obj.id === "string" && obj.id) ||
        null;
    const stateRaw = (typeof obj.state === "string" && obj.state) ||
        (typeof obj.status === "string" && obj.status) ||
        (typeof obj.health === "string" && obj.health) ||
        null;
    if (pane && stateRaw) {
        const state = normalizeState(stateRaw);
        if (state.length > 0)
            out[pane] = state;
    }
    const entries = Object.entries(obj);
    for (const [key, nested] of entries) {
        if (typeof nested === "string") {
            const state = normalizeState(nested);
            if (state.length > 0 && (ROBOT_STATES.has(state) || state.includes("idle") || state.includes("working"))) {
                out[key] = state;
            }
            continue;
        }
        collectPaneStates(nested, out);
    }
}
export function parsePaneStates(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return {};
    try {
        const parsed = JSON.parse(trimmed);
        const out = {};
        collectPaneStates(parsed, out);
        if (Object.keys(out).length > 0)
            return out;
    }
    catch {
        // fall through to line parser
    }
    const states = {};
    for (const line of trimmed.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0)
            continue;
        const colon = text.match(/^([^:=\s]+)\s*[:=]\s*([^\s]+)$/);
        if (colon) {
            states[colon[1]] = normalizeState(colon[2]);
            continue;
        }
        const spaced = text.match(/^([^\s]+)\s+([^\s]+)$/);
        if (spaced) {
            states[spaced[1]] = normalizeState(spaced[2]);
        }
    }
    return states;
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
async function defaultRunCommand(command, opts) {
    const result = await execAsync(command, {
        cwd: opts.cwd,
        timeout: opts.timeout,
        signal: opts.signal,
        maxBuffer: 1024 * 1024,
    });
    return {
        stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
        stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    };
}
function normalizeMessage(input) {
    const numericId = typeof input.id === "number" ? input.id : Number.parseInt(String(input.id), 10);
    if (!Number.isFinite(numericId))
        return null;
    return {
        id: numericId,
        thread_id: input.thread_id,
        sender_name: input.sender_name,
        subject: input.subject,
        importance: input.importance,
        created_ts: input.created_ts,
    };
}
async function appendEvent(logfile, event) {
    await mkdir(path.dirname(logfile), { recursive: true });
    await appendFile(logfile, `${JSON.stringify(event)}\n`, "utf8");
}
async function runNtmCommand(runCommandFn, command, opts, log) {
    try {
        const result = await runCommandFn(command, opts);
        return result.stdout;
    }
    catch (err) {
        const failure = err;
        log.warn("NTM command failed", {
            command,
            error: failure.message ?? String(err),
            stderr: failure.stderr,
        });
        return typeof failure.stdout === "string" ? failure.stdout : "";
    }
}
export async function startTenderDaemon(args, deps = {}) {
    const fetchInboxFn = deps.fetchInboxFn ?? fetchInbox;
    const makeExecFn = deps.makeExecFn ?? makeExec;
    const runCommandFn = deps.runCommandFn ?? defaultRunCommand;
    const loggerFactory = deps.createLoggerFn ?? createLogger;
    const log = loggerFactory("tender-daemon");
    const exec = makeExecFn(args.project);
    const logfile = path.isAbsolute(args.logfile)
        ? args.logfile
        : path.join(args.project, args.logfile);
    let state = {
        session: args.session,
        lastPollTs: 0,
        knownMessageIds: [],
        paneStates: {},
        robotState: null,
    };
    let stopped = false;
    let writeQueue = Promise.resolve();
    let pollInFlight = null;
    const queueEvent = (event) => {
        writeQueue = writeQueue.then(() => appendEvent(logfile, event));
        return writeQueue;
    };
    const doPoll = async () => {
        const pollTs = Date.now();
        const inboxRaw = await fetchInboxFn(exec, args.project, args.agent, {
            limit: 200,
            includeBodies: false,
        });
        const messages = (Array.isArray(inboxRaw) ? inboxRaw : [])
            .map((message) => normalizeMessage(message))
            .filter((message) => message !== null);
        const quotedSession = shellQuote(args.session);
        const robotRaw = await runNtmCommand(runCommandFn, `ntm --robot-is-working ${quotedSession}`, { cwd: args.project, timeout: args.ntmTimeoutMs }, log);
        const healthRaw = await runNtmCommand(runCommandFn, `ntm --robot-agent-health ${quotedSession}`, { cwd: args.project, timeout: args.ntmTimeoutMs }, log);
        const snapshot = {
            session: args.session,
            pollTs,
            messages,
            paneStates: parsePaneStates(healthRaw),
            robotState: parseRobotState(robotRaw),
        };
        const { events, nextState } = runTenderDaemonOnce(state, snapshot);
        state = nextState;
        for (const event of events) {
            await queueEvent(event);
        }
    };
    const runPoll = () => {
        if (stopped)
            return Promise.resolve();
        if (pollInFlight)
            return pollInFlight;
        pollInFlight = doPoll()
            .catch((err) => {
            log.error("Daemon poll failed", { error: err instanceof Error ? err.message : String(err) });
        })
            .finally(() => {
            pollInFlight = null;
        });
        return pollInFlight;
    };
    const timer = setInterval(() => {
        void runPoll();
    }, args.interval);
    await runPoll();
    return {
        logfile,
        stop: async (reason = "stopped") => {
            if (stopped)
                return;
            stopped = true;
            clearInterval(timer);
            if (pollInFlight)
                await pollInFlight;
            await queueEvent(makeTenderDaemonStoppedEvent(args.session, reason));
            await writeQueue;
        },
    };
}
export async function runCli(argv, deps = {}) {
    const parsed = parseTenderDaemonArgs(argv);
    if (!parsed.ok) {
        process.stderr.write(`tender-daemon: ${parsed.error}\n\n${usageText()}\n`);
        return 2;
    }
    const controller = await startTenderDaemon(parsed.args, deps);
    const log = (deps.createLoggerFn ?? createLogger)("tender-daemon");
    log.info("Tender daemon started", {
        session: parsed.args.session,
        project: parsed.args.project,
        interval: parsed.args.interval,
        logfile: controller.logfile,
        agent: parsed.args.agent,
    });
    await new Promise((resolve) => {
        let stopping = false;
        const stop = (reason) => {
            if (stopping)
                return;
            stopping = true;
            void controller.stop(reason).finally(resolve);
        };
        process.once("SIGTERM", () => stop("SIGTERM"));
        process.once("SIGINT", () => stop("SIGINT"));
    });
    return 0;
}
//# sourceMappingURL=tender-daemon.js.map