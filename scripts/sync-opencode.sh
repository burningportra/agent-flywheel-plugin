#!/usr/bin/env bash
set -euo pipefail

CDPATH=''
export CDPATH
script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd)
if ! repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel 2>/dev/null); then
  echo "sync-opencode: cannot resolve the repository root" >&2
  exit 2
fi

helper="$repo_root/scripts/opencode/sync.mjs"
if [[ ! -f "$helper" ]]; then
  echo "sync-opencode: Node helper is missing: $helper" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "sync-opencode: Node 20+ is required" >&2
  exit 2
fi

exec node "$helper" "$@"
