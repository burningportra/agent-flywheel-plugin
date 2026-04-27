---
name: flywheel-doctor
description: One-shot diagnostic of every flywheel dependency — MCP connectivity, Agent Mail liveness, br/bv/ntm/cm binaries, node version, git status, dist-drift, orphaned worktrees, and checkpoint validity. Use when debugging toolchain issues, before starting a new session, after /flywheel-cleanup, or as a CI gate.
---

Run a one-shot diagnostic sweep of the flywheel's toolchain and report each dependency's state with a single glyph per line. $ARGUMENTS

The underlying engine is the `flywheel_doctor` MCP tool — a bounded, cancellable, read-only check battery. This skill is the user-facing surface that triggers the tool and renders its `DoctorReport` envelope.

## When to invoke

- **Onboarding a new session** — run once before `/start` to confirm every required tool resolves and MCP is registered. Catches missing binaries, dist drift, and Agent Mail down before any agent spawns.
- **After `/flywheel-cleanup`** — cleanup removes orphaned worktrees and stale state; doctor verifies the cleanup left the tree in a coherent condition.
- **CI gate** — run doctor in CI prior to `npm run build` / `npm test` so a toolchain regression surfaces as a red line rather than a confusing test failure.
- **Toolchain drift suspected** — a bead fails in a way that smells like missing binary or MCP tool not registered; run doctor first and triage from its output.

## What it does

`flywheel_doctor` runs these 11 checks in parallel, each with a per-check timeout (default 2s) and a global sweep budget (default 10s):

1. `mcp_connectivity` — the MCP server (agent-flywheel) responds to a ping.
2. `agent_mail_liveness` — `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` returns 200.
3. `br_binary` — `br --version` resolves.
4. `bv_binary` — `bv --version` resolves.
5. `ntm_binary` — `ntm --version` resolves (optional — yellow if missing).
6. `cm_binary` — `cm --version` resolves (optional — yellow if missing).
7. `node_version` — `node --version` is >= the minimum supported version.
8. `git_status` — cwd is a git repo and `git status --short` succeeds.
9. `dist_drift` — `mcp-server/dist/server.js` is newer than the most-recently-modified file under `mcp-server/src/`.
10. `orphaned_worktrees` — `.claude/worktrees/` contains no sessions without a matching `.pi-flywheel/checkpoint.json`.
11. `checkpoint_validity` — `.pi-flywheel/checkpoint.json` parses and its `sessionStartSha` still resolves in `git log`.

Checks are bounded and cancellable: if the signal fires before a check completes, the report is returned with `partial: true` and whatever results finished. Individual check failures never throw — they become `red` / `yellow` entries.

## Expected output format

Render the `DoctorReport` envelope as:

```
┌─ flywheel doctor ─────────────────────────────────┐
│ cwd: <abs-path>                                   │
│ overall: [OK|WARN|FAIL]   elapsed: <ms>ms         │
├───────────────────────────────────────────────────┤
│ [OK]   mcp_connectivity       — server responded  │
│ [OK]   agent_mail_liveness    — 200 in 14ms       │
│ [OK]   br_binary              — v1.2.3            │
│ [OK]   bv_binary              — v1.1.0            │
│ [WARN] ntm_binary             — not on PATH       │
│ [OK]   cm_binary              — v0.9.1            │
│ [OK]   node_version           — v22.5.1           │
│ [OK]   git_status             — clean             │
│ [FAIL] dist_drift             — src/errors.ts     │
│        newer than dist/server.js by 43 min        │
│ [OK]   orphaned_worktrees     — 0                 │
│ [OK]   checkpoint_validity    — sha resolves      │
└───────────────────────────────────────────────────┘
```

Glyph mapping: `green → [OK]`, `yellow → [WARN]`, `red → [FAIL]`. If `partial: true`, prefix the header with `[PARTIAL — sweep budget exhausted]` and list only the checks that finished.

## Remediation flowchart

For each failing check, the skill prints the canonical one-line fix below the report:

- `mcp_connectivity` → `/reload-plugins` in Claude Code, then re-run doctor. If still red, rebuild: `cd mcp-server && npm ci && npm run build`.
- `agent_mail_liveness` → run `/agent-flywheel:flywheel-setup` (it installs and starts agent-mail; the Rust port [`mcp_agent_mail_rust`](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) is the primary distribution). Manual start: `nohup am serve-http > /dev/null 2>&1 &` (Rust, preferred) or `nohup mcp-agent-mail serve > /dev/null 2>&1 &`. Legacy Python fallback: `nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &`.
- `br_binary` missing → `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash`.
- `bv_binary` missing → `brew install dicklesworthstone/tap/bv` (Homebrew) or the beads_viewer install script.
- `ntm_binary` missing → yellow only; install via `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/ntm/main/install.sh" | bash` if you plan to use parallel swarms.
- `cm_binary` missing → yellow only; install via the cass_memory_system install script.
- `node_version` below min → upgrade node to the version pinned in `mcp-server/package.json` engines.
- `git_status` failure → cwd is not a git repo or `.git/` is corrupted; re-clone or re-init.
- `dist_drift` → `cd mcp-server && npm run build`. Never edit `dist/` directly.
- `orphaned_worktrees` → `/agent-flywheel:flywheel-cleanup` to prune them.
- `checkpoint_validity` → stale checkpoint; run `/agent-flywheel:flywheel-stop` to reset, or delete `.pi-flywheel/checkpoint.json` manually if you know the session is dead.

If `overall` is `red`, do NOT run `/start` until the red checks are fixed — downstream gates will fail with more confusing errors.

## Strategic-alignment advisory (manual, run after the MCP report — new in v3.6.5)

After rendering the MCP `DoctorReport`, run one additional **agent-side advisory check** that the MCP tool does NOT yet implement: reality-check freshness. This is documentation of a check the agent performs by querying CASS — eventually it should move into `mcp-server/src/tools/doctor.ts` as a proper check, but it ships as an advisory until then.

Procedure:
1. Call `flywheel_memory(operation: "search", cwd, query: "reality-check gap report")`.
2. Inspect the most-recent matching entry's date (entries are stored with a `date` field per `_reality_check.md` §2).
3. Count distinct prior flywheel sessions for this `cwd` (via CASS or `git log` since the project's first flywheel commit — heuristic only).
4. If ≥3 prior sessions exist AND the most recent reality-check is older than 7 sessions (or never run), append below the doctor report:

   ```
   [INFO] reality_check_freshness — last reality-check: <X> sessions ago
          → consider /agent-flywheel:flywheel-reality-check before continuing
   ```

5. If <3 prior sessions OR the most recent reality-check was within the last 7 sessions, skip silently.

This is **advisory only** — never gate on it, never mark the doctor report `red` because of it. It's a nudge, not a blocker. Single-session projects don't need reality-checks; the threshold exists to avoid noise on fresh repos.

## Skill tool invocation

Invoke the MCP tool directly with a single argument — the current working directory:

```
flywheel_doctor({ cwd: "<abs-path-to-repo-root>" })
```

Read the returned `structuredContent.data` as a `DoctorReport`:

```ts
type DoctorReport = {
  version: 1;
  cwd: string;
  overall: "green" | "yellow" | "red";
  partial: boolean;
  checks: Array<{
    name: string;
    severity: "green" | "yellow" | "red";
    detail: string;
    elapsedMs: number;
  }>;
  elapsedMs: number;
  timestamp: string;
};
```

Render each `check` as one line using the glyph mapping above. If `structuredContent?.data?.error?.code` is set, branch on `FlywheelErrorCode` — the two codes this tool can emit are `doctor_blocking_failure` (the sweep itself couldn't start, e.g. cwd isn't a directory) and `doctor_partial_result` (signalled abort before all checks finished). Do NOT parse `error.message` text.

## Notes

- Doctor is **read-only**. It never mutates `.pi-flywheel/checkpoint.json`, never writes spool files, never kills worktrees. Remediation is always user-gated.
- Safe to run concurrently with `/start` — doctor does not lock anything.
- Runtime target: under 2 seconds on a warm machine; the 10s sweep budget exists only to cap pathological cases (binary hangs).

## See also (triage chain)

Doctor is the **first** of three diagnostic commands. Run them in order:

1. **`/agent-flywheel:flywheel-doctor`** (this skill) — read-only snapshot, always safe. Run first.
2. **`/agent-flywheel:flywheel-setup`** — apply-fixes stage; installs tools, registers MCP, configures hooks. Run when doctor reports `red`/`yellow` checks.
3. **`/agent-flywheel:flywheel-healthcheck`** — deep periodic audit of codebase + bead graph + dependencies. Run on a cadence, not to fix setup problems.
