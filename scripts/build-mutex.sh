#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'Usage: scripts/build-mutex.sh <command> [args...]' >&2
  printf '%s\n' 'Example: scripts/build-mutex.sh rch build' >&2
}

if [ "$#" -eq 0 ]; then
  usage
  exit 64
fi

lock_dir=${BUILD_MUTEX_LOCK_DIR:-.pi-flywheel/build.lock.d}
retry_delay=${BUILD_MUTEX_RETRY_DELAY_SECONDS:-1}
warn_after_attempts=${BUILD_MUTEX_WARN_AFTER_ATTEMPTS:-300}

case "$lock_dir" in
  '' | '/' | '.')
    printf 'build-mutex: refusing unsafe lock directory: %s\n' "$lock_dir" >&2
    exit 64
    ;;
esac

case "$lock_dir" in
  */*) lock_parent=${lock_dir%/*} ;;
  *) lock_parent=. ;;
esac

mkdir -p "$lock_parent"

platform=$(uname -s 2>/dev/null || printf 'unknown')
attempts=0
warned=0

while ! mkdir "$lock_dir" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$warned" -eq 0 ] && [ "$attempts" -ge "$warn_after_attempts" ]; then
    printf 'build-mutex: waited at least %s attempts for %s; escalate before killing the holder\n' "$attempts" "$lock_dir" >&2
    warned=1
  fi
  sleep "$retry_delay"
done

cleanup() {
  code=$?
  trap - EXIT INT TERM HUP
  rm -f "$lock_dir/owner" 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || rm -rf "$lock_dir"
  exit "$code"
}

trap cleanup EXIT INT TERM HUP

{
  printf 'pid=%s\n' "$$"
  printf 'agent=%s\n' "${AGENT_NAME:-unknown}"
  printf 'platform=%s\n' "$platform"
  printf 'command=%s\n' "$*"
} > "$lock_dir/owner"

"$@"
