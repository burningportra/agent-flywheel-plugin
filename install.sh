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

log "install.sh started: $(date -u +%FT%TZ)"
log "flags: noninteractive=$NONINTERACTIVE skip_launch=$SKIP_LAUNCH skip_mcp_register=$SKIP_MCP_REGISTER skip_agent_mail=$SKIP_AGENT_MAIL"
log "host: os=$(detect_os) arch=$(detect_arch) pkg=$(detect_pkg)"

# Subsequent steps (CC + tools, agent-mail, finalize) land in T2.2 / T2.3.
ok "install.sh skeleton complete (T2.1)"
