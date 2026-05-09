#!/usr/bin/env bash
# R-009 (agent-ergonomics audit pass 4) — wrapper for Claude Code hooks.
#
# Pre-R-009: hooks ran with `2>/dev/null || true`, swallowing every
# error and leaving the agent with no signal when a hook crashed.
#
# Post-R-009 (this stage = warn-only): runs the hook, captures stderr
# to a log file under $XDG_STATE_HOME/agent-flywheel/hook-errors.log,
# and writes a one-line structured marker on non-zero exit. Always
# exits 0 to preserve current Claude Code behavior — agents that
# care can `tail -f` the log. v4.0 will drop the always-zero exit
# and let SessionStart/Stop hook failures surface to the user.
#
# Exit-code contract on the inner command (documented for hook authors
# who write new hook scripts; this wrapper records but does not
# propagate non-zero exits in the warn-only stage):
#   0 — ok
#   1 — user-input-error
#   2 — safety-block (refused destructive op)
#   3 — tool-environment-error (binary missing, path unwritable)
#
# Env overrides:
#   FW_HOOK_LOG       — explicit log file path (skips XDG resolution)
#   FW_HOOK_LOG_LEVEL — "off" silences the wrapper entirely; default "warn"

set -uo pipefail

# Locate the log file deterministically. Honor XDG; fall back to ~/.local/state.
log_level="${FW_HOOK_LOG_LEVEL:-warn}"
if [ "$log_level" = "off" ]; then
  exec "$@" >/dev/null 2>&1 || true
fi

if [ -n "${FW_HOOK_LOG:-}" ]; then
  log_path="$FW_HOOK_LOG"
else
  state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
  log_path="$state_home/agent-flywheel/hook-errors.log"
fi

# Best-effort log dir creation; failures here should not break the session.
mkdir -p "$(dirname "$log_path")" 2>/dev/null || true

# Run the inner command, capture combined output for logging on failure.
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
out="$("$@" 2>&1)"
rc=$?

if [ "$rc" -ne 0 ]; then
  # One-line structured marker; full output appended on subsequent lines.
  {
    printf 'ts=%s rc=%d cmd=%s\n' "$ts" "$rc" "$*"
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | sed 's/^/  /'
    fi
    printf '\n'
  } >>"$log_path" 2>/dev/null || true
fi

# Warn-only stage: never propagate the inner failure. v4.0 will drop this.
exit 0
