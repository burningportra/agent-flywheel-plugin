# One-liner install via Claude Code plugin marketplace

**Goal:** Match the `openai/codex-plugin-cc` install UX — a 4-step flow where the user runs `/plugin marketplace add burningportra/agent-flywheel-plugin`, `/plugin install agent-flywheel@agent-flywheel`, `/reload-plugins`, then `/agent-flywheel:flywheel-setup`, and everything else is auto-detected or auto-installed.

**Date:** 2026-04-16
**Mode:** Standard plan

---

## Current-state audit

| Component | Status | Gap |
|---|---|---|
| `.claude-plugin/marketplace.json` | ✅ exists | `source: "./"` works but owner is `burningportra` (ok) |
| `.claude-plugin/plugin.json` | ✅ exists | Missing `mcpServers` block — flywheel MCP server not registered for plugin autoload |
| `.mcp.json` (repo root) | ⚠️ partial | Declares `agent-mail` HTTP server only; does NOT register the local `mcp-server/dist/server.js` |
| `mcp-server/dist/` | ❌ gitignored (likely) | User must run `npm install && npm run build` manually |
| `commands/flywheel-setup.md` | ⚠️ detect-only | Tells user to install missing deps manually instead of offering to run installers |
| `README.md` | ⚠️ manual path | Leads with `git clone` + `claude --plugin-dir .` instead of `/plugin marketplace add` |

**Reference:** codex-plugin-cc ships no MCP server — it only shells to the `codex` CLI from commands/hooks, so it skips the whole build-step problem. We can't do the same (we genuinely need the MCP server), but we can make it invisible.

---

## Design

### 1. Register the flywheel MCP server as a plugin stdio server

Claude Code's plugin system autoloads MCP servers declared in `.claude-plugin/plugin.json` under a top-level `mcpServers` key. Add a stdio entry pointing to the bundled `mcp-server/dist/server.js` using the `${CLAUDE_PLUGIN_ROOT}` placeholder so the path resolves regardless of install location.

```jsonc
// .claude-plugin/plugin.json (add)
"mcpServers": {
  "agent-flywheel": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.js"]
  }
}
```

The `agent-mail` HTTP server stays in `.mcp.json` (repo-local) OR moves into `plugin.json` too — decide once: keep `.mcp.json` for *runtime* (user starts it themselves) and plugin.json for *packaged* servers. Prefer the latter if we can also auto-spawn agent-mail; otherwise keep split.

### 2. Ship prebuilt MCP server dist

Two viable strategies — pick ONE:

**A. Commit `mcp-server/dist/`** (what codex-plugin-cc does with its compiled assets).
- Remove `dist/` from `.gitignore`.
- Add a CI check that `dist/` matches `src/` (rebuild + git diff --exit-code) so it cannot drift.
- Pros: zero-config install, no Node build on first use.
- Cons: diff noise, need release discipline.

**B. Auto-build on first run via a `PreToolUse` hook or lazy builder inside `flywheel-setup`.**
- Keep `dist/` gitignored; on first invocation of any flywheel MCP tool, check for `dist/server.js`; if missing, run `npm ci && npm run build` with user consent.
- Pros: clean git history.
- Cons: first-run latency, requires Node 18+ on user machine, harder to diagnose failures.

**Recommendation: A (commit dist)** — matches Codex, keeps install friction at zero, and the manifest-drift CI guard we already run is a natural template for a `dist`-drift guard.

### 3. Smart `/agent-flywheel:flywheel-setup`

Rewrite `commands/flywheel-setup.md` to match codex-setup's interaction pattern:

For each missing dependency, the command should:
1. Detect absence (existing behavior).
2. Ask the user: *"br is not installed. Install via Homebrew? (y/N)"*
3. On consent, run the installer via `Bash`:
   - **br / bv:** `brew install burningportra/tap/br` (assuming tap exists; otherwise `npm i -g` or direct binary download — decide based on br/bv's published distribution channels)
   - **agent-mail:** detect `uv`; if present, `uv tool install mcp-agent-mail` or clone + `uv pip install -e`. Document fallback if no `uv`.
4. On refusal, print the manual install command and continue.

Handle agent-mail specially: it's a long-running HTTP server, not a CLI. `flywheel-setup` should:
- Check `/health/liveness` on port 8765.
- If not responding AND the package is installed, offer to spawn it in the background: `uv run python -m mcp_agent_mail.cli serve-http &`.
- If the package is not installed, offer to install + spawn.

Finally, ensure `.beads/` is initialized (`br init`) and register the Orchestrator agent with agent-mail.

### 4. README rewrite

Lead with the 4-step install, mirroring the codex-plugin-cc README structure:

```markdown
## Installation

**Prerequisites:** Claude Code (latest), Node.js 18.18+, and (optional) Homebrew for auto-install of deps.

1. Add the marketplace:
   `/plugin marketplace add burningportra/agent-flywheel-plugin`
2. Install the plugin:
   `/plugin install agent-flywheel@agent-flywheel`
3. Reload plugins:
   `/reload-plugins`
4. Run setup (detects + offers to install br, bv, agent-mail):
   `/agent-flywheel:flywheel-setup`
```

Move the current `git clone` + `claude --plugin-dir .` instructions into an **"Install from source (for contributors)"** appendix near the end.

---

## Work breakdown (beads)

Ordered by dependency; waves labeled for parallelism.

| # | Title | Effort | Wave | Depends on | Risk |
|---|---|---|---|---|---|
| 1 | **Register flywheel MCP server in `plugin.json`** — add `mcpServers.agent-flywheel` stdio block using `${CLAUDE_PLUGIN_ROOT}`; verify Claude Code autoloads it after `/plugin install`. | low | 1 | — | low |
| 2 | **Commit `mcp-server/dist/` + add CI drift guard** — remove `dist/` from `.gitignore`, run fresh build, commit artifacts, add GitHub Actions job that rebuilds and fails on `git diff --exit-code`. | low | 1 | — | med (diff noise, release hygiene) |
| 3 | **Auto-install flow in `flywheel-setup.md`** — rewrite the command to ask-and-install missing deps (br, bv, agent-mail). Each dep gets a detect → prompt → install-or-print-manual-command branch. | medium | 2 | 1 | med (installer fragility across macOS/Linux/Windows) |
| 4 | **Agent-mail auto-spawn** — teach `flywheel-setup` to background-launch `uv run python -m mcp_agent_mail.cli serve-http` when package present but port 8765 cold; document how to stop it. | low | 2 | 3 | med (orphan processes, port conflicts) |
| 5 | **README rewrite: 4-step install lead** — replace the Installation + Build sections with the marketplace flow; move manual path to a contributors appendix. Update `AGENTS.md` cross-refs. | low | 3 | 1, 2, 3 | low |
| 6 | **End-to-end install smoke test** — on a clean machine (or Docker container), run the 4 commands from the new README and confirm `/agent-flywheel:start` reaches the discover phase without any manual intervention. Document results in `docs/` and fix any gaps surfaced. | medium | 4 | 1–5 | high (reveals hidden assumptions) |

### Wave layout for swarm

- **Wave 1 (parallel):** #1, #2 — independent edits to `.claude-plugin/plugin.json` and `mcp-server/`/CI.
- **Wave 2 (parallel after 1):** #3, #4 — both edit `commands/flywheel-setup.md` so either serialize them or have one agent own the whole file. **Recommendation: merge #3 + #4 into a single bead** to avoid merge conflicts.
- **Wave 3:** #5 — README + AGENTS.md.
- **Wave 4:** #6 — smoke test; this bead may spawn follow-up beads if gaps are found.

---

## Acceptance criteria (for the full goal)

1. `/plugin marketplace add burningportra/agent-flywheel-plugin` + `/plugin install agent-flywheel@agent-flywheel` + `/reload-plugins` makes `/agent-flywheel:*` commands available in any Claude Code session **without cloning the repo**.
2. The flywheel MCP tools (`orch_profile`, `orch_discover`, etc.) are immediately callable — no `npm install && npm run build` required.
3. `/agent-flywheel:flywheel-setup` on a machine missing br, bv, and agent-mail detects all three, asks the user to install each, and on consent completes installation without the user copying any shell commands.
4. README's first Installation section is the 4-step marketplace flow; the `git clone` path is relegated to a "for contributors" appendix.
5. Smoke test passes on a clean macOS machine with only Claude Code + Homebrew preinstalled.

---

## Risks & open questions

- **br / bv distribution (resolved 2026-04-16):** Both tools are from `Dicklesworthstone`, not `burningportra`.
  - `br` = [`Dicklesworthstone/beads_rust`](https://github.com/Dicklesworthstone/beads_rust). Install via `curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash` (Linux/macOS/WSL) or `cargo install --git https://github.com/Dicklesworthstone/beads_rust.git`. **No Homebrew tap.**
  - `bv` = [`Dicklesworthstone/beads_viewer`](https://github.com/Dicklesworthstone/beads_viewer). Install via `brew install dicklesworthstone/tap/bv` (macOS) or `curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh | bash` (Linux/macOS).
  - **Primary installer for `flywheel-setup`:** the upstream `curl | bash` script for each tool (uniform Linux+macOS, no Homebrew prereq). Offer Homebrew path for `bv` as an alternative when `brew` is on PATH.
  - **Bonus:** current README has broken links pointing to `burningportra/br` and `burningportra/bv` — fix in bead #4 (README rewrite).
- **Windows support (resolved 2026-04-16):** **Out of scope for v1.** `flywheel-setup` should detect Windows and print manual install instructions (Scoop for `bv`, install.ps1 for `br`) without offering auto-install. Revisit after macOS/Linux flow ships.
- **agent-mail lifecycle:** auto-spawning a long-running server from a setup command is fragile. Consider whether agent-mail should instead be declared as an HTTP MCP server in `plugin.json` so Claude Code manages its lifecycle — but HTTP servers in plugin.json still expect an already-running endpoint, so this doesn't fully solve the bootstrap. **Punt: keep manual spawn with helpful error messages; revisit after smoke test.**
- **`dist/` drift in CI:** adds a required check that can block PRs if a contributor forgets to rebuild. Mitigate with a `pre-commit` hook that rebuilds automatically, or a helper script `scripts/rebuild-dist.sh` called out in CONTRIBUTING.md.
