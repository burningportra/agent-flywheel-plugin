---
name: flywheel-setup
description: Set up flywheel prerequisites for this project.
---

Set up the agent-flywheel for this project. $ARGUMENTS

Check and configure all prerequisites:

1. **MCP server (build)**: The compiled `mcp-server/dist/` is committed with the plugin, so it should work out of the box after `/plugin install`. Verify `mcp-server/dist/server.js` exists relative to the plugin root. If missing (e.g. contributor checkout without dist), instruct: `cd mcp-server && npm ci && npm run build`.

2. **MCP server (registered)**: Verify the MCP server is actually loaded in this Claude Code session.
   - Run `ToolSearch("flywheel_profile")` to check if flywheel tools are available.
   - If no results: the server is built but not registered. Instruct:
     "Add the `agent-flywheel` server entry to your Claude Code MCP config (`.mcp.json` in the plugin dir or `claude_desktop_config.json`) and restart Claude Code."

3. **br CLI**: Run `br --version` via Bash.
   - If found: check `.beads/` directory. If missing, offer to run `br init`.
   - If not found: ask *"br is not installed. Install it now? (uses the official install script)"*
     - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash`
     - On refusal: print the install command and continue.

4. **bv CLI**: Run `bv --version` via Bash.
   - If found: report version.
   - If not found: check if `brew` is on PATH.
     - Homebrew available: ask *"bv is not installed. Install via Homebrew?"* On consent: `brew install dicklesworthstone/tap/bv`
     - No Homebrew: ask *"Install via official script?"* On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh" | bash`
     - On refusal: print the relevant install command and continue.

5. **agent-mail**: Test `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` via Bash.
   - If reachable: call `health_check` via `agent-mail` MCP tool.
   - If not reachable: check if package is installed: `python3 -c "import mcp_agent_mail"` via Bash.
     - Installed but not running: ask *"agent-mail is installed but not running. Start it in the background?"* On consent: `nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &`, wait 3 seconds, re-check liveness.
     - Not installed: print *"Install with: `uv tool install mcp-agent-mail` or `pip install mcp-agent-mail`, then start with: `uv run python -m mcp_agent_mail.cli serve-http`"*. Continue.

6. **Pre-commit guard**: Call `install_precommit_guard` via `agent-mail` MCP tool with `project_key` and `code_repo_path` set to the current working directory.

7. **DCG (Destructive Command Guard)**: Check if a PreToolUse hook exists in the project's `.claude/settings.json` that blocks destructive commands. If not, create one:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             {
               "type": "command",
               "command": "bash -c 'echo \"$CLAUDE_TOOL_INPUT\" | jq -r .command | grep -qiE \"(rm\\s+-rf|git\\s+reset\\s+--hard|git\\s+clean\\s+-f|git\\s+checkout\\s+\\.\\s|git\\s+push\\s+--force|drop\\s+table|truncate\\s+table)\" && echo \"BLOCKED: Destructive command detected. Ask the user for explicit permission.\" && exit 1 || exit 0'"
             }
           ]
         }
       ]
     }
   }
   ```
   If `.claude/settings.json` already exists with other hooks, merge the PreToolUse entry rather than overwriting. This provides mechanical enforcement beyond the social rules in AGENTS.md.

8. **Register agent**: Call `register_agent` via `agent-mail` MCP tool with `project_key` and `agent_name: "Orchestrator"`.

9. Display a health checklist:
   ```
   ✅ MCP server built (dist/server.js exists)
   ✅ MCP server registered (flywheel_profile tool available)
   ✅ br v1.x.x — beads initialized
   ✅ bv v1.x.x
   ✅ agent-mail — healthy
   ✅ pre-commit guard installed
   ✅ DCG hook active
   ✅ agent registered as "Orchestrator"
   ```

10. **Gate recommendation:**
   - If ALL checks pass: "All prerequisites met. You can now run `/start`."
   - If ANY check failed: "**Do not run `/start` until all checks pass.** Fix the items marked ❌ above and re-run `/flywheel-setup`."
