#!/usr/bin/env bats
# Unit tests for install/lib/detect.sh + install/lib/log.sh + install.sh flag parser.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  # shellcheck source=../lib/detect.sh
  source "$REPO_ROOT/install/lib/detect.sh"
  # shellcheck source=../lib/log.sh
  source "$REPO_ROOT/install/lib/log.sh"
  TMP_HOME="$(mktemp -d)"
  export HOME="$TMP_HOME"
  export LOG_FILE="$TMP_HOME/install.log"
}

teardown() {
  rm -rf "${TMP_HOME:-}" 2>/dev/null || true
}

@test "detect_os returns Darwin or Linux" {
  result="$(detect_os)"
  [[ "$result" == "Darwin" || "$result" == "Linux" ]]
}

@test "detect_arch returns non-empty string" {
  result="$(detect_arch)"
  [ -n "$result" ]
}

@test "detect_pkg returns a known manager or 'unknown'" {
  result="$(detect_pkg)"
  case "$result" in
    brew|apt|dnf|pacman|unknown) ;;
    *) echo "unexpected pkg manager: $result" >&2; return 1 ;;
  esac
}

@test "log writes timestamped line to LOG_FILE" {
  log "hello world" 2>/dev/null
  [ -f "$LOG_FILE" ]
  grep -q "hello world" "$LOG_FILE"
}

@test "ok prefixes message with check mark and writes to LOG_FILE" {
  ok "did the thing" >/dev/null
  grep -q "did the thing" "$LOG_FILE"
}

@test "err writes to stderr and LOG_FILE" {
  run bash -c "source '$REPO_ROOT/install/lib/log.sh'; LOG_FILE='$LOG_FILE' err 'boom' 2>&1 1>/dev/null"
  [ "$status" -eq 0 ]
  [[ "$output" == *"boom"* ]]
  grep -q "boom" "$LOG_FILE"
}

@test "prompt returns 0 when NONINTERACTIVE=1 without reading stdin" {
  NONINTERACTIVE=1 run prompt "ignored?"
  [ "$status" -eq 0 ]
}

@test "install.sh accepts known flags and exits 0" {
  run bash "$REPO_ROOT/install.sh" --noninteractive --skip-launch --skip-mcp-register --skip-agent-mail
  [ "$status" -eq 0 ]
}

@test "install.sh rejects unknown flag with exit 1" {
  run bash "$REPO_ROOT/install.sh" --bogus-flag
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown flag"* ]]
}

@test "install.sh --help exits 0 with usage" {
  run bash "$REPO_ROOT/install.sh" --noninteractive --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "install.sh writes log to ~/.agent-flywheel/install.log" {
  run bash "$REPO_ROOT/install.sh" --noninteractive
  [ "$status" -eq 0 ]
  [ -f "$HOME/.agent-flywheel/install.log" ]
  grep -q "install.sh started" "$HOME/.agent-flywheel/install.log"
}
