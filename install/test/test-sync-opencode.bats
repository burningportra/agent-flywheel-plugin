#!/usr/bin/env bats
#
# Black-box failure matrix for the OpenCode sync pipeline (bead claude-19xh, T7).
#
# Every case runs the real CLI against a THROWAWAY fake home — never the
# runner's real ~/.config/opencode. setup() re-points HOME + XDG_CONFIG_HOME at
# a mktemp fake home and stubs `opencode` onto PATH, so no case can spawn the
# real binary or resolve the real config. Cases that need to mutate sources,
# the manifest, or the repo-root path run against a sandbox mini-repo (a copy of
# the live engine + owned assets + real skills/commands) so the real repo tree
# is only ever read, never written.
#
# The transactional-apply internals (lock, backup, per-step rollback, journal
# recovery, idempotence) are also proven at the run() level by
# opencode/fixtures/apply/run-acceptance.mjs (T6). This suite re-proves them
# end-to-end through scripts/sync-opencode.sh and adds the black-box-only cases.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SYNC="$REPO_ROOT/scripts/sync-opencode.sh"

  FAKE_HOME="$(mktemp -d)"
  # Resolve symlinks (macOS mktemp lives under /var -> /private/var): sandbox
  # mini-repos are invoked as `node <sandbox>/scripts/opencode/sync.mjs`, and the
  # helper's is-main guard compares process.argv[1] to the symlink-resolved
  # import.meta.url — an unresolved /var path would silently skip main().
  FAKE_HOME="$(cd "$FAKE_HOME" && pwd -P)"
  # Fake home: the sync never touches the runner's real ~/.config/opencode.
  export HOME="$FAKE_HOME"
  export XDG_CONFIG_HOME="$FAKE_HOME/.config"
  OC="$FAKE_HOME/.config/opencode"

  # Fast, deterministic opencode stub so no case spawns the real binary. It
  # answers `debug paths` and `mcp list` instantly; the hanging-opencode case
  # supplies its own sleeping stub on top of PATH.
  STUB_BIN="$FAKE_HOME/stubbin"
  mkdir -p "$STUB_BIN"
  cat >"$STUB_BIN/opencode" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "debug" ] && [ "$2" = "paths" ]; then
  printf 'config %s\n' "${STUB_OPENCODE_CONFIG:-/nonexistent/opencode}"
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  printf 'flywheel connected\n'
  exit 0
fi
exit 0
STUB
  chmod +x "$STUB_BIN/opencode"
  export PATH="$STUB_BIN:$PATH"
  export STUB_OPENCODE_CONFIG="$OC"

  # A stray ambient break-glass would neuter the guard corpus; scrub it.
  unset FLYWHEEL_ALLOW_AM_DOCTOR
}

teardown() {
  rm -rf "$FAKE_HOME"
}

# ── helpers ─────────────────────────────────────────────────────────────────

# Deterministic content+structure hash of a directory tree (handles spaces and
# non-ASCII names). Used to prove --check/--dry-run never mutate the target.
tree_hash() {
  node -e '
const {createHash}=require("crypto");const fs=require("fs");const path=require("path");
const root=process.argv[1];const rows=[];
const walk=(d,rel)=>{let es;try{es=fs.readdirSync(d,{withFileTypes:true});}catch(e){return;}
  es.sort((a,b)=>a.name<b.name?-1:(a.name>b.name?1:0));
  for(const e of es){const rp=rel?rel+"/"+e.name:e.name;const f=path.join(d,e.name);
    const st=fs.lstatSync(f);
    if(st.isDirectory()){rows.push("d "+rp);walk(f,rp);}
    else if(st.isFile()){rows.push("f "+rp+" "+createHash("sha256").update(fs.readFileSync(f)).digest("hex")+" "+(st.mode&0o777));}
    else if(st.isSymbolicLink()){rows.push("l "+rp+" "+fs.readlinkSync(f));}
    else rows.push("o "+rp);}};
walk(root,"");
process.stdout.write(createHash("sha256").update(rows.join("\n")).digest("hex"));
' "$1"
}

# Materialize a self-contained sandbox mini-repo (copy of the live engine +
# owned assets + real skills/commands). Echoes the sandbox root. An optional
# arg names the sandbox dir (used to inject spaces + non-ASCII into the path).
sandbox_repo() {
  local name="${1:-sandbox-repo}"
  local dest="$FAKE_HOME/$name"
  mkdir -p "$dest/scripts/opencode" "$dest/opencode/commands" "$dest/opencode/plugins" "$dest/hooks"
  cp "$REPO_ROOT"/scripts/opencode/*.mjs "$dest/scripts/opencode/"
  cp "$REPO_ROOT/opencode/manifest.json" "$REPO_ROOT/opencode/compatibility.json" "$dest/opencode/"
  cp "$REPO_ROOT"/opencode/commands/*.md "$dest/opencode/commands/"
  cp "$REPO_ROOT"/opencode/plugins/*.js "$dest/opencode/plugins/"
  cp "$REPO_ROOT/hooks/hooks.json" "$dest/hooks/"
  cp -R "$REPO_ROOT/skills" "$dest/skills"
  cp -R "$REPO_ROOT/commands" "$dest/commands"
  printf '%s' "$dest"
}

# A PID guaranteed dead (spawned and reaped) — for stale-lock reclaim.
dead_pid() {
  node -e 'const{spawnSync}=require("child_process");const c=spawnSync(process.execPath,["-e",""]);process.stdout.write(String(c.pid));'
}

count_lines() {
  printf '%s\n' "$1" | grep -c "$2" || true
}

# ── 1. first install ────────────────────────────────────────────────────────

@test "first install renders the managed tree + mcp entry into an empty fake home" {
  run bash "$SYNC" --write --config-dir "$OC"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[WRITE]"* ]]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]

  [ -f "$OC/plugins/agent-flywheel.js" ]
  [ -d "$OC/skills/flywheel-doctor" ]
  [ -f "$OC/skills/flywheel-doctor/SKILL.md" ]
  [ -f "$OC/commands/flywheel-doctor.md" ]
  [ -f "$OC/commands/start.md" ]

  # mcp.flywheel merged into a freshly created opencode.json
  [ -f "$OC/opencode.json" ]
  grep -q '"flywheel"' "$OC/opencode.json"
  grep -q 'mcp-server/dist/server.js' "$OC/opencode.json"

  # plugin sentinel rendered to the real repo abspath; the file parses
  run node --check "$OC/plugins/agent-flywheel.js"
  [ "$status" -eq 0 ]
  grep -qF "const FLYWHEEL_ROOT = \"$REPO_ROOT\"" "$OC/plugins/agent-flywheel.js"

  # transform postconditions (verification bar #6/#8), proven black-box: the
  # rewritten forms are the /agent-flywheel: slash and the $CLAUDE_PLUGIN_ROOT
  # variable — a bare prose mention of CLAUDE_PLUGIN_ROOT legitimately survives.
  run bash -c "grep -rE '/agent-flywheel:' '$OC/skills' '$OC/commands' || true"
  [ -z "$output" ]
  run bash -c "grep -rnE '[\$]\{?CLAUDE_PLUGIN_ROOT' '$OC/skills' '$OC/commands' '$OC/plugins' || true"
  [ -z "$output" ]
}

# ── 2. no-op rerun (ledger idempotence) ─────────────────────────────────────

@test "a second --write reports zero managed writes (ledger idempotence)" {
  run bash "$SYNC" --write --config-dir "$OC"
  [ "$status" -eq 0 ]

  run bash "$SYNC" --write --config-dir "$OC"
  [ "$status" -eq 0 ]
  [[ "$output" != *"[WRITE]"* ]]
  [[ "$output" != *"[LOCAL]"* ]]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]

  run bash "$SYNC" --check --config-dir "$OC"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]
}

# ── 3. source upgrade (only the changed path updates, as WRITE not LOCAL) ────

@test "a source change re-syncs only the affected path (WRITE, not LOCAL)" {
  local repo cfg
  repo="$(sandbox_repo)"
  cfg="$FAKE_HOME/oc-upgrade"

  run node "$repo/scripts/opencode/sync.mjs" --write --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 0 ]

  # Modify one managed skill source (an innocuous line — no Claude tokens).
  printf '\nSync upgrade sentinel line.\n' >> "$repo/skills/flywheel-doctor/SKILL.md"

  run node "$repo/scripts/opencode/sync.mjs" --write --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 0 ]
  # skill tree targets normalize without a trailing slash
  [[ "$output" == *"[WRITE] skills/flywheel-doctor"* ]]
  [[ "$output" != *"[LOCAL]"* ]]
  # exactly one path was written (the changed skill), nothing else
  [ "$(count_lines "$output" '^\[WRITE\]')" -eq 1 ]

  run node "$repo/scripts/opencode/sync.mjs" --check --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]
}

# ── 4. retirement (manifest drop) ───────────────────────────────────────────
# The engine's T6 contract is "never touch anything outside the owned set"
# (unmanaged siblings stay byte-for-byte). Active retire-with-backup via manifest
# tombstones is not implemented (manifest.retirements is an inert placeholder),
# so this proves the real behavior: dropping an artifact keeps sync green and
# leaves the prior install as an untouched, now-unmanaged sibling.

@test "dropping an artifact from the manifest keeps sync green and does not delete the prior install" {
  local repo cfg
  repo="$(sandbox_repo)"
  cfg="$FAKE_HOME/oc-retire"

  # Add a synthetic managed skill, install it.
  mkdir -p "$repo/skills/flywheel-retire-demo"
  cat >"$repo/skills/flywheel-retire-demo/SKILL.md" <<'SK'
---
name: flywheel-retire-demo
description: Synthetic managed skill used only to exercise manifest retirement.
---

Plain prose body with no delegations and no Claude tool calls.
SK
  node -e '
const fs=require("fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,"utf8"));
m.skills.push({name:"flywheel-retire-demo",source:"skills/flywheel-retire-demo/",target:"skills/flywheel-retire-demo/",kind:"skill-dir",transformProfile:"skill"});
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
' "$repo/opencode/manifest.json"

  run node "$repo/scripts/opencode/sync.mjs" --write --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 0 ]
  [ -f "$cfg/skills/flywheel-retire-demo/SKILL.md" ]

  # Retire: remove from the manifest AND delete the source.
  node -e '
const fs=require("fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,"utf8"));
m.skills=m.skills.filter(s=>s.name!=="flywheel-retire-demo");
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
' "$repo/opencode/manifest.json"
  rm -rf "$repo/skills/flywheel-retire-demo"

  run node "$repo/scripts/opencode/sync.mjs" --check --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]
  # Prior install remains (engine does not auto-delete the now-unmanaged sibling).
  [ -f "$cfg/skills/flywheel-retire-demo/SKILL.md" ]
}

# ── 5. local edit → [LOCAL] + backup ────────────────────────────────────────

@test "a local edit to a managed file is labelled [LOCAL] and backed up before overwrite" {
  run bash "$SYNC" --write --skip-mcp --config-dir "$OC"
  [ "$status" -eq 0 ]

  local target="$OC/commands/flywheel-doctor.md"
  [ -f "$target" ]
  printf '\n<!-- LOCAL EDIT MARKER -->\n' >> "$target"

  run bash "$SYNC" --write --skip-mcp --config-dir "$OC"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[LOCAL] commands/flywheel-doctor.md"* ]]

  # the edit is preserved in a durable backup...
  run bash -c "grep -rl 'LOCAL EDIT MARKER' '$OC/.flywheel-sync/backups' | head -1"
  [ -n "$output" ]
  # ...and the managed file is restored to the rendered source bytes
  run grep -c 'LOCAL EDIT MARKER' "$target"
  [ "$output" -eq 0 ]
}

# ── 6. custom config paths ──────────────────────────────────────────────────

@test "custom config resolution honors --config-dir, --config-file (JSONC preserved), and OPENCODE_CONFIG_DIR" {
  # (a) --config-dir
  local d1="$FAKE_HOME/cfgdir"
  mkdir -p "$d1"
  STUB_OPENCODE_CONFIG="$d1" run bash "$SYNC" --check --skip-mcp --config-dir "$d1"
  [ "$status" -ne 2 ]
  [[ "$output" == *"target=$d1"* ]]

  # (b) --config-file into an existing JSONC doc: comment + foreign server preserved
  local d2="$FAKE_HOME/cfgfile"
  mkdir -p "$d2"
  cp "$REPO_ROOT/opencode/fixtures/homes/opencode.jsonc" "$d2/opencode.jsonc"
  STUB_OPENCODE_CONFIG="$d2" run bash "$SYNC" --write --config-dir "$d2" --config-file "$d2/opencode.jsonc"
  [ "$status" -eq 0 ]
  grep -q '"flywheel"' "$d2/opencode.jsonc"
  grep -q 'some-other-server' "$d2/opencode.jsonc"
  grep -q '// keep this comment' "$d2/opencode.jsonc"

  # (c) OPENCODE_CONFIG_DIR env var
  local d3="$FAKE_HOME/cfgenv"
  mkdir -p "$d3"
  STUB_OPENCODE_CONFIG="$d3" OPENCODE_CONFIG_DIR="$d3" run bash "$SYNC" --check --skip-mcp
  [ "$status" -ne 2 ]
  [[ "$output" == *"target=$d3"* ]]
}

# ── 7. paths with spaces AND non-ASCII in the repo path (sentinel rendering) ─

@test "a repo path with spaces and non-ASCII renders the plugin sentinel correctly" {
  local repo cfg omega
  # Build the non-ASCII char (U+03A9 GREEK CAPITAL OMEGA) at runtime so this
  # .bats file stays pure ASCII (a literal multibyte char trips bats-preprocess).
  omega="$(printf '\316\251')"
  repo="$(sandbox_repo "Flywheel ${omega} sync dir")"
  cfg="$FAKE_HOME/oc-funky"

  run node "$repo/scripts/opencode/sync.mjs" --write --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]

  [ -f "$cfg/plugins/agent-flywheel.js" ]
  run node --check "$cfg/plugins/agent-flywheel.js"
  [ "$status" -eq 0 ]
  grep -qF "const FLYWHEEL_ROOT = \"$repo\"" "$cfg/plugins/agent-flywheel.js"
}

# ── 8. new unclassified Claude token fails validation as ERROR naming it ─────

@test "an unclassified Claude token in a staged skill fails validation as ERROR naming the token" {
  local repo cfg
  repo="$(sandbox_repo)"
  cfg="$FAKE_HOME/oc-unclassified"

  printf '\nExample: FutureClaudeTool(x) must be classified before shipping.\n' \
    >> "$repo/skills/flywheel-doctor/SKILL.md"

  run node "$repo/scripts/opencode/sync.mjs" --check --skip-mcp --config-dir "$cfg"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FutureClaudeTool"* ]]
  [[ "$output" == *"compatibility"* ]]
  # a failing --check writes nothing
  [ ! -d "$cfg/skills" ]
}

# ── 9. stale-report determinism ─────────────────────────────────────────────

@test "the [REPORT] stale-report section is byte-identical across two runs" {
  run bash -c "bash '$SYNC' --check --skip-mcp --config-dir '$OC' 2>/dev/null | grep '^\[REPORT\]'"
  [ "$status" -eq 0 ]
  local first="$output"

  run bash -c "bash '$SYNC' --check --skip-mcp --config-dir '$OC' 2>/dev/null | grep '^\[REPORT\]'"
  [ "$status" -eq 0 ]
  [ "$first" = "$output" ]
  [[ "$first" == *"group=ask-user-question"* ]]
}

# ── 10. symlink escape refused ──────────────────────────────────────────────

@test "a config file whose realpath escapes the config dir is refused" {
  local cfg="$FAKE_HOME/oc-escape"
  local outside="$FAKE_HOME/outside"
  mkdir -p "$cfg" "$outside"
  printf '{}\n' > "$outside/real.json"
  ln -s "$outside/real.json" "$cfg/opencode.json"

  STUB_OPENCODE_CONFIG="$cfg" run bash "$SYNC" --write --config-dir "$cfg"
  [ "$status" -ne 0 ]
  [[ "$output" == *"escapes config dir"* ]]
  # the escape target file itself was never rewritten
  run cat "$outside/real.json"
  [ "$output" = "{}" ]
}

# ── 11. lock contention + stale-lock reclaim ────────────────────────────────

@test "a concurrent sync is rejected (exit 2); a stale dead-PID lock is reclaimed with WARN" {
  mkdir -p "$OC/.flywheel-sync/lock"
  printf '{"pid": %d}\n' "$$" > "$OC/.flywheel-sync/lock/meta.json"

  FW_SYNC_PID=999999 run bash "$SYNC" --write --skip-mcp --config-dir "$OC"
  [ "$status" -eq 2 ]
  [[ "$output" == *"already running"* ]]

  local dead
  dead="$(dead_pid)"
  printf '{"pid": %s}\n' "$dead" > "$OC/.flywheel-sync/lock/meta.json"

  run bash "$SYNC" --write --skip-mcp --config-dir "$OC"
  [ "$status" -eq 0 ]
  [[ "$output" == *"reclaiming stale sync lock"* ]]
  [[ "$output" == *"[OK] OpenCode port is in sync."* ]]
}

# ── 12. every transactional-failure injection point ─────────────────────────

@test "each FW_SYNC_FAIL_AFTER injection point rolls back and exits 1 (journal|backup|rename|ledger)" {
  for step in journal backup rename ledger; do
    local cfg="$FAKE_HOME/fail-$step"
    mkdir -p "$cfg"

    run bash "$SYNC" --write --skip-mcp --config-dir "$cfg"
    echo "clean apply for $step: status=$status"
    [ "$status" -eq 0 ]

    local target="$cfg/commands/flywheel-doctor.md"
    printf '\n<!-- PENDING %s -->\n' "$step" >> "$target"
    local before
    before="$(cat "$target")"

    FW_SYNC_FAIL_AFTER="$step" run bash "$SYNC" --write --skip-mcp --config-dir "$cfg"
    echo "inject $step: status=$status output=$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"[ROLLBACK]"* ]]
    [ "$(cat "$target")" = "$before" ]
    [ ! -f "$cfg/.flywheel-sync/journal.json" ]
    [ ! -d "$cfg/.flywheel-sync/lock" ]
  done
}

# ── 13. missing binaries → clean prerequisite failure (exit 2) ──────────────

@test "a PATH scrubbed of node fails as a clean prerequisite error (exit 2)" {
  # Drop the stub bin AND every PATH dir that carries an executable node (there
  # can be more than one — e.g. a version-manager shim alongside homebrew).
  local scrubbed
  scrubbed="$(printf '%s\n' "$PATH" | tr ':' '\n' | while read -r d; do
    [ -n "$d" ] || continue
    [ "$d" = "$STUB_BIN" ] && continue
    [ -x "$d/node" ] && continue
    printf '%s\n' "$d"
  done | paste -sd: -)"

  PATH="$scrubbed" run bash "$SYNC" --check --config-dir "$OC"
  [ "$status" -eq 2 ]
  [[ "$output" == *"sync-opencode:"* ]]
}

# ── 14. hanging opencode → runtime_unverified within the 15s budget ─────────

@test "a hanging opencode classifies runtime_unverified within the 15s budget (no hang)" {
  local hbin="$FAKE_HOME/hangbin"
  mkdir -p "$hbin"
  cat >"$hbin/opencode" <<'HANG'
#!/usr/bin/env bash
if [ "$1" = "debug" ] && [ "$2" = "paths" ]; then printf 'config /nonexistent\n'; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then sleep 600; fi
exit 0
HANG
  chmod +x "$hbin/opencode"

  local start=$SECONDS
  PATH="$hbin:$PATH" run bash "$SYNC" --write --config-dir "$OC"
  local elapsed=$((SECONDS - start))

  [ "$status" -eq 0 ]
  [[ "$output" == *"runtime_unverified"* ]]
  [[ "$output" == *"timed out after 15s"* ]]
  # completes near the 15s internal budget, never an unbounded hang
  [ "$elapsed" -lt 40 ]
}

# ── 15. immutability: --check / --dry-run never mutate the target ────────────

@test "--check and --dry-run never mutate the target tree (hash-stable)" {
  run bash "$SYNC" --write --config-dir "$OC"
  [ "$status" -eq 0 ]

  local h0 h1 h2
  h0="$(tree_hash "$OC")"

  run bash "$SYNC" --check --config-dir "$OC"
  [ "$status" -eq 0 ]
  h1="$(tree_hash "$OC")"
  [ "$h0" = "$h1" ]

  run bash "$SYNC" --dry-run --config-dir "$OC"
  [ "$status" -eq 0 ]
  h2="$(tree_hash "$OC")"
  [ "$h0" = "$h2" ]

  # dry-run on an EMPTY target proposes writes (exit 1) but creates nothing
  local empty="$FAKE_HOME/oc-empty"
  mkdir -p "$empty"
  local he0 he1
  he0="$(tree_hash "$empty")"
  STUB_OPENCODE_CONFIG="$empty" run bash "$SYNC" --dry-run --skip-mcp --config-dir "$empty"
  [ "$status" -eq 1 ]
  [[ "$output" == *"(dry-run)"* ]]
  he1="$(tree_hash "$empty")"
  [ "$he0" = "$he1" ]
}

# ── 16. shared Agent-Mail guard corpus ──────────────────────────────────────

@test "the shared Agent-Mail guard corpus produces identical decisions from both guards" {
  run node "$REPO_ROOT/opencode/fixtures/hooks/run-corpus.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *"agree on every decision"* ]]
}
