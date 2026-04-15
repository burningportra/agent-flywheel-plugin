---
description: Full health check of the codebase and orchestration dependencies.
---

Run a comprehensive health check. $ARGUMENTS

Check all systems and produce a health score.

**Dependency checks** (run in parallel via Bash):
- `br --version` — bead tracker
- `bv --version` — bead visualizer
- `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` — agent-mail
- `git status --short` — repo cleanliness
- `ls .pi-orchestrator/checkpoint.json 2>/dev/null` — checkpoint state
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
