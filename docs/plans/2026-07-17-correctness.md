# Deep-plan — Correctness lens (harden the opencode port)

**Date:** 2026-07-17
**Lens:** Will this actually work? Will the sync script converge on re-run? Do the rewrite rules match what's actually in the files? What breaks the first time someone runs this on a machine that isn't kevtrinh's?
**Scope anchor:** Happy-path MVP from `docs/brainstorms/harden-the-opencode-port-of-agent-flywheel-2026-07-17.md` — sync script + Claude-isms sweep for the 23 flywheel skills and 25 commands. Diverged non-flywheel skills and the 10x auto-watching sync stay out of v1.

## Verdict

The manual port that landed today looks green from the outside — `opencode mcp list` shows the server connected and 24 skill dirs plus 25 commands are in place — but a grep across the destination reveals the sweep was substantially incomplete, and the sync script the plan is about to design has three correctness traps that will bite the second person to run it. The plan below names them explicitly and specifies the sync-script contract so idempotence is a property proven by the tool itself (a `--verify` mode that must exit 0 with zero diff), not a claim in the PR description.

## What the grep actually found (the real starting state)

The context file's "sed rewrites applied" list undersells the leftover load. `grep -rEn` across the 23 synced flywheel skills, `start/*`, and 25 commands on both sides:

- **`agent-flywheel:` prefix** still appears in 22 files on the source side after the pass — most legitimately (see the MCP-tool trap below), but at least 14 in prose slash-command references (`Run /agent-flywheel:flywheel-status`, `/agent-flywheel:start` inside instructions) that need `/agent-flywheel:` → `/` and were only partially done. `~/.config/opencode/skills/start/SKILL.md` still contains `flywheel_get_skill({ name: "agent-flywheel:start_planning" })` on ~10 lines — correct on the MCP call, but `Skill(skill: "agent-flywheel:grill-with-docs")` also survives, which is wrong for opencode.
- **`CLAUDE_PLUGIN_ROOT`** in prose ("resolve via `$CLAUDE_PLUGIN_ROOT/skills/...`") and in shell snippets (tender-daemon spawn) — 8 occurrences the first pass missed beyond the one manual fix in `start/SKILL.md`.
- **`AskUserQuestion`** — mentioned in 22 skill/command files. Some are prose ("surface the consolidated AskUserQuestion"), some are executable references — opencode's analog is the `question` tool with a different arg shape, and mechanically renaming the identifier misses the semantic delta.
- **`TeamCreate` / `TeamDelete` / `SendMessage`** — 8 skill files carry Claude-Code-only Agent-Mail-team primitives that don't exist in opencode. `SendMessage` maps roughly to `mcp__agent-mail__send_message` but with a different signature (needs `subject` and `body`, not `to` + `message` object). `TeamCreate`/`TeamDelete` have no direct equivalent; opencode uses contact handshakes and no team lifecycle. Entire remediation blocks that read `edit ~/.claude/teams/<team>/config.json to remove the stale member` are dead advice post-port.
- **`Agent(subagent_type: …, team_name: …, run_in_background: true)`** — the Claude-Code Task-tool spawn form appears in `_planning.md`, `_implement.md`, `_review.md`, `flywheel-fix`, `flywheel-refine-skills`, `flywheel-swarm`. Opencode's equivalent is workflow-driven; team_name is not a field. Prose describing this is stale, not just cosmetically wrong.
- **`Task` / `TaskCreate` / `TaskList` / `TaskStop` / `TaskUpdate`** — 19 files. Opencode ships tools with the same names but partially different semantics (TaskStop in opencode terminates a workflow task; in Claude Code it kills an Agent-spawned subagent). Mechanical rename is fine for TODO-tracker Task*; for agent-lifecycle TaskStop the referent changes and the surrounding paragraph misdirects.
- **`~/.claude/plugins/cache/agent-flywheel/agent-flywheel/<VERSION>/…`** fallback paths — 4 files. These paths do not exist on opencode installs.
- **`Skill(skill_name: "…")`** — 2 occurrences of the older kwarg spelling that today's sed rewrites only handled for `Skill(skill: "…")` (12 occurrences). Two rewrite variants needed, not one.
- **`--robot-send`** — 8 files. These are shell invocations of the local `ntm` binary and are correct as-is; no rewrite.

## Three correctness traps in the sync script design

### Trap 1 — the MCP-name preservation trap

`flywheel_get_skill` is the primary mechanism the `start` skill uses to fetch sub-phase bodies (`_planning.md`, `_implement.md`, `_review.md`, etc.) in a single MCP round-trip instead of `Read`ing them. Its `name` argument is a hard string contract: `<plugin>:<skill-name>`, e.g. `agent-flywheel:start_planning` (see `mcp-server/src/server.ts:362` and `skills-bundle.ts:347`). The tool literally validates that shape.

Today's sed rule `s|agent-flywheel:|/|g` (or its `/agent-flywheel:X` → `/X` variant) is safe **only** because it's anchored on a leading `/`. If the sync script drops the leading-slash anchor, it will corrupt every `flywheel_get_skill({ name: "agent-flywheel:start_planning" })` call in the synced files, and the `start` skill breaks silently — the coordinator does `Read` fallbacks and the whole two-phase-bundle architecture is bypassed with no error.

**Requirement:** the rewrite ruleset must document this exclusion explicitly and have a test that runs `grep -rE 'flywheel_get_skill.*name:.*"[^a]' <dest>` after sync and fails if any name arg is missing the `agent-flywheel:` prefix. Also test the inverse: `grep -rE '/agent-flywheel:' <dest>` must return zero (all slash-command-form references converted).

### Trap 2 — the shared-namespace collision

`~/.config/opencode/skills/` on this machine already contains `brainstorming`, `cass`, `cass-memory`, `caam`, `dsr`, `frontend-design`, `gdb-for-debugging`, `idea-wizard`, `memory`, `multi-model-triangulation`, `slb`, `ui-polish`, and more — installed from unrelated sources. The repo `skills/` directory also ships its own `brainstorming/`, `cass/`, `caam/`, etc. as adjuncts that were *explicitly deferred* per the brainstorm floor.

If the sync script naively `rsync -a --delete skills/ ~/.config/opencode/skills/`, it will overwrite the other-source `brainstorming` with the repo's copy (silent divergence) and delete any opencode-native skill not present in the repo (data loss). Even without `--delete`, unqualified rsync of the whole tree is a scope violation of the brainstorm.

**Requirement:** the sync script must operate off an explicit allowlist — the 23 flywheel-* skill dirs plus `start/`, `grill-with-docs/`, `memory/`, and (optionally) `_template/` — and iterate per-directory, never at the parent `skills/` level. `--delete` may be used inside each allowlisted subdir (to catch removed files within `start/`, say) but never across sibling dirs. The allowlist is checked-in data (`scripts/sync-opencode-manifest.json` or similar), not implicit in the script body.

### Trap 3 — the hardcoded FLYWHEEL_ROOT in the plugin

`~/.config/opencode/plugins/agent-flywheel.js:15` hardcodes `const FLYWHEEL_ROOT = "/Volumes/1tb/Projects/agent-flywheel"`. This is portable only to kevtrinh's laptop. The MCP-server side already auto-detects (`skills-bundle.ts:100-115` walks up from `import.meta.url` if `CLAUDE_PLUGIN_ROOT` is unset), but the plugin file does not.

**Requirement:** the sync script must resolve the repo abspath at sync time (`git rev-parse --show-toplevel` from the running script's own location) and inject it into the plugin file *and* into `opencode.json`'s `mcp.flywheel.command[1]`, both of which currently carry the hardcoded literal. Prefer templating: keep a `scripts/opencode/agent-flywheel.plugin.js.template` with a `__FLYWHEEL_ROOT__` sentinel that the script substitutes before writing. The template lives in the repo so every re-sync re-injects the current path; a user who moves the repo just re-runs sync and it heals.

## Sync-script correctness contract

The script — call it `scripts/sync-opencode.sh` — must satisfy this contract, in this order:

1. **Deterministic on unchanged input.** Two consecutive runs against the same repo commit and the same live `~/.config/opencode` must produce zero diff. `sync-opencode.sh --verify` (the dry-run mode) must exit 0 in this state and print `no drift`; if there's drift, it must print a file-level diff and exit non-zero. This is how idempotence is proven at CI time and locally after a manual edit sneaks in.
2. **All-or-nothing per artifact.** Each write goes through tmp+rename inside the same filesystem (staging under `~/.config/opencode/.sync-tmp-$PID/` then `mv`). A killed sync leaves a valid prior state, never a half-written skill directory. `opencode.json` in particular MUST be merged read → parse → deep-merge `mcp.flywheel` (and only that key) → write-atomic, so a partial write cannot lose the user's other MCP entries (augment-context-engine, context7, engram, pencil, ui-craft) or provider/permission blocks. Use the pattern already implemented in `mcp-server/src/setup-detector.ts:registerMcpAtomic`.
3. **Allowlist-scoped delete.** `--delete` is applied only inside each allowlisted destination subdir. The parent `~/.config/opencode/skills/` directory is never a delete target. Same for `~/.config/opencode/commands/` — enumerate the 25 flywheel filenames and only touch those; do not `rm *.md`.
4. **Rewrites are data-driven and tested.** Rewrite rules live in a checked-in data file (`scripts/opencode/rewrites.yaml` or `.tsv`) — a list of `{pattern, replacement, applies_to_glob, exclusions}` tuples. The script iterates the data file. A unit test (`scripts/opencode/rewrites.test.sh` or a Node script) applies each rule to a golden fixture and diffs against expected output. New rules can be added by editing the data file, not the script.
5. **The plugin file and opencode.json are re-derived every run.** Both are generated from templates in `scripts/opencode/`; the script does not read the live plugin or opencode.json and try to "update" it in place (except for opencode.json's atomic merge of the `mcp.flywheel` key). This keeps the source of truth in the repo, and any local hand-edit to the derived files is deliberately transient.
6. **The script is a no-op past a successful `--verify`.** `sync-opencode.sh` (no args) should first run `--verify`, and if drift exists, prompt or (in `--yes` mode) apply. Never apply silently when there was drift that wasn't there yesterday — that pattern hides state-drift from the user.

## Rewrite ruleset (the actual rules, with anchors and exclusions)

Each rule specifies the pattern, the transformation, and (critically) the anchor context so we don't clobber intended usages. Rules apply file-by-file to the staged copy before rename.

| # | Pattern (regex) | Replacement | Applies to | Excluded when |
|---|---|---|---|---|
| 1 | `\$CLAUDE_PLUGIN_ROOT` | `<absolute repo root>` (injected at sync time) | `*.md` in synced skills, hooks scripts | — |
| 2 | `\$\{CLAUDE_PLUGIN_ROOT\}` | `<absolute repo root>` | same | — |
| 3 | `/agent-flywheel:([a-z0-9-]+)` | `/$1` | `*.md` prose (slash-command mentions) | — |
| 4 | `Skill\(skill(?:_name)?:\s*"agent-flywheel:([a-z0-9_-]+)"` | `skill(name: "$1"` | `*.md` | — |
| 5 | `Skill\(skill(?:_name)?:\s*"([a-z0-9_-]+)"` (residual after #4) | `skill(name: "$1"` | `*.md` | Inside `flywheel_get_skill(` argument list |
| 6 | `~/\.claude/plugins/cache/agent-flywheel/agent-flywheel/<VERSION>` fallback blocks | Delete the fallback clause; keep the CLAUDE_PLUGIN_ROOT branch (now rewritten by #1) | `start/SKILL.md`, `flywheel-reality-check/SKILL.md`, `commands/start.md` | — |
| 7 | `argument-hint:.*` in YAML frontmatter | Delete the line | `commands/*.md` | Only inside frontmatter (between the first two `---` lines) |
| 8 | Version-detection stanza that greps the plugins/cache path | Replace with a direct read of `<repo root>/mcp-server/package.json` | `skills/start/SKILL.md` Step 0a | — |

Rules **NOT** to apply mechanically, and their handling instead:
- `AskUserQuestion`, `TeamCreate`/`TeamDelete`, `SendMessage`, `Agent(...)`, `TaskStop`/`TaskList` referring to agent lifecycle, `~/.claude/teams/` remediation blocks — these are semantic-delta cases, not string-substitution cases. The sync script must NOT touch them. Instead, the plan produces a **stale-reference report** (`scripts/sync-opencode.sh --stale-report`) that greps for each and prints file:line for a human to triage. v1 accepts that the model will translate these on the fly (opencode's tool listing surfaces the right names); v2 (out of scope here) is a proper porting pass.

Every rule in the table above must have a golden fixture in `scripts/opencode/fixtures/` with `in.md` and `out.md`. The fixture test is a hard CI gate; a rule that changes must show the diff in review.

## Edge cases and failure modes

**Missing destination dirs.** First-time run on a fresh opencode install: `~/.config/opencode/skills/` may not exist. Script must `mkdir -p` before every write and never fail on absent-dir.

**Partial prior sync.** Today's manual port left `start/SKILL.md` with a hand-edit to Step 0a. When the templated sync runs, that edit is overwritten. This is *correct* behavior — the repo is the source of truth — but the script must announce it: `--verify` prior to first automated sync will show every hand-edit as drift, giving the user a chance to fold the change back into the repo before it's lost. Anyone doing manual edits post-port must be told: fold into repo or lose them.

**opencode.json merge collisions.** If a user has manually added an MCP entry named `flywheel` pointing elsewhere, the merge overwrites it. That's the intent, but the pre-write step should print the diff (`- old command:` → `+ new command:`) so it's visible. If the user has a *differently-named* MCP entry that happens to point to the same server binary, leave it alone — the merge key is `mcp.flywheel` verbatim.

**opencode version drift.** The `client.tui.showToast` plugin API is documented for opencode 1.15.10 (current). It's wrapped in try/catch in the plugin, so a future opencode that removes it degrades to no toasts rather than crashing. The sync script should read `opencode --version` and print a one-line note if the value is not within a "tested" set (`1.15.x` for v1); a warning only, not a hard failure. Do not gate sync on version — the plugin's own try/catch is the last line of defense.

**macOS junk.** `--exclude '.DS_Store' --exclude '._*'` on every rsync invocation. This is easy to forget and one `.DS_Store` in the destination causes a spurious diff in `--verify`.

**Symlinks in the repo.** Repo `skills/` has no symlinks today (verified: `find skills/ -type l` is empty), but the script should `rsync -a --safe-links` defensively; a symlink pointing outside the repo would otherwise dereference into unrelated content.

**Frontmatter parsing fragility.** Rule #7 (delete `argument-hint:`) is safe for the single-line values that exist today, but a future multi-line YAML value would be silently corrupted by a naive `/^argument-hint:/d`. The fixture test must include a multi-line-value case that the script correctly refuses to mangle (either handles it, or hard-errors — pick, but not silently truncate).

**Hooks port drift from `hooks/hooks.json`.** The opencode plugin file (`plugins/agent-flywheel.js`) is a hand-translated port of `hooks/hooks.json`. Nothing in the sync script cross-checks that the four hook points in `hooks.json` (SessionStart, PreToolUse-Bash, Stop, SubagentStop, PostToolUse-flywheel_approve_beads) all have implementations in the plugin. A future edit to `hooks.json` that adds a hook point will silently not port. **Requirement:** `--verify` includes a parity check — parse `hooks/hooks.json`, walk the plugin file for the corresponding `client.on(...)` handlers, fail if any hook point in the JSON has no handler in the plugin. This is the only way the derived-artifact story stays honest as `hooks.json` evolves.

**`am-doctor` and `agent-mail-guard.js` regex parity.** The plugin file imports the same regexes as `hooks/agent-mail-guard.js` (in principle). Today it's a hand-copy — if the Bash-guard regex in the source `.js` file changes, the plugin's inline copy silently diverges. `--verify` should also assert that the guard regex source in the plugin file matches the source in `hooks/agent-mail-guard.js` (hash the extracted string). Alternatively, refactor the guard into a shared module — but that touches `mcp-server/src`, which the context file explicitly forbids for this cycle. So: verify parity, don't refactor.

## Verification bar (what "sync-green" actually means)

Post-sync, all of the following must hold. Any failure is a bug in the sync script or its ruleset, not something to note-and-move-on.

1. `sync-opencode.sh --verify` exits 0 with `no drift`. Run twice in a row to prove idempotence.
2. `opencode mcp list` shows `flywheel` connected (`node <repo root>/mcp-server/dist/server.js`).
3. `node --check ~/.config/opencode/plugins/agent-flywheel.js` succeeds.
4. `bash -n scripts/sync-opencode.sh` succeeds; shellcheck (if available) reports no warnings above `info`.
5. `grep -rE '/agent-flywheel:' ~/.config/opencode/skills/ ~/.config/opencode/commands/` returns zero matches (proves rule #3 applied everywhere).
6. `grep -rE 'flywheel_get_skill\([^)]*name:\s*"(?!agent-flywheel:)' ~/.config/opencode/skills/` returns zero (proves rule #4/#5 did not corrupt the MCP-name contract).
7. `grep -rn 'CLAUDE_PLUGIN_ROOT' ~/.config/opencode/skills/ ~/.config/opencode/commands/ ~/.config/opencode/plugins/agent-flywheel.js` returns zero (proves rule #1/#2 applied everywhere; the plugin no longer needs the env var).
8. `grep -n '/Volumes/1tb/Projects/agent-flywheel' ~/.config/opencode/plugins/agent-flywheel.js ~/.config/opencode/opencode.json` returns the injected abspath *of the current repo* — not a stale one. On a different machine, running sync would produce a different abspath and both files would update.
9. The stale-reference report (`--stale-report`) is emitted and its counts match the taxonomy above (roughly: 22 AskUserQuestion, 8 SendMessage/TeamCreate blocks, 8 Agent() spawns, 19 Task*/TaskStop, 4 `~/.claude/teams/` blocks). The counts are logged so we can track burn-down across v1→v2 sweeps.
10. `hooks/hooks.json` parity check passes (every hook point in JSON has a handler in the plugin file).
11. A smoke run: `opencode` starts, `/flywheel-doctor` runs to green, `/start` prints the banner with the correct version from the injected repo path, and one `flywheel_get_skill({ name: "agent-flywheel:start_planning" })` MCP call returns the body (not a `Read` fallback). If any of these fail, sync is not green regardless of `--verify` output.

## Explicit non-goals (per the brainstorm floor)

- Reconciling the ~20 diverged non-flywheel skills already present in `~/.config/opencode/skills/` from other sources.
- Rewriting the semantic-delta references (AskUserQuestion → question, TeamCreate → contact handshake, Agent() → workflow). The stale-reference report documents these; a follow-up cycle does the translation.
- Auto-watching, drift-detection daemons, self-heal — the 10x ceiling. Reserved as a future-directions appendix.
- Any change to `mcp-server/src` behavior (per constraints). If a correctness issue can only be fixed there, it's flagged in the report and deferred.

## Open decisions the user should pick before implementation

1. **Rewrite-rule storage:** YAML data file vs. bash function array. Recommend YAML with a tiny Node parser — human-editable, testable in isolation, doesn't put quoting hell in the script body.
2. **`--verify` failure mode when hand-edits exist:** hard-fail vs. warn-and-continue on `sync-opencode.sh` (no args) when drift is detected. Recommend hard-fail with a one-line hint (`re-run with --yes to overwrite, or fold changes into the repo first`). This forces manual edits back to the source of truth instead of accumulating.
3. **Copy vs. symlink:** default is copy (matches the "opencode files are derived artifacts" framing). Recommend adding `--link` for dev-loop iteration but keeping copy as default. A symlink accidentally landing in someone's opencode install would make repo edits ship instantly on their machine with no visible sync step — surprising in a bad way.

## Future direction (out of v1 scope, per brainstorm)

A `sync-opencode.sh --watch` mode that runs `--verify` on `fswatch skills/ commands/ hooks/ scripts/opencode/` events and applies on quiet-second, plus a periodic (`launchd` or `cron`) drift check that mails the user when live opencode config diverges from repo state. Same script, extra flag — no new architecture.
