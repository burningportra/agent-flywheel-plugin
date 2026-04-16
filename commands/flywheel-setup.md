---
description: Set up flywheel prerequisites for this project.
---

Set up the agent-flywheel for this project. $ARGUMENTS

Check, install, and configure all prerequisites. For each missing tool, ask the user before installing. On refusal, print the manual install command and continue to the next check.

## 0. ACFS stack shortcut

Before checking individual tools, count how many of the ACFS stack tools are missing (br, bv, ntm, dcg, cass, cm, agent-mail). If **3 or more** are missing, offer the fast path first:

> "Multiple ACFS stack tools are missing. Install the full stack at once? This installs br, bv, ntm, dcg, cass, cm, agent-mail, and more."

On consent, run via Bash:
```
curl -fsSL "https://raw.githubusercontent.com/DavidSchargel/dicklesworthstone-acfs-stack-for-macos/main/dicklesworthstone-stack.sh" -o /tmp/dicklesworthstone-stack.sh && chmod +x /tmp/dicklesworthstone-stack.sh && /tmp/dicklesworthstone-stack.sh install
```

Prerequisites for the stack script: `curl`, `uv`, and `python3` must be on PATH. Check these before running; if any are missing, skip the shortcut and fall through to individual installs.

After the stack installer completes, re-check each tool below — skip the install prompt for any that are now present and just report their version.

On refusal, fall through to individual tool checks below.

---

## Required tools (flywheel will not run without these)

### 1. br CLI (bead tracker)

Run `br --version` via Bash.

- **If found**: report version. Check for `.beads/` directory — if missing, offer: *"Initialize beads in this project? (`br init`)"*. On consent, run `br init`.
- **If not found**: ask *"br is not installed. Install it now? (uses the official install script)"*
  - On consent: run via Bash: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash`
  - On refusal: print the install command and continue.

### 2. bv CLI (bead viewer)

Run `bv --version` via Bash.

- **If found**: report version.
- **If not found**: check if `brew` is on PATH.
  - Homebrew available: ask *"bv is not installed. Install via Homebrew?"* On consent: `brew install dicklesworthstone/tap/bv`
  - No Homebrew: ask *"bv is not installed. Install via official script?"* On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh" | bash`
  - On refusal: print the relevant install command and continue.

### 3. agent-mail (multi-agent coordination)

Test liveness: `curl -s --max-time 3 http://127.0.0.1:8765/health/liveness` via Bash.

- **If reachable**: call `health_check` via the `agent-mail` MCP tool. Report healthy.
- **If not reachable**: check if the `mcp_agent_mail` Python package is installed: `python3 -c "import mcp_agent_mail"` via Bash.
  - Package installed but server not running: ask *"agent-mail is installed but not running. Start it in the background?"* On consent: run `nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &` via Bash, wait 3 seconds, re-check liveness.
  - Package not installed: ask *"agent-mail is not installed. Install now?"*
    - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail/main/scripts/install.sh" | bash -s -- --yes`
    - On refusal: print *"Install with: `uv tool install mcp-agent-mail` or `pip install mcp-agent-mail`, then start with: `uv run python -m mcp_agent_mail.cli serve-http`"*. Continue.

---

## Recommended tools (flywheel works without these but key features degrade)

### 4. ntm (Named Tmux Manager — parallel agent sessions)

Run `ntm --version` via Bash.

- **If found**: report version.
- **If not found**: ask *"ntm enables parallel agent swarm sessions. Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/ntm/main/install.sh" | bash`
  - On refusal: print the install command and continue.

### 5. dcg (Destructive Command Guard)

Run `dcg --version` via Bash (or check if the dcg hook exists in `.claude/settings.json`).

- **If found**: report version.
- **If not found**: ask *"dcg blocks dangerous commands (rm -rf, git push --force, etc.). Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/master/install.sh" | bash -s -- --easy-mode`
  - On refusal: print the install command and continue.

### 6. cass (Coding Agent Session Search)

Run `cass --version` via Bash.

- **If found**: report version.
- **If not found**: ask *"cass indexes past agent sessions for search. Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/coding_agent_session_search/main/install.sh" | bash -s -- --easy-mode --verify`
  - On refusal: print the install command and continue.

### 7. cm (CASS Memory — procedural memory for agents)

Run `cm --version` via Bash.

- **If found**: report version.
- **If not found**: ask *"cm gives agents procedural memory from past sessions. Install?"*
  - On consent: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/cass_memory_system/main/install.sh" | bash -s -- --easy-mode --verify`
  - On refusal: print the install command and continue.

---

## Optional tools (not prompted — listed in checklist only)

The following tools are part of the ACFS stack but not required for flywheel operation. They are checked silently and reported in the health checklist:

- **slb** (Simultaneous Launch Button) — two-person rule for destructive ops. Install: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/slb/main/scripts/install.sh" | bash`
- **ubs** (Ultimate Bug Scanner) — multi-language bug scanner. Install: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/ultimate_bug_scanner/master/install.sh" | bash -s --`
- **caam** (Account Manager) — switch between AI CLI accounts. Install: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/coding_agent_account_manager/main/install.sh" | bash`
- **ru** (Repo Updater) — batch-sync GitHub repos. Install: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/repo_updater/main/install.sh" | bash`
- **ms** (Meta Skill) — skill discovery. Install: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/meta_skill/main/install.sh" | bash`

---

## Post-install configuration

### 8. Pre-commit guard

Call `install_precommit_guard` via `agent-mail` MCP tool with `project_key` and `code_repo_path` set to the current working directory. Report success or failure.

### 9. Register agent

Call `register_agent` via `agent-mail` MCP tool with `project_key` set to the current working directory and `agent_name: "Orchestrator"`.

### 10. MCP server

Check that the flywheel MCP tools are available by confirming the `orch-tools` MCP server is loaded (it should autoload from `plugin.json`). If not available, check `mcp-server/dist/server.js` exists and instruct the user to run `/reload-plugins`.

---

## 11. Health checklist

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
```

Use a checkmark for passing items and an X for failed/skipped items. For any X items in the Required or Recommended tiers, repeat the manual install command below the checklist.

If all Required items pass: *"All prerequisites met. You can now run `/start`."*
If any Required item failed: *"Do not run `/start` until all Required items pass. Fix the items marked above and re-run `/flywheel-setup`."*
