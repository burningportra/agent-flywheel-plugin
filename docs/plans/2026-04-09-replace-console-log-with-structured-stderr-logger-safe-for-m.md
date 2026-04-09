# Plan: Structured stderr Logger + SwarmTender Auto-Escalation

**Date:** 2026-04-09  
**Goal:** Replace scattered console.warn/error calls with a structured stderr logger (safe for MCP stdio), AND add SwarmTender auto-nudge-then-kill escalation for stuck agents.

---

## 1. Executive Summary

Two reliability gaps:

**Gap A — Logging:** `console.warn` and `console.error` are already stderr-safe (no stdout corruption risk), but logging is ad hoc across 8 files with no consistent format, log levels, or context tagging. A lightweight structured logger centralizes output format, enables log-level filtering via env var, and makes CI log analysis tractable.

**Gap B — SwarmTender:** `SwarmTender` detects stuck agents and exposes `nudgeStuckAgent` / `releaseStaleReservations` helpers, but escalation is entirely manual — the caller must wire it up. In practice it never happens automatically. Adding an auto-escalation state machine (nudge → wait → kill) + completion summary eliminates the #1 manual intervention in the orchestrate skill.

---

## 2. Architecture

### 2a. Logger (`src/logger.ts`)

A minimal module exporting a `createLogger(context)` factory. Each logger instance writes structured JSON lines to `process.stderr`. No external deps.

```
interface LogLine {
  ts: string;       // ISO timestamp
  level: string;    // "debug" | "info" | "warn" | "error"
  ctx: string;      // e.g. "beads", "checkpoint", "tender"
  msg: string;
  [key: string]: unknown;  // optional structured fields
}
```

Level filtering via `ORCH_LOG_LEVEL` env var (default: `"warn"`).  
Level order: `debug < info < warn < error`.

Example output (one JSON line per log call):
```
{"ts":"2026-04-09T13:00:00.000Z","level":"warn","ctx":"beads","msg":"bv --robot-insights returned unparseable JSON"}
```

### 2b. SwarmTender Escalation State Machine

New state added to `AgentStatus`:

```typescript
nudgesSent: number;       // how many nudges sent to this agent
lastNudgedAt: number;     // timestamp of last nudge
```

New `TenderConfig` fields:
```typescript
/** Delay after first stuck detection before sending first nudge (default 0 = immediate). */
nudgeDelayMs: number;
/** How many nudges to send before killing (default 2). */
maxNudges: number;
/** How long to wait after last nudge before declaring kill (default 120_000 = 2min). */
killWaitMs: number;
```

New `SwarmTenderOptions` callbacks:
```typescript
onKill?: (agent: AgentStatus) => void;
onSwarmComplete?: (summary: SwarmCompletionSummary) => void;
```

New `SwarmCompletionSummary` type:
```typescript
interface SwarmCompletionSummary {
  totalAgents: number;
  completedNormally: number;
  killedStuck: number;
  elapsedMs: number;
  stuckAgentNames: string[];
}
```

Escalation flow (runs in `poll()` when an agent is stuck):

```
stuck detected
  └─ nudgesSent < maxNudges AND elapsed since lastNudgedAt >= nudgeDelayMs?
       └─ YES → nudgeStuckAgent(), nudgesSent++, lastNudgedAt = now
       └─ NO  → elapsed since lastNudgedAt >= killWaitMs?
                  └─ YES → onKill(agent), removeAgent(stepIndex)
                  └─ NO  → wait (still in nudge cooldown)
```

When the last agent is removed (`agents.size === 0`), emit `onSwarmComplete`.

**Auto-nudge is opt-in:** The auto-escalation only activates when `options.orchestratorAgentName` is set. Without it, stuck detection still fires `onStuck` as before (backward compatible).

---

## 3. Implementation Phases

### Phase 1 — Logger module (T1)
**Files:** `mcp-server/src/logger.ts` (new)  
**Depends on:** nothing

Create the logger module.

### Phase 2 — Logger adoption (T2)
**Files:** `server.ts`, `beads.ts`, `checkpoint.ts`, `cli-exec.ts`, `coordination.ts`, `state.ts`, `sophia.ts`, `bead-templates.ts`  
**Depends on:** T1

Replace all `console.warn` / `console.error` calls with logger calls using the appropriate context tag.

### Phase 3 — SwarmTender escalation (T3)
**Files:** `mcp-server/src/tender.ts`  
**Depends on:** T1 (uses logger internally)

Add `nudgesSent`, `lastNudgedAt` to `AgentStatus`. Add new config fields + callbacks. Implement auto-escalation in `poll()`. Implement `onSwarmComplete` emission.

### Phase 4 — Tests (T4)
**Files:** `mcp-server/src/__tests__/logger.test.ts` (new), `mcp-server/src/__tests__/tender.test.ts` (new)  
**Depends on:** T1, T3

Write unit tests for:
- Logger: level filtering, structured output format, context tagging
- SwarmTender: escalation state machine transitions (stuck → nudge → kill), completion summary, backward compat without orchestratorAgentName

### Phase 5 — Build + verify (T5)
**Depends on:** T1, T2, T3, T4

`npm run build` must pass. `npm test` must pass.

---

## 4. File-Level Changes

### `mcp-server/src/logger.ts` (NEW)

```typescript
const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = typeof LEVELS[number];

const envLevel = (process.env.ORCH_LOG_LEVEL ?? "warn").toLowerCase() as Level;
const minLevel = LEVELS.indexOf(envLevel) >= 0 ? LEVELS.indexOf(envLevel) : 2;

export function createLogger(ctx: string) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => log("debug", ctx, msg, fields),
    info:  (msg: string, fields?: Record<string, unknown>) => log("info",  ctx, msg, fields),
    warn:  (msg: string, fields?: Record<string, unknown>) => log("warn",  ctx, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => log("error", ctx, msg, fields),
  };
}

function log(level: Level, ctx: string, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS.indexOf(level) < minLevel) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(), level, ctx, msg, ...fields,
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}
```

### `mcp-server/src/server.ts`

Replace:
```typescript
console.error(`[claude-orchestrator] Tool ${name} error:`, err);
console.error("[claude-orchestrator] MCP server started");
```
With:
```typescript
import { createLogger } from "./logger.js";
const log = createLogger("server");
// ...
log.error("Tool error", { tool: name, err: String(err) });
log.info("MCP server started");
```

### `mcp-server/src/beads.ts`

Replace 3× `console.warn` with `log.warn(...)` using ctx `"beads"`.

### `mcp-server/src/checkpoint.ts`

Replace 5× `console.warn` with `log.warn(...)` using ctx `"checkpoint"`.

### `mcp-server/src/cli-exec.ts`

Replace 4× `console.warn` with `log.warn(...)` using ctx `"cli-exec"`.

### `mcp-server/src/coordination.ts`

Replace 1× `console.warn` with `log.warn(...)` using ctx `"coordination"`.

### `mcp-server/src/state.ts`

Replace 1× `console.warn` with `log.warn(...)` using ctx `"state"`.

### `mcp-server/src/sophia.ts`

Replace 2× `console.warn` with `log.warn(...)` using ctx `"sophia"`.

### `mcp-server/src/bead-templates.ts`

Replace 1× `console.warn` with `log.warn(...)` using ctx `"bead-templates"`.

### `mcp-server/src/tender.ts`

1. Add `nudgesSent: number` and `lastNudgedAt: number` to `AgentStatus` interface (both default `0`).
2. Add `nudgeDelayMs`, `maxNudges`, `killWaitMs` to `TenderConfig` with defaults.
3. Add `onKill` and `onSwarmComplete` to `SwarmTenderOptions`.
4. Add `SwarmCompletionSummary` interface to exports.
5. Add `private startedAt: number` field (set in constructor).
6. Add `private killedAgents: string[]` field.
7. Update `poll()` to implement auto-escalation (see §2b).
8. Update `removeAgent()` to check `agents.size === 0` → emit `onSwarmComplete`.
9. Use `createLogger("tender")` for internal logging.

---

## 5. Testing Strategy

### `logger.test.ts`
- Mock `process.stderr.write`
- Test: below `minLevel` calls produce no output
- Test: output is valid JSON with correct `level`, `ctx`, `msg`, `ts` fields
- Test: extra fields are merged into output
- Test: `ORCH_LOG_LEVEL=debug` enables debug output

### `tender.test.ts`
- Use vi.useFakeTimers() to control time
- Test: stuck agent → nudge sent after stuckThreshold
- Test: stuck agent → second nudge sent after nudgeDelayMs cooldown
- Test: stuck agent → kill fired after maxNudges exceeded + killWaitMs elapsed
- Test: no auto-escalation when `orchestratorAgentName` is absent (backward compat)
- Test: `onSwarmComplete` fires when last agent removed
- Test: `removeAgent` on non-stuck agent still triggers completion

---

## 6. Acceptance Criteria

- [ ] `mcp-server/src/logger.ts` exists and exports `createLogger`
- [ ] Zero `console.warn` / `console.error` in `mcp-server/src/` (except logger.ts itself uses `process.stderr.write`)
- [ ] `npm run build` exits 0
- [ ] `npm test` exits 0 with logger and tender tests passing
- [ ] `AgentStatus` has `nudgesSent` and `lastNudgedAt` fields
- [ ] `TenderConfig` has `nudgeDelayMs`, `maxNudges`, `killWaitMs` with documented defaults
- [ ] `SwarmTenderOptions` has `onKill` and `onSwarmComplete` callbacks
- [ ] Auto-escalation only activates when `orchestratorAgentName` is set (backward compat)
- [ ] `onSwarmComplete` fires when agent count drops to 0

---

## 7. Dependency Graph

```
T1 (logger module)
  ├── T2 (logger adoption)  ──┐
  └── T3 (tender escalation) ─┤
                               ├── T4 (tests)
                               └── T5 (build + verify)
```

Tasks:
- **T1** depends_on: []
- **T2** depends_on: [T1]
- **T3** depends_on: [T1]
- **T4** depends_on: [T1, T2, T3]
- **T5** depends_on: [T1, T2, T3, T4]

---

## 8. Risk & Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Logger output breaks existing tests that assert on console | Low | All existing tests mock console or don't assert on it; logger uses `process.stderr.write` |
| Tender auto-kill prematurely kills slow-but-legitimate agents | Medium | Default `killWaitMs=120_000` (2 min after 2 nudges) gives 5+ min total grace; opt-in via `orchestratorAgentName` |
| Agent Mail unavailable when nudge fires | Low | `nudgeStuckAgent` already handles failure gracefully (returns void) |
| TypeScript strict mode rejects new optional fields | Low | Initialize `nudgesSent: 0, lastNudgedAt: 0` in constructor alongside existing fields |
