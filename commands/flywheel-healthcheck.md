---
description: Full health check of the codebase and flywheel dependencies.
---

**See also (triage chain):** `flywheel-healthcheck` is the **third** step: a deep periodic audit of the codebase, bead graph, and dependencies. For a fast, read-only toolchain snapshot, run `/flywheel-doctor` first; it is safe and finishes in under 2s. To install missing tools or repair configuration flagged by doctor, run `/flywheel-setup`. Do not use healthcheck for fresh-clone setup problems; use `flywheel-doctor` → `flywheel-setup`.

Run a health check. $ARGUMENTS

Produce a health score across dependencies, codebase state, beads, duel artifacts, and duel readiness.

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
