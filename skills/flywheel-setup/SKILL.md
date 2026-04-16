---
name: flywheel-setup
description: Set up flywheel prerequisites for this project.
---

Set up the agent-flywheel for this project. $ARGUMENTS

Check and configure all prerequisites. For each missing tool, ask the user before installing. On refusal, print the manual install command and continue.

## 0. ACFS stack shortcut

Before checking individual tools, count how many of the ACFS stack tools are missing (br, bv, ntm, dcg, cass, cm, agent-mail). Run `br --version`, `bv --version`, `ntm --version`, `dcg --version`, `cass --version`, `cm --version`, and `python3 -c "import mcp_agent_mail"` via Bash to check.

If **3 or more** are missing, offer the fast path:

> "Multiple ACFS stack tools are missing. Install the full stack at once? This installs br, bv, ntm, dcg, cass, cm, agent-mail, and more."

Prerequisites for the stack script: `curl`, `uv`, and `python3` must be on PATH. Check these first; if any are missing, skip the shortcut and fall through to individual installs.

On consent, run via Bash:
```
curl -fsSL "https://raw.githubusercontent.com/DavidSchargel/dicklesworthstone-acfs-stack-for-macos/main/dicklesworthstone-stack.sh" -o /tmp/dicklesworthstone-stack.sh && chmod +x /tmp/dicklesworthstone-stack.sh && /tmp/dicklesworthstone-stack.sh install
```

After the stack installer completes, re-check each tool below — skip the install prompt for any that are now present and just report their version.

On refusal, fall through to individual tool checks.

## 1. MCP server (build)

The compiled `mcp-server/dist/` is committed with the plugin, so it should work out of the box after `/plugin install`. Verify `mcp-server/dist/server.js` exists relative to the plugin root. If missing (e.g. contributor checkout without dist), instruct: `cd mcp-server && npm ci && npm run build`.

## 2. MCP server (registered)

Verify the MCP server is loaded in this Claude Code session.
- Run `ToolSearch("flywheel_profile")` to check if flywheel tools are available.
- If no results: the server is built but not registered. Instruct the user to run `/reload-plugins`.

---

## Required tools (flywheel will not run without these)

### 3. br CLI (bead tracker)

Run `br --version` via Bash.

- If found: check `.beads/` directory. If missing, offer to run `br init`.
- If not found: ask *"br is not installed. Install it now? (uses the official install script)"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash`
  - On refusal: print the install command and continue.

### 4. bv CLI (bead viewer)

Run `bv --version` via Bash.

- If found: report version.
- If not found: check if `brew` is on PATH.
  - Homebrew available: ask *"bv is not installed. Install via Homebrew?"* On consent: `brew install dicklesworthstone/tap/bv`
  - No Homebrew: ask *"Install via official script?"* On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh" | bash`
  - On refusal: print the relevant install command and continue.

### 5. agent-mail (multi-agent coordination)

Test liveness: `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` via Bash.

- If reachable: call `health_check` via `agent-mail` MCP tool.
- If not reachable: check if package is installed: `python3 -c "import mcp_agent_mail"` via Bash.
  - Installed but not running: ask *"agent-mail is installed but not running. Start it in the background?"* On consent: `nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &`, wait 3 seconds, re-check liveness.
  - Not installed: ask *"agent-mail is not installed. Install now?"*
    - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail/main/scripts/install.sh" | bash -s -- --yes`
    - On refusal: print install instructions and continue.

---

## Recommended tools (flywheel works but key features degrade without these)

### 6. ntm (Named Tmux Manager — parallel agent sessions)

Run `ntm --version` via Bash.

- If found: report version.
- If not found: ask *"ntm enables parallel agent swarm sessions. Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/ntm/main/install.sh" | bash`
  - On refusal: print the install command and continue.

### 7. dcg (Destructive Command Guard)

Run `dcg --version` via Bash (or check if the dcg hook exists in `.claude/settings.json`).

- If found: report version.
- If not found: ask *"dcg blocks dangerous commands (rm -rf, git push --force, etc.). Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/master/install.sh" | bash -s -- --easy-mode`
  - On refusal: print the install command and continue.

If dcg is installed, also verify that a PreToolUse hook exists in `.claude/settings.json` that blocks destructive commands. If not, create one:
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
If `.claude/settings.json` already exists with other hooks, merge the PreToolUse entry rather than overwriting.

### 8. cass (Coding Agent Session Search)

Run `cass --version` via Bash.

- If found: report version.
- If not found: ask *"cass indexes past agent sessions for search. Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/coding_agent_session_search/main/install.sh" | bash -s -- --easy-mode --verify`
  - On refusal: print the install command and continue.

### 9. cm (CASS Memory — procedural memory for agents)

Run `cm --version` via Bash.

- If found: report version.
- If not found: ask *"cm gives agents procedural memory from past sessions. Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/cass_memory_system/main/install.sh" | bash -s -- --easy-mode --verify`
  - On refusal: print the install command and continue.

---

## Optional tools (not prompted — reported in checklist only)

Check these silently via `<tool> --version` and report in the health checklist. Do not prompt to install.

- **slb** — two-person rule for destructive ops. `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/slb/main/scripts/install.sh" | bash`
- **ubs** — multi-language bug scanner. `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/ultimate_bug_scanner/master/install.sh" | bash -s --`
- **caam** — AI CLI account switcher. `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/coding_agent_account_manager/main/install.sh" | bash`
- **ru** — batch repo sync. `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/repo_updater/main/install.sh" | bash`
- **ms** — skill discovery. `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/meta_skill/main/install.sh" | bash`

---

## Post-install configuration

### 10. Pre-commit guard

Call `install_precommit_guard` via `agent-mail` MCP tool with `project_key` and `code_repo_path` set to the current working directory.

### 11. Register agent

Call `register_agent` via `agent-mail` MCP tool with `project_key` set to the current working directory and `agent_name: "Orchestrator"`.

---

## 12. Health checklist

Display a summary with all tools grouped by tier:

```
REQUIRED
  br v1.x.x — beads initialized
  bv v1.x.x
  agent-mail — healthy

RECOMMENDED
  ntm v1.x.x
  dcg v1.x.x
  cass v1.x.x
  cm v1.x.x

OPTIONAL
  slb — not installed
  ubs — not installed
  caam — not installed
  ru — not installed
  ms — not installed

CONFIGURATION
  pre-commit guard installed
  MCP server loaded
  agent registered as "Orchestrator"
```

Use a checkmark for passing items and an X for failed/skipped items. For any X items in the Required or Recommended tiers, repeat the manual install command below the checklist.

If ALL Required items pass: *"All prerequisites met. You can now run `/start`."*
If ANY Required item failed: *"Do not run `/start` until all Required items pass. Fix the items marked above and re-run `/flywheel-setup`."*
