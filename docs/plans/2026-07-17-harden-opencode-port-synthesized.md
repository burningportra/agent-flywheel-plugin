# Deep-plan (synthesized) — Harden the opencode port of agent-flywheel

**Date:** 2026-07-17
**Coordinator:** RusticLark (opencode, k3)
**Synthesizer:** QuietCliff (claude-opus-4-7)
**Inputs:** `docs/plans/2026-07-17-correctness.md`, `docs/plans/2026-07-17-ergonomics.md`, `docs/plans/2026-07-17-robustness.md`
**Scope anchor:** happy-path MVP from `docs/brainstorms/harden-the-opencode-port-of-agent-flywheel-2026-07-17.md` — a repeatable sync script plus a v1 Claude-ism stale-report over the managed skills and commands (translation deferred to v2 per alignment 2026-07-17). Diverged non-flywheel skills, watchers, and self-heal remain future work.

## Verdict

Build the opencode port as a deterministic, fail-closed compiler with a small, obvious CLI on top: a thin `scripts/sync-opencode.sh` shell wrapper delegates to a Node helper that renders repo sources into a staged tree, validates it (mechanical + semantic + hook parity + dependency closure), diffs against the owned subset of `~/.config/opencode`, and — only if everything passes — applies the change transactionally with a journal, per-file backup, and startup recovery for interrupted prior runs. `--check` (default) reports drift, `--dry-run` shows the itemized preview, `--write` applies and re-checks. The three source plans converge on the deliverable but disagree on how much semantic work belongs in v1 and how much of the tool should live in Node vs. shell; this plan flags both tensions and takes a position.

## What each plan does best (and its unique insight)

### Correctness plan
Best at naming the *silent* traps a rewrite pass will hit and pinning down the anchors that keep those traps from firing. Its unique insight is the **MCP-name preservation trap**: `flywheel_get_skill` treats its `name` arg as a hard `<plugin>:<skill-name>` string contract (`mcp-server/src/server.ts:362`, `skills-bundle.ts:347`), so a rewrite rule that isn't anchored on a leading `/` will corrupt every `flywheel_get_skill({ name: "agent-flywheel:start_planning" })` call in the port and the two-phase-bundle mechanism the `start` skill depends on breaks silently — the coordinator just falls back to `Read`. Also uniquely named the **hooks-to-plugin drift risk**: `hooks/hooks.json` will evolve and the plugin file is a hand-copy; without a parity check the divergence goes undetected. First to identify the hardcoded `FLYWHEEL_ROOT` in the live plugin as a portability blocker.

### Ergonomics plan
Best at turning the deliverable into a *product*: a stable CLI shape with exit codes CI can consume, output labels operators can scan, and an opt-in `install.sh --with-opencode` path that respects the constraint "don't auto-configure opencode just because the binary is on PATH." Its unique insight is that **the numbers in the context file have already drifted** (context says 25 commands, source has 23 managed command files: `flywheel-*` + `start`), so counts must be discovered at runtime, not baked into prose. Also uniquely named the ownership-boundary output that prints source/target/mode before doing work, the compact label vocabulary (`[OK]`, `[DRIFT]`, `[WARN]`, `[ERROR]`, `[SKIP]`), and the `docs/opencode.md` README-linked discovery path — the operator surface the other two plans didn't consider.

### Robustness plan
Best at making the port survive the failure modes that only show up in production: interrupted mid-apply, JSONC comments/trailing commas in the user's `opencode.jsonc`, paths with spaces, a hanging `opencode mcp list` probe (already observed once — didn't complete in 30s), API drift in `client.tui.showToast`. Two unique insights that neither other plan surfaced:
- **The `flywheel_flywheel_*` MCP prefix contract.** OpenCode namespaces MCP tools by config-key prefix, so the repo's `flywheel_*` tools surface at runtime as `flywheel_flywheel_get_skill`, etc. Every synced skill that calls `flywheel_get_skill(...)` will fail at runtime unless a compatibility preamble maps the logical name to the actual prefix. This is the single biggest correctness gap the manual port has today, and only robustness caught it.
- **The `grill-with-docs` dependency-closure hole.** `commands/grill-with-docs.md` delegates to `skill(name: "grill-with-docs")`, but `grill-with-docs` is *outside* the 23 managed skill dirs — it only happens to exist on this machine because it was installed from an unrelated source. On another machine, install every managed file and `/grill-with-docs` still fails. The manifest must classify delegated dependencies and the fix is a repo-owned command override that loads the bundled flywheel skill via MCP rather than a same-name native skill.

Also uniquely enumerated the actual scope of the semantic sweep (197 `AskUserQuestion`, 66 `Team*`/`SendMessage`, 77 `Agent(`, 52 `Task*` matches on the live target) — an order of magnitude more than correctness's file-count-based estimate implied.

## Best-of-all-worlds — decisions and provenance

For each major decision, the plan says which source plan the approach came from and why.

**Public CLI shape** → *ergonomics*. Three modes (`--check` default, `--dry-run`, `--write`), exit codes (0 clean / 1 drift-or-error / 2 usage/prerequisite), `--config-dir` and `--skip-mcp` as the only additional options, `NO_COLOR` honored, no `--force`/`--watch`/`--json`/`--uninstall` in v1. Adopt ergonomics' stable label vocabulary (`[OK]`, `[DRIFT]`, `[WARN]`, `[ERROR]`, `[SKIP]`, `[WRITE]`, `[CHECK]`) and its "print resolved source/target/mode before doing work" preamble. Reason: this is the shipping product surface; correctness treated the CLI as an implementation detail (`--verify` as an ad-hoc mode) and robustness didn't formalize it. Wrong choices here are expensive to unwind and CI-hostile.

**Implementation language** → *robustness*. Thin shellchecked `scripts/sync-opencode.sh` wrapper that `exec`s a Node helper under `scripts/opencode/{sync.mjs, transforms.mjs, validate.mjs}`. Node 20+ is already a project prerequisite. Reason: JSONC preservation, atomic multi-file rename, timeout-bounded child processes, hashing, and journal-based recovery all need Node — trying to do them in pure shell either produces a bigger shell or ships known-broken. Ergonomics' preference for "named bash functions" is defensible only if the scope stayed narrow, but the scope needed (JSONC merge, hook-guard shared-corpus tests, semantic overlay patches, transaction recovery) is not narrow. **Tension flag** — see below.

**Rewrite-rule storage** → *robustness*, rejecting both correctness's YAML data table and ergonomics' "keep as bash functions". Named JS transform functions in `scripts/opencode/transforms.mjs`, each with id, scope glob, pre/postconditions, and a golden fixture pair under `opencode/fixtures/transforms/<id>/{in,out}`. Reason: YAML tuples don't handle context-sensitive exclusions cleanly (rule #5 excludes matches inside `flywheel_get_skill(...)`); bash functions can't be unit-tested against fixtures. Named functions with fixture-driven tests are the middle both other plans were reaching for.

**Source layout** → *ergonomics' top-level naming* + *robustness' inner structure*.

```
opencode/
  manifest.json               # owned artifacts, transform profiles, dependency closure, retire tombstones
  compatibility.json          # forbidden tokens + narrowly-justified retained forms with reasons
  commands/
    start.md                  # intentional short native-skill override (checked in, not derived)
    grill-with-docs.md        # bundled-MCP entry point that dodges the unmanaged skill dependency
  plugins/
    agent-flywheel.js         # checked-in template with typed sentinel for repo root
  patches/                    # reviewed semantic overlays applied after mechanical transforms
  fixtures/{transforms,hooks,homes}/
scripts/
  sync-opencode.sh            # thin shell wrapper; execs the Node helper
  opencode/
    sync.mjs
    transforms.mjs
    validate.mjs
install/test/
  test-sync-opencode.bats     # black-box temp-home coverage
docs/opencode.md              # canonical user guide linked from README
```

Ergonomics correctly argued `opencode/` at the top level is more discoverable than nesting under `scripts/`. Robustness's inner structure (manifest, compatibility, patches, fixtures) is right for the scope. Neither plan gets this layout in isolation.

**Rewrite ruleset** → hybrid: *correctness's mechanical data table* wrapped in *robustness's 4-class taxonomy*, gated by *ergonomics' ERROR/WARN/OK output classification*.

Robustness's 4-class taxonomy is the framing every rule slots into:

| Class | Examples | Mechanism |
|---|---|---|
| Safe lexical | `$CLAUDE_PLUGIN_ROOT`, `/agent-flywheel:<slash-cmd>`, `Skill(skill: "agent-flywheel:X")` / `Skill(skill_name: ...)`, `argument-hint:` frontmatter | Named transform function + fixture; postcondition scan asserts zero residuals. |
| Structured equivalent | `AskUserQuestion` (opencode's `question` tool with matching arg shape) | Translate the tool name AND the payload schema; validate rendered payload against fixtures. Do not merely rename. |
| Semantic overlay | `Agent(...)`, `TeamCreate` / `TeamDelete`, `SendMessage`, agent-lifecycle `TaskStop`, `~/.claude/teams/` remediation blocks, Claude hook-setup prose, `~/.claude/plugins/cache/...` fallback branches | Reviewed patches (`opencode/patches/*.patch`) that apply against the normalized staged tree; strict hunk preflight — a stale patch fails the render. Prefer the repo's mandatory NTM path; where OpenCode has no safe equivalent, state the degraded behavior explicitly. |
| Intentional retain | `flywheel_get_skill(...)` names beginning `agent-flywheel:`, `ntm --robot-*`, provider names `claude`/`codex`/`gemini` in provider-health contexts | Explicit entries in `opencode/compatibility.json` with reason; no blanket token allowlist. |

Correctness's mechanical data table becomes the Safe-lexical class contents (with the MCP-name-preservation anchor stated in a postcondition, not just a comment). Ergonomics' post-render validator classifies leftover findings ERROR / WARN / OK, groups by token, shows first path per group, and prints the exact `rg` command to see the full set. A copy operation may succeed while compatibility validation fails; in that case the final status is failure, not "synced." **v1 scope amendment (alignment, 2026-07-17):** only the Safe-lexical class is transformed in v1; Structured-equivalent and Semantic-overlay classes are detected and emitted as a grouped stale-report (T5), with translation deferred to v2 — an unclassified new token outside the known groups still fails ERROR.

**Manifest + dependency closure** → *robustness*. `opencode/manifest.json` lists each active source/destination pair with kind, transform profile, and dependency metadata; also records MCP config key (`flywheel`), plugin template, hook coverage table, and intentional retirements. Discovery-vs-manifest cross-check runs on every invocation: a new `skills/flywheel-*` fails `inventory_unclassified`; a missing source fails `inventory_missing`; every managed command whose `skill(name:)`/slash delegation points outside the manifest fails closure. Reason: only robustness caught the `grill-with-docs` closure hole, and the manifest is the only mechanism that keeps that class of bug from recurring.

**grill-with-docs specifically** → *robustness*. Ship a repo-owned `opencode/commands/grill-with-docs.md` override that loads `agent-flywheel:grill-with-docs` through the bundled flywheel MCP tool (`flywheel_flywheel_get_skill({ name: "agent-flywheel:grill-with-docs" })`) rather than delegating to a same-name native skill. Do not overwrite the user's separately installed `grill-with-docs` skill directory. Reason: the closure hole is real and the fix stays inside scope.

**MCP tool-prefix contract (`flywheel_flywheel_*`)** → *skip, resolved at alignment*. No compatibility preamble, no call-site rewrite: the porting session demonstrated live that opencode resolves unprefixed `flywheel_*` references to `flywheel_flywheel_*` tools by suffix, matching how Claude Code resolves `mcp__` prefixes. The MCP-name *preservation* rule (never rewrite `agent-flywheel:` inside `flywheel_get_skill` name args) stays as a transform postcondition — that trap is real regardless of prefix strategy. T10's smoke test asserts one prefixed call returns the bundled body, pinning the behavior.

**opencode.json / opencode.jsonc merge** → *robustness*. Use a pinned JSONC-preserving document editor that modifies only the `mcp.flywheel` node. If the JSONC editor dependency is unavailable at run time, fail before writing — never fall back to `JSON.parse` + `JSON.stringify`, which destroys comments and trailing commas. Back up original mode and bytes, write the replacement with the same permissions, verify the edited document parses before renaming. Refuse if both `opencode.json` and `opencode.jsonc` exist without an explicit `--config-file` disambiguator. Reason: only robustness identified the JSONC contract; correctness and ergonomics both assumed strict JSON.

**Config-path resolution** → *robustness*. Precedence: (1) explicit `--config-dir` / `--config-file` test-and-user flags, (2) `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG` env vars, (3) bounded `opencode debug paths` output as a diagnostic cross-check (report but don't error on mismatch), (4) `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. Warn (don't fail) when `OPENCODE_CONFIG_CONTENT` is set because an inline runtime override may supersede the persisted entry. Reason: only robustness identified XDG + env + `debug paths`; ergonomics only had `--config-dir`.

**Machine-path portability** → *robustness*, generalizing *correctness*'s original spot of `FLYWHEEL_ROOT`. Ten machine-path references currently live in the installed targets (plugin `FLYWHEEL_ROOT`, `mcp.flywheel.command[1]`, version-read commands, tender-daemon spawn commands). All derive at render time from `git -C <script-dir> rev-parse --show-toplevel`. Templates use typed sentinels replaced via `JSON.stringify(repoRoot)` — never a raw `sed`. Fixture must include a repo path with spaces and non-ASCII characters to prove the encoding survives.

**Transactional apply / recovery** → *robustness*. Lock (`~/.config/opencode/.sync-lock/` with owner PID + start time), same-filesystem staging under `.sync-tmp-$PID/`, per-file backup with mode 0700, on-disk journal with schema version, atomic renames, ledger of installed hashes written last, startup recovery for abandoned journals (prepared/committing with a dead owner PID → validate backup → restore before starting a new render). Reason: correctness had "tmp+rename atomic" but not interrupted-mid-apply recovery, three-way diff for local divergence, or ledger of installed hashes to distinguish repo upgrade from local edit. Robustness had all three.

**Hook parity + guard equivalence** → *robustness*, superseding *correctness*'s regex-hash proposal. Two checks:
- **Hook coverage table** in `opencode/manifest.json` maps each Claude hook key/matcher in `hooks/hooks.json` to its OpenCode event/handler. Validation fails when `hooks/hooks.json` gains or removes a hook without a manifest update.
- **Shared allow/block corpus** for the two Agent-Mail guards (`hooks/agent-mail-guard.js` and its inlined port in the plugin). Each dangerous/benign/break-glass command must produce the same decision from both. Comparing regex source strings — correctness's original idea — is too coupled to formatting (a whitespace change causes false-positive drift). Testing behavior is what matters.

**Toast API drift** → *robustness*. Feature-detect `client.tui.showToast` at plugin load; log one structured warning when absent. The current bare `try {} catch {}` prevents a crash but silently hides API drift, so it can't serve as verification.

**Bounded `opencode mcp list` probe** → *robustness*. `spawnSync(..., { timeout: 15_000 })` around the runtime smoke; a hang classifies as `runtime_unverified`, releases the sync lock, and reports red on runtime — but does not undo a valid filesystem transaction, because network/process health is independent of generation correctness. The 30s hang observed during robustness planning is real; every child process needs a timeout.

**install.sh integration** → *ergonomics*. Add `--with-opencode` as an opt-in flag. Preserve existing Claude-default behavior exactly. Make the currently reserved `--skip-mcp-register` meaningful for this path by forwarding `--skip-mcp`. Fail if `--with-opencode` is passed but `opencode` is missing (do not silently degrade). Explicit flag counts as consent in `--noninteractive`. No `curl | bash --with-opencode` until the installer has a durable clone strategy; no OpenCode integration in `install.ps1` this cycle. Reason: robustness didn't cover installer integration; ergonomics did with a clean opt-in shape that matches the "don't auto-configure just because binary exists" constraint.

**Documentation surface** → *ergonomics*. Add `docs/opencode.md` (prerequisites → first sync → what the script owns → first run → update flow → troubleshooting → current limitations). Short README subsection under Install linking to it, labeled derived/preview. Contributor note in `CONTRIBUTING.md`. Source-of-truth rule added to `AGENTS.md`. CHANGELOG entry. Examples show current output but label counts as illustrative, generated during verification.

**Doctor-yellow triage** → *consensus of all three*. The sync script MUST NOT auto-fix Codex config or clean the dirty working tree. Verify the Codex row (already fixed today) separately; triage the dirty paths by path and provenance (source change / generated artifact / deep-plan artifact / unknown owner) and land or discard each with a reason.

**Numbers in output** → *ergonomics* + *robustness* both hit this: counts are discovered every run, never baked into prose. The context file's "25 commands" is already stale; the source has 23 managed commands (22 `flywheel-*` + `start`). Prose in docs may show current values as *illustrative*.

## Verification bar (composite)

Post-sync, all of these must hold. Any failure is a bug, not a note-and-move-on:

1. `scripts/sync-opencode.sh --check` exits 0 with `[OK] OpenCode port is in sync.` Run twice consecutively to prove idempotence.
2. `scripts/sync-opencode.sh --dry-run` exits 0 with no proposed writes; a target-tree hash before and after the dry-run is byte-identical (proves dry-run is a proof path, not a partial mutation).
3. `bash -n scripts/sync-opencode.sh` succeeds; `shellcheck` reports no warnings above `info`.
4. `node --check ~/.config/opencode/plugins/agent-flywheel.js` succeeds.
5. `opencode mcp list` shows `flywheel` connected within the 15s timeout.
6. `grep -rE '/agent-flywheel:' ~/.config/opencode/skills/ ~/.config/opencode/commands/` returns zero matches.
7. `grep -rE 'flywheel_get_skill\([^)]*name:\s*"(?!agent-flywheel:)' ~/.config/opencode/skills/` returns zero (MCP-name preservation preserved).
8. `grep -rn 'CLAUDE_PLUGIN_ROOT' ~/.config/opencode/{skills,commands,plugins}/` returns zero.
9. `grep -n '/Volumes/1tb/Projects/agent-flywheel' ~/.config/opencode/plugins/agent-flywheel.js ~/.config/opencode/opencode.json` returns the *current* repo abspath. On a different machine, running sync produces a different abspath and both files update in one transaction.
10. Compatibility validator reports zero ERROR-class findings; the semantic-class Claude-only references appear only as grouped `[REPORT]` lines in the stale-report (baseline: 197 `AskUserQuestion`, 77 `Agent(`, 66 `Team*`/`SendMessage`, 35 `Task*` — informational, not failing); any WARN is on the reviewed allowlist in `opencode/compatibility.json` with a reason.
11. Hook parity check: every hook point in `hooks/hooks.json` has a handler in the plugin file (JSON parse + AST walk).
12. Shared-corpus guard equivalence: every dangerous/benign/break-glass command in the fixture produces the same allow/block from both `hooks/agent-mail-guard.js` and the plugin's inlined port.
13. Dependency closure: every managed command's `skill(name:)` / slash delegation resolves to a manifest-owned skill, a flywheel MCP bundle name, or an explicitly external allowlist entry.
14. Runtime smoke: `opencode` starts, `/flywheel-doctor` reaches green, `/start` prints the banner with the correct version (read from the injected repo path), one `flywheel_flywheel_get_skill({ name: "agent-flywheel:start_planning" })` returns the body from the bundle (pins the suffix-resolution behavior the prefix-skip decision relies on), one Agent-Mail guard block/allow pair works.

## Task plan (composite; adopts robustness's dependency shape with ergonomics' beading discipline)

### T1. Manifest, ownership, dependency closure
`depends_on: []`
Add `opencode/manifest.json` with 23 managed skill dirs, 25 commands (discovered, not hardcoded), plugin template, MCP key, transform profiles, external dependency classification, no initial retirements. Implement discovery vs. manifest cross-check and dependency-closure validator for native skill / slash / MCP delegation. Resolve `grill-with-docs` via a repo-owned command override that loads the bundled flywheel skill through MCP; do not touch separately installed non-flywheel skill directories. Acceptance: adding a synthetic `skills/flywheel-new/` fails `inventory_unclassified`; removing a listed source fails `inventory_missing`; every managed command dependency is classified; parent directories are never ownership targets.

### T2. OpenCode-native source assets and hook mapping
`depends_on: [T1]`
Move the current live plugin into `opencode/plugins/agent-flywheel.js` as a real template. Replace `/Volumes/1tb/Projects/agent-flywheel` and every other machine literal with typed sentinels. Add the intentional short `opencode/commands/start.md` (native `skill(name: "start")` invocation, not the Claude essay). Add `opencode/commands/grill-with-docs.md` (bundled-MCP entry). Encode Claude-hook-to-OpenCode-event coverage in the manifest. Remove unconditional macOS recovery prose; guard by `process.platform`. Feature-detect `client.tui.showToast` and log structured warning when absent. Acceptance: templates contain no user/volume literals; `node --check` passes before and after test rendering; hook map covers every entry in `hooks/hooks.json`.

### T3. Public CLI + deterministic renderer + mechanical transforms
`depends_on: [T1, T2]`
Create `scripts/sync-opencode.sh` (thin shell wrapper: resolve repo, validate helper exists, `exec node …`) and `scripts/opencode/{sync.mjs, transforms.mjs, validate.mjs}`. Implement the exact three-mode CLI contract (`--check` default, `--dry-run`, `--write`, exit codes 0/1/2, `--config-dir`, `--skip-mcp`, help text as product surface). Render to a private temp tree; apply mechanical transforms with the MCP-name-preservation anchor as a postcondition scan; derive MCP command from `.claude-plugin/plugin.json` (not a duplicated constant); resolve config path via the flags → env → `opencode debug paths` → XDG precedence; refuse simultaneous `.json`/`.jsonc` ambiguity. Each transform has an id, scope, pre/postconditions, and a golden fixture pair. Acceptance: two renders from identical bytes are byte-identical; paths with spaces and Unicode render correctly; `agent-flywheel:start_planning` survives; `/agent-flywheel:start` and unsupported frontmatter do not; check/dry-run touch nothing.

### T4. JSONC-preserving MCP merge + config-file safety
`depends_on: [T1, T3]`
Integrate a pinned JSONC-preserving document editor that changes only `mcp.flywheel`. Fail before writing if the editor is unavailable. Back up original bytes with permissions, verify edited output parses before rename. Path-containment checks on both source and destination symlinks. Never log unrelated config contents (may contain provider secrets). Acceptance: JSON and JSONC fixtures preserve unrelated keys, comments, trailing commas, and file permissions; custom profiles work; missing or ambiguous config fails before writes.

### T5. Claude-ism stale-report (semantic sweep deferred to v2)
`depends_on: [T3]`
Implement the v1 stale-report: scan the staged tree for the semantic-class Claude-only references (`AskUserQuestion`, `Agent(`, `TeamCreate`/`TeamDelete`/`SendMessage`, agent-lifecycle `Task*`, `~/.claude/teams/` and `~/.claude/plugins/cache/` remediation blocks, Claude hook-setup prose), group findings by token with first-path-per-group and the exact `rg` command for the full set, and emit them as a labeled `[REPORT]` section (baseline verified 2026-07-17: 197 `AskUserQuestion`, 77 `Agent(`, 66 `Team*`/`SendMessage`, 35 `Task*`). The report is informational — it does not fail the sync — but an *unclassified* new Claude-only token that matches no known group fails the compatibility validator as ERROR. Patch-based translation of these call sites (the original T5) is explicitly deferred to v2. Acceptance: report counts match a fresh `rg` baseline within run-to-run determinism; a deliberately introduced new Claude tool call fails validation; report output is stable across two consecutive runs.

### T6. Ledger, lock, transactional apply, and recovery
`depends_on: [T3, T4]`
Add a private state dir under the resolved OpenCode config with schema-versioned ledger, lock metadata (owner PID + start time), transaction journal, and mode-0700 per-file backups. Classify normal upgrades vs. local divergence by three-way hashes (source / installed-per-ledger / live). Stage on the destination filesystem, journal before renames, write the ledger last, roll back caught failures, recover abandoned valid journals at next startup. `spawnSync(..., { timeout: 15_000 })` around every child process; a hung `opencode mcp list` classifies runtime as `runtime_unverified` but does not roll back a valid filesystem apply. Acceptance: concurrent invocation is rejected; local edits are labeled and backed up; forced failure after each commit step restores the prior tree; simulated hard-kill journal is recovered; unmanaged siblings and config keys remain byte-for-byte unchanged.

### T7. Failure matrix, hook-guard corpus, black-box test coverage
`depends_on: [T2, T5, T6]`
Add `install/test/test-sync-opencode.bats` and focused Node fixtures for transforms, JSONC, plugin hooks. Cover: first install, no-op rerun, source upgrade, intentional retirement, local edit, custom config paths, paths with spaces, new unclassified Claude tokens failing validation, stale-report determinism, symlink escapes, lock contention, every transactional-failure injection point, missing binaries, a fake hanging `opencode`. Shared allow/block corpus for the two Agent-Mail guards (source `.js` and inlined plugin port) must produce identical decisions. A target-tree hash before/after check and dry-run proves immutability. Acceptance: tests never touch the runner's real `~/.config/opencode`; a second write reports zero writes; timeout tests finish within budget; hook guard corpora produce equivalent decisions.

### T8. install.sh --with-opencode opt-in
`depends_on: [T3, T7]`
Extend `install.sh` parsing, help, logs, and final handoff with the opt-in flow. Preserve every existing flag and behavior. Make `--skip-mcp-register` meaningful for this path by forwarding `--skip-mcp` to the sync script. Missing `opencode` under `--with-opencode` is an error (do not silently degrade). Do not expand `install.ps1`. Add Bats cases for help text, default-no-write behavior, explicit integration with a stub `opencode`, missing-binary failure, noninteractive behavior, and skip-MCP forwarding. Acceptance: running existing installer smoke commands without `--with-opencode` never creates OpenCode files; explicit integration invokes the sync exactly once and shows its result; missing OpenCode never ends with "OpenCode ready."

### T9. Docs, README discovery path, adjacent-yellow triage
`depends_on: [T6, T7, T8]`
Add `docs/opencode.md` (prerequisites, first sync, ownership boundary, first run, update flow, troubleshooting, current limitations). Short README subsection under Install, labeled derived/preview. Contributor note in `CONTRIBUTING.md` — changes to managed sources must run the temp-home tests. Source-of-truth rule in `AGENTS.md`. CHANGELOG entry. No hard-coded artifact counts as timeless facts. Verify the Codex-config doctor row (already fixed today) separately; triage the 24–27 dirty repo paths by owner and land or discard each with a reason. Acceptance: an OpenCode user finds the integration from README Install without searching; docs use `/start` and `/flywheel-doctor` in OpenCode sections; codex row is reported verified or still yellow; dirty paths each have an owner assigned.

### T10. Live dogfood with zero-drift evidence
`depends_on: [T7, T8, T9]`
Run `--dry-run` against the current live config, review every planned deletion or backup, apply once, rerun `--check` and `--dry-run` to prove zero managed drift. Run `node --check` on the installed plugin, `opencode mcp list` within the timeout, `/flywheel-doctor`, `/start` reaching a native `question` gate without invoking Claude-only tools, one `flywheel_flywheel_get_skill` MCP call returning the bundled body, one Agent-Mail guard block/allow pair. Record commands and result summary in completion evidence; do not commit machine-local config. Acceptance: post-write `--check` and `--dry-run` show zero managed drift; runtime smoke green on every listed check; unrelated local OpenCode assets remain present.

### Dependency graph
```
T1 manifest/ownership
├── T2 native assets + hook map
├── T3 CLI + renderer + mechanical
│    ├── T4 JSONC merge + config safety
│    └── T5 stale-report (sweep deferred to v2)
│
T3 + T4 ──> T6 transaction/ledger
T2 + T5 + T6 ──> T7 failure matrix + tests
T3 + T7 ──> T8 install.sh integration
T6 + T7 + T8 ──> T9 docs + triage
T7 + T8 + T9 ──> T10 live dogfood
```

## Unresolved tensions (flagged for user decision)

1. **Shell functions vs. Node helper — real disagreement.** Ergonomics explicitly argued for keeping transforms as named bash functions in `scripts/sync-opencode.sh`, calling extraction to another language "another language to understand." Robustness (and this synthesis) argue Node is the only tenable substrate for JSONC preservation, timeout-bounded probes, transactional recovery, and hashing. **Position taken:** Node helper. **Trade-off:** contributors who wanted a pure-bash script won't get one. **What would flip it:** if the JSONC + timeout + transaction pieces are pushed to v2, ergonomics' shell-only stance becomes reasonable and lighter to maintain.

2. **How aggressively to sweep semantic Claude-isms in v1 — RESOLVED at alignment (user, 2026-07-17).** Correctness's original position was mechanical-only: v1 emits a `--stale-report` counting the semantic-delta references, and a follow-up cycle does the translation. Ergonomics wanted post-render validation with grouped errors. Robustness wanted full sweep via checked-in patches, fail-closed. **User decision: cut T5 to a stale-report.** v1 counts and groups the semantic-class references (verified baseline: 197 `AskUserQuestion`, 77 `Agent(`, 66 `Team*`/`SendMessage`, 35 `Task*`), patch-based translation ships in v2. T7's stale-patch test cases are dropped with it; new-Claude-token detection stays (the report fails closed on unclassified tokens).

3. **`grill-with-docs` bundled-MCP override.** All three plans agree the current setup has a dependency-closure hole, but only robustness proposed the specific fix (bundled MCP override). The alternative would be to add `grill-with-docs` to the managed skill set — expanding the ownership boundary. **Position taken:** the bundled-MCP override, because it keeps the ownership boundary tight and matches how `start_planning` etc. are already fetched. **What would flip it:** if a future cycle promotes `grill-with-docs` to a first-class flywheel skill, add it to the manifest and drop the override.

4. **MCP tool-prefix strategy — RESOLVED at alignment (user, 2026-07-17): skip both.** Robustness proposed a compatibility preamble at the top of each managed skill that maps logical `flywheel_*` names to `flywheel_flywheel_*`; the alternative was rewriting every call site. **User decision: neither.** Live evidence from the porting session invalidates the premise — opencode resolved `flywheel_flywheel_get_skill` and `flywheel_flywheel_doctor` from unprefixed `flywheel_*` skill references by suffix match, the same way Claude Code resolves its `mcp__server__tool` prefixing. No preamble, no call-site rewrite. T10's runtime smoke keeps one real `flywheel_flywheel_get_skill` call as the pin for the behavior this decision relies on.

5. **Opencode version baseline.** Ergonomics observed the binary on this machine reports 1.15.5 while the context file names 1.15.10. Robustness flagged that version strings alone are not proof — feature-detect capabilities. **Position taken:** report the detected version as diagnostics, feature-detect capabilities (`client.tui.showToast`, `session.idle`, `tool.execute.before/after`, `question` tool), warn outside the tested capability baseline, do not hard-gate on version. Consensus of ergonomics + robustness against a version-string gate.

## Explicit non-goals (union of all three plans)

- Reconciling, overwriting, or choosing winners among the diverged non-flywheel skill directories already installed in `~/.config/opencode/skills/` from other sources.
- Filesystem watcher, launch agent, cron job, automatic reapply, drift notification, self-healing daemon.
- Changes to `mcp-server/src` behavior, renames of MCP tools, redesigning the Claude plugin around OpenCode.
- Making arbitrary local edits inside managed generated files a second source of truth. v1 preserves them in backups and points maintainers back to templates/patches.
- Native Windows / PowerShell parity. v1 targets the repo's existing macOS/Linux Node+Bash environment and says so.
- Auto-cleaning the current dirty repository or mutating Codex configuration from the sync script.
- Promising compatibility with unknown future OpenCode plugin APIs without capability tests; version strings alone are not proof.
- `curl | bash --with-opencode` (the installer has no durable clone/download strategy yet); OpenCode launch behavior in `install.sh`.
- `--force`, `--watch`, `--json`, `--uninstall`, or an interactive menu on the sync CLI.
- Patch-based semantic translation of `AskUserQuestion` / `Agent(` / `Team*` / `SendMessage` / `Task*` call sites (deferred to v2 per alignment 2026-07-17; v1 ships the grouped stale-report instead).
- MCP tool-prefix compatibility preambles or call-site rewrites for `flywheel_flywheel_*` (skip resolved at alignment 2026-07-17; suffix resolution verified live).

## Future direction (out of v1 scope)

Once the renderer, ledger, and recovery path have survived normal repo upgrades, add a watcher that calls the same read-only `--check` and explicit `--write` operations on `fswatch skills/ commands/ hooks/ opencode/` events, plus a periodic (`launchd` or `cron`) drift check that notifies the user when live opencode config diverges from repo state. Same script, extra flag — no daemon-specific transformation path, no daemon-owned source state. Also possible v2 directions: patch-based semantic translation of the Claude-only tool references tracked by the T5 stale-report (the original T5 scope, deferred at alignment); promoting `grill-with-docs` to a first-class flywheel skill (retire the bundled-MCP override); Windows parity in `install.ps1`; a standalone `curl | bash` OpenCode installer once the clone strategy is durable.
