#!/usr/bin/env bats
# Unit tests for install/lib/install-tool.sh

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  TMP_HOME="$(mktemp -d)"
  export HOME="$TMP_HOME"
  export LOG_FILE="$TMP_HOME/install.log"
  # shellcheck source=../lib/log.sh
  source "$REPO_ROOT/install/lib/log.sh"
  # shellcheck source=../lib/install-tool.sh
  source "$REPO_ROOT/install/lib/install-tool.sh"
}

teardown() {
  rm -rf "${TMP_HOME:-}" 2>/dev/null || true
}

@test "install_tool fails clearly when pkg unknown" {
  PKG=unknown run install_tool fakebin
  [ "$status" -eq 1 ]
  [[ "$output" == *"package manager not recognized"* ]]
}

@test "install_tool with empty arg returns 2 (usage error)" {
  PKG=brew run install_tool ""
  [ "$status" -eq 2 ]
  [[ "$output" == *"without a tool name"* ]]
}

@test "install_tool dispatches on PKG via case (brew path attempted)" {
  # Stub brew so we don't actually mutate the host.
  brew() { echo "BREW $*"; return 0; }
  export -f brew 2>/dev/null || true
  PKG=brew
  run install_tool widget
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installing widget via brew"* ]]
}

@test "install_claude_code errors when not brew and npm missing" {
  # Shadow `command` so npm is reported as missing without breaking PATH.
  command() {
    if [ "$1" = "-v" ] && [ "$2" = "npm" ]; then return 1; fi
    builtin command "$@"
  }
  export -f command 2>/dev/null || true
  PKG=apt run install_claude_code
  [ "$status" -eq 1 ]
  [[ "$output" == *"requires brew or npm"* ]]
}
