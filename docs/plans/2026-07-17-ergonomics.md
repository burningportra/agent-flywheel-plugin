# Ergonomics plan — harden the OpenCode port

**Date:** 2026-07-17  
**Perspective:** ergonomics  
**Scope anchor:** happy-path MVP from `docs/brainstorms/harden-the-opencode-port-of-agent-flywheel-2026-07-17.md`

## Verdict

Ship one safe, obvious repo command for the derived OpenCode port: `scripts/sync-opencode.sh`. With no arguments it should report drift without writing, `--dry-run` should show the proposed changes, and `--write` should apply them and immediately prove that a second check is clean.

Keep the existing Claude plugin as the source of truth and present OpenCode as a from-source integration. The v1 workflow is `git pull -> sync check -> sync write -> /flywheel-doctor`; repository watching, self-healing, non-flywheel skill reconciliation, and a standalone OpenCode installer remain future work.

## Grounded friction inventory

1. **There is no repeatable entry point.** The current OpenCode port was assembled with manual `rsync`, `sed`, config editing, and a handwritten plugin, so a user cannot reproduce or update it from the repository.
2. **The live files do not explain their ownership.** `~/.config/opencode/plugins/agent-flywheel.js` contains a machine-specific absolute root, while skills and commands look like ordinary editable files. A user can reasonably edit them and lose those edits on the next manual sync.
3. **A broad delete would be unsafe.** The live OpenCode config contains many unrelated skills, commands, and plugins. The sync may own `flywheel-*`, `start`, `agent-flywheel.js`, and `mcp.flywheel`; it must not treat the parent directories as generated output.
4. **The stated inventory has already drifted.** The context says 23 skills and 25 commands, but the current source tree has 23 managed skill directories and 23 managed command files (`flywheel-*` plus `start`). Counts in output and docs must be discovered, not copied into prose as constants.
5. **The current mechanical rewrite is incomplete.** The derived skills still contain `AskUserQuestion`, `Agent(...)`, `TeamCreate`, `SendMessage`, `TaskCreate`, `~/.claude/...`, and similar Claude-specific instructions. A sync that copies successfully but leaves those behind cannot end with a generic success message.
6. **`commands/start.md` is intentionally non-mechanical.** The OpenCode version is a short `skill(name: "start")` pointer, while the Claude source is a longer namespaced `Skill(...)` explanation. Treating this as another global search-and-replace will reintroduce the UX regression that was manually fixed.
7. **`install.sh` is Claude-only.** Its help, prompts, and final handoff all assume Claude Code; `--skip-mcp-register` is parsed but currently has no effect. OpenCode integration needs to be explicit so existing installs do not suddenly write to `~/.config/opencode`.
8. **The repository has no OpenCode discovery path.** README, CONTRIBUTING, and the complete guide describe Claude and limited Codex use, but no page tells an OpenCode user where the derived files come from, what the sync owns, or how to update it.
9. **Verification is fragmented.** `bash -n`, `node --check`, config validation, residual-token checks, idempotence, and `opencode mcp list` are separate facts in the planning context. The script should make them one post-write result with named failures and one next action.
10. **The host version is not stable enough to bake into the workflow.** The deep-plan context records OpenCode 1.15.10, while the binary visible to this shell reports 1.15.5. The script should print the detected version and test capabilities, not enforce a version string copied from the plan.

## Resolved UX decisions

### 1. Put the user entry point in `scripts/`

Use `scripts/sync-opencode.sh`, next to `scripts/sync-commands-to-skills.sh`. Contributors already look in this directory for repo maintenance commands, and the existing sync script establishes the useful convention that checking is the default and writing is explicit.

Keep OpenCode-specific source assets under a new top-level `opencode/` directory:

```text
opencode/
  commands/
    start.md                    # deliberate OpenCode override
  plugins/
    agent-flywheel.js           # checked-in template with repo-root sentinel
scripts/
  sync-opencode.sh              # only public sync entry point
install/test/
  test-sync-opencode.bats       # temp-home behavior tests
docs/
  opencode.md                   # canonical user guide
```

The normal skill and command bodies still come from `skills/` and `commands/`. Do not check in a second full copy of the 23 skills or commands. The two assets above exist because they are genuinely target-specific: the plugin has no Claude-side equivalent, and the short OpenCode start command is intentionally different from its Claude command.

Keep the small mechanical transforms as named functions in `sync-opencode.sh` for v1. A separate rewrite-rule data format would give maintainers another language to understand without removing the need for context-sensitive checks. If the rule set grows beyond a handful of reviewed functions, extraction can be a later refactor.

### 2. Make checking the default and writing unmistakable

The public CLI contract should be:

```text
Usage: scripts/sync-opencode.sh [mode] [options]

Modes (choose at most one):
  --check                 Concise drift check; this is the default.
  --dry-run               Detailed, itemized preview; writes nothing.
  --write                 Apply changes, then rerun the check.

Options:
  --config-dir DIR        Override ~/.config/opencode (primarily for tests).
  --skip-mcp              Leave mcp.flywheel untouched and skip its live probe.
  -h, --help              Show ownership, modes, exit codes, and examples.
```

Do not add `--force`, `--watch`, `--json`, `--quiet`, `--uninstall`, or aliases in v1. Each adds a behavior branch that is unnecessary for the happy path. Honor `NO_COLOR` and disable color when stdout is not a TTY instead of adding another flag.

Mode semantics must be exact:

| Invocation | Writes? | Detail | Exit 0 | Exit 1 | Exit 2 |
|---|---:|---|---|---|---|
| no args / `--check` | no | changed components and summary | clean | drift | usage/prerequisite error |
| `--dry-run` | no | itemized files plus field-level MCP change | clean | changes pending | usage/prerequisite error |
| `--write` | yes | written components plus post-write verification | apply and verify clean | apply/verification failure | usage/prerequisite error |

Returning 1 for drift makes the default useful in CI and pre-release checks. The final line must always say whether anything changed and what command the user should run next; users should never have to infer success from a stream of `rsync` output.

### 3. State the ownership boundary before showing changes

Every mode should print the resolved source, target, and mode before doing work:

```text
agent-flywheel OpenCode sync
  mode:   check
  source: /path/to/agent-flywheel
  target: /Users/name/.config/opencode
  owns:   skills/{flywheel-*,start}, commands/{flywheel-*,start.md},
          plugins/agent-flywheel.js, opencode.json:mcp.flywheel
```

The implementation may use `rsync --delete` only inside an owned skill directory. It must never use `--delete` against `skills/`, `commands/`, `plugins/`, or the OpenCode config root. When an owned source name is removed in a later release, the sync may remove the matching target inside the documented `flywheel-*`/`start` namespace, but it must list that deletion in check and dry-run output first.

`opencode.json` is shared state, not a generated artifact. Merge only `mcp.flywheel`, preserve every sibling key, make a timestamped backup before a changed write, and display only the field being changed so unrelated config or credentials never leak into terminal output.

### 4. Render to a temporary tree before comparing or writing

Build the desired skills, commands, and plugin in a temporary staging directory, apply the transforms there, and validate the staged result. Both check modes compare that same rendered tree with the destination; write mode copies the already-validated tree and then reruns the concise check.

This gives all three modes one behavior contract. It also makes dry-run trustworthy: no command in its path needs write access to `~/.config/opencode`, and tests can checksum a fixture tree before and after the run.

The renderer should derive the managed inventory from current source names (`skills/flywheel-*`, `skills/start`, `commands/flywheel-*.md`, `commands/start.md`) and report the discovered counts. Fail with a named error when a required source asset disappears; do not silently produce a smaller port.

### 5. Separate transform success from compatibility success

The mechanical renderer covers these known derivations:

- replace `$CLAUDE_PLUGIN_ROOT` with the resolved repository root;
- rewrite `/agent-flywheel:<name>` command references to `/<name>`;
- rewrite supported `Skill(..."agent-flywheel:<name>"...)` forms to OpenCode `skill(name: "<name>")` syntax;
- remove unsupported `argument-hint` command frontmatter while preserving supported fields;
- use `opencode/commands/start.md` instead of mechanically translating the Claude start command;
- render the repository root sentinel in `opencode/plugins/agent-flywheel.js`.

After rendering, run a compatibility scan for the Claude-only vocabulary agreed by the correctness plan. Classify findings rather than dumping a wall of grep output:

- `ERROR`: executable instructions still require an unavailable Claude tool or an unresolved template sentinel;
- `WARN`: prose, examples, or fallback paths mention Claude and need a reviewed allowlist decision;
- `OK`: no unapproved residuals.

Default check output should group findings by token and show the first path for each group. Dry-run may list every affected path. In all modes, print the exact `rg` command that reveals the full set. A copy operation may succeed while compatibility validation fails; in that case the final result is failure, not “synced.”

### 6. Use stable, compact output labels

Use `[CHECK]`, `[DRIFT]`, `[WRITE]`, `[WARN]`, `[ERROR]`, `[SKIP]`, and `[OK]` consistently. Send normal results to stdout and diagnostics to stderr. Avoid raw `diff` for ordinary checks because it buries the action; reserve unified or itemized detail for `--dry-run`.

A clean check should fit on one screen:

```text
[OK] skills: 23 current
[OK] commands: 23 current
[OK] plugin: current; node --check passed
[OK] MCP: mcp.flywheel current; flywheel connected
[OK] OpenCode port is in sync. No files changed.
```

A drifted check should say what happens next:

```text
[DRIFT] skills: 4 files differ
[DRIFT] commands: start.md differs
[OK] plugin: current
[DRIFT] MCP: command path points to a different checkout
[ERROR] compatibility: 3 unapproved Claude-only instructions remain
No files changed. Inspect with --dry-run; apply with --write after errors are resolved.
```

After a successful write, end with:

```text
[OK] Wrote 5 generated files and mcp.flywheel; post-write check is clean.
Restart an open OpenCode session, then run /flywheel-doctor and /start.
```

If `opencode` is absent, file/config validation can still run, but the live MCP probe must be a visible `[SKIP]`, and the final summary must say that connectivity was not verified. If the user explicitly selected install integration with `--with-opencode`, a missing binary is an error because continuing would produce a false “OpenCode ready” handoff.

### 7. Keep `install.sh` integration opt-in

Add `--with-opencode` to `install.sh`; preserve the current no-flag Claude behavior exactly. Do not configure OpenCode merely because the binary happens to be on PATH.

When `--with-opencode` is passed from a source checkout:

1. detect `opencode` and print its actual version;
2. run `scripts/sync-opencode.sh --write` after the Node prerequisite check;
3. pass `--skip-mcp` when the existing `--skip-mcp-register` flag is present;
4. fail the requested OpenCode step if the binary is missing or the sync cannot verify clean;
5. print the OpenCode handoff (`/flywheel-doctor`, then `/start`) alongside the existing Claude handoff.

The explicit flag is also sufficient consent in `--noninteractive` mode; do not add a hidden prompt. Without the flag, the installer should only mention the documented OpenCode path when it detects the binary.

This integration is for `bash install.sh` from a clone because the MCP command points at committed `mcp-server/dist/server.js` in that stable checkout. Do not advertise `curl | bash --with-opencode` until the installer has a durable clone/download strategy. Do not add OpenCode launch behavior; `--skip-launch` keeps its current Claude meaning in v1.

### 8. Give users one canonical documentation path

Add a short “OpenCode from source” subsection directly under README’s Install section, label the integration as derived/preview, and link to `docs/opencode.md`. Keep the repository’s Claude-plugin headline and default install path intact.

`docs/opencode.md` should answer the workflow in this order:

1. prerequisites and the stable-checkout requirement;
2. first sync (`--check`, `--dry-run`, `--write`);
3. what the script owns and what it preserves;
4. first run (`opencode mcp list`, `/flywheel-doctor`, `/start`);
5. update flow (`git pull`, check, dry-run if drifted, write);
6. troubleshooting: disconnected MCP, moved checkout, local edits to generated files, unsupported Claude-only tokens, and plugin syntax errors;
7. current limitations: no non-flywheel skill reconciliation, Windows installer, watcher, self-heal, or target parity guarantee.

Add a contributor note to `CONTRIBUTING.md`: changes to `skills/flywheel-*`, `skills/start`, `commands/flywheel-*`, `commands/start.md`, or the OpenCode plugin template must run the temp-home test and sync check. Add a short OpenCode-port section to `AGENTS.md` with the same source-of-truth and verification rule. Record the shipped integration in `CHANGELOG.md`.

Avoid hard-coded artifact counts in narrative docs. Examples may show the current output, but they must label counts as illustrative or generate them during verification.

## Task plan

### E1. Land the OpenCode-owned source assets and ownership contract

`depends_on: []`

Add `opencode/plugins/agent-flywheel.js` from the working local port, replacing its absolute repository root with one obvious renderer sentinel. Add the intentionally short OpenCode `opencode/commands/start.md`. Document in file headers which artifacts are source templates and which local destinations are generated.

Acceptance:

- the plugin template passes `node --check` before and after sentinel substitution;
- the start override invokes `skill(name: "start")` and forwards `$ARGUMENTS` without importing the Claude maintainer essay;
- no other complete skill or command copy is added under `opencode/`;
- the ownership set is exactly the four scoped surfaces described above.

Verification:

```bash
test -f opencode/plugins/agent-flywheel.js
test -f opencode/commands/start.md
node --check opencode/plugins/agent-flywheel.js
rg -n 'skill\(name: "start"\)|AGENT_FLYWHEEL_REPO_ROOT' opencode
```

### E2. Implement the safe sync CLI and renderer

`depends_on: [E1]`

Create `scripts/sync-opencode.sh` with the exact mode/flag/exit-code contract above. Resolve the repo relative to the script, render to a temporary tree, inventory managed sources dynamically, compare only owned destinations, merge only `mcp.flywheel`, and rerun check after every write.

The help text is part of the product: include the default mode, destructive boundary, source-checkout requirement, exit codes, and copy-paste examples. Invalid mode combinations and missing `--config-dir` values must fail before touching the destination.

Acceptance:

- no-argument and explicit check modes are read-only;
- dry-run is more detailed than check but makes the same decision;
- write mode cannot report success until the second check is clean;
- `--config-dir` redirects every destination, including `opencode.json`;
- unrelated target skills, commands, plugins, and config keys survive unchanged;
- the summary uses discovered counts and a single actionable next command.

Verification:

```bash
bash -n scripts/sync-opencode.sh
shellcheck scripts/sync-opencode.sh
scripts/sync-opencode.sh --help
```

### E3. Add post-render compatibility and verification UX

`depends_on: [E2]`

Encode the agreed Claude-ism taxonomy as a post-render validator with reviewed allowlists, then sweep the current 23 managed skills and 23 commands until the validator has no unapproved errors. Integrate `node --check` for the plugin, JSON/config validation, and the live `opencode mcp list` probe into the component summary.

This task owns presentation and gating, not the taxonomy’s semantic decisions: use the correctness planner’s list of constructs that must be rewritten versus allowed prose. Do not hide a residual behind a successful copy count.

Acceptance:

- every unresolved executable Claude-only construct produces an actionable grouped error;
- approved prose mentions are explicit, narrow allowlist entries rather than a global skip;
- unresolved template sentinels are always errors;
- the full residual scan is reproducible with a printed `rg` command;
- unavailable live probes render `[SKIP]` and keep “not verified” in the final summary.

Verification:

```bash
scripts/sync-opencode.sh --dry-run
node --check "$HOME/.config/opencode/plugins/agent-flywheel.js"
```

### E4. Prove idempotence and preservation in an isolated OpenCode home

`depends_on: [E2, E3]`

Add `install/test/test-sync-opencode.bats` and include the new script/path in `.github/workflows/install.yml`. Every write test uses `--config-dir` with a fresh temp directory; CI must never touch the runner’s real `~/.config/opencode`.

Fixtures should include unrelated skills, commands, plugins, and unrelated `opencode.json` keys. Cover clean check, drift check, detailed dry-run, first write, second-write no-op, source update, owned deletion, config merge, `--skip-mcp`, invalid flags, missing prerequisites, plugin syntax failure, and residual-token failure. Check a tree hash before and after dry-run to prove it wrote nothing.

Acceptance:

- first write followed by check exits 0;
- second write reports zero writes;
- drifted check/dry-run exit 1 and leave the fixture byte-for-byte unchanged;
- unrelated fixture artifacts and config keys survive all modes;
- shellcheck and Bats run on macOS and Ubuntu in the existing install workflow.

Verification:

```bash
bats install/test/test-sync-opencode.bats
shellcheck scripts/sync-opencode.sh install.sh install/lib/*.sh
```

### E5. Add explicit `install.sh --with-opencode` integration

`depends_on: [E2, E4]`

Extend `install.sh` parsing, help, logs, and final handoff with the opt-in flow above. Keep the current default and all existing flags backward compatible. Make the currently reserved `--skip-mcp-register` meaningful for this path by forwarding `--skip-mcp`.

Add Bats cases for help text, default no-write behavior, explicit integration with a stub `opencode`, explicit missing-binary failure, noninteractive behavior, and skip-MCP forwarding. Do not expand `install.ps1` in this cycle; the docs should call the OpenCode installer integration macOS/Linux-only.

Acceptance:

- running existing installer smoke commands without `--with-opencode` never creates OpenCode files;
- explicit OpenCode integration invokes the sync exactly once and shows its result;
- missing OpenCode cannot end with “OpenCode ready”;
- active OpenCode is never auto-launched;
- the final handoff uses `/flywheel-doctor` and `/start`, not Claude’s namespaced commands.

Verification:

```bash
bats install/test/test-detect.bats install/test/test-sync-opencode.bats
bash install.sh --help | rg -- '--with-opencode|--skip-mcp-register'
```

### E6. Add the README-to-help discovery path

`depends_on: [E2, E5]`

Add `docs/opencode.md`, a compact README install entry, contributor verification notes, the AGENTS source-of-truth rule, and a CHANGELOG entry. Use the exact commands and ownership language from the script help so users do not see two competing workflows.

The documentation must be honest about the port’s status: it is derived from a Claude Code plugin, requires a stable clone, and covers the managed flywheel surfaces only. It should tell users that generated local edits are overwritten and that moving the checkout requires rerunning `--write` to update absolute paths.

Acceptance:

- an OpenCode user finds the integration from README’s Install section without searching the repository;
- the canonical guide includes first install, update, verification, ownership, and troubleshooting;
- CONTRIBUTING and AGENTS name the check contributors must run;
- narrative docs do not claim a frozen number of commands or full non-flywheel parity;
- all examples use `/start` and `/flywheel-doctor` in OpenCode sections.

Verification:

```bash
rg -n 'OpenCode|sync-opencode\.sh' README.md docs/opencode.md CONTRIBUTING.md AGENTS.md CHANGELOG.md
rg -n '/start|/flywheel-doctor|--dry-run|--write' docs/opencode.md
```

### E7. Dogfood the live port and capture the zero-drift handoff

`depends_on: [E3, E4, E5, E6]`

Run dry-run against the current `~/.config/opencode`, review every planned deletion or overwrite, then apply once. Rerun check/dry-run to prove zero drift, verify the plugin syntax, confirm the MCP is connected, and start a fresh OpenCode session to exercise `/flywheel-doctor` and `/start`.

Record only the commands and result summary in the completion evidence; do not commit machine-local config. Verify the already-fixed codex-config doctor row separately and report the repository dirty-tree yellow separately. The sync script must not repair Codex config or clean the repository.

Acceptance:

- the pre-write dry-run shows only owned targets;
- post-write check and dry-run both report zero diff;
- `node --check` passes on the installed plugin;
- `opencode mcp list` shows flywheel connected;
- `/flywheel-doctor` and `/start` load without unavailable-tool instructions on the exercised happy path;
- unrelated local OpenCode assets remain present.

Verification:

```bash
scripts/sync-opencode.sh --dry-run
scripts/sync-opencode.sh --write
scripts/sync-opencode.sh --check
scripts/sync-opencode.sh --dry-run
node --check "$HOME/.config/opencode/plugins/agent-flywheel.js"
opencode mcp list
```

## Dependency graph and bead sizing

```text
E1 source assets
  -> E2 sync CLI
       -> E3 compatibility UX
       -> E4 isolated tests
            -> E5 install integration
       E2 + E5 -> E6 docs
       E3 + E4 + E5 + E6 -> E7 live dogfood
```

- **E1** is one bead because the two target-specific assets establish the source/derived boundary together.
- **E2** is one bead because mode parsing, staging, comparison, and write-after-validation form one CLI behavior contract; splitting them would create incompatible partial modes.
- **E3** is separate because the residual taxonomy will be reconciled with the correctness plan and can change without destabilizing file synchronization.
- **E4** is one test bead because idempotence and preservation are two sides of the same temp-home fixture contract.
- **E5** is isolated because installer regressions affect the existing Claude happy path and deserve a narrow review.
- **E6** groups the discovery surfaces because README, guide, help, AGENTS, and CONTRIBUTING must describe one command contract.
- **E7** is a dogfood gate rather than an implementation grab bag; it mutates only machine-local derived files and produces acceptance evidence.

## Explicit non-goals

- Reconcile or overwrite non-flywheel skills already installed from other sources.
- Add repo watching, automatic reapply, drift notifications, or self-healing.
- Change `mcp-server/src` behavior or rename the doubled OpenCode MCP tool prefix.
- Turn `install.sh` into a standalone OpenCode downloader or durable repo installer.
- Add OpenCode parity to `install.ps1` or native Windows support in this cycle.
- Add `--force`, `--watch`, `--json`, `--uninstall`, or an interactive menu to the sync CLI.
- Make local OpenCode files a second source of truth or preserve arbitrary edits inside generated flywheel files.
- Clean the repository’s dirty working tree or mutate Codex configuration from the sync script.
- Promise that every Claude-specific concept has an OpenCode equivalent; unsupported behaviors should fail visibly or be documented as limitations.

## Future direction

After v1 has survived normal repository updates, the same renderer can support a watch mode, drift notification, and self-heal. That work should reuse the check/write contract and ownership boundary rather than adding a daemon-specific path, but it should not be converted to beads in this cycle.
