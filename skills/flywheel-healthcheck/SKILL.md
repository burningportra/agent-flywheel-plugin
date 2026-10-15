---
name: flywheel-healthcheck
description: Full health check of the codebase and flywheel dependencies.
---

Run a health check. $ARGUMENTS

**First action: parse `$ARGUMENTS` for `--json`.** Call `flywheel_doctor({cwd})` first for the read-only toolchain snapshot. When `--json` is present, fan out the dependency / codebase / bead / duel checks, assemble a single JSON envelope `{tool:"flywheel_healthcheck", version, status, phase, data:{doctor, dependencies, codebase, beads, duel, score}}`, print it to stdout, and exit. Otherwise render the human-friendly health report below.

Produce a health score across dependencies, codebase state, beads, duel artifacts, and duel readiness.

## --json output schema

When invoked with `--json`, this skill emits to stdout a single JSON envelope
that wraps the doctor report plus dependency / codebase / bead / duel sections. Pin
the contract shape via `flywheel_capabilities` (`data.contract_version`).

Top-level: `{tool:"flywheel_healthcheck", version, status, phase, data}`
Status:    `"ok" | "error"` (errors carry `data.kind:"error"` + `data.error.{code,message,hint,try_this,retryable}`)
`data` keys: `doctor` (raw `flywheel_doctor` envelope), `dependencies`, `codebase`, `beads`, `duel`, `score`.

**Dependency checks** (run in parallel via Bash):
- `br --version` — bead tracker
- `bv --version` — bead visualizer
- `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` — agent-mail
- `git status --short` — repo cleanliness
- `ls .pi-flywheel/checkpoint.json 2>/dev/null` — checkpoint state
- `ls "$CLAUDE_PLUGIN_ROOT/mcp-server/dist/server.js" 2>/dev/null` — MCP server built

**Codebase health** (use Agent(Explore)):
- TODO/FIXME count: `grep -r "TODO\|FIXME\|HACK" --include="*.ts" | wc -l`
- Test ratio: count test files vs source files
- Any obvious linting or compilation errors

**Bead health**:
- Run `br list --json` — count open/closed/in-progress/deferred
- Run `bv --json` — check for cycles or orphaned beads

**Duel artifact hygiene** (cwd-scoped, read-only):
- `find . -maxdepth 1 -name 'WIZARD_*.md' -mtime +7 -print` — list duel transcripts older than 7 days
- `find . -maxdepth 1 -name 'DUELING_WIZARDS_REPORT.md' -mtime +7 -print` — stale synthesis reports
- For each match, surface it under STALE DUEL ARTIFACTS. Do **not** auto-delete; these transcripts feed the bead Provenance block. Suggest `/flywheel-cleanup` if the user wants to archive or remove them.

**Duel readiness** (one line in the report):
- Count of healthy {cc, cod, gmi} CLIs from doctor's last run + ntm presence.
- Render: `Duel-ready: yes (cc+cod+gmi healthy, ntm ok)` / `partial (cc+cod only)` / `no (ntm missing)` / `no (only 1 CLI healthy)`.

**Display health report**:
```
DEPENDENCIES
  ✅ br v1.x.x
  ✅ bv v1.x.x
  ✅ agent-mail — healthy
  ⚠️  MCP server not built (run: cd mcp-server && npm run build)

CODEBASE
  TODOs: N
  Test coverage: N% (N test files / N source files)
  Git: clean / N uncommitted changes

BEADS
  Open: N | In progress: N | Closed: N | Deferred: N
  Graph: ✅ no cycles | ⚠️ N orphans

HEALTH SCORE: N/10
```

## See also (triage chain)

Healthcheck is the **third** of three diagnostic commands. Run them in order:

1. **`/agent-flywheel:flywheel-doctor`** — read-only snapshot. Run first when toolchain drift is suspected.
2. **`/agent-flywheel:flywheel-setup`** — apply-fixes stage; installs tools, registers MCP, configures hooks.
3. **`/agent-flywheel:flywheel-healthcheck`** (this skill) — deep periodic audit of codebase, bead graph, and dependencies. Run it on a cadence, not for fresh-clone setup problems (use doctor → setup for that).
