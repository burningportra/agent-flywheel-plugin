---
description: Full health check of the codebase and flywheel dependencies.
---

**See also (triage chain):** `flywheel-healthcheck` is the **third** step — a deep periodic audit (codebase + bead graph + dependencies). For a fast, read-only toolchain snapshot, run `/flywheel-doctor` first — it's always safe and completes in under 2s. To install missing tools or repair configuration that doctor flagged, run `/flywheel-setup`. Do not reach for healthcheck to fix a fresh-clone setup problem — that's `flywheel-doctor` → `flywheel-setup`.

Run a comprehensive health check. $ARGUMENTS

Check all systems and produce a health score.

**Dependency checks** (run in parallel via Bash):
- `br --version` — bead tracker
- `bv --version` — bead visualizer
- `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` — agent-mail
- `git status --short` — repo cleanliness
- `ls .pi-flywheel/checkpoint.json 2>/dev/null` — checkpoint state
- `ls mcp-server/dist/server.js 2>/dev/null` — MCP server built

**Codebase health** (use Agent(Explore)):
- TODO/FIXME count: `grep -r "TODO\|FIXME\|HACK" --include="*.ts" | wc -l`
- Test ratio: count test files vs source files
- Any obvious linting or compilation errors

**Bead health**:
- Run `br list --json` — count open/closed/in-progress/deferred
- Run `bv --json` — check for cycles or orphaned beads

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
