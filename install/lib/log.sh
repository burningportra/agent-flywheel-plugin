#!/usr/bin/env bash
# install/lib/log.sh — logging + prompt helpers for install.sh

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "${LOG_FILE:-/dev/null}" >&2; }
err() { echo "❌ $*" | tee -a "${LOG_FILE:-/dev/null}" >&2; }
ok()  { echo "✓ $*" | tee -a "${LOG_FILE:-/dev/null}"; }
prompt() {
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then return 0; fi
  read -r -p "$1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}
