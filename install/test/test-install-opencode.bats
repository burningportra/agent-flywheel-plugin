#!/usr/bin/env bats
#
# install.sh --with-opencode opt-in (bead claude-29sq, T8).
#
# Every case runs the real install.sh end-to-end against a THROWAWAY fake home
# with every base-install prerequisite stubbed onto PATH, so no case installs a
# package, hits the network, starts agent-mail, or touches the runner's real
# ~/.config/opencode. Control cases run a SANDBOX copy of install.sh whose
# scripts/sync-opencode.sh is a recording stub — it appends one line per
# invocation to $SYNC_LOG and echoes its argv — so "runs the sync exactly once"
# and "--skip-mcp forwarded" are asserted directly on the recorded argv rather
# than through the real renderer's side effects. Two cases drive the REAL sync
# (via a stub opencode) to prove the install.sh -> sync-opencode.sh wiring
# actually renders the managed port.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  INSTALL="$REPO_ROOT/install.sh"

  FAKE_HOME="$(mktemp -d)"
  # Resolve symlinks (macOS mktemp lives under /var -> /private/var) so path
  # comparisons and the real sync's realpath checks stay consistent.
  FAKE_HOME="$(cd "$FAKE_HOME" && pwd -P)"
  export HOME="$FAKE_HOME"
  export XDG_CONFIG_HOME="$FAKE_HOME/.config"
  OC="$XDG_CONFIG_HOME/opencode"

  # Stub every base-install prerequisite so the installer takes only its
  # "already installed" branches — no brew/npm install, no agent-mail spawn.
  STUB_BIN="$FAKE_HOME/stubbin"
  mkdir -p "$STUB_BIN"
  local t
  for t in claude br bv cm dcg ntm am; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/$t"
    chmod +x "$STUB_BIN/$t"
  done
  # Fast opencode stub so the --with-opencode precheck's `command -v opencode`
  # succeeds and the real sync can resolve config + probe runtime instantly.
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

  # Recording-stub sink (only the sandbox sync stub writes here; absence proves
  # the sync was never invoked).
  export SYNC_LOG="$FAKE_HOME/sync-invocations.log"
}

teardown() {
  rm -rf "$FAKE_HOME"
}

# ── helpers ─────────────────────────────────────────────────────────────────

# Materialize a sandbox copy of install.sh + its libs whose
# scripts/sync-opencode.sh is a recording stub (argv -> $SYNC_LOG, exit
# ${STUB_SYNC_EXIT:-0}). Echoes the sandbox install.sh path.
sandbox_installer() {
  local dest="$FAKE_HOME/inst"
  mkdir -p "$dest/install/lib" "$dest/scripts"
  cp "$INSTALL" "$dest/install.sh"
  cp "$REPO_ROOT"/install/lib/*.sh "$dest/install/lib/"
  cat >"$dest/scripts/sync-opencode.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SYNC_LOG:?SYNC_LOG must be set}"
printf '[stub-sync] invoked with: %s\n' "$*"
exit "${STUB_SYNC_EXIT:-0}"
STUB
  chmod +x "$dest/scripts/sync-opencode.sh"
  printf '%s' "$dest/install.sh"
}

# ── 1. help text ────────────────────────────────────────────────────────────

@test "help text advertises --with-opencode and the sync-opencode.sh path" {
  run bash "$INSTALL" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--with-opencode"* ]]
  [[ "$output" == *"scripts/sync-opencode.sh"* ]]
}

# ── 2. syntax ───────────────────────────────────────────────────────────────

@test "install.sh parses cleanly under bash -n" {
  run bash -n "$INSTALL"
  [ "$status" -eq 0 ]
}

# ── 3. default path writes zero OpenCode files and never runs the sync ───────

@test "a default install (no --with-opencode) writes zero OpenCode files and never runs the sync" {
  local inst
  inst="$(sandbox_installer)"
  run bash "$inst" --noninteractive --skip-launch --skip-agent-mail
  [ "$status" -eq 0 ]
  [[ "$output" == *"Bootstrap complete"* ]]
  # sync never invoked (recording sink absent)
  [ ! -f "$SYNC_LOG" ]
  # no opencode config materialized in the fake home
  [ ! -e "$OC" ]
  [[ "$output" != *"OpenCode port configured"* ]]
  [[ "$output" != *"Configuring OpenCode port"* ]]
}

# ── 4. explicit opt-in runs the sync exactly once (default forwards --write) ─

@test "--with-opencode runs the sync exactly once and streams its result" {
  local inst
  inst="$(sandbox_installer)"
  run bash "$inst" --noninteractive --skip-launch --skip-agent-mail --with-opencode
  [ "$status" -eq 0 ]
  [[ "$output" == *"[stub-sync] invoked with: --write"* ]]
  [[ "$output" == *"OpenCode port configured"* ]]
  # exactly one invocation recorded, argv is --write only (no --skip-mcp)
  [ -f "$SYNC_LOG" ]
  [ "$(wc -l < "$SYNC_LOG" | tr -d '[:space:]')" -eq 1 ]
  run cat "$SYNC_LOG"
  [ "$output" = "--write" ]
}

# ── 5. --skip-mcp-register forwards --skip-mcp (argv-recording stub) ─────────

@test "--with-opencode --skip-mcp-register forwards --skip-mcp to the sync" {
  local inst
  inst="$(sandbox_installer)"
  run bash "$inst" --noninteractive --skip-launch --skip-agent-mail --with-opencode --skip-mcp-register
  [ "$status" -eq 0 ]
  [ -f "$SYNC_LOG" ]
  [ "$(wc -l < "$SYNC_LOG" | tr -d '[:space:]')" -eq 1 ]
  run cat "$SYNC_LOG"
  [ "$output" = "--write --skip-mcp" ]
}

# ── 6. missing opencode binary → hard error, never claims readiness ─────────

@test "--with-opencode with no opencode binary is a hard error and never claims the port is ready" {
  # Scrub every PATH entry that carries an opencode executable (there may be
  # more than one), and drop our own stub bin so nothing resolves `opencode`.
  local scrubbed
  scrubbed="$(printf '%s\n' "$PATH" | tr ':' '\n' | while read -r d; do
    [ -n "$d" ] || continue
    [ "$d" = "$STUB_BIN" ] && continue
    [ -x "$d/opencode" ] && continue
    printf '%s\n' "$d"
  done | paste -sd: -)"

  PATH="$scrubbed" run bash "$INSTALL" --noninteractive --skip-launch --skip-agent-mail --with-opencode
  [ "$status" -ne 0 ]
  [[ "$output" == *"requires the 'opencode' binary"* ]]
  # never a false readiness claim, and it fails BEFORE the base handoff
  [[ "$output" != *"OpenCode ready"* ]]
  [[ "$output" != *"OpenCode port configured"* ]]
  [[ "$output" != *"Bootstrap complete"* ]]
  [ ! -e "$OC" ]
}

# ── 7. sync failure fails the install (exit code propagates) ─────────────────

@test "a failing sync fails the install (propagates its exit code) and points at docs/opencode.md" {
  local inst
  inst="$(sandbox_installer)"
  STUB_SYNC_EXIT=3 run bash "$inst" --noninteractive --skip-launch --skip-agent-mail --with-opencode
  [ "$status" -eq 3 ]
  [[ "$output" == *"OpenCode sync failed (exit 3)"* ]]
  [[ "$output" == *"docs/opencode.md"* ]]
  [[ "$output" != *"OpenCode port configured"* ]]
}

# ── 8. noninteractive without the flag is NOT implicit consent ──────────────

@test "--noninteractive without --with-opencode never touches OpenCode config (no implicit consent)" {
  run bash "$INSTALL" --noninteractive --skip-launch --skip-agent-mail
  [ "$status" -eq 0 ]
  [[ "$output" == *"Bootstrap complete"* ]]
  [ ! -e "$OC" ]
  [[ "$output" != *"OpenCode port configured"* ]]
  [[ "$output" != *"Configuring OpenCode port"* ]]
}

# ── 9. missing sync script → clean downloaded-copy failure ──────────────────

@test "--with-opencode with the sync script absent fails cleanly (downloaded-copy guard)" {
  local inst
  inst="$(sandbox_installer)"
  rm -f "$(dirname "$inst")/scripts/sync-opencode.sh"
  run bash "$inst" --noninteractive --skip-launch --skip-agent-mail --with-opencode
  [ "$status" -ne 0 ]
  [[ "$output" == *"sync script not found"* ]]
  [[ "$output" != *"OpenCode port configured"* ]]
  [[ "$output" != *"Bootstrap complete"* ]]
}

# ── 10. real sync end-to-end: renders the managed port, forwards --skip-mcp ──

@test "--with-opencode --skip-mcp-register drives the real sync and renders the managed port" {
  # Real install.sh -> real scripts/sync-opencode.sh -> stub opencode. Renders
  # into the fake home's opencode config; --skip-mcp keeps the config file's
  # mcp.flywheel entry untouched (and re-proves forwarding through the real CLI).
  OPENCODE_CONFIG_DIR="$OC" run bash "$INSTALL" \
    --noninteractive --skip-launch --skip-agent-mail --with-opencode --skip-mcp-register
  [ "$status" -eq 0 ]
  [[ "$output" == *"OpenCode port configured"* ]]
  [[ "$output" == *"[SKIP] mcp.flywheel (--skip-mcp)"* ]]
  # the real renderer wrote the managed tree
  [ -f "$OC/plugins/agent-flywheel.js" ]
  [ -d "$OC/skills/flywheel-doctor" ]
  [ -f "$OC/commands/start.md" ]
}
