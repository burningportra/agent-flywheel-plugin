---
description: Set up orchestration prerequisites for this project.
---

Set up the orchestrator for this project. $ARGUMENTS

Check and configure all prerequisites:

1. **br CLI**: Run `br --version` via Bash.
   - If not found: "br is not installed. Install from https://github.com/burningportra/br"
   - If found: check `.beads/` directory. If missing, offer to run `br init`.

2. **bv CLI**: Run `bv --version` via Bash. Report status.

3. **agent-mail**: Test `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` via Bash.
   - If reachable: call `health_check` via `agent-mail` MCP tool.
   - If not reachable: "agent-mail is not running. Start it with: `uv run python -m mcp_agent_mail.cli serve-http`"

4. **Pre-commit guard**: Call `install_precommit_guard` via `agent-mail` MCP tool with `project_key` and `code_repo_path` set to the current working directory.

5. **Register agent**: Call `register_agent` via `agent-mail` MCP tool with `project_key` and `agent_name: "Orchestrator"`.

6. **MCP server**: Check that `mcp-server/dist/server.js` exists. If not, instruct: "Build the MCP server first: `cd mcp-server && npm install && npm run build`"

7. Display a health checklist:
   ```
   ✅ br v1.x.x — beads initialized
   ✅ bv v1.x.x
   ✅ agent-mail — healthy
   ✅ pre-commit guard installed
   ✅ MCP server built
   ```
