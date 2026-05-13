#!/usr/bin/env bash
# install/lib/install-tool.sh — package-manager-aware tool installers.
#
# Exports:
#   install_tool <name>       Install a single CLI via the detected pkg manager.
#                             Honors PKG env var (defaults to brew).
#                             Brew tries burningportra/tap/<name> first, falls
#                             back to plain <name>. Returns 1 on unknown pkg.
#   install_claude_code       Install Claude Code (brew formula on macOS;
#                             npm global elsewhere).
#
# Failure policy: a single tool's failure is reported via err() and propagates
# the non-zero exit code so the caller can decide whether to abort the loop.
# install.sh wraps each call with `|| err …` so the loop continues.

install_tool() {
  local tool="$1"
  local pkg="${PKG:-brew}"
  if [ -z "$tool" ]; then
    err "install_tool called without a tool name"
    return 2
  fi
  log "Installing $tool via $pkg"
  case "$pkg" in
    brew)
      brew install "burningportra/tap/$tool" 2>/dev/null \
        || brew install "$tool"
      ;;
    apt)
      sudo apt-get install -y "$tool"
      ;;
    dnf)
      sudo dnf install -y "$tool"
      ;;
    pacman)
      sudo pacman -S --noconfirm "$tool"
      ;;
    *)
      err "Cannot auto-install $tool — package manager not recognized (PKG=$pkg)"
      return 1
      ;;
  esac
}

install_claude_code() {
  local pkg="${PKG:-brew}"
  log "Installing Claude Code via $pkg (fallback: npm)"
  case "$pkg" in
    brew)
      brew install anthropic/cc/claude
      ;;
    *)
      if command -v npm >/dev/null 2>&1; then
        npm install -g @anthropic-ai/claude-cli
      else
        err "Claude Code install requires brew or npm; neither available"
        return 1
      fi
      ;;
  esac
}
