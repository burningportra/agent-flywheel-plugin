#!/bin/sh
set -eu

if [ -n "${CLAUDE_TEAMS_DIR:-}" ]; then
  teams_dir=$CLAUDE_TEAMS_DIR
else
  teams_dir=${HOME:?HOME is required}/.claude/teams
fi

[ -d "$teams_dir" ] || exit 0
[ "$#" -gt 0 ] || exit 0

tmp_path=""
cleanup() {
  [ -z "$tmp_path" ] || rm -f "$tmp_path"
}
trap cleanup EXIT HUP INT TERM

for team_name in "$@"; do
  case "$team_name" in
    ""|.|..|*/*)
      printf 'team-drain: invalid team name: %s\n' "$team_name" >&2
      exit 2
      ;;
  esac
  team_dir=$teams_dir/$team_name
  if [ ! -d "$team_dir" ]; then
    printf 'team-drain: team directory not found: %s\n' "$team_dir" >&2
    exit 2
  fi
  config_path=$team_dir/config.json
  if [ ! -f "$config_path" ]; then
    printf 'team-drain: config not found: %s\n' "$config_path" >&2
    exit 2
  fi
  tmp_path=$config_path.tmp.$$

  node --input-type=module - "$config_path" "$tmp_path" <<'NODE'
import { readFileSync, statSync, writeFileSync } from "node:fs";

const [sourcePath, targetPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(sourcePath, "utf8"));
if (config === null || typeof config !== "object" || !Array.isArray(config.members)) {
  throw new Error(`${sourcePath} must contain a members array`);
}
config.members = config.members.filter(
  (member) => member !== null && typeof member === "object" && member.name === "team-lead",
);
writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: statSync(sourcePath).mode,
});
NODE

  mv "$tmp_path" "$config_path"
  tmp_path=""
  printf '%s\n' "$team_name"
done
