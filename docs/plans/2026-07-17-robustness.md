# Robustness plan — harden the OpenCode port

**Date:** 2026-07-17
**Lens:** repo evolution, target drift, path portability, upgrade safety, and sync failure recovery
**Scope anchor:** the happy-path MVP in `docs/brainstorms/harden-the-opencode-port-of-agent-flywheel-2026-07-17.md`: one repeatable repo-to-OpenCode sync plus a real compatibility sweep over the 23 managed skill directories and 25 commands. Reconciliation of unrelated non-flywheel skills and automatic watching/self-healing stay out of v1.

## Verdict

Build the port as a deterministic, fail-closed compiler from repo sources into an explicitly owned subset of the OpenCode config. A future repo change should either produce a validated new target tree or stop before touching the live install; a partially translated, partially written “successful” sync is the failure this plan is designed to prevent.

Keep `scripts/sync-opencode.sh` as the public command, but put path handling, rendering, JSONC edits, hashing, bounded subprocesses, and transaction recovery in a Node helper. Node 20+ is already a project prerequisite, while shell-only `sed`/`rsync` logic makes the important failure cases—paths with spaces, JSONC preservation, semantic overlays, interrupted multi-file writes, and machine-readable drift state—needlessly fragile.

## Grounded starting state

The numbers below came from the current repo and live `~/.config/opencode` on 2026-07-17. They are evidence for the design, not constants to bake into user-facing prose.

| Check | Current result | Why it matters |
|---|---|---|
| Managed source inventory | 22 `skills/flywheel-*` directories plus `skills/start` = 23; `commands/*.md` = 25 | The sync needs an exact ownership manifest, but output should discover and report counts rather than trusting this snapshot forever. |
| Managed live inventory | The same 22 flywheel directories plus `start`, and all 25 command filenames exist | The manual copy covered the named files, so drift checks must compare content and behavior rather than counts alone. |
| Semantic Claude vocabulary | Source and live targets both contain 197 `AskUserQuestion`, 66 `TeamCreate|TeamDelete|SendMessage`, 77 `Agent(`, and 52 `Task*` matches | The manual pass removed lexical prefixes but did not perform the promised semantic sweep. A copy succeeding cannot mean compatibility succeeded. |
| Lexical rewrites | Live targets contain zero `$CLAUDE_PLUGIN_ROOT` and zero `/agent-flywheel:` matches | These rules work, but broadening either regex would corrupt required bundle IDs such as `agent-flywheel:start_planning`. |
| Machine-specific paths | The installed targets contain ten `/Volumes/1tb/Projects/agent-flywheel` references, including the plugin constant, MCP command, version reads, and tender-daemon commands | Moving the repo or running on another machine breaks the port until every generated path is derived from the script’s actual checkout. |
| Claude-only filesystem assumptions | The live managed targets still contain 22 `.claude`/`~/.claude` references | Several are executable recovery instructions, so treating them as harmless prose would leave failure paths broken even if the main path works. |
| Checked-in OpenCode source | No repo-owned OpenCode plugin/template exists; the only `agent-flywheel.js` is in the live config | The live machine is currently the only source for a load-bearing artifact, so a fresh install cannot be reproduced from the repo. |
| Command dependency closure | `commands/grill-with-docs.md` delegates to `skill(name: "grill-with-docs")`, but `grill-with-docs` is outside the 23 managed dirs and only happens to exist in this user’s Claude/Agents skill locations | Another machine can install all declared managed files and still have `/grill-with-docs` fail. The manifest must classify every delegated dependency. |
| Plugin syntax | `node --check ~/.config/opencode/plugins/agent-flywheel.js` passes | Syntax validation is necessary, but it does not prove event names, hook parity, or the `client.tui.showToast` capability. |
| Config location | `opencode debug paths` reports `/Users/kevtrinh/.config/opencode` here | The script must honor `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, XDG paths, and test overrides rather than hard-code this result. |
| MCP smoke | A bounded local attempt at `opencode mcp list` printed the table header but did not finish within 30 seconds | The required connectivity check needs its own timeout and error classification; the sync must never hang forever because an unrelated MCP server is unhealthy. |
| Dirty-tree adjacent | The prompt’s 24-file yellow had become 27 entries during this deep-plan pass, mostly untracked compiled tests plus one modified source test and planning artifacts | Count-based cleanup instructions go stale immediately in a shared checkout. Triage must be by path and provenance, with no bulk deletion. |

OpenCode’s current documentation confirms three contracts the implementation must respect: configuration supports both JSON and JSONC, custom config files/directories are selected with `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`, and global skills are loaded through the native `skill({ name })` tool. Plugin documentation lists `session.created`, `session.idle`, `tool.execute.before`, and `tool.execute.after`, but those APIs still need capability tests because OpenCode auto-updates. Sources: [configuration](https://dev.opencode.ai/docs/config), [CLI environment variables](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/cli.mdx), [skills](https://opencode.ai/docs/skills/), and [plugins](https://dev.opencode.ai/docs/plugins/).

## Robustness contract

The implementation is green only when all of these invariants hold together.

1. **The repo is the sole authoring source.** Managed live files are outputs. OpenCode-specific templates, semantic overlays, transformation rules, and ownership metadata live in this repository; the generator never learns a rule by reading a hand-edited destination.
2. **The managed boundary is exact.** The sync may replace only manifest-owned skill directories, command files, `plugins/agent-flywheel.js`, its private state directory, and `mcp.flywheel`. It never runs a parent-level `--delete`, rewrites unrelated OpenCode config keys, or adopts a same-named file without reporting it.
3. **Inventory changes require review.** A new `skills/flywheel-*` directory or `commands/flywheel-*.md`, a missing manifest source, or a managed command whose delegated skill is unclassified fails the render. Silent scope shrink is not an upgrade strategy.
4. **Transforms are context-sensitive.** Slash-command names may lose `/agent-flywheel:`, while `flywheel_get_skill({ name: "agent-flywheel:…" })` must retain the namespace. `--robot-send` and provider names such as `claude`, `codex`, and `gemini` are intentional; Claude tool calls and `.claude` recovery paths are not.
5. **Semantic compatibility is gated separately from file drift.** Rendering, compatibility validation, installation, and runtime smoke checks report distinct outcomes. “Files copied” cannot mask an unavailable tool instruction or a failed plugin load.
6. **Every mutation is recoverable.** The desired tree is fully rendered and validated before a destination write. Apply uses a lock, a same-filesystem staging area, a private backup, an on-disk journal, atomic renames, and startup recovery for an interrupted prior transaction.
7. **Local divergence is visible and preserved.** The state ledger records the last installed hashes. If a live managed file no longer matches that hash, the next check labels it as a local edit, and write mode backs it up before replacing it. Unmanaged siblings remain untouched.
8. **Machine paths are render inputs.** The repo root and OpenCode config path are resolved at runtime, encoded structurally rather than interpolated through `sed`, and tested with spaces and Unicode. No checked-in file contains `/Users/kevtrinh` or `/Volumes/1tb`.
9. **External probes are bounded.** Every child process has a timeout, captured stderr, and a named failure. A timed-out `opencode mcp list` marks runtime verification failed without leaving a lock or rolling back an otherwise valid generated tree.
10. **Dry-run is a proof path.** Check and dry-run generate and validate the same desired tree as write mode, but make no destination mutation—not a temp file, backup, lock, config reformat, or ledger update.

## Proposed source layout

```text
scripts/
  sync-opencode.sh                 # public, shellchecked wrapper; execs Node helper
  opencode/
    sync.mjs                       # modes, render pipeline, diff, transaction, recovery
    transforms.mjs                 # named lexical/structural transformations
    validate.mjs                   # inventory, compatibility, hook, and output invariants
opencode/
  manifest.json                    # owned artifacts, dependency closure, retire tombstones
  compatibility.json               # forbidden tokens and narrowly justified retained forms
  commands/
    start.md                       # intentional short native-skill entry point
    grill-with-docs.md             # bundled-MCP entry, avoiding an unmanaged skill dependency
  plugins/
    agent-flywheel.js              # checked-in template with a typed root sentinel
  patches/
    start.patch                    # reviewed semantic changes after mechanical normalization
    standalone.patch               # reviewed semantic changes for managed skills/commands
  fixtures/
    transforms/
    hooks/
    homes/
install/test/
  test-sync-opencode.bats          # black-box temp-home and failure-recovery coverage
```

Do not check in a second complete copy of the managed skills and commands. Mechanical changes belong in named transforms, and meaning-changing differences belong in reviewable patches that apply to the normalized staging tree. A stale patch must fail its preflight hunk check; it must never be skipped because the source moved “close enough.”

The shell wrapper should resolve its own repository with `git -C <script-dir> rev-parse --show-toplevel`, validate that the helper exists, and `exec node … "$@"`. It should not contain rewrite regexes or JSON manipulation. The Node helper can use argument arrays, `realpath`, `lstat`, hashes, and `spawnSync(..., { timeout })` without shell evaluation.

### Manifest and lifecycle rules

`opencode/manifest.json` should list each active source/destination pair with `kind`, `transformProfile`, and dependency metadata. It also records the MCP config key (`flywheel`), plugin template, supported OpenCode capability baseline, and intentional retirements.

- Compare the explicit manifest with discovered core candidates on every run. A new matching source fails with `inventory_unclassified`; a missing active source fails with `inventory_missing` before staging touches the live tree.
- Treat a directory as one owned unit, so a file removed from `skills/start/` disappears from the rendered directory. Never infer ownership of sibling directories from a glob at write time.
- Remove a formerly managed file only through a `status: "retired"` tombstone. The apply may delete it only when the ledger proves the destination was installed by an earlier sync; otherwise preserve it and report a conflict.
- Validate dependency closure for native `skill(name: "…")`, slash-command delegation, and repo-relative `Read` fallbacks. Each dependency must be managed, served by the flywheel MCP bundle, or explicitly external with a verification rule and rationale.
- Resolve the current `/grill-with-docs` gap without reconciling the unrelated skill ecosystem: install an OpenCode command override that loads `agent-flywheel:grill-with-docs` through the managed flywheel MCP bundle. Do not overwrite the user’s separately installed `grill-with-docs` or `memory` skill.

### Render pipeline

Every mode uses one pipeline in this order:

1. **Resolve and preflight.** Resolve repo root, config dir, config file, required binaries, manifest, and prior journal. Reject source/destination symlinks that escape their allowed roots, missing inputs, ambiguous simultaneous `opencode.json`/`opencode.jsonc`, and an active sync lock.
2. **Recover if needed.** If a prior journal is `prepared` or `committing` and its owner PID is gone, validate the recorded backup and restore it before starting a new render. An unknown or corrupt journal blocks with a manual recovery path rather than guessing.
3. **Snapshot source inputs.** Hash the managed repo files, manifest, transforms, patches, plugin template, `.claude-plugin/plugin.json`, and relevant hook sources. Record the current commit plus a dirty flag for diagnostics; the content hash, rather than HEAD alone, defines the build input.
4. **Render to a private temp tree.** Copy active managed sources with Node filesystem APIs, reject source symlinks, apply mechanical transforms, apply semantic patches with a strict preflight, render typed sentinels, and generate the OpenCode compatibility header that maps logical `flywheel_*` names to the actual `flywheel_flywheel_*` tool prefix.
5. **Generate shared-config edits.** Derive the MCP command from `.claude-plugin/plugin.json` by replacing `${CLAUDE_PLUGIN_ROOT}` structurally, then form OpenCode’s `mcp.flywheel = { type: "local", command: [...], enabled: true }`. This follows a future server-entry move when the canonical plugin manifest changes instead of duplicating `mcp-server/dist/server.js` in another constant.
6. **Validate the staged result.** Run frontmatter parsing, compatibility scans, dependency closure, unresolved-sentinel checks, plugin import/mock tests, hook parity, path-containment checks, and `node --check`. No destination comparison or mutation occurs until all validators pass.
7. **Compare desired, live, and ledger hashes.** Classify each path as current, normal source upgrade, missing, obsolete-owned, or locally diverged. Show only managed-file diffs and the old/new `mcp.flywheel` field; never print the rest of a config that may contain provider secrets.
8. **Stop for check/dry-run.** Return the documented drift/error exit code after deleting only the private OS temp tree. A test must prove the target tree hash is byte-identical before and after both modes.
9. **Apply transactionally.** Acquire the lock, stage under the target filesystem, back up every affected managed path and the config with private permissions, write the journal, rename managed units into place, apply the JSONC-preserving MCP edit, write the ledger last, and verify all installed hashes. Any caught failure restores the backup; a hard kill is recovered from the journal on the next invocation.
10. **Run bounded runtime smoke.** After the filesystem transaction is committed, run `opencode --version`, `opencode debug paths`, and a time-bounded `opencode --pure mcp list`; then exercise the plugin load and one bundled-skill retrieval. Runtime failure makes the overall verification red but does not replace good files with an older backup, because network/process health is independent of generation correctness.

### Shared config and path portability

OpenCode supports JSONC, comments, and trailing commas, so `JSON.parse` followed by `JSON.stringify` is not an acceptable merge. Use a pinned JSONC document editor that changes only the `mcp.flywheel` node and preserves surrounding text; if that dependency is unavailable, fail before writing instead of falling back to a lossy rewrite. Back up the original mode and bytes, write the replacement with the same permissions, and verify the edited document parses before rename.

Resolve destinations in this precedence order:

1. explicit test/user flags (`--config-dir`, and `--config-file` when needed);
2. `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG`;
3. the bounded output of `opencode debug paths`;
4. `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`.

If `OPENCODE_CONFIG_CONTENT` is set, warn that an inline runtime override may supersede the persisted entry and require the runtime smoke to confirm the effective configuration. If both `opencode.json` and `opencode.jsonc` exist and no explicit config file resolves the ambiguity, stop. Never use `eval` or shell tilde expansion on an environment-provided path.

The plugin template should use a sentinel replaced through `JSON.stringify(repoRoot)`, not a raw search/replace. The renderer should similarly generate version-read and tender-daemon commands with shell-safe quoting. A repo move is a normal upgrade: check reports path drift in the plugin and `mcp.flywheel`, write updates both in one transaction, and the ledger records the new root.

### Compatibility policy for future Claude-isms

The current manual sync proves that broad text replacement is insufficient. Split compatibility work into four explicit classes:

| Class | Examples | v1 handling |
|---|---|---|
| Safe lexical | `/agent-flywheel:flywheel-status`, supported command frontmatter, `Skill(skill: "agent-flywheel:start")` | Named transforms with golden input/output fixtures and postconditions. |
| Structured equivalent | `AskUserQuestion` payloads where OpenCode’s `question` tool supports the same decision | Translate the tool and field schema, update prose, and validate the rendered payload shape against fixtures. Do not merely rename the identifier. |
| Semantic overlay | `Agent(...)`, `TeamCreate`, `TeamDelete`, `SendMessage`, agent-lifecycle `TaskStop`, `.claude/teams`, Claude hook setup, and fallback paths | Replace the surrounding workflow through checked-in patches. Prefer the repo’s mandatory NTM path; where OpenCode lacks a safe equivalent, state the degraded behavior explicitly rather than leaving an unusable call. |
| Intentional retain | `flywheel_get_skill` IDs beginning `agent-flywheel:`, `ntm --robot-*`, provider-health checks for `claude`, and historical prose that is actually necessary | Allow only exact snippets or scoped patterns with a reason in `compatibility.json`; a blanket token allowlist is forbidden. |

After translation, scan fenced calls, inline code, prose, and paths. New matches for the known Claude lexicon are errors unless explicitly retained. Also inventory call-like identifiers in fenced blocks against OpenCode built-ins, the configured flywheel MCP tools, NTM commands, and a small justified language-function allowlist; this catches a newly introduced `SomeNewClaudeTool(...)` even before its name is added to the known-token list.

The MCP prefix is another target-specific contract. OpenCode exposes the repo’s `flywheel_*` server tools as `flywheel_flywheel_*` under the current config key. Render one concise compatibility preamble into managed OpenCode skills and verify a real `flywheel_flywheel_get_skill` call in smoke tests; do not rewrite bundle identifiers or change `mcp-server/src` in this cycle.

### Hook and plugin drift

The OpenCode plugin is a semantic port of `hooks/hooks.json`, `hooks/startup.js`, and `hooks/agent-mail-guard.js`; copying it on each sync does not prove it still represents those sources.

- Put a hook-coverage table in the manifest mapping each Claude hook key/matcher to its OpenCode event/handler. Validation fails when `hooks/hooks.json` gains or removes a hook without a reviewed mapping update.
- Use a shared command corpus to black-box both Agent Mail guards. Each dangerous, benign, and break-glass command must produce the same allow/block decision; comparing regex source strings is too coupled to formatting.
- Mock the plugin client and fire `session.created`, `session.idle`, `tool.execute.before`, and `tool.execute.after`. Assert bounded reservation release, no uncaught toast/log failure, and no stdout output.
- Feature-detect `client.tui.showToast` and log one structured warning when absent. The existing empty `catch {}` prevents a crash but also hides API drift, so it cannot serve as verification.
- Keep OS-specific recovery prose out of the generated plugin unless guarded by `process.platform`. The canonical `flywheel_remediate` path should be first; `launchctl` cannot be presented as universal advice on Linux.
- Treat the installed OpenCode version as diagnostics, not a hard-coded pass condition. Warn outside the tested capability baseline, then let event/tool smoke tests determine green or red.

## Failure matrix

| Failure | Detection point | Required result |
|---|---|---|
| Repo adds a new flywheel skill/command | Manifest-vs-discovery preflight | Fail `inventory_unclassified`; destination remains unchanged until ownership and compatibility rules are reviewed. |
| Source file/dir is renamed or removed | Active manifest path check | Fail before staging; do not delete the old live artifact without an explicit retire tombstone. |
| New Claude-only tool call appears | Post-render compatibility and call-identifier scan | Fail with file, line, token, and the command to reproduce the full scan. |
| A semantic patch no longer applies | Patch preflight | Fail `semantic_overlay_stale`; never continue with the unpatched file. |
| Repo moved, path contains spaces/Unicode | Root resolution plus path fixture | Render new encoded paths; check reports ordinary drift, then one write updates plugin and MCP entry together. |
| Config directory is customized | Precedence resolver and `opencode debug paths` cross-check | Write only the resolved profile; mismatch between requested and effective paths is a visible error. |
| `opencode.jsonc` has comments/trailing commas | JSONC fixture and parse/edit/parse test | Preserve all unrelated bytes semantically and all comments textually while changing only `mcp.flywheel`. |
| Existing `mcp.flywheel` points elsewhere | Three-way diff against ledger | Report the field-level conflict, back up on explicit write, preserve every sibling key. |
| Live managed file was hand-edited | Actual hash differs from ledger hash | Label `local divergence`, include it in backup, and never describe the change as a routine repo upgrade. |
| Destination contains a symlink escape | `lstat`/`realpath` containment check | Refuse to read through or replace it; show the exact path. |
| Two syncs race | Atomic lock-dir acquisition | One proceeds; the other exits quickly with owner PID/start time and makes no writes. |
| Process receives SIGINT/SIGTERM mid-apply | Journal plus signal/finally handler | Restore backup, clear owned lock, return failure. |
| Process receives SIGKILL or host crashes | Incomplete journal on next start | Validate and restore the previous snapshot before any new render; corrupt recovery data blocks for manual action. |
| Disk full/read-only/rename error | Checked filesystem operation | Roll back completed renames, retain journal/backup for diagnosis, never claim partial success. |
| Plugin template has syntax/API drift | `node --check`, mock import, capability tests | Block apply for syntax/contract failure; runtime feature loss is a named red or warning according to whether it is load-bearing. |
| `opencode mcp list` or another server hangs | Node child-process timeout | Kill the probe, release the sync lock, report `runtime_unverified`; do not hang or erase a valid install. |
| Source checkout is dirty | Source snapshot | Warn with content hash and dirty flag; render the actual bytes. Final release/dogfood evidence separately requires intentional dirty-tree triage. |

## Task plan

### R1. Define the managed manifest, dependency closure, and retirement contract

`depends_on: []`

Add `opencode/manifest.json` with the current 23 managed skill directories, 25 commands, plugin template, MCP key, transform profiles, external/bundled dependencies, and no retirements initially. Implement discovery checks for new/missing core artifacts and closure checks for native skill/slash/MCP delegation. Resolve `grill-with-docs` through a repo-owned command override that loads the bundled flywheel skill, leaving separately installed non-flywheel skill directories untouched.

Acceptance: a fresh manifest check exactly accounts for the current core surfaces; adding a synthetic `skills/flywheel-new/` or removing a listed source fails; every managed command dependency is classified; parent OpenCode directories are never ownership targets.

### R2. Check in the OpenCode-native source assets and hook mapping

`depends_on: [R1]`

Move the current live plugin into `opencode/plugins/agent-flywheel.js` as a real template, replace machine literals with typed sentinels, add the short native `start` and bundled-MCP `grill-with-docs` command overrides, and encode Claude-hook-to-OpenCode-event coverage in the manifest. Remove unconditional macOS recovery prose and make missing toast capability observable through structured logging.

Acceptance: templates contain no user/volume literals, `node --check` passes before and after test rendering, the hook map covers every key/matcher in `hooks/hooks.json`, and plugin tests write nothing to stdout.

### R3. Implement deterministic rendering and context-aware mechanical transforms

`depends_on: [R1, R2]`

Create the thin shell wrapper and Node renderer. Copy only active manifest sources into a private tree, remove `argument-hint` through frontmatter parsing, rewrite slash and native-skill forms without touching MCP bundle IDs, render root/tool-prefix compatibility text, apply special command templates, and generate stable hashes. Each transform gets an ID, scope, pre/postcondition, and golden fixtures including near-misses.

Acceptance: two renders from identical bytes are byte-identical; paths with spaces and Unicode render correctly; `agent-flywheel:start_planning` survives; `/agent-flywheel:start` and unsupported frontmatter do not; check/dry-run do not touch the target.

### R4. Complete the semantic Claude-ism sweep as reviewable overlays

`depends_on: [R3]`

Translate the current `AskUserQuestion` payload/prose set to OpenCode’s question contract, replace Agent/Team/SendMessage/agent-Task lifecycle passages with NTM-first or explicit degraded OpenCode behavior, and remove executable `.claude` path assumptions from the 23 managed skills and 25 commands. Store meaning-changing edits as patches against the normalized render and encode narrow retained forms with reasons.

Acceptance: the staged compatibility scan has zero unapproved Claude-tool/path findings; every retained `agent-flywheel:` is an MCP bundle ID; every retained Claude provider name is in a provider/NTM context; deliberately adding a new tool call or making a patch stale fails before install.

### R5. Add portable config resolution and a JSONC-preserving MCP merge

`depends_on: [R1]`

Resolve config dir/file with the documented flag/env/debug/XDG precedence, derive the server command from `.claude-plugin/plugin.json`, and edit only `mcp.flywheel` with a pinned JSONC-preserving editor. Validate path containment, ambiguous config files, `OPENCODE_CONFIG_CONTENT`, file modes, and server-entry existence. Never log unrelated config bodies.

Acceptance: JSON and JSONC fixtures preserve unrelated keys, comments, trailing commas, and permissions; custom profiles work; missing or ambiguous config fails before writes; a moved checkout changes exactly the generated root-bearing fields.

### R6. Implement the ledger, lock, transactional apply, and recovery path

`depends_on: [R3, R5]`

Add a private state directory under the resolved OpenCode config containing a schema-versioned ledger, lock metadata, transaction journal, and mode-0700 backups. Classify normal upgrades versus local divergence by three-way hashes. Stage on the destination filesystem, journal before renames, write the ledger last, roll back caught failures, and recover abandoned valid journals at next startup.

Acceptance: concurrent invocation is rejected; local edits are labeled and backed up; a forced failure after each commit step restores the exact prior tree; a simulated hard-kill journal is recovered; unmanaged siblings and config keys remain byte-for-byte unchanged.

### R7. Build the compatibility, plugin, and failure-injection test matrix

`depends_on: [R2, R4, R6]`

Add temp-home black-box tests under `install/test/` plus focused Node fixtures for transforms, JSONC, and plugin hooks. Cover first install, no-op rerun, source upgrade, intentional retirement, local edit, custom config paths, paths with spaces, stale patches, new Claude tokens, symlink escapes, lock contention, every transactional failure point, missing binaries, and a fake `opencode` process that hangs.

Acceptance: tests never touch the runner’s real home; a target-tree hash proves check/dry-run immutability; second write reports zero changes; timeout tests finish within their budget; hook guard corpora produce equivalent allow/block decisions.

### R8. Document the upgrade and recovery contract, then triage adjacent yellows

`depends_on: [R6, R7]`

Document first sync, normal `git pull → check → dry-run → write → smoke`, moved-checkout recovery, local-divergence backups, stale semantic overlays, interrupted transaction recovery, ownership boundaries, and the current capability baseline. Verify the codex-config doctor row only. Triage the dirty repo by exact path and provenance; do not delete generated test outputs or reset source changes merely to make the count green.

Acceptance: docs contain no fixed artifact counts presented as timeless facts; recovery instructions name the journal/backup locations and never advise deleting a lock blindly; codex config is reported as verified or still yellow; dirty paths are assigned to source change, generated artifact, deep-plan artifact, or unknown owner.

### R9. Adopt and dogfood the live install with zero-drift evidence

`depends_on: [R7, R8]`

Run check and dry-run against the current live config, review every local-divergence backup, apply once, and rerun both modes. Then run bounded plugin/MCP/capability smoke, execute `/start`, retrieve `agent-flywheel:start_planning` through the exposed MCP tool, and exercise one question gate plus one Agent Mail guard block/allow pair. Record results in completion evidence, not in committed machine-local files.

Acceptance: the second check and dry-run show zero managed drift; `node --check` passes; the actual resolved OpenCode config contains the current checkout path only where generated; `opencode mcp list` shows flywheel connected within its timeout; `/start` reaches a native question without invoking Claude-only tools; unrelated local assets remain present.

## Dependency graph

```text
R1 manifest/ownership
├── R2 native assets + hook map
├── R3 deterministic renderer ──> R4 semantic sweep
└── R5 config/MCP merge

R3 + R5 ──> R6 transaction/ledger
R2 + R4 + R6 ──> R7 failure matrix
R6 + R7 ──> R8 docs + adjacent triage
R7 + R8 ──> R9 live adoption
```

R4 and R5 can proceed in parallel after the mechanical pipeline and manifest exist. R6 must precede live application, while R7 must exercise recovery before R9 is allowed to touch the real config.

## Verification block

The exact test command may be wired into the existing install test job, but the acceptance surface should remain runnable locally without an OpenCode account or the user’s real config:

```bash
bash -n scripts/sync-opencode.sh
shellcheck scripts/sync-opencode.sh install/test/test-sync-opencode.bats
bats install/test/test-sync-opencode.bats
node --test scripts/opencode/*.test.mjs

# Read-only default and detailed preview against an isolated profile.
tmp_dir=$(mktemp -d)
OPENCODE_CONFIG_DIR="$tmp_dir/config profile" scripts/sync-opencode.sh --check
OPENCODE_CONFIG_DIR="$tmp_dir/config profile" scripts/sync-opencode.sh --dry-run

# First apply, then convergence proof.
OPENCODE_CONFIG_DIR="$tmp_dir/config profile" scripts/sync-opencode.sh --write
OPENCODE_CONFIG_DIR="$tmp_dir/config profile" scripts/sync-opencode.sh --check
OPENCODE_CONFIG_DIR="$tmp_dir/config profile" scripts/sync-opencode.sh --dry-run

# Real-machine acceptance after isolated tests pass.
scripts/sync-opencode.sh --dry-run
scripts/sync-opencode.sh --write
scripts/sync-opencode.sh --check
node --check "$HOME/.config/opencode/plugins/agent-flywheel.js"
opencode debug paths
opencode mcp list
```

Tests should invoke the Node helper with injected filesystem/process failure points rather than trying to manufacture ENOSPC or SIGKILL against a real home. The production code must ignore those injection knobs unless `NODE_ENV=test` and the destination is under the test temp root.

## Explicit non-goals

- Reconcile, overwrite, or choose winners among diverged non-flywheel skill directories already installed from other sources.
- Add a filesystem watcher, launch agent, cron job, automatic reapply, drift notification, or self-healing daemon.
- Change `mcp-server/src` behavior, rename MCP tools, or redesign the Claude plugin around OpenCode.
- Make arbitrary local edits inside managed generated files a second supported source of truth; v1 preserves them in backups and points maintainers back to repo templates/patches.
- Add native Windows/PowerShell parity. The v1 script targets the repo’s existing macOS/Linux Node+Bash environment and must say so.
- Auto-clean the current dirty repository or mutate Codex configuration from the sync script.
- Promise compatibility with unknown future OpenCode plugin APIs without capability tests; version strings alone are not proof.

## Future direction

Once the renderer, ledger, and recovery path have survived ordinary upgrades, a watcher can call the same read-only check and explicit write operations. It should add no second transformation path and no daemon-owned source state, but it remains outside this cycle’s happy-path MVP.
