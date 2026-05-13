#!/usr/bin/env bats
# Unit tests for install/lib/agent-mail.sh (start_agent_mail + node_ok).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  TMP_HOME="$(mktemp -d)"
  export HOME="$TMP_HOME"
  export LOG_FILE="$TMP_HOME/install.log"
  export LOG_DIR="$TMP_HOME"
  : >"$LOG_FILE"
  TMP_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # Sandbox PATH: only TMP_BIN plus the bare minimum needed for bats internals
  # (mktemp, cat, chmod live in /usr/bin and /bin). Real node/am/curl on the
  # host must NOT bleed in — tests stub them per-case.
  export PATH="$TMP_BIN:/usr/bin:/bin"
  # shellcheck source=../lib/log.sh
  source "$REPO_ROOT/install/lib/log.sh"
  # shellcheck source=../lib/agent-mail.sh
  source "$REPO_ROOT/install/lib/agent-mail.sh"
}

teardown() {
  rm -rf "${TMP_HOME:-}" "${TMP_BIN:-}" 2>/dev/null || true
  export PATH="$ORIG_PATH"
}

# ---- node_ok ----

@test "node_ok rejects when node is missing" {
  # No node on sandbox PATH.
  run node_ok
  [ "$status" -eq 1 ]
  [[ "$output" == *"node not found"* ]]
}

@test "node_ok rejects node 18" {
  cat >"$TMP_BIN/node" <<'EOF'
#!/usr/bin/env bash
echo "v18.0.0"
EOF
  chmod +x "$TMP_BIN/node"
  run node_ok
  [ "$status" -eq 1 ]
  [[ "$output" == *"< 20"* || "$output" == *"nvm install 20"* ]]
}

@test "node_ok accepts node 20" {
  cat >"$TMP_BIN/node" <<'EOF'
#!/usr/bin/env bash
echo "v20.10.0"
EOF
  chmod +x "$TMP_BIN/node"
  run node_ok
  [ "$status" -eq 0 ]
  [[ "$output" == *"v20"* ]]
}

@test "node_ok accepts node 22" {
  cat >"$TMP_BIN/node" <<'EOF'
#!/usr/bin/env bash
echo "v22.4.1"
EOF
  chmod +x "$TMP_BIN/node"
  run node_ok
  [ "$status" -eq 0 ]
}

# ---- start_agent_mail ----

@test "start_agent_mail short-circuits when service already healthy" {
  cat >"$TMP_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$TMP_BIN/curl"
  run start_agent_mail
  [ "$status" -eq 0 ]
  [[ "$output" == *"already running"* ]]
}

@test "start_agent_mail fails when am binary missing and service down" {
  # curl returns non-zero (no service); no am binary on PATH.
  cat >"$TMP_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
  chmod +x "$TMP_BIN/curl"
  run start_agent_mail
  [ "$status" -eq 1 ]
  [[ "$output" == *"am binary not found"* ]]
}

@test "start_agent_mail launches am and verifies health" {
  # First curl call (pre-check) fails, am launches OK, post-launch curl succeeds.
  cat >"$TMP_BIN/curl_state" <<'EOF'
0
EOF
  cat >"$TMP_BIN/curl" <<EOF
#!/usr/bin/env bash
# First call fails (not yet started); subsequent calls succeed.
state_file="$TMP_BIN/curl_state"
n=\$(cat "\$state_file" 2>/dev/null || echo 0)
echo \$((n+1)) >"\$state_file"
if [ "\$n" -eq 0 ]; then exit 7; else exit 0; fi
EOF
  chmod +x "$TMP_BIN/curl"
  cat >"$TMP_BIN/am" <<'EOF'
#!/usr/bin/env bash
echo "am stub invoked: $*" >"$LOG_DIR/agent-mail.log"
exit 0
EOF
  chmod +x "$TMP_BIN/am"
  run start_agent_mail
  [ "$status" -eq 0 ]
  [[ "$output" == *"started"* ]]
}

@test "start_agent_mail errors when launch fails health check" {
  # curl always fails; am exits cleanly but service never responds.
  cat >"$TMP_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
  chmod +x "$TMP_BIN/curl"
  cat >"$TMP_BIN/am" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$TMP_BIN/am"
  run start_agent_mail
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not respond"* ]]
}
