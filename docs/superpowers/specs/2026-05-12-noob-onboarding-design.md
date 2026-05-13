# agent-flywheel noob-onboarding design (v3.16.0)

**Status:** Approved (design phase). Awaiting implementation plan.
**Author:** flywheel session 2026-05-12
**Target release:** v3.16.0 (single mega-release)

## Goal

A mid-level dev new to agentic coding can go from `curl | bash` to a
successful first bead completion in ≤10 minutes with ≤5 prompts total, on
a fresh macOS, Linux, or Windows machine.

## Persona

Mid-level developer, new to agentic coding. Knows CLI basics (`git`, `npm`,
`jq`, `lsof`) but unfamiliar with multi-agent terms (NTM panes, agent-mail,
beads, MCP). Wants curl|bash one-liner or a single Claude Code command.
Needs glossary inline. Expects "just work" defaults.

## Success criteria

- `curl -sSL <url>/install.sh | bash` works on macOS 14+ and Ubuntu 22.04+
- `iwr -useb <url>/install.ps1 | iex` works on Windows 11 / PowerShell 7
- After install, first `/agent-flywheel:start` auto-detects "first run",
  offers tutorial, completes a real bead end-to-end
- `flywheel_doctor` reports `green` overall on a freshly-installed machine
- Every error a noob hits in the first 10 min has a paste-ready `try_this`
  recovery command
- No regression for existing users (checkpoint detection + drift checks
  unchanged)

## Non-goals

- No standalone `aflyw` CLI wrapper (would double maintenance surface)
- No web-based onboarding companion (overkill for a CLI tool)
- No multi-language install (English only this cycle)
- No native Windows multi-agent swarm (NTM is tmux-based — Windows native
  degrades to `Agent()` fallback; WSL2 path documented for full features)

---

## Architecture

### New files

- `install.sh` — macOS/Linux bash bootstrap (~150 LOC)
- `install.ps1` — Windows PowerShell bootstrap (~150 LOC, parity with install.sh)
- `skills/start/_tutorial_bead.md` — tutorial-bead tour skill (loaded by
  Step 0d on first-run detection)
- `mcp-server/src/errors-try-this.ts` — exported `DEFAULT_TRY_THIS` dict
  for every `FlywheelErrorCode`, with type-level enforcement that every
  code has both `hint` and `tryThis`
- `mcp-server/src/platform.ts` — platform detection
  (`process.platform === 'win32'` → PowerShell equivalents)

### Modified files

- `skills/flywheel-setup/SKILL.md` — rewrite to one-batch consent flow
  (244 LOC → ~280 LOC)
- `skills/flywheel-doctor/SKILL.md` — add inline remediation for
  `projects_base` misconfig + `orphan_tender_daemons` (uses `platform.ts`)
- `skills/start/SKILL.md`:
  - Step 0b: new check 9 (first-run state)
  - Step 0c: pre-flight banner extension for missing deps + glossary footer
  - Step 0d: tutorial-bead route when first-run detected
- `skills/start/_inflight_prompt.md` — Windows-native fallback (`Agent()`
  spawn) when NTM unavailable
- `README.md` — replace install section with 2-line curl|bash; move CC
  plugin path to "advanced install" section
- `mcp-server/src/errors.ts` — extend each error meta with `tryThis`
- `mcp-server/src/tools/doctor.ts` — platform-aware probes
  (`Get-NetTCPConnection` vs `lsof`)
- `mcp-server/src/tools/profile.ts` — Windows path normalization (handle
  backslashes in cwd)

### Path through the system (mid-level dev, fresh machine)

```
1. curl -sSL <url>/install.sh | bash    (or iwr | iex on Windows)
   └→ install.sh:
      - detects OS, shell, package manager
      - installs Claude Code via brew/npm/winget if missing
      - installs br/bv/cm/dcg/ntm via brew/scoop/cargo install
      - checks Node version ≥20 (suggests nvm if older)
      - optionally starts agent-mail HTTP service (background)
      - prints 3 CC commands to copy, optionally launches CC

2. Inside Claude Code:
   /plugin marketplace add burningportra/agent-flywheel-plugin
   /plugin install agent-flywheel@agent-flywheel
   /reload-plugins
   /agent-flywheel:flywheel-setup
   └→ flywheel-setup:
      - parallel detection (CLIs, agent-mail, MCP register, projects_base)
      - builds plan object
      - ONE AskUserQuestion: full plan + "Run batch | Review each | Cancel"
      - executes batch (logs to ~/.agent-flywheel/setup.log)
      - calls flywheel_doctor; green → "/agent-flywheel:start to begin"

3. /agent-flywheel:start
   └→ Step 0b check 9: first-run?
      (no checkpoint AND no beads AND no docs/plans AND no .pi-orchestrator
       AND no CASS entries for this cwd)
   └→ Yes → tutorial-bead offer (auto-Recommended)
      - 5-step narrated tour: profile → plan → bead → implement → commit
      - micro-goal: "Add a CHANGELOG entry for today" (fallback: create it)
      - end-of-tour: keep/rollback prompt
   └→ No → regular Step 0d menu (unchanged)
```

### Windows-native vs WSL2 decision

- `install.ps1` installs CC + br/bv/cm (Scoop/winget) but **flags NTM as
  unavailable** (tmux requirement)
- On Windows-native, flywheel runs single-agent (`Agent()` fallback) —
  auto-swarm degrades to sequential bead processing with banner warning
- Users wanting full multi-agent swarm get a one-liner in the install
  output: *"For parallel swarm: install WSL2 and run install.sh inside it"*

---

## Detailed design

### install.sh / install.ps1

**install.sh** (bash, macOS + Linux):

```bash
#!/usr/bin/env bash
# install.sh — bootstrap agent-flywheel on a fresh machine
set -euo pipefail

# 1. Detect OS + package manager
OS=$(uname -s)              # Darwin or Linux
ARCH=$(uname -m)            # arm64 / x86_64
PKG=$(detect_pkg)           # brew / apt / dnf / pacman

# 2. Detect Claude Code
if ! command -v claude >/dev/null; then
  prompt "Claude Code not found. Install via $PKG? (Y/n)"
  install_claude_code        # brew install OR npm i -g @anthropic-ai/claude-cli
fi

# 3. Required CLIs (br, bv, cm, dcg, ntm)
MISSING=()
for tool in br bv cm dcg ntm; do
  command -v "$tool" >/dev/null || MISSING+=("$tool")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  prompt "Install ${#MISSING[@]} tools via $PKG? (Y/n)"
  for tool in "${MISSING[@]}"; do install_tool "$tool"; done
fi

# 4. Node 20+ check
node_ok || nvm_suggest

# 5. agent-mail HTTP service
if ! curl -fsS --max-time 1 http://127.0.0.1:8765/health/liveness >/dev/null; then
  prompt "Start agent-mail HTTP service? (Y/n)"
  am serve-http --port 8765 &
fi

# 6. Print CC commands
cat <<'EOF'
✓ Bootstrap complete. Now inside Claude Code, run:

  /plugin marketplace add burningportra/agent-flywheel-plugin
  /plugin install agent-flywheel@agent-flywheel
  /agent-flywheel:flywheel-setup

EOF

# 7. Optionally launch CC
prompt "Launch Claude Code now? (Y/n)" && claude
```

**install.ps1** (PowerShell, Windows) — same structure with platform swaps:
`winget install` / `scoop install` / `Invoke-WebRequest | Invoke-Expression` in
place of `curl`. Detects WSL2 and recommends running `install.sh` inside it
for full features. Installs Windows-compatible CLIs (br/bv/cm via Scoop bucket
or GitHub release zips); flags NTM as unavailable.

PowerShell parity with install.sh's seven numbered steps is mandatory: OS
detection, CC detection/install (winget/scoop), required-CLI loop, Node
check, agent-mail start (`Start-Process -WindowStyle Hidden am serve-http
--port 8765`), CC commands print, optional CC launch. The shared snapshot
test (risk #5) asserts step-by-step equivalence.

**Critical install-script decisions:**

- **No silent sudo.** If apt needs sudo, fail fast with a clear prompt asking
  the user to re-run with sudo. Never escalate silently.
- **PATH safety.** After installs, `source ~/.zshrc` (or `~/.bashrc`) and
  re-check binaries before continuing. Brew installs aren't visible without
  this on fresh shells.
- **Idempotent.** Every check `command -v` first — never re-install.
- **Logged.** All actions tee to `~/.agent-flywheel/install.log`.
- **Verifiable.** SHA256 published in README so paranoid users can verify
  before piping to bash. Manual 3-step install also documented.
- **Flags:** `--noninteractive` (CI), `--skip-launch`, `--skip-mcp-register`,
  `--skip-agent-mail` for test scenarios.

### /flywheel-setup one-batch flow

Replaces the current 12-step per-tool prompt loop. Single consent gate.

```
0. Banner: "Scanning install state…"

1. PARALLEL DETECTION (one batch_execute):
   - which claude/codex/gemini      → CLI presence
   - which br/bv/cm/dcg/ntm         → required tools
   - curl :8765/health/liveness     → agent-mail service
   - jq mcpServers ~/.claude.json   → MCP registered
   - ntm config show projects_base  → NTM base
   - test -d $NTM_BASE/$(basename $PWD) → projects_base correct for cwd
   - flywheel_doctor (read-only)    → baseline state

2. BUILD PLAN OBJECT:
   plan = {
     install:    ['br', 'bv'],
     register:   ['MCP server'],
     start:      ['agent-mail HTTP'],
     configure:  ['projects_base symlink for agent-flywheel'],
     skip:       ['ntm (already installed)', 'cm (already installed)']
   }
   If empty everywhere → "Everything already configured." → exit

3. PRESENT PLAN (one AskUserQuestion):
   "Install plan: <bulleted plan summary>
    Run the whole batch (Recommended) | Review each step | Cancel"

4. EXECUTE BATCH:
   Sequential, tee'd to ~/.agent-flywheel/setup.log.
   On failure of any step:
     - Surface error.tryThis
     - AskUserQuestion: Retry | Skip | Abort

5. POST-FLIGHT:
   - flywheel_doctor (read-only)
   - If green: "Setup complete ✓. Run /agent-flywheel:start to begin."
   - If yellow/red: print failing checks + their tryThis, exit nonzero
```

**Auto-symlink for `projects_base`:**
- Detect: `NTM_BASE=$(ntm config show | awk -F'"' '/^projects_base/ {print $2}')`
- If `$NTM_BASE/$(basename $PWD)` doesn't exist:
  `ln -s $PWD $NTM_BASE/$(basename $PWD)`
- Re-run the `ntm-ready` check from Step 0b — if still misconfigured,
  surface error with the manual fix command.

**MCP registration:**
- Read `~/.claude.json`. If `mcpServers.agent-flywheel` already set: skip.
- Else: merge in the standard MCP block. Write atomically (tmp → mv).

**Backwards compatibility:**
- Old per-tool prompts preserved as the "Review each step" fallback inside
  the new batch prompt.
- All current 12-step probes still run during detection — just collapsed
  into a single user-facing prompt.

### First-run tutorial-bead

**First-run detection** (Step 0b new check 9). User is "first run" iff ALL of:
- No `.pi-flywheel/checkpoint.json`
- `br list --json` returns 0 beads
- No `docs/plans/*.md`
- No `.pi-orchestrator/` (older state files)
- No CASS entries for this cwd

If any is true → not first-run. Regular Step 0d menu fires.

**Tutorial-bead skill** (`skills/start/_tutorial_bead.md`). Routing: Step 0d
adds a 5th option **"Take the 5-min tour (first time?)"** to the fresh-start
menu, auto-Recommended when first-run detected.

**Tour flow** (every step narrated in 1-2 sentences before tool call,
skippable at each step):

```
1. "Welcome to agent-flywheel! 5-min tour. I'll run a real micro-bead
    end-to-end so you can see the loop. Goal: 'Add a CHANGELOG entry for
    today'. This WILL commit to your repo.  [Continue] | [Skip]"

2. "Step 1/5: PROFILE — scan your repo for languages, frameworks,
    structure. ~30s."
    → flywheel_profile, show key findings

3. "Step 2/5: PLAN — generate a tiny one-section plan. Plans live in
    docs/plans/."
    → write docs/plans/<date>-tutorial.md (single section)
    → flywheel_plan({ planFile, source: 'tutorial' })

4. "Step 3/5: BEAD — plans turn into beads (atomic tasks tracked by br).
    One bead for this tour."
    → flywheel_approve_beads(action='start') → creates 1 bead via br

5. "Step 4/5: IMPLEMENT — do the work. Inline this time (real flywheel
    spawns parallel agents for larger work)."
    → Edit CHANGELOG.md (create if missing) → mark bead done in br

6. "Step 5/5: REVIEW — commit + close. Real flywheel runs flywheel_review
    here; we skip that to save tour time."
    → git add CHANGELOG.md && git commit -m 'docs: tutorial bead'

7. "Done! ✓ You just ran scan→plan→bead→implement→commit. That's the
    flywheel."
    + glossary footer
    + end-of-tour: "Keep the commit? Y/n" (default keep)
    + next-step pointer: "Run /agent-flywheel:start anytime"
```

### Inline glossary

Appended below every:
- Start menu (Step 0d)
- Doctor output
- Setup plan presentation
- Pre-flight banner on /start (Step 0c)

```
Glossary: bead=atomic task · plan=grouped beads · flywheel=full loop
          NTM=tmux multi-agent · agent-mail=inter-agent inbox · MCP=Model Context Protocol
```

One line, ~80 chars. Cheap to read, easy to ignore once familiar.

### try_this hints + pre-flight banner + doctor expansion

**try_this on every FlywheelErrorCode.** Today `errors.ts` has
`DEFAULT_HINTS` (1-sentence recovery) and v3.15.0 added `DEFAULT_TRY_THIS`
(paste-ready command). Gap: not every code has both.

Action: audit all 47 codes in `FLYWHEEL_ERROR_CODES`. Populate both
dictionaries. Add type-level enforcement:

```ts
type ErrorMeta = { hint: string; tryThis: string }
const ERROR_META: Record<FlywheelErrorCode, ErrorMeta> = { ... }
```

TypeScript build fails if any code missing either field.

Standard rendering wherever structured errors surface:
```
❌ <error.code>: <error.message>
   Hint: <error.hint>
   Try:  <error.tryThis>
```

**Pre-flight banner on `/start`** (Step 0c extension). After welcome banner,
if doctor returned any of: required CLI missing (br/bv/cm), agent-mail
offline, MCP not connected, projects_base misconfigured — surface a single
block above the menu:

```
⚠ Pre-flight issues:
   • bv not installed       → Try: brew install burningportra/tap/bv
   • agent-mail offline     → Try: am serve-http --port 8765 &
   • projects_base mismatch → Try: ln -s "$PWD" "$NTM_BASE/agent-flywheel"

Run /agent-flywheel:flywheel-setup to fix all at once, or continue with
degraded features.
```

Then a sub-AskUserQuestion: `Run setup now | Continue with degraded | Show me what's degraded`.

**Doctor inline-remediation expansion.** Today's doctor has inline
remediation for 9 checks. Add 2:

1. **`projects_base` misconfig** — detect ntm-misconfigured from Step 0b,
   offer dry-run/execute/skip for `ln -s "$PWD" "$NTM_BASE/<basename>"`.
2. **`orphan_tender_daemons`** — list candidate PIDs from doctor output,
   offer dry-run (`ps -p`), execute (`kill -TERM` then KILL if alive), skip.

Both follow the existing dry-run/execute/skip pattern. ~40 LOC each.

---

## Testing

### CI matrix

| Platform | OS | Shell | What runs |
|----------|-----|-------|-----------|
| macOS | macos-latest | bash 5 / zsh | install.sh (noninteractive) |
| Linux | ubuntu-22.04 | bash 5 | install.sh (noninteractive) |
| Linux Docker | debian:12 / ubuntu:22.04 | bash 5 | install.sh (fresh-machine fidelity) |
| Windows | windows-latest | PowerShell 7 | install.ps1 (noninteractive) |

### Per-layer

**install.sh / install.ps1:**
- Flags `--noninteractive --skip-launch --skip-mcp-register` for CI
- Assert: exit code 0, binaries on PATH, agent-mail `/health/liveness`
  returns 200, log file exists
- Idempotency: run twice, second is no-op
- Negative: kill brew/winget mid-script, assert clean failure + try_this

**/flywheel-setup batch:**
- Unit test plan-builder with fake detection results
- Integration test: stub `installTool`, run batch, verify markers
- Snapshot test: rendered plan text for 5 input combinations

**Tutorial-bead:**
- E2E on throwaway repo: `mktemp -d && git init && bash install.sh`
  → `claude --headless < tutorial-input.txt`
- Assert: CHANGELOG.md modified, 1 commit, bead closed in br
- Failure mode: kill agent mid-tour, verify graceful recovery

**try_this enforcement:**
- Post-compile check walking `FLYWHEEL_ERROR_CODES`; fails CI if any code
  missing `hint` or `tryThis`.

**Pre-flight banner:**
- Snapshot tests for each subset of issues × {first-run, returning-user} =
  8 snapshots.

**First-run detection:**
- 5 negative tests: each first-run signal individually present → returns false
- 1 positive: all 5 signals absent → returns true

### Manual verification before release

- macOS UTM fresh VM
- Windows 11 fresh VM
- Docker minimal Linux image
- End-to-end timer: install → setup → tutorial-bead must be ≤10 min

---

## Rollout

### Single v3.16.0 mega-release

PR sequence (parallel where possible):

| # | PR | LOC | Depends on |
|---|----|-----|-----------|
| 1 | `errors.ts` populate `DEFAULT_TRY_THIS` + type enforcement | ~150 | — |
| 2 | `install.sh` + `install.ps1` + GitHub Actions CI matrix | ~400 | — |
| 3 | `/flywheel-setup` batch rewrite + auto-symlink | ~250 | #1 |
| 4 | Step 0c pre-flight banner + Step 0d glossary footer | ~80 | #1, #3 |
| 5 | Step 0b check 9 + Step 0d tutorial route + `_tutorial_bead.md` | ~200 | #4 |
| 6 | Doctor inline-remediation expansion | ~80 | #1 |
| 7 | README rewrite + CHANGELOG + version bump + dist rebuild | ~100 | #2–#6 |

Total: ~1260 LOC. PRs 1, 2, 6 parallelizable; rest serial.

### Release checklist (gates v3.16.0 tag)

- [ ] All 7 PRs merged to main
- [ ] Manual macOS UTM test green (install.sh → setup → /start → tutorial → bead closed)
- [ ] Manual Windows 11 VM test green (PowerShell parity)
- [ ] CI matrix green (macos / ubuntu / docker / windows)
- [ ] Doctor reports `green` overall on each platform after install
- [ ] CHANGELOG.md entry written
- [ ] README rewrite reviewed
- [ ] `mcp-server/package.json` bumped to 3.16.0
- [ ] `mcp-server/dist/` rebuilt and committed
- [ ] GitHub Release notes written, tag pushed

---

## Risks

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | Curl\|bash adoption resistance | README has 3-step manual install; SHA256 published; install.sh source on GitHub |
| 2 | Auto-symlink surprises | Explicit in batch plan text; can decline batch; per-tool fallback preserves consent |
| 3 | Tutorial-bead writes user repo | Upfront warning + end-of-tour rollback prompt |
| 4 | `~/.claude.json` write race | Atomic tmp+rename (POSIX guarantee) |
| 5 | install.ps1 lags install.sh over time | Shared snapshot test asserting feature parity; CI fails on drift |
| 6 | First-run detection false negative | Per-cwd detection; all 5 signals must be absent |
| 7 | brew tap unavailable for br/bv | Pre-flight verify tap; fallback to curl-binary from GitHub release per tool |

---

## Backwards compatibility (no breaking changes)

- Existing users with checkpoint + beads: untouched. First-run detection
  returns false.
- Existing `/flywheel-setup` users: new batch flow additive; old per-tool
  preserved as "Review each step" fallback.
- Existing `error.hint` consumers: unchanged. `try_this` is additive.
- Existing doctor checks: unchanged. New remediation is additive.
- Existing CLI/MCP behavior: zero deletion.
