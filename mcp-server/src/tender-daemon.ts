import { exec as execCb } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fetchInbox } from "./agent-mail.js";
import { makeExec, type ExecFn } from "./exec.js";
import { errMsg } from "./errors.js";
import {
  DEFAULT_TENDER_DAEMON_AGENT,
  DEFAULT_TENDER_DAEMON_INTERVAL_MS,
  makeTenderDaemonStoppedEvent,
  runTenderDaemonOnce,
  type TenderDaemonEvent,
  type TenderDaemonMessage,
  type TenderDaemonPollSnapshot,
  type TenderDaemonState,
} from "./tender.js";
import { createLogger, type Logger } from "./logger.js";

const execAsync = promisify(execCb);

const DEFAULT_LOGFILE = ".pi-flywheel/tender-events.log";
const DEFAULT_NTM_TIMEOUT_MS = 5_000;
const ROBOT_STATES = new Set(["working", "idle", "rate_limited", "error", "context_low"]);

interface AgentMailMessage {
  id: number | string;
  thread_id?: string;
  sender_name?: string;
  subject?: string;
  importance?: "low" | "normal" | "high" | "urgent";
  created_ts?: string;
}

export interface TenderDaemonArgs {
  session: string;
  project: string;
  interval: number;
  logfile: string;
  agent: string;
  ntmTimeoutMs: number;
}

export interface ParseArgsSuccess {
  ok: true;
  args: TenderDaemonArgs;
}

export interface ParseArgsFailure {
  ok: false;
  error: string;
}

export type ParseArgsResult = ParseArgsSuccess | ParseArgsFailure;

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

export type RunCommandFn = (
  command: string,
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<RunCommandResult>;

export interface TenderDaemonDeps {
  fetchInboxFn?: typeof fetchInbox;
  makeExecFn?: typeof makeExec;
  runCommandFn?: RunCommandFn;
  createLoggerFn?: typeof createLogger;
}

export interface TenderDaemonController {
  stop: (reason?: string) => Promise<void>;
  logfile: string;
}

export function usageText(): string {
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

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, got '${raw}'`);
  }
  return value;
}

export function parseTenderDaemonArgs(argv: string[]): ParseArgsResult {
  const parsed: Partial<TenderDaemonArgs> = {
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
        } catch (err) {
          return { ok: false, error: errMsg(err) };
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
        } catch (err) {
          return { ok: false, error: errMsg(err) };
        }
        break;
      default:
        return { ok: false, error: `unknown flag '--${key}'` };
    }

    if (consumedNext) i++;
  }

  if (!parsed.session) return { ok: false, error: "missing required --session" };

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

function normalizeState(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function parseRobotState(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const compact = normalized.split(/\s+/);
  for (const token of compact) {
    const cleaned = token.replace(/[^a-z_]/g, "");
    if (ROBOT_STATES.has(cleaned)) return cleaned;
  }

  return compact[0] ?? null;
}

/**
 * Extract a `{pane, state}` pair from one pane-shaped object. Returns
 * `null` when the shape doesn't match — we never coerce arbitrary
 * top-level keys (`health_grade`, `recommendation`, ...) into pane IDs.
 * That's the root cause of the bogus `pane_state_changed` events tracked
 * in bead 3ag.
 */
function extractPaneEntry(obj: Record<string, unknown>): { pane: string; state: string } | null {
  const pane =
    (typeof obj.pane === "string" && obj.pane) ||
    (typeof obj.name === "string" && obj.name) ||
    (typeof obj.id === "string" && obj.id) ||
    null;
  if (!pane) return null;
  const stateRaw =
    (typeof obj.state === "string" && obj.state) ||
    (typeof obj.status === "string" && obj.status) ||
    (typeof obj.health === "string" && obj.health) ||
    null;
  if (!stateRaw) return null;
  const state = normalizeState(stateRaw);
  if (state.length === 0) return null;
  return { pane, state };
}

/**
 * Collect pane states from an `ntm --robot-agent-health` JSON payload.
 *
 * Schema-strict (bead 3ag): only iterate the recognised pane carriers —
 * `parsed.panes`, `parsed.agents`, or a top-level array of pane objects.
 * Never iterate top-level scalar keys like `health_grade`, `fleet_health`,
 * or `recommendation` as if they were pane IDs.
 */
function collectPaneStates(value: unknown, out: Record<string, string>): void {
  if (value === null || value === undefined) return;

  // Top-level array → each element is a pane object.
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = extractPaneEntry(item as Record<string, unknown>);
      if (entry) out[entry.pane] = entry.state;
    }
    return;
  }

  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;

  // Object that is itself a pane row.
  const direct = extractPaneEntry(obj);
  if (direct) {
    out[direct.pane] = direct.state;
    return;
  }

  // Recognised pane carriers. Order matters: panes first (canonical), then
  // agents (alternate name some ntm builds emit). Both must be arrays.
  const carrierKeys = ["panes", "agents"] as const;
  for (const key of carrierKeys) {
    const carrier = obj[key];
    if (Array.isArray(carrier)) {
      collectPaneStates(carrier, out);
      // Don't double-count; first matching carrier wins.
      return;
    }
  }
}

export function parsePaneStates(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  try {
    const parsed = JSON.parse(trimmed);
    // If the input parsed as JSON, trust the schema-strict pane collector —
    // do NOT fall through to the line parser. The line parser is only for
    // non-JSON `key: value` payloads, and applying it to a JSON string with
    // no `panes[]` would let stray top-level keys leak in (the original
    // 3ag bug).
    const out: Record<string, string> = {};
    collectPaneStates(parsed, out);
    return out;
  } catch {
    // not valid JSON — fall through to line parser
  }

  const states: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) continue;

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function defaultRunCommand(
  command: string,
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
): Promise<RunCommandResult> {
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

function normalizeMessage(input: AgentMailMessage): TenderDaemonMessage | null {
  const numericId =
    typeof input.id === "number" ? input.id : Number.parseInt(String(input.id), 10);
  if (!Number.isFinite(numericId)) return null;

  return {
    id: numericId,
    thread_id: input.thread_id,
    sender_name: input.sender_name,
    subject: input.subject,
    importance: input.importance,
    created_ts: input.created_ts,
  };
}

async function appendEvent(logfile: string, event: TenderDaemonEvent): Promise<void> {
  await mkdir(path.dirname(logfile), { recursive: true });
  await appendFile(logfile, `${JSON.stringify(event)}\n`, "utf8");
}

async function runNtmCommand(
  runCommandFn: RunCommandFn,
  command: string,
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
  log: Logger,
): Promise<string> {
  try {
    const result = await runCommandFn(command, opts);
    return result.stdout;
  } catch (err) {
    const failure = err as { message?: string; stdout?: string; stderr?: string };
    log.warn("NTM command failed", {
      command,
      error: failure.message ?? String(err),
      stderr: failure.stderr,
    });
    return typeof failure.stdout === "string" ? failure.stdout : "";
  }
}

export async function startTenderDaemon(
  args: TenderDaemonArgs,
  deps: TenderDaemonDeps = {},
): Promise<TenderDaemonController> {
  const fetchInboxFn = deps.fetchInboxFn ?? fetchInbox;
  const makeExecFn = deps.makeExecFn ?? makeExec;
  const runCommandFn = deps.runCommandFn ?? defaultRunCommand;
  const loggerFactory = deps.createLoggerFn ?? createLogger;
  const log = loggerFactory("tender-daemon");

  const exec = makeExecFn(args.project);
  const logfile = path.isAbsolute(args.logfile)
    ? args.logfile
    : path.join(args.project, args.logfile);

  let state: TenderDaemonState = {
    session: args.session,
    lastPollTs: 0,
    knownMessageIds: [],
    paneStates: {},
    robotState: null,
  };

  let stopped = false;
  let writeQueue = Promise.resolve();
  let pollInFlight: Promise<void> | null = null;

  const queueEvent = (event: TenderDaemonEvent): Promise<void> => {
    writeQueue = writeQueue.then(() => appendEvent(logfile, event));
    return writeQueue;
  };

  const doPoll = async (): Promise<void> => {
    const pollTs = Date.now();

    const inboxRaw = await fetchInboxFn(exec as ExecFn, args.project, args.agent, {
      limit: 200,
      includeBodies: false,
    });
    const messages = (Array.isArray(inboxRaw) ? inboxRaw : [])
      .map((message) => normalizeMessage(message as AgentMailMessage))
      .filter((message): message is TenderDaemonMessage => message !== null);

    const quotedSession = shellQuote(args.session);
    const robotRaw = await runNtmCommand(
      runCommandFn,
      `ntm --robot-is-working ${quotedSession}`,
      { cwd: args.project, timeout: args.ntmTimeoutMs },
      log,
    );
    const healthRaw = await runNtmCommand(
      runCommandFn,
      `ntm --robot-agent-health ${quotedSession}`,
      { cwd: args.project, timeout: args.ntmTimeoutMs },
      log,
    );

    const snapshot: TenderDaemonPollSnapshot = {
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

  const runPoll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pollInFlight) return pollInFlight;

    pollInFlight = doPoll()
      .catch((err) => {
        log.error("Daemon poll failed", { error: errMsg(err) });
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
    stop: async (reason: string = "stopped") => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (pollInFlight) await pollInFlight;
      await queueEvent(makeTenderDaemonStoppedEvent(args.session, reason));
      await writeQueue;
    },
  };
}

export async function runCli(argv: string[], deps: TenderDaemonDeps = {}): Promise<number> {
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

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      void controller.stop(reason).finally(resolve);
    };

    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });

  return 0;
}
