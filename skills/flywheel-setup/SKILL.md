---
name: orchestrate-setup
description: Set up orchestration prerequisites for this project.
---

Set up the orchestrator for this project. $ARGUMENTS

Check and configure all prerequisites:

1. **MCP server (build)**: Locate and verify the orchestrator MCP server is built.
   - The plugin's `skills/` directory is typically a symlink to the repo root's `skills/` folder. Resolve it to find `mcp-server/` as a sibling:
     ```bash
     SKILLS_REAL=$(readlink ~/.claude/plugins/marketplaces/local-desktop-app-uploads/claude-orchestrator/skills 2>/dev/null)
     MCSRV="${SKILLS_REAL%/skills}/mcp-server"
     test -f "$MCSRV/dist/server.js" && echo "OK: $MCSRV" || echo "MISSING: $MCSRV"
     ```
   - If MISSING: **STOP.** Instruct:
     ```
     cd <resolved-mcp-server-path> && npm install && npm run build
     ```
   - Do not proceed to other checks until this passes.

2. **MCP server (registered)**: Verify the MCP server is actually loaded in this Claude Code session.
   - Run `ToolSearch("orch_profile")` to check if orchestrator tools are available.
   - If no results: the server is built but not registered. Instruct:
     "Add the `orchestrator` server entry to your Claude Code MCP config (`.mcp.json` in the plugin dir or `claude_desktop_config.json`) and restart Claude Code."

3. **br CLI**: Run `br --version` via Bash.
   - If not found: "br is not installed. Install from https://github.com/burningportra/br"
   - If found: check `.beads/` directory. If missing, offer to run `br init`.

4. **bv CLI**: Run `bv --version` via Bash. Report status.

5. **agent-mail**: Test `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` via Bash.
   - If reachable: call `health_check` via `agent-mail` MCP tool.
   - If not reachable: "agent-mail is not running. Start it with: `uv run python -m mcp_agent_mail.cli serve-http`"

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
   ✅ MCP server registered (orch_profile tool available)
   ✅ br v1.x.x — beads initialized
   ✅ bv v1.x.x
   ✅ agent-mail — healthy
   ✅ pre-commit guard installed
   ✅ DCG hook active
   ✅ agent registered as "Orchestrator"
   ```

10. **Gate recommendation:**
   - If ALL checks pass: "All prerequisites met. You can now run `/orchestrate`."
   - If ANY check failed: "**Do not run `/orchestrate` until all checks pass.** Fix the items marked ❌ above and re-run `/orchestrate-setup`."
