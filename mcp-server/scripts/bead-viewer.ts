#!/usr/bin/env node
// bead-viewer: read-only HTTP server that renders the bead graph in a browser.
//
// Routes:
//   GET /              -> bead-viewer-assets/index.html
//   GET /assets/<file> -> bead-viewer-assets/<file>  (path-traversal safe)
//   GET /api/graph     -> JSON { nodes, edges, cycles, generatedAt, truncated }
//   GET /api/bead/:id  -> JSON bead body from `br show <id> --json`
//
// Hard-bound to loopback (127.0.0.1 / localhost / ::1). FW_VIEWER_BIND with any
// non-loopback value is refused at startup. Per-IP rate limit, concurrent
// connection cap, per-conn timeout, and parent-pid watch are enforced.
//
// Bead bodies are returned as JSON only; the HTML side renders them via
// textContent — never inlined into HTML. This is the XSS defense.

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";

interface CliArgs {
  port: number;
  dbPath?: string;
  noOpen: boolean;
}

// Dual-runtime module loading mirrors bench-deep-plan.ts: when compiled we live
// at dist/scripts/ and import from ../bead-graph.js; when running under tsx we
// import from ../src/bead-graph.js. Avoids a rootDir violation.
const isCompiled = import.meta.url.includes("/dist/scripts/");
const beadGraphModulePath = isCompiled
  ? "../bead-graph.js"
  : "../src/bead-graph.js";

interface BeadGraphModule {
  buildBeadGraph: (
    listJson: unknown[],
    depJson: unknown[],
  ) => {
    nodes: Array<{ id: string; status: string; [k: string]: unknown }>;
    edges: Array<{ from: string; to: string; [k: string]: unknown }>;
    cycles: Array<{ beadIds: string[] }>;
    generatedAt: string;
  };
}

const { buildBeadGraph } = (await import(beadGraphModulePath)) as BeadGraphModule;

const MAX_CONCURRENT_CONN = 16;
const RATE_LIMIT_PER_SEC = 30;
const PER_CONN_TIMEOUT_MS = 60_000;
const MAX_GRAPH_NODES = 2000;
const PARENT_WATCH_INTERVAL_MS = 1000;
const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asset path: compiled lives at dist/scripts/, source at scripts/.
const ASSETS_DIR = isCompiled
  ? path.resolve(__dirname, "../../scripts/bead-viewer-assets")
  : path.resolve(__dirname, "./bead-viewer-assets");

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: 0, noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        process.stderr.write(`bead-viewer: invalid --port value: ${v}\n`);
        process.exit(2);
      }
      args.port = n;
    } else if (a === "--no-open") {
      args.noOpen = true;
    } else if (a === "--db") {
      args.dbPath = argv[++i];
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: bead-viewer [--port N] [--no-open] [--db <path>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`bead-viewer: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

interface RateState {
  windowStart: number;
  count: number;
}

function makeRateLimiter(): (ip: string) => boolean {
  const state = new Map<string, RateState>();
  return (ip: string) => {
    const now = Date.now();
    const cur = state.get(ip);
    if (!cur || now - cur.windowStart >= 1000) {
      state.set(ip, { windowStart: now, count: 1 });
      return true;
    }
    cur.count++;
    if (cur.count > RATE_LIMIT_PER_SEC) return false;
    return true;
  };
}

function execBr(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      "br",
      args,
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        cwd,
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.toString().trim() || err.message;
          reject(new Error(`br ${args.join(" ")} failed: ${msg}`));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  if (!res.headersSent) {
    res.writeHead(status, {
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    });
  }
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
}

async function handleGraph(res: http.ServerResponse): Promise<void> {
  // br does not expose a global dep-list dump; per-issue dep listing would N+1.
  // buildBeadGraph already mines inline `dependencies[]` from each list row.
  let listOut: string;
  try {
    listOut = await execBr(["list", "--json"]);
  } catch (e) {
    sendJson(res, 502, { error: (e as Error).message });
    return;
  }

  let listJson: unknown[];
  try {
    const lp = JSON.parse(listOut);
    listJson = Array.isArray(lp) ? lp : [];
  } catch {
    listJson = [];
  }

  const graph = buildBeadGraph(listJson, []);
  let truncated = false;
  let nodes = graph.nodes;
  let edges = graph.edges;
  if (nodes.length > MAX_GRAPH_NODES) {
    truncated = true;
    nodes = nodes.slice(0, MAX_GRAPH_NODES);
    const keep = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }

  sendJson(res, 200, {
    nodes,
    edges,
    cycles: graph.cycles,
    generatedAt: graph.generatedAt,
    truncated,
  });
}

async function handleBead(res: http.ServerResponse, id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > 128) {
    sendJson(res, 400, { error: "invalid bead id" });
    return;
  }
  let out: string;
  try {
    out = await execBr(["show", id, "--json"]);
  } catch (e) {
    sendJson(res, 404, { error: (e as Error).message });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    sendJson(res, 502, { error: "br show returned non-JSON output" });
    return;
  }
  sendJson(res, 200, parsed);
}

async function handleAsset(
  res: http.ServerResponse,
  fileRel: string,
): Promise<void> {
  const resolved = path.resolve(ASSETS_DIR, fileRel);
  if (!resolved.startsWith(ASSETS_DIR + path.sep) && resolved !== ASSETS_DIR) {
    send(res, 403, "forbidden", { "Content-Type": "text/plain" });
    return;
  }
  let body: Buffer;
  try {
    body = await fs.readFile(resolved);
  } catch {
    send(res, 404, "not found", { "Content-Type": "text/plain" });
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : ext === ".json"
            ? "application/json; charset=utf-8"
            : "application/octet-stream";
  send(res, 200, body, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
}

async function handleIndex(res: http.ServerResponse): Promise<void> {
  let body: Buffer;
  try {
    body = await fs.readFile(path.join(ASSETS_DIR, "index.html"));
  } catch {
    send(res, 500, "index.html missing", { "Content-Type": "text/plain" });
    return;
  }
  send(res, 200, body, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bind = process.env.FW_VIEWER_BIND ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(bind)) {
    process.stderr.write(
      `bead-viewer: refused non-loopback bind FW_VIEWER_BIND=${bind}\n`,
    );
    process.exit(2);
  }

  let activeConn = 0;
  const allowRequest = makeRateLimiter();

  const server = http.createServer(async (req, res) => {
    const ip =
      req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "unknown";
    if (!allowRequest(ip)) {
      send(res, 429, "rate limited", { "Content-Type": "text/plain" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${bind}`);
    const pathname = url.pathname;

    if (req.method !== "GET") {
      send(res, 405, "method not allowed", { "Content-Type": "text/plain" });
      return;
    }

    try {
      if (pathname === "/" || pathname === "/index.html") {
        await handleIndex(res);
        return;
      }
      if (pathname === "/api/graph") {
        await handleGraph(res);
        return;
      }
      const beadMatch = pathname.match(/^\/api\/bead\/([^/]+)$/);
      if (beadMatch) {
        await handleBead(res, decodeURIComponent(beadMatch[1]));
        return;
      }
      if (pathname.startsWith("/assets/")) {
        await handleAsset(res, pathname.slice("/assets/".length));
        return;
      }
      send(res, 404, "not found", { "Content-Type": "text/plain" });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });

  server.on("connection", (socket) => {
    activeConn++;
    if (activeConn > MAX_CONCURRENT_CONN) {
      socket.destroy();
      activeConn--;
      return;
    }
    socket.setTimeout(PER_CONN_TIMEOUT_MS, () => {
      socket.destroy();
    });
    socket.once("close", () => {
      activeConn--;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, bind, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr ? addr.port : args.port;
  const url = `http://${bind}:${actualPort}`;
  process.stdout.write(`bead-viewer ready: ${url}\n`);

  if (!args.noOpen) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    try {
      const child = child_process.spawn(opener, [url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      child.on("error", () => {
        // best-effort; user can navigate manually
      });
    } catch {
      // best-effort
    }
  }

  const ppid = process.ppid;
  if (ppid && ppid !== 1) {
    setInterval(() => {
      try {
        process.kill(ppid, 0);
      } catch {
        process.exit(0);
      }
    }, PARENT_WATCH_INTERVAL_MS).unref();
  }

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`bead-viewer: fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
