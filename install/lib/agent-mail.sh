#!/usr/bin/env bash
# install/lib/agent-mail.sh — start the agent-mail HTTP service and probe its
# /health/liveness endpoint. Depends on log/ok/err from lib/log.sh and the
# LOG_DIR env var (typically ~/.agent-flywheel/, set in install.sh).

# start_agent_mail
# Starts `am serve-http --port 8765` in the background via nohup, redirecting
# stdout/stderr to $LOG_DIR/agent-mail.log. Returns 0 if /health/liveness
# answers within ~2 seconds, 1 otherwise.
start_agent_mail() {
  if curl -fsS --max-time 1 http://127.0.0.1:8765/health/liveness >/dev/null 2>&1; then
    ok "agent-mail already running on :8765"
    return 0
  fi
  if ! command -v am >/dev/null 2>&1; then
    err "am binary not found; install via 'brew install burningportra/tap/agent-mail'"
    return 1
  fi
  local logfile="${LOG_DIR:-$HOME/.agent-flywheel}/agent-mail.log"
  log "Starting agent-mail HTTP service on :8765 (log: $logfile)"
  nohup am serve-http --port 8765 >"$logfile" 2>&1 &
  disown 2>/dev/null || true
  sleep 2
  if curl -fsS --max-time 1 http://127.0.0.1:8765/health/liveness >/dev/null 2>&1; then
    ok "agent-mail HTTP service started"
    return 0
  fi
  err "agent-mail did not respond on :8765 after 2s; check $logfile"
  return 1
}

# node_ok
# Asserts a Node runtime ≥ 20 is on PATH. Returns 1 on missing or older node.
node_ok() {
  if ! command -v node >/dev/null 2>&1; then
    err "node not found — install Node 20+ (https://nodejs.org or 'nvm install 20')"
    return 1
  fi
  local raw major
  raw="$(node -v 2>/dev/null)"
  major="$(printf '%s' "$raw" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ -z "$major" ] || ! [[ "$major" =~ ^[0-9]+$ ]]; then
    err "could not parse Node version from '$raw'"
    return 1
  fi
  if [ "$major" -lt 20 ]; then
    err "Node $raw < 20 — install with: nvm install 20"
    return 1
  fi
  ok "Node $raw ✓"
}
