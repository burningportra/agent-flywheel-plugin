# agent-flywheel on OpenCode (derived / preview)

The OpenCode port is a **derived artifact**. The repository is the source of truth for the Claude Code plugin; `scripts/sync-opencode.sh` renders the managed skills, commands, and plugin into your OpenCode config. You never hand-edit the installed OpenCode files — you edit the repo and re-run the sync. This page is the canonical guide to running that sync and living with the port.

> **Preview status.** v1 ships the deterministic sync toolchain and a Claude-ism stale-report. Semantic translation of Claude-only tool calls (`AskUserQuestion`, `Agent(`, `Team*` / `SendMessage`, `Task*`) is deferred to v2 — v1 detects and counts them but does not rewrite them. See [Current limitations](#current-limitations).

## Prerequisites

- **Node.js 20+.** The sync is a thin `scripts/sync-opencode.sh` shell wrapper that `exec`s a Node helper (`scripts/opencode/sync.mjs`). Node 20+ is the pinned floor for the helper.
- **A full repo checkout.** `curl | bash` cannot configure OpenCode yet (no durable clone strategy), so run the sync from a cloned working tree.
- **The `opencode` binary on `PATH`** — only needed for the post-write runtime smoke (`opencode mcp list`) and, of course, to actually run the ported flywheel. Install OpenCode from its own distribution first; the sync itself renders fine without it, but the runtime check will report `runtime_unverified`.
- **git**, because the renderer derives the repo root (and every machine-path sentinel it injects) from `git rev-parse --show-toplevel`.

## First sync

The CLI has three modes and you walk them in order — look, preview, apply:

```bash
# 1. See whether anything is out of sync (this is the default mode; read-only).
scripts/sync-opencode.sh --check

# 2. Preview every managed write without touching the target.
scripts/sync-opencode.sh --dry-run

# 3. Apply the managed writes atomically, then re-check.
scripts/sync-opencode.sh --write
```

`--check` renders the port into a private temp tree, diffs it against the owned subset of your OpenCode config, and reports drift. `--dry-run` shows the itemized `[WRITE]` preview it *would* apply — proven immutable (a target-tree hash is byte-identical before and after). `--write` applies each managed item transactionally (staging on the destination filesystem, per-file backups, a journal, and the installed-hash ledger written last), then re-runs the check.

A clean run ends with (output is illustrative):

```
[CHECK] source=/path/to/agent-flywheel target=/Users/you/.config/opencode mode=check ...
[OK] OpenCode port is in sync.
```

**Exit codes** (CI-consumable): `0` clean (or write completed and the re-check is clean), `1` drift / pending dry-run writes / validation failure / apply error, `2` invalid usage or a missing prerequisite.

**Config path resolution** follows this precedence: `--config-dir` / `--config-file` flags → `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG` env vars → `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. `opencode debug paths` is consulted only as a bounded diagnostic cross-check. The sync refuses to guess when both `opencode.json` and `opencode.jsonc` exist — pass `--config-file` to disambiguate.

### Via the installer

If you install from a full checkout, `install.sh --with-opencode` runs `scripts/sync-opencode.sh --write` once at the end of setup. It fails fast (before doing any install work) if the `opencode` binary is missing — it never silently degrades. `--skip-mcp-register` is forwarded as `--skip-mcp`, so the sync leaves your OpenCode config file and the `mcp.flywheel` entry untouched while still rendering skills and commands.

## Ownership boundary

The sync owns **exactly** the source/target pairs enumerated in [`opencode/manifest.json`](../opencode/manifest.json) — nothing more. Read that file when you want the authoritative list; it is hand-authored and the sync cross-checks the live tree against it on every invocation.

**What the script owns and manages:**

- The managed flywheel **skill directories** (`skills/flywheel-*/`, `skills/start/`) — matched by pattern, cross-checked against the manifest, not a hardcoded count. Adding a new `skills/flywheel-*/` dir without updating the manifest fails the run (`inventory_unclassified`); removing a listed source fails it (`inventory_missing`).
- The managed **command files** (`commands/flywheel-*.md`, `commands/start.md`).
- Two **command overrides** shipped verbatim from `opencode/commands/`: a short native `start.md` (a `skill(name: "start")` pointer, not the long Claude command essay) and a `grill-with-docs.md` that loads the bundled skill through MCP so `/grill-with-docs` resolves on any machine.
- The **plugin** `plugins/agent-flywheel.js`, rendered from the checked-in template with the repo-root sentinel replaced by your actual absolute path.
- The single **`mcp.flywheel`** node in your `opencode.json` / `opencode.jsonc`, merged with a JSONC-preserving editor that leaves comments, trailing commas, unrelated keys, and file permissions intact.

**What it never touches:**

- Parent directories (`skills/`, `commands/`, `plugins/`) are never ownership targets — only the enumerated leaves.
- Non-flywheel skills already in your `~/.config/opencode/skills/` from other sources. The port never reconciles, overwrites, or picks winners among diverged unrelated skills.
- Any config key other than `mcp.flywheel`, and any other MCP server you have configured.

## First run

Once synced, launch OpenCode and drive the flywheel with its native slash commands — `/start`, `/flywheel-doctor`, `/flywheel-status`, and the rest — the same names, without the `agent-flywheel:` prefix that Claude Code uses.

**How MCP tools are named.** OpenCode namespaces MCP tools by their config key, so the flywheel's `flywheel_*` tools surface at runtime with the key prefixed: `flywheel_flywheel_get_skill`, `flywheel_flywheel_doctor`, and so on. You don't rewrite anything — OpenCode resolves an unprefixed `flywheel_*` reference to the prefixed tool by suffix match, the same way Claude Code resolves its `mcp__server__tool` names. A skill body that calls `flywheel_get_skill(...)` works as written; the runtime just binds it to `flywheel_flywheel_get_skill`.

A good first-run smoke: run `/flywheel-doctor` (it should reach green), then `/start` (it prints the banner with the version read from your injected repo path and routes into the state-aware menu).

## Update flow

The port is derived, so it drifts whenever the repo changes. After you pull repo updates:

```bash
git pull
scripts/sync-opencode.sh --check     # [OK] → nothing to do; [DRIFT] → re-apply
scripts/sync-opencode.sh --write      # only if --check reported drift
```

Wire `scripts/sync-opencode.sh --check` into CI (or a pre-flight step) to catch a stale port — it exits `1` on any managed drift and `0` when the port matches the repo. Because `--check` and `--dry-run` are read-only, they are safe to run anywhere, any number of times.

## Troubleshooting

**Lock contention.** Only one sync runs at a time. A concurrent invocation is rejected while another holds the lock (`<config-dir>/.sync-lock/`, tagged with the owner PID and start time). If a prior run was hard-killed, the next run prints `[WARN] reclaiming stale sync lock ...` once it confirms the owner PID is dead, then proceeds. Don't delete the lock directory by hand — let the reclaim logic handle it.

**`[LOCAL]` divergence.** A managed file labeled `LOCAL` means its live bytes differ from what the ledger recorded installing — someone hand-edited a generated OpenCode file. The sync backs up the local copy (mode 0700) before overwriting and points you back to the repo template/patch. Generated files are not a second source of truth: make the change in the repo and re-sync. (A normal repo upgrade is distinguished from a local edit by three-way hashing: source vs. installed-per-ledger vs. live.)

**`runtime_unverified`.** After a successful `--write`, the sync runs a bounded `opencode mcp list` smoke (15s timeout). If `opencode` is missing or the probe hangs, the runtime line reads `runtime_unverified` and the run reports red *on runtime only* — it does **not** roll back the filesystem apply, because process/network health is independent of whether the files rendered correctly. Re-run `opencode mcp list` yourself, or confirm the binary is on `PATH`.

**Stale-report `[REPORT]` lines.** The compatibility validator emits a grouped Claude-ism stale report — one `[REPORT]` line per token group (e.g. `AskUserQuestion`, `Agent(`, `Team*` / `SendMessage`, `Task*`, `~/.claude/...` paths, Claude hook-setup prose) with a count, the first path in the group, and the exact `rg` command to list every occurrence. This is **informational and never fails the sync** — it tracks the semantic translation debt deferred to v2. An illustrative block:

```
[REPORT] Claude-ism stale report (informational; rg commands run from repository root)
[REPORT] group=ask-user-question count=<n> first=skills/start/SKILL.md
[REPORT] rg[ask-user-question]=rg --sort path ... -e '\bAskUserQuestion\b' ...
```

Counts are discovered each run — treat any number you see as a snapshot, not a fixed fact. What *does* fail the sync (as `[ERROR]`) is an **unclassified** new Claude-only token — one that matches no known report group and no reviewed allowlist entry in [`opencode/compatibility.json`](../opencode/compatibility.json). That is the fail-closed guard: v1 won't silently admit a brand-new Claude tool call into the ported tree.

**`[DRIFT]` on a fresh checkout.** Expected before the first `--write`. Run `--dry-run` to see the itemized writes, then `--write`.

## Current limitations

- **No watch mode.** There is no daemon, launch agent, or cron reapply. Re-run `--check` / `--write` yourself after repo updates. A watcher is future (v2) work — same script, extra flag.
- **No Windows / PowerShell parity.** v1 targets the repo's existing macOS/Linux Node + Bash environment. `install.ps1` is not extended for OpenCode.
- **Semantic Claude-isms are report-only in v1.** The stale-report counts Claude-only tool calls; it does not translate them. Patch-based translation of those call sites is deferred to v2. The ported skills still run because OpenCode resolves the flywheel MCP tools by suffix, but Claude-specific tool prose remains visible until the v2 overlay lands.
- **No `curl | bash --with-opencode`.** The installer has no durable clone/download strategy yet, so OpenCode configuration requires a full local checkout.
- **Single config file per run.** If both `opencode.json` and `opencode.jsonc` exist, the sync refuses until you pass `--config-file` — it will not guess which one you meant.

## See also

- [`opencode/manifest.json`](../opencode/manifest.json) — the authoritative ownership boundary (managed skills, commands, overrides, plugin, hook coverage).
- [`opencode/compatibility.json`](../opencode/compatibility.json) — the reviewed report groups and the ERROR/WARN token lexicon.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to change managed sources and run the temp-home test suite.
- [`AGENTS.md`](../AGENTS.md) — the repo-is-source-of-truth rule for the port.
