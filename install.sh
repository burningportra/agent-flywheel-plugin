#!/usr/bin/env bash
# install.sh — bootstrap agent-flywheel on a fresh machine
# Usage: curl -sSL https://example.com/install.sh | bash [-s -- --noninteractive]
set -euo pipefail

NONINTERACTIVE=0
SKIP_LAUNCH=0
SKIP_MCP_REGISTER=0
SKIP_AGENT_MAIL=0
SHOW_HELP=0

usage() {
  cat <<'EOF'
Usage: bash install.sh [flags]

Flags:
  --noninteractive      Run without prompts (CI mode).
  --skip-launch         Skip starting Claude Code at the end.
  --skip-mcp-register   Skip registering the MCP plugin.
  --skip-agent-mail     Skip starting / installing agent-mail.
  -h, --help            Show this help and exit.

Log file: ~/.agent-flywheel/install.log
EOF
}

for arg in "$@"; do
  case "$arg" in
    --noninteractive) NONINTERACTIVE=1 ;;
    --skip-launch) SKIP_LAUNCH=1 ;;
    --skip-mcp-register) SKIP_MCP_REGISTER=1 ;;
    --skip-agent-mail) SKIP_AGENT_MAIL=1 ;;
    -h|--help) SHOW_HELP=1 ;;
    *) echo "Unknown flag: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$SHOW_HELP" = "1" ]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOG_DIR="$HOME/.agent-flywheel"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install.log"
export LOG_FILE NONINTERACTIVE

# shellcheck source=install/lib/log.sh
source "$SCRIPT_DIR/install/lib/log.sh"
# shellcheck source=install/lib/detect.sh
source "$SCRIPT_DIR/install/lib/detect.sh"
# shellcheck source=install/lib/install-tool.sh
source "$SCRIPT_DIR/install/lib/install-tool.sh"

log "install.sh started: $(date -u +%FT%TZ)"
log "flags: noninteractive=$NONINTERACTIVE skip_launch=$SKIP_LAUNCH skip_mcp_register=$SKIP_MCP_REGISTER skip_agent_mail=$SKIP_AGENT_MAIL"

PKG="$(detect_pkg)"
export PKG
log "host: os=$(detect_os) arch=$(detect_arch) pkg=$PKG"

# Claude Code
if ! command -v claude >/dev/null 2>&1; then
  if prompt "Claude Code not found. Install via $PKG?"; then
    install_claude_code || err "Claude Code install failed (continuing)"
  else
    log "Skipping Claude Code install"
  fi
else
  ok "Claude Code already installed"
fi

# Required CLIs
MISSING=()
for tool in br bv cm dcg ntm; do
  command -v "$tool" >/dev/null 2>&1 || MISSING+=("$tool")
done

if [ ${#MISSING[@]} -gt 0 ]; then
  log "Missing tools: ${MISSING[*]}"
  if prompt "Install ${#MISSING[@]} tool(s) (${MISSING[*]}) via $PKG?"; then
    for tool in "${MISSING[@]}"; do
      install_tool "$tool" || err "Failed to install $tool (continuing)"
    done
  else
    log "Skipping required-CLI install"
  fi
else
  ok "All required CLIs (br/bv/cm/dcg/ntm) already on PATH"
fi

# Re-source shell config so brew installs land on PATH for the rest of the script.
if [ -f "$HOME/.zshrc" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.zshrc" 2>/dev/null || true
fi
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.bashrc" 2>/dev/null || true
fi

# Subsequent steps (agent-mail, Node, MCP register, launch) land in T2.3.
ok "install.sh through T2.2 complete"
