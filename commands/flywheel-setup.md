---
description: Set up flywheel prerequisites for this project.
---

Set up the agent-flywheel for this project. $ARGUMENTS

Check, install, and configure all prerequisites. For each missing tool, ask the user before installing. On refusal, print the manual install command and continue to the next check.

## 1. br CLI (bead tracker)

Run `br --version` via Bash.

- **If found**: report version. Check for `.beads/` directory — if missing, offer: *"Initialize beads in this project? (`br init`)"*. On consent, run `br init`.
- **If not found**: ask *"br is not installed. Install it now? (uses the official install script)"*
  - On consent: run via Bash: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash`
  - On refusal: print `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash` and continue.

## 2. bv CLI (bead viewer)

Run `bv --version` via Bash.

- **If found**: report version.
- **If not found**: check if `brew` is on PATH.
  - Homebrew available: ask *"bv is not installed. Install via Homebrew?"* On consent: `brew install dicklesworthstone/tap/bv`
  - No Homebrew: ask *"bv is not installed. Install via official script?"* On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh" | bash`
  - On refusal: print the relevant install command and continue.

## 3. agent-mail (multi-agent coordination)

Test liveness: `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` via Bash.

- **If reachable**: call `health_check` via the `agent-mail` MCP tool. Report healthy.
- **If not reachable**: check if the `mcp_agent_mail` Python package is installed: `python3 -c "import mcp_agent_mail"` via Bash.
  - Package installed but server not running: ask *"agent-mail is installed but not running. Start it in the background?"* On consent: run `nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &` via Bash, wait 3 seconds, re-check liveness.
  - Package not installed: print instructions: *"agent-mail is not installed. Install with: `uv tool install mcp-agent-mail` or `pip install mcp-agent-mail`, then start with: `uv run python -m mcp_agent_mail.cli serve-http`"*. Continue.

## 4. Pre-commit guard

Call `install_precommit_guard` via `agent-mail` MCP tool with `project_key` and `code_repo_path` set to the current working directory. Report success or failure.

## 5. Register agent

Call `register_agent` via `agent-mail` MCP tool with `project_key` set to the current working directory and `agent_name: "Orchestrator"`.

## 6. MCP server

Check that the flywheel MCP tools are available by confirming the `orch-tools` MCP server is loaded (it should autoload from `plugin.json`). If not available, check `mcp-server/dist/server.js` exists and instruct the user to run `/reload-plugins`.

## 7. Health checklist

Display a summary:
```
br v1.x.x — beads initialized
bv v1.x.x
agent-mail — healthy
pre-commit guard installed
MCP server loaded
```

Use a checkmark for passing items and an X for failed/skipped items. For any X items, repeat the manual install command below the checklist.
