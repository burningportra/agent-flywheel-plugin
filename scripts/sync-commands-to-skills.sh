#!/usr/bin/env bash
# Sync commands/*.md with skills/*/SKILL.md content.
#
# Background: the plugin system injects commands/*.md as the prompt when users
# run /<name>. The authoritative content lives in skills/<name>/SKILL.md. These
# two files drift apart easily — this script checks for drift and can rewrite
# commands/*.md from the skill content.
#
# Usage:
#   scripts/sync-commands-to-skills.sh           # check only, exits 1 on drift
#   scripts/sync-commands-to-skills.sh --write   # rewrite commands/*.md in place

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMANDS_DIR="$REPO_ROOT/commands"
SKILLS_DIR="$REPO_ROOT/skills"

WRITE=0
if [[ "${1:-}" == "--write" ]]; then
  WRITE=1
fi

drift_count=0
fixed_count=0

for cmd in "$COMMANDS_DIR"/*.md; do
  name=$(basename "$cmd" .md)
  skill="$SKILLS_DIR/$name/SKILL.md"

  if [[ ! -f "$skill" ]]; then
    continue
  fi

  # Compare body (skip frontmatter: cmd=lines 4+, skill=lines 5+)
  if ! diff -q <(tail -n +4 "$cmd") <(tail -n +5 "$skill") > /dev/null 2>&1; then
    drift_count=$((drift_count + 1))
    echo "DRIFT: $name"

    if [[ $WRITE -eq 1 ]]; then
      # Preserve the command's frontmatter (lines 1-3), replace body with skill body (lines 5+)
      # Skill line 5 is already the blank line after frontmatter, so no need to add one.
      {
        head -n 3 "$cmd"
        tail -n +5 "$skill"
      } > "$cmd.tmp"
      mv "$cmd.tmp" "$cmd"
      fixed_count=$((fixed_count + 1))
      echo "  ✓ rewrote $cmd from $skill"
    fi
  fi
done

if [[ $drift_count -eq 0 ]]; then
  echo "OK: all command/skill pairs in sync"
  exit 0
fi

if [[ $WRITE -eq 1 ]]; then
  echo ""
  echo "Fixed $fixed_count/$drift_count drifted pairs."
  exit 0
fi

echo ""
echo "Found $drift_count drifted pairs. Run with --write to fix."
exit 1
